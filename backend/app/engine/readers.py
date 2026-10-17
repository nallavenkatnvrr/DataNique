"""Database readers: land a table or query result in DuckDB as fast as the
environment allows.

Each database has an ordered chain of readers; the first one that works is
used and the run log names it. Readers that are not installed are skipped
silently, readers that fail fall through to the next one.

=============  =============================================================
PostgreSQL     DuckDB postgres scanner (parallel binary COPY) → ADBC → cursor
MySQL          DuckDB mysql scanner → ADBC (dbc "mysql" driver) → ConnectorX → cursor
SQL Server     ADBC (dbc "mssql" driver) → Arrow ODBC → ConnectorX → cursor
Snowflake      ADBC (password auth) → connector Arrow batches → cursor
Oracle         python-oracledb Arrow batches (fetch_df_batches) → ConnectorX → cursor
=============  =============================================================

The order is what measured fastest; ``DV_READER_ORDER_<DBTYPE>`` (comma
list of reader names) overrides it.
"""
from __future__ import annotations

import threading

import logging
import os
import re
import time
from pathlib import Path
from typing import Callable
from urllib.parse import quote

from app.config import settings
from app.engine.spec import SideSpec

log = logging.getLogger("dv.engine.readers")

BATCH_ROWS = 200_000


class ReaderUnavailable(RuntimeError):
    """The reader can't be used here (not installed, unsupported auth)."""


class ReadContext:
    def __init__(self, con, table: str, side: SideSpec, record, role: str, sql: str,
                 table_parts: tuple[str | None, str | None, str] | None,
                 columns: list[str] | None, max_rows: int,
                 on_rows: Callable[[int], None], cancelled: Callable[[], bool],
                 log_fn: Callable[[str, str], None], cancel_hooks: list):
        self.con = con
        self.table = table
        self.side = side
        self.record = record
        self.role = role
        self.sql = sql
        self.table_parts = table_parts
        self.columns = columns
        self.max_rows = max_rows
        self.on_rows = on_rows
        self.cancelled = cancelled
        self.log = log_fn
        self.cancel_hooks = cancel_hooks

    @property
    def db_type(self) -> str:
        return (self.record.db_type or "").lower()


def _password(record) -> str:
    from app.security.crypto import decrypt
    return decrypt(record.password_enc) or ""


def _check_cancel(ctx: ReadContext):
    if ctx.cancelled():
        raise InterruptedError("Cancelled")


# ---------------------------------------------------------------------------
# Arrow ingestion helpers
# ---------------------------------------------------------------------------
def _normal_type(t):
    """One Arrow type per logical type, so batches from one result agree:
    integers → int64, float32 → float64, timestamps → microseconds (DuckDB's
    TIMESTAMP; nanosecond values can't hold dates like 9999-12-31),
    dictionaries decoded. NULL-typed columns are left for ``_ingest_batches``."""
    import pyarrow as pa

    if pa.types.is_dictionary(t):
        return _normal_type(t.value_type)
    if pa.types.is_integer(t):
        return pa.uint64() if t == pa.uint64() else pa.int64()
    if pa.types.is_floating(t):
        return pa.float64()
    if pa.types.is_timestamp(t):
        return pa.timestamp("us", t.tz)
    if pa.types.is_large_string(t):
        return pa.string()
    return t


def _normalize_table(tbl):
    import pyarrow as pa

    fields, changed = [], False
    for f in tbl.schema:
        nt = _normal_type(f.type)
        changed |= nt != f.type
        fields.append(pa.field(f.name, nt, True))
    if not changed:
        return tbl
    try:
        return tbl.cast(pa.schema(fields), safe=False)
    except Exception:
        cols = []
        for col, f in zip(tbl.columns, fields):
            try:
                cols.append(col.cast(f.type, safe=False))
            except Exception:
                cols.append(col)
        return pa.Table.from_arrays(cols, names=tbl.column_names)


def _ingest_batches(ctx: ReadContext, batches) -> int:
    """Append an iterable of Arrow tables / record batches to ctx.table.

    The first batch fixes the table's types, so every batch is normalised
    first (``_normalize_table``); a column that was entirely NULL so far gets
    its real type from the first batch that has values."""
    import pyarrow as pa

    created = False
    n = 0
    null_cols: set[str] = set()
    for b in batches:
        _check_cancel(ctx)
        if isinstance(b, pa.RecordBatch):
            b = pa.Table.from_batches([b])
        elif not isinstance(b, pa.Table):
            b = pa.table(b)
        if b.num_rows == 0 and created:
            continue
        if ctx.max_rows and n + b.num_rows > ctx.max_rows:
            b = b.slice(0, ctx.max_rows - n)
        b = _normalize_table(b)
        ctx.con.register("__dv_batch", b)
        try:
            if not created:
                null_cols = {f.name for f in b.schema if pa.types.is_null(f.type)}
                ctx.con.execute(f"CREATE OR REPLACE TABLE {ctx.table} AS SELECT * FROM __dv_batch")
                created = True
            else:
                if null_cols:
                    typed = {f.name for f in b.schema if not pa.types.is_null(f.type)} & null_cols
                    if typed:
                        types = {r[0]: r[1] for r in ctx.con.execute("DESCRIBE SELECT * FROM __dv_batch").fetchall()}
                        for c in typed:
                            qc = '"' + c.replace('"', '""') + '"'
                            ctx.con.execute(f"ALTER TABLE {ctx.table} ALTER COLUMN {qc} SET DATA TYPE {types[c]}")
                        null_cols -= typed
                ctx.con.execute(f"INSERT INTO {ctx.table} BY NAME SELECT * FROM __dv_batch")
        finally:
            ctx.con.unregister("__dv_batch")
        n += b.num_rows
        ctx.on_rows(n)
        if ctx.max_rows and n >= ctx.max_rows:
            break
    if not created:
        raise RuntimeError("The reader returned no result set")
    if null_cols:
        # Never got values: make them text so comparisons don't see a NULL type.
        for c in null_cols:
            qc = '"' + c.replace('"', '""') + '"'
            ctx.con.execute(f"ALTER TABLE {ctx.table} ALTER COLUMN {qc} SET DATA TYPE VARCHAR")
    return n


def _rows_to_arrow(names: list[str], rows: list[tuple]):
    import pyarrow as pa

    cols = list(zip(*rows)) if rows else [[] for _ in names]
    arrays = []
    for col in cols:
        try:
            arr = pa.array(col)
        except (pa.ArrowInvalid, pa.ArrowTypeError, TypeError, ValueError, OverflowError):
            arr = pa.array([None if v is None else str(v) for v in col], type=pa.string())
        arrays.append(arr)
    return pa.Table.from_arrays(arrays, names=_unique_names(names))


def _unique_names(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        key = n.lower()
        if key in seen:
            seen[key] += 1
            out.append(f"{n}_{seen[key]}")
        else:
            seen[key] = 0
            out.append(n)
    return out


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------
def _ext_dir() -> Path:
    """Bundled DuckDB extensions (backend/duckdb_extensions) so corporate
    machines without internet access still get the scanners."""
    return settings.backend_dir / "duckdb_extensions"


def _load_extension(con, name: str) -> None:
    try:
        con.execute(f"LOAD {name}")
        return
    except Exception:
        pass
    import duckdb

    bundled = _ext_dir() / f"v{duckdb.__version__}"
    for plat in bundled.glob("*") if bundled.exists() else []:
        for cand in (plat / f"{name}_scanner.duckdb_extension", plat / f"{name}.duckdb_extension"):
            if cand.exists():
                try:
                    con.execute(f"LOAD '{cand.as_posix()}'")
                    return
                except Exception:
                    continue
    try:
        con.execute(f"INSTALL {name}")
        con.execute(f"LOAD {name}")
    except Exception as exc:
        raise ReaderUnavailable(f"DuckDB {name} extension unavailable: {str(exc)[:160]}")


def _kv(**kw) -> str:
    def esc(v):
        v = str(v)
        if v == "" or any(c in v for c in " '\\="):
            return "'" + v.replace("\\", "\\\\").replace("'", "\\'") + "'"
        return v
    return " ".join(f"{k}={esc(v)}" for k, v in kw.items() if v not in (None, ""))


def _scanner_select(ctx: ReadContext, alias: str, quote_fn) -> str | None:
    """Use the scanner's own (parallel) table scan when reading a plain table."""
    if ctx.side.kind != "table" or ctx.side.filter_sql or ctx.max_rows or not ctx.table_parts:
        return None
    if getattr(ctx, "_incremental", False):
        return None
    _db, schema, table = ctx.table_parts
    cols = ", ".join(f'"{c}"' for c in ctx.columns) if ctx.columns else "*"
    return f'SELECT {cols} FROM {alias}."{schema}"."{table}"'


def read_duckdb_postgres(ctx: ReadContext) -> str:
    _load_extension(ctx.con, "postgres")
    r = ctx.record
    extra = r.extra or {}
    alias = f"pg_{ctx.role}"
    dsn = _kv(host=r.host, port=r.port or 5432, dbname=ctx.side.database or r.database,
              user=r.username, password=_password(r), sslmode=extra.get("sslmode"),
              connect_timeout=settings.connect_timeout)
    ctx.con.execute(f"ATTACH '{dsn.replace(chr(39), chr(39) * 2)}' AS {alias} (TYPE postgres, READ_ONLY)")
    try:
        sel = None
        if ctx.table_parts:
            db, schema, table = ctx.table_parts
            ctx.table_parts = (db, schema or r.schema_name or "public", table)
            sel = _scanner_select(ctx, alias, None)
        if sel is None:
            sql = ctx.sql.replace("'", "''")
            sel = f"SELECT * FROM postgres_query('{alias}', '{sql}')"
        ctx.con.execute(f"CREATE OR REPLACE TABLE {ctx.table} AS {sel}")
    finally:
        try:
            ctx.con.execute(f"DETACH {alias}")
        except Exception:
            pass
    return "duckdb postgres scanner"


def read_duckdb_mysql(ctx: ReadContext) -> str:
    _load_extension(ctx.con, "mysql")
    r = ctx.record
    alias = f"my_{ctx.role}"
    db = ctx.side.database or r.database or ctx.side.schema_name or r.schema_name
    dsn = _kv(host=r.host, port=r.port or 3306, database=db, user=r.username, password=_password(r))
    ctx.con.execute(f"ATTACH '{dsn.replace(chr(39), chr(39) * 2)}' AS {alias} (TYPE mysql, READ_ONLY)")
    try:
        sql = ctx.sql.replace("'", "''")
        ctx.con.execute(f"CREATE OR REPLACE TABLE {ctx.table} AS SELECT * FROM mysql_query('{alias}', '{sql}')")
    finally:
        try:
            ctx.con.execute(f"DETACH {alias}")
        except Exception:
            pass
    return "duckdb mysql scanner"


def _adbc_stream(ctx: ReadContext, conn) -> int:
    cur = conn.cursor()
    ctx.cancel_hooks.append(lambda: _safe(lambda: conn.adbc_connection.cancel()))
    try:
        cur.execute(ctx.sql)
        reader = cur.fetch_record_batch()

        def batches():
            for b in reader:
                yield b
        return _ingest_batches(ctx, batches())
    finally:
        _safe(cur.close)
        _safe(conn.close)


def read_adbc_postgres(ctx: ReadContext) -> str:
    try:
        import adbc_driver_postgresql.dbapi as pgdb  # type: ignore
    except Exception:
        raise ReaderUnavailable("adbc-driver-postgresql not installed")
    r = ctx.record
    uri = (f"postgresql://{quote(r.username or '', safe='')}:{quote(_password(r), safe='')}"
           f"@{r.host}:{r.port or 5432}/{quote(ctx.side.database or r.database or '', safe='')}")
    _adbc_stream(ctx, pgdb.connect(uri))
    return "adbc postgresql"


def _adbc_manager(driver: str, uri: str, db_kwargs: dict | None = None):
    try:
        import adbc_driver_manager.dbapi as mgr  # type: ignore
    except Exception:
        raise ReaderUnavailable("adbc-driver-manager not installed")
    try:
        return mgr.connect(driver=driver, uri=uri, db_kwargs=db_kwargs or None, autocommit=True)
    except Exception as exc:
        msg = str(exc)
        if "Could not load" in msg or "not found" in msg.lower() or "NOT_FOUND" in msg:
            raise ReaderUnavailable(f"ADBC {driver} driver not installed (dbc install {driver})")
        raise


def read_adbc_mssql(ctx: ReadContext) -> str:
    r = ctx.record
    extra = r.extra or {}
    auth = (extra.get("auth_mode") or "sql").lower()
    if auth not in ("sql", "windows", ""):
        raise ReaderUnavailable(f"ADBC SQL Server path does not handle auth_mode={auth}")
    host = r.host or "localhost"
    port = f":{r.port}" if r.port else ""
    params = {"database": ctx.side.database or r.database or "master",
              "encrypt": "true" if str(extra.get("encrypt", "yes")).lower() in ("yes", "true", "1", "mandatory") else "disable",
              "TrustServerCertificate": "true" if str(extra.get("trust_server_certificate", "yes")).lower() in ("yes", "true", "1") else "false"}
    q = "&".join(f"{k}={quote(str(v), safe='')}" for k, v in params.items())
    if auth == "windows":
        uri = f"sqlserver://{host}{port}?{q}&authenticator=winsspi"
    else:
        uri = f"sqlserver://{quote(r.username or '', safe='')}:{quote(_password(r), safe='')}@{host}{port}?{q}"
    _adbc_stream(ctx, _adbc_manager("mssql", uri))
    return "adbc mssql"


def read_adbc_mysql(ctx: ReadContext) -> str:
    r = ctx.record
    db = ctx.side.database or r.database or r.schema_name or ""
    uri = f"{quote(r.username or '', safe='')}:{quote(_password(r), safe='')}@tcp({r.host}:{r.port or 3306})/{db}"
    _adbc_stream(ctx, _adbc_manager("mysql", uri))
    return "adbc mysql"


def read_adbc_snowflake(ctx: ReadContext) -> str:
    r = ctx.record
    extra = r.extra or {}
    auth = (extra.get("authenticator") or "snowflake").strip().lower()
    if auth != "snowflake":
        # SSO / key-pair keep using the connector's existing session so no
        # second browser login is triggered.
        raise ReaderUnavailable("ADBC Snowflake path is used for password logins only")
    try:
        import adbc_driver_snowflake.dbapi as sf  # type: ignore
    except Exception:
        raise ReaderUnavailable("adbc-driver-snowflake not installed")
    account = (extra.get("account") or r.host or "").strip()
    account = re.sub(r"\.snowflakecomputing\.com.*$", "", account.replace("https://", ""))
    kw = {
        "username": r.username or "",
        "password": _password(r),
        "adbc.snowflake.sql.account": account,
        "adbc.snowflake.sql.db": ctx.side.database or r.database or "",
        "adbc.snowflake.sql.schema": ctx.side.schema_name or r.schema_name or "",
        "adbc.snowflake.sql.warehouse": extra.get("warehouse") or "",
        "adbc.snowflake.sql.role": extra.get("role") or "",
    }
    _adbc_stream(ctx, sf.connect(db_kwargs={k: v for k, v in kw.items() if v}))
    return "adbc snowflake"


def read_arrow_odbc(ctx: ReadContext) -> str:
    try:
        from arrow_odbc import read_arrow_batches_from_odbc  # type: ignore
    except Exception:
        raise ReaderUnavailable("arrow-odbc not installed")
    from app.connectors.factory import _build_connector

    conn_str = _build_connector(ctx.record).odbc_connection_string()
    reader = read_arrow_batches_from_odbc(query=ctx.sql, connection_string=conn_str, batch_size=BATCH_ROWS,
                                          max_text_size=65536, max_binary_size=65536)
    _ingest_batches(ctx, reader)
    return "arrow-odbc"


def _connectorx_uri(ctx: ReadContext) -> str:
    r = ctx.record
    user, pw = quote(r.username or "", safe=""), quote(_password(r), safe="")
    db = quote(ctx.side.database or r.database or "", safe="")
    t = ctx.db_type
    if t == "postgres":
        return f"postgresql://{user}:{pw}@{r.host}:{r.port or 5432}/{db}"
    if t == "mysql":
        return f"mysql://{user}:{pw}@{r.host}:{r.port or 3306}/{db or quote(r.schema_name or '', safe='')}"
    if t == "sqlserver":
        extra = r.extra or {}
        enc = "true" if str(extra.get("encrypt", "yes")).lower() in ("yes", "true", "1") else "false"
        trusted = "&trusted_connection=true" if (extra.get("auth_mode") or "").lower() == "windows" else ""
        return f"mssql://{user}:{pw}@{r.host}:{r.port or 1433}/{db or 'master'}?encrypt={enc}&trust_server_certificate=true{trusted}"
    if t == "oracle":
        extra = r.extra or {}
        svc = quote(extra.get("service_name") or r.database or "", safe="")
        return f"oracle://{user}:{pw}@{r.host}:{r.port or 1521}/{svc}"
    raise ReaderUnavailable("ConnectorX does not support this database")


def read_connectorx(ctx: ReadContext) -> str:
    try:
        import connectorx as cx  # type: ignore
    except Exception:
        raise ReaderUnavailable("connectorx not installed")
    tbl = cx.read_sql(_connectorx_uri(ctx), ctx.sql, return_type="arrow")
    _ingest_batches(ctx, [tbl])
    return "connectorx"


def read_oracle_arrow(ctx: ReadContext) -> str:
    from app.connectors.factory import get_compare_connector

    connector = get_compare_connector(ctx.record, role=ctx.role)
    with connector._conn_lock:
        conn = connector._get_or_open_validated_conn()
        if not hasattr(conn, "fetch_df_batches"):
            raise ReaderUnavailable("python-oracledb 3.0+ needed for Arrow fetch")
        ctx.cancel_hooks.append(lambda: _safe(conn.cancel))
        import pyarrow as pa

        def batches():
            for df in conn.fetch_df_batches(statement=ctx.sql, size=BATCH_ROWS):
                try:
                    yield pa.table(df)
                except Exception:
                    yield pa.Table.from_arrays(df.column_arrays(), names=df.column_names())
        _ingest_batches(ctx, batches())
    return "oracledb arrow"


_sf_patch_lock = threading.Lock()


def _unified_batches(batches):
    """Cast record batches to one schema (see ``_normal_type``)."""
    import pyarrow as pa

    batches = list(batches)
    first = batches[0].schema
    fields = []
    for i, f in enumerate(first):
        kinds = {b.schema.field(i).type for b in batches}
        t = _normal_type(f.type)
        if len({_normal_type(k) for k in kinds}) > 1:
            non_null = [k for k in kinds if not pa.types.is_null(k)]
            try:
                t = pa.unify_schemas([pa.schema([pa.field("x", _normal_type(k))]) for k in non_null],
                                     promote_options="permissive").field("x").type if non_null else f.type
            except Exception:
                t = pa.string()
        elif pa.types.is_null(t):
            t = _normal_type(next((k for k in kinds if not pa.types.is_null(k)), t))
        fields.append(pa.field(f.name, t, True, f.metadata))
    target = pa.schema(fields)
    out = []
    for b in batches:
        tb = pa.Table.from_batches([b])
        try:
            tb = tb.cast(target, safe=False)
        except Exception:
            tb = pa.Table.from_arrays([c.cast(f.type, safe=False) if c.type != f.type else c
                                       for c, f in zip(tb.columns, target)], schema=target)
        out.extend(tb.to_batches())
    return out, target


def _patch_snowflake_arrow() -> None:
    """The Snowflake connector joins the record batches of each result chunk
    with ``pyarrow.Table.from_batches``, which raises "Schema at index N was
    different" when its own per-batch conversion picked different types (a
    batch holding 9999-12-31 becomes timestamp[us] while the others are
    timestamp[ns]; integer widths, nullability). Route that one call through
    a version that first casts the batches to a common schema."""
    try:
        from snowflake.connector import nanoarrow_arrow_iterator as mod  # type: ignore
    except Exception:
        return
    with _sf_patch_lock:
        if getattr(mod, "_dv_patched", False) or not hasattr(mod, "pyarrow"):
            return
        real = mod.pyarrow

        def from_batches(batches, schema=None):
            batches = list(batches)
            try:
                return real.Table.from_batches(batches, schema) if schema is not None else real.Table.from_batches(batches)
            except real.ArrowInvalid:
                if len(batches) < 2:
                    raise
                unified, target = _unified_batches(batches)
                return real.Table.from_batches(unified, target)

        class _TableProxy:
            def __getattr__(self, name):
                if name == "from_batches":
                    return from_batches
                return getattr(real.Table, name)

        class _PyArrowProxy:
            Table = _TableProxy()

            def __getattr__(self, name):
                return getattr(real, name)

        mod.pyarrow = _PyArrowProxy()
        mod._dv_patched = True


def read_snowflake_arrow(ctx: ReadContext) -> str:
    from app.connectors.factory import get_compare_connector

    _patch_snowflake_arrow()

    connector = get_compare_connector(ctx.record, role=ctx.role)
    with connector.cursor() as cur:
        ctx.cancel_hooks.append(lambda: _safe(lambda: cur.connection.cursor().execute(f"SELECT SYSTEM$CANCEL_QUERY('{cur.sfqid}')")))
        cur.execute(ctx.sql)
        if not hasattr(cur, "fetch_arrow_batches"):
            raise ReaderUnavailable("snowflake connector without Arrow support")
        it = cur.fetch_arrow_batches()
        n = _ingest_batches(ctx, it) if it is not None else 0
        if n == 0:
            # Empty result: Snowflake yields no batches; build an empty table.
            names = [d[0] for d in cur.description or []]
            _ingest_batches(ctx, [_rows_to_arrow(names, [])])
    return "snowflake arrow"


def read_cursor(ctx: ReadContext) -> str:
    """Portable DB-API fetchmany → Arrow → DuckDB."""
    from app.connectors.factory import get_compare_connector

    connector = get_compare_connector(ctx.record, role=ctx.role)
    with connector.cursor() as cur:
        conn = getattr(cur, "connection", None)
        if hasattr(conn, "cancel"):
            ctx.cancel_hooks.append(lambda: _safe(conn.cancel))
        elif hasattr(cur, "cancel"):
            ctx.cancel_hooks.append(lambda: _safe(cur.cancel))
        try:
            cur.arraysize = 20_000
        except Exception:
            pass
        cur.execute(ctx.sql)
        names = [d[0] for d in cur.description or []]

        def batches():
            got_any = False
            while True:
                _check_cancel(ctx)
                rows = cur.fetchmany(50_000)
                if not rows:
                    break
                got_any = True
                yield _rows_to_arrow(names, rows)
            if not got_any:
                yield _rows_to_arrow(names, [])
        _ingest_batches(ctx, batches())
    return "cursor"


def _safe(fn):
    try:
        fn()
    except Exception:
        pass


READERS: dict[str, Callable[[ReadContext], str]] = {
    "duckdb_postgres": read_duckdb_postgres,
    "duckdb_mysql": read_duckdb_mysql,
    "adbc_postgres": read_adbc_postgres,
    "adbc_mssql": read_adbc_mssql,
    "adbc_mysql": read_adbc_mysql,
    "adbc_snowflake": read_adbc_snowflake,
    "arrow_odbc": read_arrow_odbc,
    "connectorx": read_connectorx,
    "oracle_arrow": read_oracle_arrow,
    "snowflake_arrow": read_snowflake_arrow,
    "cursor": read_cursor,
}

DEFAULT_CHAINS = {
    "postgres": ["duckdb_postgres", "adbc_postgres", "cursor"],
    "mysql": ["duckdb_mysql", "adbc_mysql", "connectorx", "cursor"],
    "sqlserver": ["adbc_mssql", "arrow_odbc", "connectorx", "cursor"],
    "snowflake": ["adbc_snowflake", "snowflake_arrow", "cursor"],
    "oracle": ["oracle_arrow", "connectorx", "cursor"],
}


def reader_chain(db_type: str) -> list[str]:
    env = os.environ.get(f"DV_READER_ORDER_{db_type.upper()}")
    if env:
        chain = [x.strip() for x in env.split(",") if x.strip() in READERS]
        if chain:
            return chain
    return list(DEFAULT_CHAINS.get(db_type, ["cursor"]))


def available_readers() -> dict[str, list[dict]]:
    """For the Settings page: which readers each database would use."""
    def installed(name: str) -> bool:
        mods = {
            "adbc_postgres": "adbc_driver_postgresql", "adbc_snowflake": "adbc_driver_snowflake",
            "adbc_mssql": "adbc_driver_manager", "adbc_mysql": "adbc_driver_manager",
            "arrow_odbc": "arrow_odbc", "connectorx": "connectorx", "oracle_arrow": "oracledb",
            "snowflake_arrow": "snowflake.connector", "duckdb_postgres": "duckdb", "duckdb_mysql": "duckdb",
        }
        mod = mods.get(name)
        if not mod:
            return True
        try:
            __import__(mod)
            return True
        except Exception:
            return False
    return {db: [{"name": n, "installed": installed(n)} for n in reader_chain(db)] for db in DEFAULT_CHAINS}


# ---------------------------------------------------------------------------
# SQL for a side
# ---------------------------------------------------------------------------
def native_select(record, side: SideSpec, columns: list[str] | None, incremental: tuple[str, str] | None,
                  max_rows: int) -> tuple[str, tuple | None]:
    """Native SQL that returns the side's rows (and the table parts)."""
    from app.connectors.factory import _build_connector

    dialect = _build_connector(record).dialect
    db_type = (record.db_type or "").lower()
    if side.kind == "query":
        sql = side.sql.strip().rstrip(";").strip()
        wheres = []
        if incremental:
            wheres.append(_incremental_pred(dialect, db_type, *incremental))
        if wheres or max_rows:
            sql = f"SELECT * FROM ({sql}) dvq" + (f" WHERE {' AND '.join(wheres)}" if wheres else "")
            sql = _limit(db_type, sql, max_rows)
        return sql, None
    db = side.database or None
    schema = side.schema_name or record.schema_name or None
    if db_type == "postgres":
        db = None  # a PostgreSQL connection is bound to one database
    fq = dialect.fq_table(db, schema, side.table)
    cols = ", ".join(dialect.quote_ident(c) for c in columns) if columns else "*"
    wheres = []
    if side.filter_sql and side.filter_sql.strip():
        wheres.append(f"({side.filter_sql.strip()})")
    if incremental:
        wheres.append(_incremental_pred(dialect, db_type, *incremental))
    sql = f"SELECT {cols} FROM {fq}" + (f" WHERE {' AND '.join(wheres)}" if wheres else "")
    return _limit(db_type, sql, max_rows), (side.database or record.database, schema, side.table)


def _incremental_pred(dialect, db_type: str, column: str, since: str) -> str:
    lit = "'" + since.replace("'", "''") + "'"
    col = dialect.quote_ident(column)
    if db_type == "oracle":
        return f"{col} >= TO_TIMESTAMP({lit}, 'YYYY-MM-DD\"T\"HH24:MI:SS.FF')" if "T" in since else f"{col} >= TO_DATE({lit}, 'YYYY-MM-DD')"
    return f"{col} >= {lit}"


def _limit(db_type: str, sql: str, n: int) -> str:
    if not n:
        return sql
    if db_type == "sqlserver":
        return f"SELECT TOP {int(n)} * FROM ({sql}) dvl"
    if db_type == "oracle":
        return f"{sql} FETCH FIRST {int(n)} ROWS ONLY"
    return f"{sql} LIMIT {int(n)}"


def read_side(con, table: str, side: SideSpec, record, role: str, columns: list[str] | None,
              max_rows: int, incremental: tuple[str, str] | None,
              on_rows: Callable[[int], None], cancelled: Callable[[], bool],
              log_fn: Callable[[str, str], None], cancel_hooks: list) -> dict:
    """Run the reader chain. Returns {reader, rows, read_ms, sql, attempts}."""
    sql, parts = native_select(record, side, columns, incremental, max_rows)
    db_type = (record.db_type or "").lower()
    attempts = []
    t0 = time.perf_counter()
    first_error: Exception | None = None
    for name in reader_chain(db_type):
        _check_cancel_fn(cancelled)
        ctx = ReadContext(con, table, side, record, role, sql, parts, columns, max_rows,
                          on_rows, cancelled, log_fn, cancel_hooks)
        ctx._incremental = bool(incremental)
        t1 = time.perf_counter()
        try:
            label = READERS[name](ctx)
            rows = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            on_rows(rows)
            attempts.append({"reader": name, "ok": True, "ms": int((time.perf_counter() - t1) * 1000)})
            return {"reader": label, "rows": rows, "read_ms": int((time.perf_counter() - t0) * 1000),
                    "attempts": attempts, "sql": sql}
        except InterruptedError:
            raise
        except ReaderUnavailable as exc:
            attempts.append({"reader": name, "ok": False, "skipped": True, "error": str(exc)[:300]})
        except Exception as exc:
            if cancelled():
                raise InterruptedError("Cancelled")
            first_error = first_error or exc
            attempts.append({"reader": name, "ok": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"})
            log_fn("warn", f"{role}: reader {name} failed ({type(exc).__name__}: {str(exc)[:200]}); trying the next one")
        try:
            con.execute(f"DROP TABLE IF EXISTS {table}")
        except Exception:
            pass
    if first_error:
        raise first_error
    raise RuntimeError("No reader could read this side: " + "; ".join(a.get("error", "") for a in attempts))


def _check_cancel_fn(cancelled):
    if cancelled():
        raise InterruptedError("Cancelled")


# ---------------------------------------------------------------------------
# Metadata used before reading
# ---------------------------------------------------------------------------
_PK_SQL = {
    "postgres": """
        SELECT a.attname FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
        WHERE i.indisprimary AND n.nspname = {schema} AND c.relname = {table}
        ORDER BY array_position(i.indkey, a.attnum)""",
    "mysql": """
        SELECT column_name FROM information_schema.key_column_usage
        WHERE constraint_name = 'PRIMARY' AND table_schema = {schema} AND table_name = {table}
        ORDER BY ordinal_position""",
    "sqlserver": """
        SELECT kcu.COLUMN_NAME FROM {db_prefix}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN {db_prefix}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = {schema} AND tc.TABLE_NAME = {table}
        ORDER BY kcu.ORDINAL_POSITION""",
    "oracle": """
        SELECT cols.column_name FROM all_constraints cons
        JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner
        WHERE cons.constraint_type = 'P' AND cons.owner = {schema} AND cols.table_name = {table}
        ORDER BY cols.position""",
}


def primary_key(record, side: SideSpec) -> list[str]:
    """Primary key columns of a table side, or [] when unknown."""
    from app.connectors.factory import get_compare_connector

    db_type = (record.db_type or "").lower()
    connector = get_compare_connector(record, role="meta")
    schema = side.schema_name or record.schema_name
    db = side.database or record.database
    try:
        if db_type == "snowflake":
            fq = connector.dialect.fq_table(db, schema, side.table)
            with connector.cursor() as cur:
                cur.execute(f"SHOW PRIMARY KEYS IN TABLE {fq}")
                names = [d[0].lower() for d in cur.description]
                rows = cur.fetchall()
            ci, si = names.index("column_name"), names.index("key_sequence")
            return [r[ci] for r in sorted(rows, key=lambda r: int(r[si]))]
        tmpl = _PK_SQL.get(db_type)
        if not tmpl:
            return []

        def lit(v):
            return "'" + str(v).replace("'", "''") + "'" if v is not None else "NULL"
        if db_type == "postgres":
            schema = schema or "public"
        if db_type == "mysql":
            schema = db or schema
        if db_type == "oracle":
            schema = schema or (record.username or "").upper()
        if db_type == "sqlserver":
            schema = schema or "dbo"
        db_prefix = f"[{db.replace(']', ']]')}]." if db_type == "sqlserver" and db else ""
        sql = tmpl.format(schema=lit(schema), table=lit(side.table), db_prefix=db_prefix)
        return [r[0] for r in connector.execute_rows(sql)]
    except Exception as exc:
        log.info("primary key lookup failed: %s", exc)
        return []


def table_columns(record, side: SideSpec) -> list[dict]:
    from app.connectors.factory import get_compare_connector

    connector = get_compare_connector(record, role="meta")
    return list(connector.get_columns(side.database or None, side.schema_name or None, side.table))


def estimated_rows(record, side: SideSpec) -> int | None:
    """Catalog row estimate (no table scan), or None."""
    from app.connectors.factory import get_compare_connector

    db_type = (record.db_type or "").lower()
    connector = get_compare_connector(record, role="meta")
    schema = side.schema_name or record.schema_name
    db = side.database or record.database

    def lit(v):
        return "'" + str(v).replace("'", "''") + "'"
    try:
        if db_type == "postgres":
            sql = (f"SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                   f"WHERE n.nspname={lit(schema or 'public')} AND c.relname={lit(side.table)}")
        elif db_type == "mysql":
            sql = f"SELECT table_rows FROM information_schema.tables WHERE table_schema={lit(db or schema)} AND table_name={lit(side.table)}"
        elif db_type == "sqlserver":
            pre = f"[{db.replace(']', ']]')}]." if db else ""
            sql = (f"SELECT SUM(p.rows) FROM {pre}sys.partitions p JOIN {pre}sys.tables t ON t.object_id=p.object_id "
                   f"JOIN {pre}sys.schemas s ON s.schema_id=t.schema_id WHERE p.index_id IN (0,1) "
                   f"AND s.name={lit(schema or 'dbo')} AND t.name={lit(side.table)}")
        elif db_type == "oracle":
            sql = f"SELECT num_rows FROM all_tables WHERE owner={lit(schema or (record.username or '').upper())} AND table_name={lit(side.table)}"
        elif db_type == "snowflake":
            pre = connector.dialect.quote_ident(db) + "." if db else ""
            sql = f"SELECT row_count FROM {pre}information_schema.tables WHERE table_schema={lit(schema)} AND table_name={lit(side.table)}"
        else:
            return None
        row = connector.execute_one(sql)
        return int(row[0]) if row and row[0] is not None and int(row[0]) >= 0 else None
    except Exception:
        return None

