"""SQL IDE router - execute queries, manage sessions, generate DDL/INSERT/EXEC.

This powers the SQL IDE tab in the frontend, providing DBeaver-like functionality:
- Multiple script tabs (sessions) with independent connections
- Parallel query execution across sessions
- Persistent results per tab (switching tabs doesn't erase results)
- DDL generation, INSERT generation, EXEC proc generation
- Global query tracker for background monitoring
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.connectors.factory import get_connector
from app.db.store import Connection as ConnectionRecord, get_session as get_db_session
from app.services.query_session import (
    MAX_ROWS_DEFAULT, MAX_ROWS_LIMIT, MAX_STATEMENTS_PER_EXECUTION, query_manager,
)
from app.services.ddl_generator import generate_ddl, generate_insert, generate_exec_proc


router = APIRouter(prefix="/api/sql-ide", tags=["sql-ide"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class CreateSessionRequest(BaseModel):
    connection_id: int
    name: str = "Untitled"


class RenameSessionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)


class ChangeConnectionRequest(BaseModel):
    connection_id: int


class SnowflakeContextBody(BaseModel):
    """Optional per-query Snowflake session context.

    Each field, if non-empty, is translated to a ``USE <kind> "name"``
    statement that runs BEFORE the user's SQL. Per-query (not session-
    cached) so two tabs sharing the same connection can use different
    warehouses / roles without stepping on each other.
    """
    role: str | None = None
    warehouse: str | None = None
    database: str | None = None
    schema_name: str | None = None


class ExecuteRequest(BaseModel):
    sql: str = Field(min_length=1)
    connection_id: int | None = None  # override session's default
    max_rows: int = Field(default=MAX_ROWS_DEFAULT, ge=1, le=MAX_ROWS_LIMIT)
    snowflake_context: SnowflakeContextBody | None = None
    # Statements already split by the client (same rules as
    # app.services.sql_split). When omitted, ``sql`` is split server-side.
    statements: list[str] | None = Field(default=None, max_length=MAX_STATEMENTS_PER_EXECUTION)
    # Auto-commit (default) or manual transaction mode for this tab's session.
    autocommit: bool = True
    # Stop at the first failing statement (default) or run the rest anyway.
    stop_on_error: bool = True


class CloseSessionsRequest(BaseModel):
    session_ids: list[str] = Field(default_factory=list, max_length=500)


class DDLRequest(BaseModel):
    connection_id: int
    database: str | None = None
    schema_name: str | None = None
    table: str = Field(min_length=1)


class InsertGenRequest(BaseModel):
    connection_id: int
    database: str | None = None
    schema_name: str | None = None
    table: str = Field(min_length=1)
    limit: int = 100


class ExecProcRequest(BaseModel):
    db_type: str
    database: str | None = None
    schema_name: str | None = None
    proc_name: str = Field(min_length=1)
    params: list[dict] | None = None


# ---------------------------------------------------------------------------
# Session management
# ---------------------------------------------------------------------------

@router.post("/sessions", status_code=201)
def create_session(req: CreateSessionRequest) -> dict:
    # Validate connection exists
    db_session = get_db_session()
    try:
        record = db_session.get(ConnectionRecord, req.connection_id)
        if not record:
            raise HTTPException(404, f"Connection {req.connection_id} not found")
    finally:
        db_session.close()

    s = query_manager.create_session(req.connection_id, req.name)
    return s.to_dict()


@router.get("/sessions")
def list_sessions() -> list[dict]:
    return query_manager.list_sessions()


@router.get("/sessions/{session_id}")
def get_session(session_id: str, include_results: bool = False) -> dict:
    s = query_manager.get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")
    return s.to_dict(include_results=include_results)


@router.put("/sessions/{session_id}/rename")
def rename_session(session_id: str, req: RenameSessionRequest) -> dict:
    if not query_manager.rename_session(session_id, req.name):
        raise HTTPException(404, "Session not found")
    s = query_manager.get_session(session_id)
    return s.to_dict() if s else {}


@router.put("/sessions/{session_id}/connection")
def change_session_connection(session_id: str, req: ChangeConnectionRequest) -> dict:
    # Validate connection exists
    db_session = get_db_session()
    try:
        record = db_session.get(ConnectionRecord, req.connection_id)
        if not record:
            raise HTTPException(404, f"Connection {req.connection_id} not found")
    finally:
        db_session.close()

    if not query_manager.change_connection(session_id, req.connection_id):
        raise HTTPException(404, "Session not found")
    s = query_manager.get_session(session_id)
    return s.to_dict() if s else {}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> Response:
    if not query_manager.delete_session(session_id):
        raise HTTPException(404, "Session not found")
    return Response(status_code=204)


@router.post("/sessions/close")
def close_sessions(req: CloseSessionsRequest) -> dict:
    """Close several sessions at once (tab close, workspace switch, page unload).

    Unknown ids are ignored so a page-unload beacon can fire blindly."""
    closed = [sid for sid in req.session_ids if query_manager.delete_session(sid)]
    return {"closed": closed}


@router.post("/sessions/{session_id}/commit")
def commit_transaction(session_id: str) -> dict:
    return _end_transaction(session_id, commit=True)


@router.post("/sessions/{session_id}/rollback")
def rollback_transaction(session_id: str) -> dict:
    return _end_transaction(session_id, commit=False)


def _end_transaction(session_id: str, commit: bool) -> dict:
    try:
        return query_manager.end_transaction(session_id, commit=commit)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(400, f"{'Commit' if commit else 'Rollback'} failed: {exc!s:.1000}") from exc


# ---------------------------------------------------------------------------
# Query execution
# ---------------------------------------------------------------------------

@router.post("/sessions/{session_id}/execute")
def execute_query(session_id: str, req: ExecuteRequest) -> dict:
    """Submit a query for background execution. Returns immediately with exec_id."""
    s = query_manager.get_session(session_id)
    if not s:
        raise HTTPException(404, "Session not found")

    # Translate the optional Snowflake context into a dict the query
    # manager can prepend as USE statements. None / missing values are
    # filtered out.
    sf_ctx: dict | None = None
    if req.snowflake_context is not None:
        sf_ctx = {k: v for k, v in req.snowflake_context.model_dump().items() if v}
        if not sf_ctx:
            sf_ctx = None

    try:
        ex = query_manager.execute(
            session_id, req.sql, req.connection_id, req.max_rows,
            snowflake_context=sf_ctx,
            statements=req.statements,
            autocommit=req.autocommit,
            stop_on_error=req.stop_on_error,
        )
    except RuntimeError as e:
        raise HTTPException(429, str(e)) from e
    if not ex:
        raise HTTPException(500, "Failed to queue execution")
    return ex.to_dict()


@router.get("/sessions/{session_id}/executions/{exec_id}")
def get_execution(
    session_id: str,
    exec_id: str,
    lightweight: bool = False,
    offset: int = 0,
    limit: int | None = None,
) -> dict:
    """Return execution status (+ optionally rows).

    When ``lightweight=true``, only status / row_count / error / timing are
    returned - the full ``rows`` and ``columns`` arrays are omitted. The
    frontend polls in lightweight mode while the query is running so the
    growing in-flight rows array isn't shipped 2x/s, then fetches the full
    payload once on completion.

    When ``limit`` is provided, only the row window ``[offset:offset+limit]``
    is shipped (plus ``has_more`` / ``total_rows``) so the grid can show the
    first page immediately and lazily "Load more" as the user scrolls -
    DBeaver-style - without transferring the whole result at once.
    """
    ex = query_manager.get_execution(session_id, exec_id)
    if not ex:
        raise HTTPException(404, "Execution not found")
    if lightweight:
        # Return summary_dict (no row data) + status - small + cheap to serialize
        d = ex.summary_dict()
        d["affected_rows"] = ex.affected_rows
        return d
    return ex.to_dict(offset=offset, limit=limit)


@router.get("/sessions/{session_id}/executions/{exec_id}/rows")
def get_execution_rows(
    session_id: str,
    exec_id: str,
    offset: int = 0,
    limit: int = 200,
    set_index: int = 0,
) -> dict:
    """Return just a row window for one result set - for lazy scroll.

    Rows are sliced from the already-fetched in-memory result, so this is
    cheap and never re-hits the database."""
    ex = query_manager.get_execution(session_id, exec_id)
    if not ex:
        raise HTTPException(404, "Execution not found")
    return ex.rows_window(set_index=set_index, offset=offset, limit=max(1, limit))


@router.post("/sessions/{session_id}/executions/{exec_id}/cancel")
def cancel_execution(session_id: str, exec_id: str) -> dict:
    if not query_manager.cancel_execution(session_id, exec_id):
        raise HTTPException(400, "Cannot cancel (not running or not found)")
    ex = query_manager.get_execution(session_id, exec_id)
    return ex.to_dict() if ex else {"status": "cancelled"}


@router.delete("/sessions/{session_id}/executions/{exec_id}")
def clear_execution(session_id: str, exec_id: str) -> Response:
    """Remove an execution and free its result memory."""
    if not query_manager.clear_execution(session_id, exec_id):
        raise HTTPException(404, "Execution not found")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Global query tracker
# ---------------------------------------------------------------------------

@router.get("/queries/running")
def running_queries() -> list[dict]:
    """All currently running/queued queries across all sessions."""
    return query_manager.running_queries()


@router.get("/queries/recent")
def recent_queries(limit: int = Query(default=100, ge=1, le=500)) -> list[dict]:
    """Recent queries across all sessions (sorted newest first)."""
    return query_manager.all_queries(limit)


# ---------------------------------------------------------------------------
# DDL / INSERT / EXEC generation
# ---------------------------------------------------------------------------

def _load_record(conn_id: int) -> ConnectionRecord:
    db_session = get_db_session()
    try:
        rec = db_session.get(ConnectionRecord, conn_id)
        if not rec:
            raise HTTPException(404, f"Connection {conn_id} not found")
        return rec
    finally:
        db_session.close()


@router.post("/generate/ddl")
def gen_ddl(req: DDLRequest) -> dict:
    record = _load_record(req.connection_id)
    connector = get_connector(record, purpose="sql_ide")
    try:
        ddl = generate_ddl(connector, req.database, req.schema_name, req.table)
        return {"sql": ddl, "type": "ddl"}
    except Exception as exc:
        return {"sql": None, "type": "ddl", "error": str(exc)[:1000]}


@router.post("/generate/insert")
def gen_insert(req: InsertGenRequest) -> dict:
    record = _load_record(req.connection_id)
    connector = get_connector(record, purpose="sql_ide")
    try:
        sql = generate_insert(connector, req.database, req.schema_name, req.table, req.limit)
        return {"sql": sql, "type": "insert"}
    except Exception as exc:
        return {"sql": None, "type": "insert", "error": str(exc)[:1000]}


@router.post("/generate/exec-proc")
def gen_exec_proc(req: ExecProcRequest) -> dict:
    try:
        sql = generate_exec_proc(
            req.db_type, req.database, req.schema_name, req.proc_name, req.params
        )
        return {"sql": sql, "type": "exec_proc"}
    except Exception as exc:
        return {"sql": None, "type": "exec_proc", "error": str(exc)[:1000]}


# ---------------------------------------------------------------------------
# Visual Diff Excel export (phase 4.35)
# ---------------------------------------------------------------------------

class DiffCell(BaseModel):
    """One cell pair (left value, right value, whether they match).

    Values are passed as their string-rendered form because the frontend
    has already converted them via String(value) when computing the
    diff. Preserving original types isn't needed for the Excel export -
    the goal is to faithfully reproduce what the user saw on screen.
    """
    left: str | None = None
    right: str | None = None
    match: bool


class DiffRow(BaseModel):
    """Paired source/target row at one row position."""
    row_idx: int
    has_diff: bool
    cells: list[DiffCell]


class DiffExportRequest(BaseModel):
    """Payload from the frontend - exact replica of the visual diff state."""
    left_label: str = "Left"
    right_label: str = "Right"
    columns: list[str]
    rows: list[DiffRow]
    total_diffs: int = 0
    left_row_count: int = 0
    right_row_count: int = 0
    only_in_left: int = 0
    only_in_right: int = 0
    show_only_diffs: bool = False
    # Optional: original script names + result labels, for the Summary sheet
    left_source: str = ""
    right_source: str = ""
    # Enhanced fields (phase 5)
    left_sql: str = ""
    right_sql: str = ""
    all_columns: list[str] = []          # full column list before hiding
    hidden_columns: list[str] = []       # columns the user excluded
    compare_limit: int = -1              # -1 = all rows compared
    rows_compared: int = 0
    total_available: int = 0
    identical_rows: int = 0
    diff_rows: int = 0
    total_cells: int = 0
    match_pct: float = 100.0
    left_elapsed_ms: int = 0
    right_elapsed_ms: int = 0


@router.post("/diff/export-excel")
def export_diff_excel(req: DiffExportRequest, save_to_disk: bool = False) -> Response:
    """Build an Excel workbook that exactly mirrors the on-screen Visual
    Diff: paired L/R rows with red highlighting on left mismatches and
    green on right mismatches.

    Two sheets:
      * Summary    - total diff count, row counts, source labels
      * Visual Diff - the paired-row table with cell highlighting

    When ``save_to_disk`` is true (desktop auto-save mode) the workbook is
    written into the user-configured exports folder and a JSON ``{saved_path}``
    is returned instead of a download stream. Otherwise a binary .xlsx download
    response is returned.
    """
    import io
    import xlsxwriter  # type: ignore
    from datetime import datetime
    from fastapi.responses import StreamingResponse

    def _escape_control(value):
        """Make non-printable control chars visible in Excel cells.
        Mirrors the frontend `escapeControlCharsPlain` helper so the
        exported workbook is consistent with what's on screen - NUL
        bytes become ``[NUL]``, TAB → ``[TAB]``, etc. xlsxwriter
        writes raw NUL bytes as garbage / strips them, so escaping is
        also needed to PRESERVE the data, not just to make it visible.
        """
        if value is None:
            return None
        if not isinstance(value, str):
            value = str(value)
        # Fast path: no control chars
        if not any(ord(c) < 0x20 or ord(c) == 0x7F for c in value):
            return value
        labels = {
            0x00: "[NUL]", 0x07: "[BEL]", 0x08: "[BS]",  0x09: "[TAB]",
            0x0A: "[LF]",  0x0B: "[VT]",  0x0C: "[FF]",  0x0D: "[CR]",
            0x1B: "[ESC]", 0x7F: "[DEL]",
        }
        out = []
        for c in value:
            code = ord(c)
            if code in labels:
                out.append(labels[code])
            elif code < 0x20:
                out.append(f"[\\x{code:02X}]")
            else:
                out.append(c)
        return "".join(out)

    buf = io.BytesIO()
    wb = xlsxwriter.Workbook(buf, {
        "in_memory": True,
        "constant_memory": False,
        "nan_inf_to_errors": True,
        # Database values are data, never formulas or links: a cell value
        # such as "=HYPERLINK(...)" must stay inert text in the workbook.
        "strings_to_formulas": False,
        "strings_to_urls": False,
    })

    # ---- Format palette ----
    # We deliberately match the on-screen colors: pale-red background for L
    # mismatch cells (#FECACA via bg_color), pale-green for R mismatch
    # cells (#BBF7D0). These hex codes are the Tailwind red-200 / green-200
    # equivalents used in the UI. Keeping them in sync gives the user a
    # "same screen, exported" experience instead of an arbitrary palette.
    fmt_header = wb.add_format({
        "bold": True, "bg_color": "#E5E7EB", "border": 1,
        "align": "left", "valign": "vcenter", "font_size": 10,
    })
    fmt_row_idx = wb.add_format({
        "bold": True, "bg_color": "#F3F4F6", "border": 1,
        "align": "center", "valign": "vcenter", "font_size": 9,
        "font_color": "#6B7280",
    })
    fmt_lr_label_left = wb.add_format({
        "bold": True, "bg_color": "#F3F4F6", "border": 1,
        "align": "center", "valign": "vcenter", "font_size": 9,
        "font_color": "#DC2626",  # red-600
    })
    fmt_lr_label_right = wb.add_format({
        "bold": True, "bg_color": "#F3F4F6", "border": 1,
        "align": "center", "valign": "vcenter", "font_size": 9,
        "font_color": "#16A34A",  # green-600
    })
    fmt_cell_match = wb.add_format({
        "border": 1, "align": "left", "valign": "vcenter",
        "font_size": 10, "font_name": "Consolas",
    })
    fmt_cell_left_diff = wb.add_format({
        "border": 1, "align": "left", "valign": "vcenter",
        "font_size": 10, "font_name": "Consolas",
        "bg_color": "#FECACA", "font_color": "#991B1B", "bold": True,  # red-200 + red-900
    })
    fmt_cell_right_diff = wb.add_format({
        "border": 1, "align": "left", "valign": "vcenter",
        "font_size": 10, "font_name": "Consolas",
        "bg_color": "#BBF7D0", "font_color": "#166534", "bold": True,  # green-200 + green-900
    })
    fmt_null = wb.add_format({
        "border": 1, "italic": True, "font_color": "#9CA3AF",
        "font_size": 10, "font_name": "Consolas", "align": "left",
    })
    fmt_summary_label = wb.add_format({
        "bold": True, "bg_color": "#F3F4F6", "border": 1, "align": "left", "valign": "vcenter",
    })
    fmt_summary_value = wb.add_format({
        "border": 1, "align": "left", "valign": "vcenter",
    })

    fmt_section = wb.add_format({
        "bold": True, "bg_color": "#DBEAFE", "border": 1,
        "align": "left", "valign": "vcenter", "font_size": 11,
    })
    fmt_sql = wb.add_format({
        "border": 1, "align": "left", "valign": "top",
        "font_name": "Consolas", "font_size": 9, "text_wrap": True,
    })
    fmt_verdict_match = wb.add_format({
        "bold": True, "bg_color": "#BBF7D0", "border": 1,
        "align": "center", "valign": "vcenter", "font_size": 14,
        "font_color": "#166534",
    })
    fmt_verdict_diff = wb.add_format({
        "bold": True, "bg_color": "#FECACA", "border": 1,
        "align": "center", "valign": "vcenter", "font_size": 14,
        "font_color": "#991B1B",
    })

    # ---- Sheet 1: Summary ----
    s = wb.add_worksheet("Summary")
    s.set_column(0, 0, 30)
    s.set_column(1, 1, 80)

    verdict = "MATCH" if req.total_diffs == 0 and req.only_in_left == 0 and req.only_in_right == 0 else "MISMATCH"
    compare_limit_str = "All rows" if req.compare_limit < 0 else f"First {req.compare_limit} rows"
    left_time = f"{req.left_elapsed_ms / 1000:.2f}s" if req.left_elapsed_ms else "N/A"
    right_time = f"{req.right_elapsed_ms / 1000:.2f}s" if req.right_elapsed_ms else "N/A"
    hidden_str = ", ".join(req.hidden_columns) if req.hidden_columns else "None"
    compared_cols = ", ".join(req.columns) if req.columns else "N/A"

    r = 0
    # Title + verdict
    s.merge_range(r, 0, r, 1, "Visual Diff Export Report", fmt_section)
    r += 1
    s.write(r, 0, "Generated at", fmt_summary_label)
    s.write(r, 1, datetime.now().strftime("%Y-%m-%d %H:%M:%S"), fmt_summary_value)
    r += 1
    s.write(r, 0, "Verdict", fmt_summary_label)
    s.write(r, 1, verdict, fmt_verdict_match if verdict == "MATCH" else fmt_verdict_diff)
    r += 2

    # ---- Sources ----
    s.merge_range(r, 0, r, 1, "Source Details", fmt_section)
    r += 1
    for lbl, val in [
        ("Left result", f"{req.left_label}  ({req.left_source})" if req.left_source else req.left_label),
        ("Right result", f"{req.right_label}  ({req.right_source})" if req.right_source else req.right_label),
        ("Left execution time", left_time),
        ("Right execution time", right_time),
    ]:
        s.write(r, 0, lbl, fmt_summary_label)
        s.write(r, 1, val, fmt_summary_value)
        r += 1
    r += 1

    # ---- SQL Queries ----
    s.merge_range(r, 0, r, 1, "SQL Queries", fmt_section)
    r += 1
    s.write(r, 0, "Left query", fmt_summary_label)
    left_sql = req.left_sql.strip() or "(not available)"
    sql_lines = max(left_sql.count("\n") + 1, 2)
    s.set_row(r, min(sql_lines * 13, 200))
    s.write(r, 1, left_sql, fmt_sql)
    r += 1
    s.write(r, 0, "Right query", fmt_summary_label)
    right_sql = req.right_sql.strip() or "(not available)"
    sql_lines2 = max(right_sql.count("\n") + 1, 2)
    s.set_row(r, min(sql_lines2 * 13, 200))
    s.write(r, 1, right_sql, fmt_sql)
    r += 2

    # ---- Row Statistics ----
    s.merge_range(r, 0, r, 1, "Row Statistics", fmt_section)
    r += 1
    for lbl, val in [
        ("Left row count", req.left_row_count),
        ("Right row count", req.right_row_count),
        ("Compare limit", compare_limit_str),
        ("Rows compared", req.rows_compared),
        ("Total available rows", req.total_available),
        ("Identical rows", req.identical_rows),
        ("Rows with differences", req.diff_rows),
        ("Rows only in left", req.only_in_left),
        ("Rows only in right", req.only_in_right),
    ]:
        s.write(r, 0, lbl, fmt_summary_label)
        s.write(r, 1, val, fmt_summary_value)
        r += 1
    r += 1

    # ---- Cell Statistics ----
    s.merge_range(r, 0, r, 1, "Cell Statistics", fmt_section)
    r += 1
    for lbl, val in [
        ("Total cells compared", req.total_cells),
        ("Cell differences", req.total_diffs),
        ("Cell match %", f"{req.match_pct:.2f}%"),
    ]:
        s.write(r, 0, lbl, fmt_summary_label)
        s.write(r, 1, val, fmt_summary_value)
        r += 1
    r += 1

    # ---- Column Details ----
    s.merge_range(r, 0, r, 1, "Column Details", fmt_section)
    r += 1
    for lbl, val in [
        ("Columns in result", len(req.all_columns) if req.all_columns else len(req.columns)),
        ("Columns compared", len(req.columns)),
        ("Columns excluded", len(req.hidden_columns)),
        ("Excluded column list", hidden_str),
        ("Compared column list", compared_cols),
    ]:
        s.write(r, 0, lbl, fmt_summary_label)
        s.write(r, 1, val, fmt_summary_value)
        r += 1
    r += 1

    # ---- Export Settings ----
    s.merge_range(r, 0, r, 1, "Export Settings", fmt_section)
    r += 1
    for lbl, val in [
        ("Diff rows in export", len(req.rows)),
        ("Filter applied", "Show only diff rows" if req.show_only_diffs else "All rows"),
    ]:
        s.write(r, 0, lbl, fmt_summary_label)
        s.write(r, 1, val, fmt_summary_value)
        r += 1

    # ---- Sheet 2: Column Breakdown ----
    cs = wb.add_worksheet("Column Breakdown")
    cs.set_column(0, 0, 6)
    cs.set_column(1, 1, 40)
    cs.set_column(2, 2, 12)
    cs.set_column(3, 3, 14)
    cs.set_column(4, 4, 12)
    cs.write(0, 0, "#", fmt_header)
    cs.write(0, 1, "Column Name", fmt_header)
    cs.write(0, 2, "Status", fmt_header)
    cs.write(0, 3, "Cell Diffs", fmt_header)
    cs.write(0, 4, "Match %", fmt_header)
    hidden_set = set(req.hidden_columns)
    # Per-column diff counts from the row data
    col_diff_counts: dict[str, int] = {c: 0 for c in req.columns}
    for row in req.rows:
        for ci, cell in enumerate(row.cells):
            if ci < len(req.columns) and not cell.match:
                col_diff_counts[req.columns[ci]] = col_diff_counts.get(req.columns[ci], 0) + 1
    row_total = len(req.rows) if req.rows else 1
    ci_row = 1
    for idx, col_name in enumerate(req.all_columns or req.columns):
        cs.write(ci_row, 0, idx + 1, fmt_summary_value)
        cs.write(ci_row, 1, col_name, fmt_summary_value)
        if col_name in hidden_set:
            cs.write(ci_row, 2, "Excluded", wb.add_format({"border": 1, "font_color": "#9CA3AF", "italic": True}))
            cs.write(ci_row, 3, "-", fmt_summary_value)
            cs.write(ci_row, 4, "-", fmt_summary_value)
        else:
            diffs = col_diff_counts.get(col_name, 0)
            pct = ((row_total - diffs) / row_total * 100) if row_total > 0 else 100
            cs.write(ci_row, 2, "Compared", wb.add_format({"border": 1, "font_color": "#166534", "bold": True}))
            cs.write(ci_row, 3, diffs, fmt_cell_left_diff if diffs > 0 else fmt_cell_match)
            cs.write(ci_row, 4, f"{pct:.1f}%", fmt_summary_value)
        ci_row += 1

    # ---- Sheet 2: Visual Diff ----
    d = wb.add_worksheet("Visual Diff")
    d.freeze_panes(1, 2)  # freeze header row + #/LR columns
    d.set_column(0, 0, 5)   # # column
    d.set_column(1, 1, 4)   # L/R column
    d.set_column(2, 2 + len(req.columns) - 1, 18)  # data columns

    # Header
    d.write(0, 0, "#", fmt_header)
    d.write(0, 1, "L/R", fmt_header)
    for ci, col in enumerate(req.columns):
        d.write(0, 2 + ci, col, fmt_header)

    # Data - two physical rows per logical diff row (L then R), with
    # the # column merged across both. Cell formatting mirrors the
    # frontend: red bg on L mismatches, green bg on R mismatches.
    excel_row = 1  # start after header
    for row in req.rows:
        # Merge the # column across the L+R pair
        d.merge_range(
            excel_row, 0, excel_row + 1, 0,
            row.row_idx + 1, fmt_row_idx,
        )

        # Left row
        d.write(excel_row, 1, "L", fmt_lr_label_left)
        for ci, cell in enumerate(row.cells):
            value = _escape_control(cell.left)
            if value is None:
                d.write(excel_row, 2 + ci, "NULL", fmt_null)
            else:
                fmt = fmt_cell_left_diff if not cell.match else fmt_cell_match
                d.write(excel_row, 2 + ci, value, fmt)

        # Right row
        d.write(excel_row + 1, 1, "R", fmt_lr_label_right)
        for ci, cell in enumerate(row.cells):
            value = _escape_control(cell.right)
            if value is None:
                d.write(excel_row + 1, 2 + ci, "NULL", fmt_null)
            else:
                fmt = fmt_cell_right_diff if not cell.match else fmt_cell_match
                d.write(excel_row + 1, 2 + ci, value, fmt)

        excel_row += 2

    wb.close()
    buf.seek(0)

    # Build a filename hint. Strip characters that would break Content-Disposition.
    safe_left = "".join(c for c in req.left_label if c.isalnum() or c in "._-")[:40] or "left"
    safe_right = "".join(c for c in req.right_label if c.isalnum() or c in "._-")[:40] or "right"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"visual_diff_{safe_left}_vs_{safe_right}_{ts}.xlsx"

    if save_to_disk:
        # Desktop auto-save mode: write straight into the configured exports
        # folder and hand back the path so the UI can show a toast.
        from fastapi.responses import JSONResponse
        from app.services.app_settings import get_exports_dir
        out_path = get_exports_dir() / filename
        out_path.write_bytes(buf.getvalue())
        return JSONResponse({"saved_path": str(out_path), "filename": filename})

    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
