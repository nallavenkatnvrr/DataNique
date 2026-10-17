"""Browse and export the per-run encrypted diff store."""
from __future__ import annotations

import json
import os
import secrets
import threading
import time
from pathlib import Path

from app.config import settings
from app.engine import core, files

KINDS = {"only_source": "only_source", "only_target": "only_target", "changed": "changed"}


class StoreMissing(FileNotFoundError):
    pass


def _open(run_uuid: str):
    import duckdb

    if not core.store_exists(run_uuid):
        raise StoreMissing("This run has no saved differences")
    con = duckdb.connect(":memory:")
    try:
        core.attach_store(con, run_uuid, "rs", read_only=True)
    except FileNotFoundError as exc:
        con.close()
        raise StoreMissing(str(exc))
    except Exception as exc:
        con.close()
        from cryptography.exceptions import InvalidTag
        if isinstance(exc, (InvalidTag, ValueError)):
            raise StoreMissing("The saved differences of this run are damaged and can't be decrypted")
        raise
    return con


def meta(run_uuid: str) -> dict:
    con = _open(run_uuid)
    try:
        row = con.execute("SELECT meta FROM rs.meta").fetchone()
        m = json.loads(row[0]) if row else {}
        tables = {r[0] for r in con.execute("SELECT table_name FROM duckdb_tables() WHERE database_name='rs'").fetchall()}
        m["counts"] = {k: (con.execute(f"SELECT count(*) FROM rs.{k}").fetchone()[0] if k in tables else 0) for k in KINDS}
        return m
    finally:
        con.close()


def _where(con, table: str, search: str | None, column: str | None, params: list) -> str:
    cols = [r[0] for r in con.execute(f"DESCRIBE rs.{table}").fetchall()]
    conds = []
    if column and table == "changed":
        conds.append("list_contains(__diff, ?)")
        params.append(column)
    if search:
        parts = [f"coalesce(CAST({core.canon.qi(c)} AS VARCHAR), '')" for c in cols if c != "__diff"]
        conds.append(f"concat_ws('\x1f', {', '.join(parts)}) ILIKE ?")
        params.append(f"%{search}%")
    return (" WHERE " + " AND ".join(conds)) if conds else ""


def browse(run_uuid: str, kind: str, offset: int = 0, limit: int = 200, search: str | None = None,
           column: str | None = None) -> dict:
    table = KINDS.get(kind)
    if not table:
        raise ValueError("kind must be only_source, only_target or changed")
    con = _open(run_uuid)
    try:
        exists = con.execute("SELECT count(*) FROM duckdb_tables() WHERE database_name='rs' AND table_name=?", [table]).fetchone()[0]
        if not exists:
            return {"kind": kind, "columns": [], "rows": [], "total": 0, "offset": offset}
        params: list = []
        where = _where(con, table, search, column, params)
        total = con.execute(f"SELECT count(*) FROM rs.{table}{where}", params).fetchone()[0]
        cur = con.execute(f"SELECT * FROM rs.{table}{where} LIMIT {int(limit)} OFFSET {int(offset)}", params)
        names = [d[0] for d in cur.description]
        rows = [[(list(v) if n == "__diff" and v is not None else files.display_value(v)) for n, v in zip(names, r)]
                for r in cur.fetchall()]
        types = {r[0]: r[1] for r in con.execute(f"DESCRIBE rs.{table}").fetchall()}
        return {"kind": kind, "columns": [{"name": n, "type": types.get(n)} for n in names],
                "rows": rows, "total": total, "offset": offset}
    finally:
        con.close()


# ---------------------------------------------------------------------------
# Exports (CSV / Parquet / JSON / XLSX) through one-time download tickets
# ---------------------------------------------------------------------------
def exports_tmp() -> Path:
    p = settings.data_dir / "tmp" / "exports"
    p.mkdir(parents=True, exist_ok=True)
    return p


def export(run_uuid: str, kind: str, fmt: str, search: str | None = None, column: str | None = None) -> tuple[Path, str]:
    table = KINDS.get(kind)
    if not table:
        raise ValueError("bad kind")
    if fmt not in ("csv", "parquet", "json", "xlsx"):
        raise ValueError("format must be csv, parquet, json or xlsx")
    out = exports_tmp() / f"{secrets.token_hex(8)}.{fmt}"
    con = _open(run_uuid)
    try:
        params: list = []
        where = _where(con, table, search, column, params)
        if fmt == "xlsx":
            from app.engine.report import write_rows_xlsx
            cur = con.execute(f"SELECT * FROM rs.{table}{where}", params)
            write_rows_xlsx(out, kind, cur)
        else:
            sel = f"SELECT * FROM rs.{table}{where}"
            if fmt == "csv":
                sel = f"SELECT * REPLACE (array_to_string(__diff, ', ') AS __diff) FROM rs.{table}{where}" if table == "changed" else sel
            opts = {"csv": "(FORMAT CSV, HEADER)", "parquet": "(FORMAT PARQUET, COMPRESSION ZSTD)", "json": "(FORMAT JSON, ARRAY true)"}[fmt]
            if params:
                # COPY can't take parameters: materialise first
                con.execute(f"CREATE TEMP TABLE x AS {sel}", params)
                sel = "SELECT * FROM x"
            con.execute(f"COPY ({sel}) TO '{out.as_posix()}' {opts}")
    finally:
        con.close()
    return out, f"{kind}.{fmt}"


class Tickets:
    """One-time, short-lived download links (no session token in URLs)."""

    def __init__(self):
        self._t: dict[str, tuple[Path, str, str, float, bool]] = {}
        self._lock = threading.Lock()

    def issue(self, path: Path, filename: str, media: str, delete_after: bool = True, ttl: float = 300) -> str:
        tok = secrets.token_urlsafe(24)
        with self._lock:
            self._purge()
            self._t[tok] = (path, filename, media, time.time() + ttl, delete_after)
        return tok

    def take(self, tok: str):
        with self._lock:
            self._purge()
            return self._t.pop(tok, None)

    def _purge(self):
        now = time.time()
        for k, v in list(self._t.items()):
            if v[3] < now:
                self._t.pop(k, None)
                if v[4]:
                    try:
                        os.unlink(v[0])
                    except OSError:
                        pass


tickets = Tickets()

MEDIA = {
    "csv": "text/csv",
    "parquet": "application/vnd.apache.parquet",
    "json": "application/json",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}
