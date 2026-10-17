"""Query session manager for the SQL IDE.

Manages parallel query execution across multiple script tabs. Each "session"
corresponds to a script tab in the frontend. Queries run in background threads
so the user can switch tabs and fire new queries without waiting.

Key design:
- Each session has an ID (UUID), a connection_id, and a history of executions.
- Executions run in a ThreadPoolExecutor so multiple sessions execute in parallel.
- Each execution tracks status (running/done/error/cancelled), elapsed time,
  row results, column names, and error info.
- Results are kept in memory until explicitly cleared or the session is closed.
- A global registry lets the frontend poll running queries across all sessions.
"""
from __future__ import annotations

import decimal
import json
import math
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, Future
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any

from app.util_time import now_iso


class ExecStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCESS = "success"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class Execution:
    exec_id: str
    session_id: str
    connection_id: int
    sql: str
    status: ExecStatus = ExecStatus.QUEUED
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    affected_rows: int | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    elapsed_ms: int = 0
    # Multiple result sets (for stored procs that return >1 result)
    result_sets: list[dict] = field(default_factory=list)
    # Snowflake-only: { role, warehouse, database, schema_name } — each
    # field, if set, becomes a `USE <kind> "name"` statement prepended
    # to the user's SQL.
    snowflake_context: dict | None = None
    # Pre-split statements from the client (the IDE splits with the same
    # rules as app.services.sql_split and keeps their editor offsets so errors
    # and results map back to the right statement). None = split ``sql`` here.
    statements: list[str] | None = None
    # Number of statements to run (known once the script is split).
    statement_total: int | None = None
    # True = every statement is committed as it runs (DBeaver "Auto-commit").
    # False = manual transaction mode; the client commits / rolls back.
    autocommit: bool = True
    stop_on_error: bool = True
    # Per-statement execution log for the IDE "Messages" tab.
    messages: list[dict] = field(default_factory=list)
    error_statement_index: int | None = None
    _cancel_flag: bool = field(default=False, repr=False)
    _slot_released: bool = field(default=False, repr=False)
    # Driver cursor / connection of the running statement, for a soft cancel.
    _cursor: Any = field(default=None, repr=False)
    _driver_conn: Any = field(default=None, repr=False)

    def to_dict(self, offset: int = 0, limit: int | None = None) -> dict:
        """Serialize the execution.

        When ``limit`` is provided, the row arrays (top-level ``rows`` and
        each result set's ``rows``) are sliced to the window
        ``[offset:offset+limit]`` and a ``has_more`` flag plus ``total_rows``
        are added so the frontend can lazily "Load more" on scroll without
        ever shipping the entire result in one payload. ``row_count`` /
        per-set ``row_count`` always remain the FULL fetched counts.
        """
        if limit is None:
            return {
                "exec_id": self.exec_id,
                "session_id": self.session_id,
                "connection_id": self.connection_id,
                "sql": self.sql[:2000],
                "status": self.status.value,
                "columns": self.columns,
                "rows": self.rows,
                "row_count": self.row_count,
                "total_rows": len(self.rows),
                "window_offset": 0,
                "has_more": False,
                "affected_rows": self.affected_rows,
                "error": self.error,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                "elapsed_ms": self.elapsed_ms,
                "result_sets": self.result_sets,
                "messages": self.messages,
                "error_statement_index": self.error_statement_index,
                "autocommit": self.autocommit,
            }

        off = max(0, offset)
        rows_win = self.rows[off:off + limit]
        rsets_win = []
        for rs in self.result_sets:
            full = rs.get("rows", [])
            sl = full[off:off + limit]
            rsets_win.append({
                **rs,
                "rows": sl,
                "window_offset": off,
                "total_rows": len(full),
                "has_more": (off + len(sl)) < len(full),
            })
        return {
            "exec_id": self.exec_id,
            "session_id": self.session_id,
            "connection_id": self.connection_id,
            "sql": self.sql[:2000],
            "status": self.status.value,
            "columns": self.columns,
            "rows": rows_win,
            "row_count": self.row_count,
            "total_rows": len(self.rows),
            "window_offset": off,
            "has_more": (off + len(rows_win)) < len(self.rows),
            "affected_rows": self.affected_rows,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_ms": self.elapsed_ms,
            "result_sets": rsets_win,
            "messages": self.messages,
            "error_statement_index": self.error_statement_index,
            "autocommit": self.autocommit,
        }

    def rows_window(self, set_index: int, offset: int, limit: int) -> dict:
        """Return just a row window for one result set — for lazy scroll."""
        off = max(0, offset)
        if 0 <= set_index < len(self.result_sets):
            full = self.result_sets[set_index].get("rows", [])
        else:
            full = self.rows
        sl = full[off:off + limit]
        return {
            "set_index": set_index,
            "rows": sl,
            "window_offset": off,
            "total_rows": len(full),
            "has_more": (off + len(sl)) < len(full),
        }

    def summary_dict(self) -> dict:
        """Lightweight dict for the query tracker (no row data)."""
        return {
            "exec_id": self.exec_id,
            "session_id": self.session_id,
            "connection_id": self.connection_id,
            "sql": self.sql[:500],
            "status": self.status.value,
            "row_count": self.row_count,
            "error": self.error[:500] if self.error else None,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_ms": self.elapsed_ms,
            "statement_count": len(self.messages),
            "statement_total": self.statement_total,
        }


@dataclass
class Session:
    session_id: str
    connection_id: int
    name: str = "Untitled"
    created_at: str = ""
    executions: dict[str, Execution] = field(default_factory=dict)
    # Ordered list of exec_ids (most recent last)
    exec_order: list[str] = field(default_factory=list)
    # monotonic() of the last request touching this session (idle reaper)
    last_activity: float = field(default_factory=time.monotonic)
    # (id(driver connection), autocommit) last applied, so the driver call is
    # only repeated when the mode or the underlying connection changes.
    autocommit_state: tuple[int, bool] | None = None
    # True once a statement ran in manual-commit mode and neither COMMIT nor
    # ROLLBACK has been issued since — switching back to auto-commit is then
    # refused instead of silently discarding or committing that work.
    manual_dirty: bool = False

    def to_dict(self, include_results: bool = False) -> dict:
        d: dict = {
            "session_id": self.session_id,
            "connection_id": self.connection_id,
            "name": self.name,
            "created_at": self.created_at,
            "execution_count": len(self.executions),
            "running": any(
                e.status in (ExecStatus.QUEUED, ExecStatus.RUNNING)
                for e in self.executions.values()
            ),
            "transaction_pending": self.manual_dirty,
        }
        if include_results:
            d["executions"] = [
                self.executions[eid].to_dict() for eid in self.exec_order
                if eid in self.executions
            ]
        else:
            d["executions"] = [
                self.executions[eid].summary_dict() for eid in self.exec_order
                if eid in self.executions
            ]
        return d


# How many rows the SQL IDE fetches into server memory per query. The grid
# only ships ~200 at a time to the browser (windowed) and lazily loads more
# on scroll, so this larger cap just controls how far you can scroll before
# hitting the "truncated" ceiling — it does NOT bloat the initial payload.
MAX_ROWS_DEFAULT = 200_000
MAX_ROWS_LIMIT = 1_000_000
MAX_RESULT_SETS = 20
MAX_CONCURRENT_PER_CONNECTION = 3
MAX_STATEMENTS_PER_EXECUTION = 1000
# Sessions untouched for this long (and with nothing running) are closed, which
# also closes their dedicated DB connection. The IDE recreates a session
# transparently on its next run, so an expiry only drops old results.
SESSION_IDLE_TTL_SECONDS = 8 * 60 * 60
REAPER_INTERVAL_SECONDS = 300


def _split_sql_statements(sql: str, db_type: str | None = None) -> list[str]:
    """Split a script into statements (see app.services.sql_split for the rules)."""
    from app.services.sql_split import split_sql_statements
    return split_sql_statements(sql, db_type)


def _sql_ide_purpose(session_id: str) -> str:
    return f"sql_ide:{session_id}"


class QuerySessionManager:
    """Thread-safe manager for all SQL IDE sessions.

    Concurrency model
    -----------------
    * **Global**: up to ``max_workers`` queries run in parallel across all
      sessions (ThreadPoolExecutor).
    * **Per-connection**: up to ``MAX_CONCURRENT_PER_CONNECTION`` queries may
      be admitted (queued or running) against the same ``connection_id`` at a
      time. Additional submissions are rejected rather than queued silently.

    Design: single-user
    -------------------
    There is no authentication or tenant isolation. The session store and
    connection cache are shared across the single process. This is
    intentional — the tool runs locally on the developer's machine.
    """

    def __init__(self, max_workers: int = 8):
        self._lock = threading.Lock()
        self._sessions: dict[str, Session] = {}
        self._futures: dict[str, Future] = {}
        self._running_per_conn: dict[int, int] = {}
        self._shutdown = False
        self._reaper: threading.Thread | None = None
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="sql-ide"
        )

    # ---- session CRUD ----

    def create_session(self, connection_id: int, name: str = "Untitled") -> Session:
        sid = uuid.uuid4().hex[:12]
        s = Session(
            session_id=sid,
            connection_id=connection_id,
            name=name,
            created_at=now_iso(),
        )
        with self._lock:
            self._sessions[sid] = s
        return s

    def get_session(self, session_id: str) -> Session | None:
        with self._lock:
            s = self._sessions.get(session_id)
            if s is not None:
                s.last_activity = time.monotonic()
            return s

    def list_sessions(self) -> list[dict]:
        with self._lock:
            return [s.to_dict() for s in self._sessions.values()]

    def delete_session(self, session_id: str) -> bool:
        with self._lock:
            s = self._sessions.pop(session_id, None)
            if s is None:
                return False
            for eid in s.exec_order:
                self._cancel_exec_locked(eid, s)
            connection_ids = {s.connection_id}
            connection_ids.update(ex.connection_id for ex in s.executions.values())

        from app.connectors.factory import evict_connector
        for connection_id in connection_ids:
            try:
                evict_connector(
                    connection_id,
                    purpose=_sql_ide_purpose(session_id),
                    force=True,
                )
            except Exception:
                pass
        return True

    def rename_session(self, session_id: str, name: str) -> bool:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return False
            s.name = name
            return True

    def change_connection(self, session_id: str, connection_id: int) -> bool:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return False
            if s.connection_id == connection_id:
                return True
            connector_keys = {
                (s.connection_id, _sql_ide_purpose(session_id)),
                (connection_id, _sql_ide_purpose(session_id)),
            }
            for ex in s.executions.values():
                connector_keys.add((ex.connection_id, _sql_ide_purpose(session_id)))
                self._cancel_exec_locked(ex.exec_id, s)
            s.connection_id = connection_id

        from app.connectors.factory import evict_connector
        for record_id, purpose in connector_keys:
            try:
                evict_connector(record_id, purpose=purpose, force=True)
            except Exception:
                pass
        return True

    def _release_connection_slot_locked(self, ex: Execution) -> None:
        if ex._slot_released:
            return
        ex._slot_released = True
        count = self._running_per_conn.get(ex.connection_id, 1)
        if count <= 1:
            self._running_per_conn.pop(ex.connection_id, None)
        else:
            self._running_per_conn[ex.connection_id] = count - 1

    def _cancel_exec_locked(
        self, exec_id: str, session: Session,
    ) -> tuple[bool, tuple[int, str] | None]:
        ex = session.executions.get(exec_id)
        if not ex or ex.status in (ExecStatus.SUCCESS, ExecStatus.ERROR, ExecStatus.CANCELLED):
            return False, None

        was_running = ex.status == ExecStatus.RUNNING
        ex._cancel_flag = True
        future = self._futures.get(exec_id)
        if future is not None:
            if future.cancel():
                self._futures.pop(exec_id, None)
                self._release_connection_slot_locked(ex)
                was_running = False
            else:
                was_running = True

        ex.status = ExecStatus.CANCELLED
        ex.finished_at = now_iso()
        connector_key = (
            (ex.connection_id, _sql_ide_purpose(ex.session_id))
            if was_running else None
        )
        return True, connector_key

    # ---- execution ----

    def execute(
        self,
        session_id: str,
        sql: str,
        connection_id: int | None = None,
        max_rows: int = MAX_ROWS_DEFAULT,
        snowflake_context: dict | None = None,
        statements: list[str] | None = None,
        autocommit: bool = True,
        stop_on_error: bool = True,
    ) -> Execution | None:
        """Submit a query for background execution. Returns the Execution immediately.

        Raises ``RuntimeError`` if the per-connection concurrency limit is reached.
        """
        eid = uuid.uuid4().hex[:12]
        self._ensure_reaper()
        with self._lock:
            if self._shutdown:
                raise RuntimeError("Query session manager is shutting down")
            s = self._sessions.get(session_id)
            if not s:
                return None
            s.last_activity = time.monotonic()
            conn_id = connection_id if connection_id is not None else s.connection_id
            admitted = self._running_per_conn.get(conn_id, 0)
            if admitted >= MAX_CONCURRENT_PER_CONNECTION:
                raise RuntimeError(
                    f"Connection {conn_id} already has {admitted} running queries "
                    f"(max {MAX_CONCURRENT_PER_CONNECTION}). Wait for one to finish or cancel it."
                )

            bounded_max_rows = max(1, min(int(max_rows), MAX_ROWS_LIMIT))
            ex = Execution(
                exec_id=eid,
                session_id=session_id,
                connection_id=conn_id,
                sql=sql,
                snowflake_context=snowflake_context,
                statements=[st for st in (statements or []) if st and st.strip()] or None,
                autocommit=bool(autocommit),
                stop_on_error=bool(stop_on_error),
            )
            s.executions[eid] = ex
            s.exec_order.append(eid)
            self._running_per_conn[conn_id] = admitted + 1
            try:
                self._futures[eid] = self._pool.submit(
                    self._run_query, ex, bounded_max_rows
                )
            except Exception:
                s.executions.pop(eid, None)
                try:
                    s.exec_order.remove(eid)
                except ValueError:
                    pass
                self._release_connection_slot_locked(ex)
                raise
        return ex

    @staticmethod
    def _context_statements(db_type: str, ctx: dict | None) -> list[str]:
        """USE / SET statements that establish the tab's database/schema context."""
        if not ctx:
            return []
        use_stmts: list[str] = []
        db_type = (db_type or "").lower()
        if db_type == "snowflake":
            def _q(v: str) -> str:
                return '"' + str(v).replace('"', '""') + '"'
            if ctx.get("role"):
                use_stmts.append(f"USE ROLE {_q(ctx['role'])}")
            if ctx.get("warehouse"):
                use_stmts.append(f"USE WAREHOUSE {_q(ctx['warehouse'])}")
            if ctx.get("database"):
                use_stmts.append(f"USE DATABASE {_q(ctx['database'])}")
            if ctx.get("schema_name"):
                use_stmts.append(f"USE SCHEMA {_q(ctx['schema_name'])}")
        elif db_type == "sqlserver":
            if ctx.get("database"):
                db_name = str(ctx["database"]).replace("]", "]]")
                use_stmts.append(f"USE [{db_name}]")
        elif db_type == "oracle":
            if ctx.get("schema_name"):
                schema = str(ctx["schema_name"]).replace('"', '""')
                use_stmts.append(f'ALTER SESSION SET CURRENT_SCHEMA = "{schema}"')
        elif db_type in ("postgres", "postgresql"):
            if ctx.get("schema_name"):
                schema = str(ctx["schema_name"]).replace('"', '""')
                # Quoted identifier keeps mixed-case schemas; public stays
                # reachable for extensions and unqualified functions.
                use_stmts.append(f'SET search_path TO "{schema}", public')
        elif db_type == "mysql":
            if ctx.get("database"):
                db_name = str(ctx["database"]).replace("`", "``")
                use_stmts.append(f"USE `{db_name}`")
        return use_stmts

    def _apply_autocommit(self, ex: Execution, conn: Any) -> None:
        """Put the driver connection in the requested commit mode (once per change)."""
        with self._lock:
            s = self._sessions.get(ex.session_id)
            state = s.autocommit_state if s else None
            dirty = bool(s and s.manual_dirty)
        key = (id(conn), ex.autocommit)
        if state == key:
            return
        if ex.autocommit:
            if dirty:
                raise RuntimeError(
                    "This tab has uncommitted changes from manual-commit mode. "
                    "Commit or roll back before switching back to auto-commit."
                )
            # Connection validation / heartbeat pings may have opened an
            # implicit transaction while in manual mode; nothing of the user's
            # is pending (manual_dirty is False), so end it before switching.
            try:
                conn.rollback()
            except Exception:
                pass
        attr = getattr(conn, "autocommit", None)
        try:
            if callable(attr):          # snowflake-connector, PyMySQL
                attr(ex.autocommit)
            else:                       # psycopg, pyodbc, oracledb
                conn.autocommit = ex.autocommit
        except Exception as exc:
            raise RuntimeError(
                f"Could not switch auto-commit {'on' if ex.autocommit else 'off'}: {exc}. "
                "Commit or roll back the open transaction first."
            ) from exc
        with self._lock:
            if s is not None:
                s.autocommit_state = key

    def _collect_result_sets(
        self, ex: Execution, cur: Any, max_rows: int, stmt_index: int, title: str,
        first_index: int,
    ) -> list[dict] | None:
        """Drain every result set the current statement produced. None = cancelled."""
        sets: list[dict] = []
        guard = 0
        while True:
            if ex._cancel_flag:
                return None
            if cur.description:
                cols = [desc[0] for desc in cur.description]
                # Drain in bounded batches up to max_rows. A single
                # fetchmany(max_rows) under-reads on drivers that return
                # only their first internal buffer per call.
                rows_raw: list = []
                while len(rows_raw) < max_rows:
                    if ex._cancel_flag:
                        return None
                    want = min(50_000, max_rows - len(rows_raw))
                    batch = cur.fetchmany(want)
                    if not batch:
                        break
                    rows_raw.extend(batch)
                rows = [[_safe_val(v) for v in r] for r in rows_raw]
                sets.append({
                    "index": first_index + len(sets),
                    "columns": cols,
                    "rows": rows,
                    "row_count": len(rows),
                    "truncated": len(rows_raw) >= max_rows,
                    "statement_index": stmt_index,
                    "title": title,
                })
            guard += 1
            if guard > MAX_RESULT_SETS:
                break
            try:
                if not cur.nextset():
                    break
            except Exception:
                break
        return sets

    def _run_query(self, ex: Execution, max_rows: int) -> None:
        """Worker function executed in the thread pool."""
        t0 = time.perf_counter()
        conn = None
        try:
            from app.connectors.factory import get_connector
            from app.db.store import Connection as ConnectionRecord, get_session as get_db_session

            with self._lock:
                if ex._cancel_flag:
                    ex.status = ExecStatus.CANCELLED
                    return
                ex.status = ExecStatus.RUNNING
                ex.started_at = now_iso()

            raw_sql = ex.sql.strip()
            if not raw_sql and not ex.statements:
                ex.status = ExecStatus.ERROR
                ex.error = "No SQL to execute"
                return

            db_session = get_db_session()
            try:
                record = db_session.get(ConnectionRecord, ex.connection_id)
                if not record:
                    raise ValueError(f"Connection {ex.connection_id} not found")
            finally:
                db_session.close()

            statements = ex.statements or _split_sql_statements(raw_sql, record.db_type)
            ex.statement_total = len(statements)
            if not statements:
                ex.status = ExecStatus.ERROR
                ex.error = "No SQL to execute (only comments?)"
                return
            context_stmts = self._context_statements(record.db_type, ex.snowflake_context)

            if ex._cancel_flag:
                ex.status = ExecStatus.CANCELLED
                return
            connector = get_connector(record, purpose=_sql_ide_purpose(ex.session_id))
            if ex._cancel_flag:
                ex.status = ExecStatus.CANCELLED
                return

            with connector.cursor() as cur:
                conn = getattr(cur, "connection", None)
                ex._cursor, ex._driver_conn = cur, conn
                if conn is not None:
                    self._apply_autocommit(ex, conn)
                for ctx_stmt in context_stmts:
                    if ex._cancel_flag:
                        ex.status = ExecStatus.CANCELLED
                        return
                    cur.execute(ctx_stmt)

                result_sets: list[dict] = []
                affected_total: int | None = None
                failed = False
                for idx, stmt in enumerate(statements):
                    if ex._cancel_flag:
                        ex.status = ExecStatus.CANCELLED
                        return
                    first_line = next((ln.strip() for ln in stmt.splitlines() if ln.strip() and not ln.strip().startswith("--")), stmt.strip())
                    msg: dict = {
                        "index": idx,
                        "sql": stmt[:500],
                        "status": "running",
                        "rows": 0,
                        "affected_rows": None,
                        "elapsed_ms": 0,
                        "error": None,
                        "result_sets": [],
                    }
                    ex.messages.append(msg)
                    ts = time.perf_counter()
                    if not ex.autocommit:
                        with self._lock:
                            sess = self._sessions.get(ex.session_id)
                            if sess is not None:
                                sess.manual_dirty = True
                    try:
                        cur.execute(stmt)
                        sets = self._collect_result_sets(
                            ex, cur, max_rows, idx, first_line[:120], len(result_sets),
                        )
                        if sets is None:
                            ex.status = ExecStatus.CANCELLED
                            msg["status"] = "cancelled"
                            return
                        room = MAX_RESULT_SETS - len(result_sets)
                        kept = sets[:max(0, room)]
                        result_sets.extend(kept)
                        msg["result_sets"] = [rs["index"] for rs in kept]
                        msg["rows"] = sum(rs["row_count"] for rs in sets)
                        if not sets:
                            try:
                                rc = cur.rowcount
                                if rc is not None and rc >= 0:
                                    msg["affected_rows"] = rc
                                    affected_total = (affected_total or 0) + rc
                            except Exception:
                                pass
                        if len(sets) > len(kept):
                            msg["note"] = f"{len(sets) - len(kept)} result set(s) not kept (limit {MAX_RESULT_SETS})"
                        msg["status"] = "success"
                    except Exception as exc:
                        if ex._cancel_flag:
                            # The driver aborted the statement because the
                            # user cancelled it — not a SQL error.
                            msg["status"] = "cancelled"
                            ex.status = ExecStatus.CANCELLED
                            return
                        msg["status"] = "error"
                        msg["error"] = str(exc)[:2000]
                        if ex.error_statement_index is None:
                            ex.error_statement_index = idx
                            ex.error = str(exc)[:2000]
                        failed = True
                        if ex.autocommit and conn is not None:
                            try:
                                conn.rollback()
                            except Exception:
                                pass
                        if ex.stop_on_error:
                            for rest_idx in range(idx + 1, len(statements)):
                                ex.messages.append({
                                    "index": rest_idx,
                                    "sql": statements[rest_idx][:500],
                                    "status": "skipped",
                                    "rows": 0,
                                    "affected_rows": None,
                                    "elapsed_ms": 0,
                                    "error": None,
                                    "result_sets": [],
                                })
                            break
                    finally:
                        msg["elapsed_ms"] = int((time.perf_counter() - ts) * 1000)

                ex.result_sets = result_sets
                ex.affected_rows = affected_total
                if result_sets:
                    ex.columns = result_sets[0]["columns"]
                    ex.rows = result_sets[0]["rows"]
                    ex.row_count = result_sets[0]["row_count"]

            if ex._cancel_flag:
                ex.status = ExecStatus.CANCELLED
            elif failed:
                ex.status = ExecStatus.ERROR
            else:
                ex.status = ExecStatus.SUCCESS

        except Exception as exc:
            if ex._cancel_flag:
                ex.status = ExecStatus.CANCELLED
            else:
                ex.status = ExecStatus.ERROR
                ex.error = str(exc)[:2000]
        finally:
            ex._cursor = ex._driver_conn = None
            ex.elapsed_ms = int((time.perf_counter() - t0) * 1000)
            ex.finished_at = now_iso()
            with self._lock:
                self._futures.pop(ex.exec_id, None)
                self._release_connection_slot_locked(ex)

    # ---- manual transactions ----

    def end_transaction(self, session_id: str, commit: bool) -> dict:
        """COMMIT or ROLLBACK the session's open transaction (manual-commit mode)."""
        from app.connectors.factory import get_connector
        from app.db.store import Connection as ConnectionRecord, get_session as get_db_session

        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                raise KeyError("Session not found")
            if any(e.status in (ExecStatus.QUEUED, ExecStatus.RUNNING) for e in s.executions.values()):
                raise RuntimeError("A query is still running in this tab — wait for it or cancel it first")
            s.last_activity = time.monotonic()
            connection_id = s.connection_id
        db_session = get_db_session()
        try:
            record = db_session.get(ConnectionRecord, connection_id)
            if not record:
                raise KeyError(f"Connection {connection_id} not found")
        finally:
            db_session.close()
        connector = get_connector(record, purpose=_sql_ide_purpose(session_id))
        t0 = time.perf_counter()
        with connector.cursor() as cur:
            conn = cur.connection
            if commit:
                conn.commit()
            else:
                conn.rollback()
        with self._lock:
            s = self._sessions.get(session_id)
            if s is not None:
                s.manual_dirty = False
        return {
            "ok": True,
            "action": "commit" if commit else "rollback",
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            "finished_at": now_iso(),
        }

    # ---- idle session reaper ----

    def _ensure_reaper(self) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return
        with self._lock:
            if self._reaper is not None and self._reaper.is_alive():
                return
            self._reaper = threading.Thread(
                target=self._reap_loop, name="sql-ide-session-reaper", daemon=True,
            )
            self._reaper.start()

    def _reap_loop(self) -> None:
        while not self._shutdown:
            time.sleep(REAPER_INTERVAL_SECONDS)
            try:
                self.reap_idle_sessions()
            except Exception:
                pass

    def reap_idle_sessions(self, idle_seconds: float | None = None) -> list[str]:
        """Close sessions idle longer than the TTL that have nothing running."""
        ttl = SESSION_IDLE_TTL_SECONDS if idle_seconds is None else idle_seconds
        now = time.monotonic()
        with self._lock:
            stale = [
                sid for sid, s in self._sessions.items()
                if now - s.last_activity > ttl
                and not any(e.status in (ExecStatus.QUEUED, ExecStatus.RUNNING) for e in s.executions.values())
            ]
        for sid in stale:
            self.delete_session(sid)
        return stale

    def cancel_execution(self, session_id: str, exec_id: str) -> bool:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return False
            cancelled, connector_key = self._cancel_exec_locked(exec_id, s)
        if connector_key is not None:
            ex = s.executions.get(exec_id)
            if ex is not None and _soft_cancel(ex):
                # The driver interrupts the statement and the session (temp
                # tables, SET options, an open manual transaction on most
                # engines) survives. Fall back to closing the connection if
                # the statement is still running a few seconds later.
                timer = threading.Timer(
                    SOFT_CANCEL_GRACE_SECONDS, self._evict_if_running, args=(exec_id, connector_key),
                )
                timer.daemon = True
                timer.start()
            else:
                self._evict(connector_key)
        return cancelled

    @staticmethod
    def _evict(connector_key: tuple[int, str]) -> None:
        from app.connectors.factory import evict_connector
        try:
            evict_connector(connector_key[0], purpose=connector_key[1], force=True)
        except Exception:
            pass

    def _evict_if_running(self, exec_id: str, connector_key: tuple[int, str]) -> None:
        with self._lock:
            still_running = exec_id in self._futures
        if still_running:
            self._evict(connector_key)

    def get_execution(self, session_id: str, exec_id: str) -> Execution | None:
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return None
            s.last_activity = time.monotonic()
            return s.executions.get(exec_id)

    def clear_execution(self, session_id: str, exec_id: str) -> bool:
        """Remove an execution's results (free memory)."""
        with self._lock:
            s = self._sessions.get(session_id)
            if not s:
                return False
            ex = s.executions.get(exec_id)
            if not ex or exec_id in self._futures:
                return False
            s.executions.pop(exec_id, None)
            try:
                s.exec_order.remove(exec_id)
            except ValueError:
                pass
            return True

    # ---- global query tracker ----

    def running_queries(self) -> list[dict]:
        """Return summary of all currently running/queued queries across all sessions."""
        out: list[dict] = []
        with self._lock:
            for s in self._sessions.values():
                for ex in s.executions.values():
                    if ex.status in (ExecStatus.QUEUED, ExecStatus.RUNNING):
                        out.append({**ex.summary_dict(), "session_name": s.name})
        return out

    def all_queries(self, limit: int = 100) -> list[dict]:
        """Return summary of recent queries across all sessions."""
        out: list[dict] = []
        with self._lock:
            for s in self._sessions.values():
                for eid in reversed(s.exec_order):
                    ex = s.executions.get(eid)
                    if ex:
                        out.append({**ex.summary_dict(), "session_name": s.name})
                    if len(out) >= limit:
                        break
                if len(out) >= limit:
                    break
        # Sort by started_at descending
        out.sort(key=lambda x: x.get("started_at") or "", reverse=True)
        return out[:limit]

    def shutdown(self, timeout: float = 2.0) -> None:
        with self._lock:
            if self._shutdown:
                return
            self._shutdown = True
            connector_keys: set[tuple[int, str]] = set()
            for session in self._sessions.values():
                connector_keys.add((
                    session.connection_id, _sql_ide_purpose(session.session_id)
                ))
                for ex in session.executions.values():
                    connector_keys.add((
                        ex.connection_id, _sql_ide_purpose(ex.session_id)
                    ))
                    self._cancel_exec_locked(ex.exec_id, session)

        self._pool.shutdown(wait=False, cancel_futures=True)

        def _evict_connectors() -> None:
            from app.connectors.factory import evict_connector
            for connection_id, purpose in connector_keys:
                try:
                    evict_connector(connection_id, purpose=purpose, force=True)
                except Exception:
                    pass

        cleanup = threading.Thread(
            target=_evict_connectors,
            name="sql-ide-shutdown-evict",
            daemon=True,
        )
        cleanup.start()
        cleanup.join(max(0.0, timeout))


SOFT_CANCEL_GRACE_SECONDS = 5.0


def _soft_cancel(ex: Execution) -> bool:
    """Ask the driver to interrupt the running statement (thread-safe calls).

    psycopg / python-oracledb cancel through the connection, pyodbc through
    the cursor. Other drivers (Snowflake, PyMySQL) return False and the caller
    closes the connection instead.
    """
    conn, cur = ex._driver_conn, ex._cursor
    module = type(conn).__module__ if conn is not None else ""
    try:
        if module.startswith("psycopg"):
            cancel = getattr(conn, "cancel_safe", None) or conn.cancel
            cancel()
            return True
        if module.startswith("oracledb"):
            conn.cancel()
            return True
        if cur is not None and type(cur).__module__.startswith("pyodbc"):
            cur.cancel()
            return True
    except Exception:
        return False
    return False


_JS_SAFE_INT = 2**53 - 1


def _safe_val(v: Any) -> Any:
    """Convert a DB value to something JSON (and JavaScript) can carry exactly.

    - integers beyond 2^53 and non-integral DECIMAL/NUMERIC become strings so
      the browser never rounds them (NUMERIC(12,2) 47606.70 stays "47606.70")
    - NaN / Infinity become strings (they are not valid JSON)
    - JSON / array columns become JSON text, binary becomes a hex preview
    - timestamps use a space separator, like database clients show them
    """
    if v is None:
        return None
    if isinstance(v, bool) or isinstance(v, str):
        return v
    if isinstance(v, int):
        return v if -_JS_SAFE_INT <= v <= _JS_SAFE_INT else str(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, decimal.Decimal):
        if not v.is_finite():
            return str(v)
        if v == v.to_integral_value() and v.as_tuple().exponent >= 0 and abs(v) <= _JS_SAFE_INT:
            return int(v)
        return format(v, "f")
    if isinstance(v, datetime):
        return v.isoformat(sep=" ")
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        if len(b) <= 64:
            return "0x" + b.hex()
        return f"0x{b[:64].hex()}… ({len(b):,} bytes)"
    if isinstance(v, (dict, list, tuple)):
        try:
            return json.dumps(v, default=str, ensure_ascii=False)
        except (TypeError, ValueError):
            return str(v)
    return str(v)


# Singleton
query_manager = QuerySessionManager()
