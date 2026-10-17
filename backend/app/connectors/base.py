from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from contextlib import contextmanager
from typing import Any, Iterator

from app.db.store import Connection as ConnectionRecord


class ColumnInfo(dict):
    """Column metadata: {name, data_type, nullable, ordinal_position, is_numeric, is_temporal, is_string}."""


# Substrings (lower-cased) that, when seen in an exception message, indicate
# the underlying DB connection is no longer usable and should be dropped so
# the next call re-establishes it. Conservative on purpose - we only evict on
# clear "the connection is dead" signals, not on regular SQL errors.
_DEAD_CONNECTION_HINTS = (
    "connection already closed",
    "cursor's connection has been closed",
    "connection has been closed",
    "server closed the connection",
    "closed connection",
    "connection closed",
    "broken pipe",
    "connection reset",
    "operationalerror",
    "server has gone away",
    "not connected",
    "connection is closed",
    "lost connection",
    "08s01",       # SQL Server: communication link failure
    "08006",       # generic ANSI: connection failure
    "ora-03113",   # Oracle: end-of-file on communication channel
    "ora-03114",   # Oracle: not connected to ORACLE
    "ora-12537",   # Oracle: TNS: connection closed
    "390100",      # Snowflake: token expired
    "390114",      # Snowflake: authentication token has expired
    "390195",      # Snowflake: invalid master token
)


def _looks_like_dead_conn(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(hint in msg for hint in _DEAD_CONNECTION_HINTS)


# Substrings that indicate a PERMANENT failure - retrying will never help.
# We bail out immediately on these instead of wasting the retry budget.
_AUTH_FAILURE_HINTS = (
    "password",
    "authentication failed",
    "auth failed",
    "login failed",
    "access denied",
    "permission denied",
    "invalid username",
    "invalid user",
    "incorrect username",
    "role \"",  # Postgres: role "x" does not exist (checked with "does not exist" below)
    "ora-01017",   # Oracle: invalid username/password
    "ora-28000",   # Oracle: account locked
    "ora-28001",   # Oracle: password expired
    "28p01",       # Postgres: invalid password
    "18456",       # SQL Server: login failed
    "250001",      # Snowflake: incorrect username/password
)


def _looks_like_auth_failure(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if "role \"" in msg:
        return "does not exist" in msg
    return any(hint in msg for hint in _AUTH_FAILURE_HINTS if hint != "role \"")


class Connector(ABC):
    db_type: str = "base"

    def __init__(self, record: ConnectionRecord):
        self.record = record
        self._raw_password: str | None = None
        # Persistent underlying DB connection; lazily opened, reused across
        # every cursor() call until disposed or evicted.
        self._conn: Any | None = None
        # RLock so nested cursor() calls (rare but possible) don't deadlock.
        self._conn_lock = threading.RLock()

    @abstractmethod
    def connect(self) -> Any:
        """Open a new live connection to the source DB and return it.

        Subclasses must implement this. The base class caches the returned
        connection in ``self._conn`` and reuses it; ``connect()`` itself is
        only invoked on first use or after the previous connection died.
        """

    def _connect_with_retry(self) -> Any:
        """Open a NEW connection, retrying transient failures with backoff.

        Permanent failures (bad password, locked account, missing role)
        are detected via ``_looks_like_auth_failure`` and raised on the
        first attempt - no point retrying those. Everything else (network
        blips, brief timeouts, token-refresh races) gets up to
        ``settings.connect_retries`` extra attempts with linearly growing
        backoff. The last error is re-raised if all attempts fail.
        """
        import time as _t

        try:
            from app.config import settings
            retries = max(0, int(getattr(settings, "connect_retries", 2)))
            backoff = float(getattr(settings, "connect_retry_backoff", 1.5))
        except Exception:
            retries, backoff = 2, 1.5

        attempt = 0
        last_exc: BaseException | None = None
        while True:
            try:
                return self.connect()
            except Exception as exc:
                last_exc = exc
                # Never retry a clearly-permanent auth/permission failure.
                if _looks_like_auth_failure(exc):
                    raise
                attempt += 1
                if attempt > retries:
                    raise
                try:
                    _t.sleep(backoff * attempt)
                except Exception:
                    pass
        # Unreachable, but keeps type-checkers happy.
        if last_exc:
            raise last_exc

    def _get_or_open_conn(self) -> Any:
        """Return the cached connection, opening one lazily if needed."""
        if self._conn is None:
            self._conn = self._connect_with_retry()
        return self._conn

    def _is_alive(self, conn: Any) -> bool:
        """Cheap roundtrip to confirm a cached connection still works.

        Run a 1-row query that the dialect tells us is the right ping
        statement (Oracle ``SELECT 1 FROM DUAL``, others ``SELECT 1``).
        Returns False on ANY error - caller's job to drop and reopen.
        """
        try:
            cur = conn.cursor()
            try:
                cur.execute(self.dialect.ping_sql())
                cur.fetchone()
                return True
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
        except Exception:
            return False

    def _get_or_open_validated_conn(self) -> Any:
        """Like _get_or_open_conn but pings before reuse.

        When ``settings.validate_before_use`` is true (default), every
        call confirms the cached connection still responds. If not, drop
        and reopen. Catches silently-dead connections that the previous
        retry-on-cursor logic only noticed AFTER a failed cursor open.
        """
        try:
            from app.config import settings
            validate = bool(getattr(settings, "validate_before_use", True))
        except Exception:
            validate = True

        if self._conn is None:
            self._conn = self._connect_with_retry()
            return self._conn
        if validate and not self._is_alive(self._conn):
            # Stale - drop and reopen
            self._drop_conn()
            self._conn = self._connect_with_retry()
        return self._conn

    def _drop_conn(self) -> None:
        """Close and forget the cached connection (safe if already closed)."""
        c, self._conn = self._conn, None
        if c is not None:
            try:
                c.close()
            except Exception:
                pass

    def close(self, conn: Any | None = None) -> None:
        """Back-compat shim.

        Old code called ``self.close(conn)`` to explicitly close a connection
        returned by ``self.connect()``. With persistent connections we want
        that to be a no-op for the cached connection (otherwise we'd close
        it after every cursor block). Only close if ``conn`` is something
        other than the cached instance.
        """
        if conn is None or conn is self._conn:
            return
        try:
            conn.close()
        except Exception:
            pass

    def dispose(self, force: bool = False) -> None:
        """Public method: close the cached connection. Safe to call multiple times.

        ``force=False`` (default): acquires the connector lock first.
        Safe and orderly - waits for any in-flight cursor to finish.

        ``force=True``: SKIPS the lock and closes the underlying
        connection immediately. Use when the connector is wedged (a
        cursor is hung inside the driver, holding the lock forever).
        Closing the connection out from under the stuck cursor causes
        the driver to return an error from that operation, which then
        releases the lock cleanly.

        This is the escape hatch for the snowflake-driver-deadlock
        scenario: SHOW WAREHOUSES hangs in C code, lock held, normal
        dispose() can't make progress because it waits for the same
        lock. force=True bypasses that.
        """
        if force:
            c, self._conn = self._conn, None
            if c is not None:
                try:
                    c.close()
                except Exception:
                    pass
        else:
            with self._conn_lock:
                self._drop_conn()

    @contextmanager
    def cursor(self) -> Iterator[Any]:
        """Yield a cursor on the persistent connection.

        Auto-reconnects once if the connection appears dead. The cursor is
        closed at the end of the with-block, but the underlying connection
        is kept alive for the next caller.
        """
        with self._conn_lock:
            try:
                conn = self._get_or_open_validated_conn()
                cur = conn.cursor()
            except Exception as exc:
                # Open failed - drop and retry once (covers stale-cached connections).
                self._drop_conn()
                if not _looks_like_dead_conn(exc):
                    # Surface auth failures, network errors etc. immediately
                    # rather than retrying blindly.
                    raise
                conn = self._get_or_open_conn()
                cur = conn.cursor()

            dead = False
            try:
                yield cur
            except Exception as exc:
                if _looks_like_dead_conn(exc):
                    dead = True
                raise
            finally:
                try:
                    cur.close()
                except Exception:
                    pass
                if dead:
                    self._drop_conn()

    def test(self) -> dict:
        with self.cursor() as cur:
            cur.execute(self.dialect.ping_sql())
            row = cur.fetchone()
        return {"ok": True, "ping": str(row[0]) if row else None}

    def execute_one(self, sql: str) -> tuple | None:
        with self.cursor() as cur:
            cur.execute(sql)
            return cur.fetchone()

    def execute_rows(self, sql: str, limit: int | None = None) -> list[tuple]:
        with self.cursor() as cur:
            cur.execute(sql)
            if limit is None:
                return list(cur.fetchall())
            # Drain up to `limit` in bounded batches. A single
            # fetchmany(limit) under-reads on drivers that return only their
            # first internal buffer per call, so callers (e.g. file compare)
            # would silently get fewer rows than requested.
            out: list = []
            while len(out) < limit:
                want = min(50_000, limit - len(out))
                batch = cur.fetchmany(want)
                if not batch:
                    break
                out.extend(batch)
            return out

    def stream_rows(self, sql: str, batch_size: int = 50_000) -> Iterator[tuple]:
        with self.cursor() as cur:
            cur.execute(sql)
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    break
                for r in rows:
                    yield r

    # ----- metadata helpers (dialect-driven, can be overridden) -----

    def list_databases(self) -> list[str]:
        sql = self.dialect.list_databases_sql()
        return [r[0] for r in self.execute_rows(sql)]

    def list_schemas(self, database: str | None = None) -> list[str]:
        db = database or self.record.database
        sql = self.dialect.list_schemas_sql(db)
        return [r[0] for r in self.execute_rows(sql)]

    def list_tables(self, database: str | None = None, schema: str | None = None) -> list[str]:
        db = database or self.record.database
        sc = schema or self.record.schema_name
        sql = self.dialect.list_tables_sql(db, sc)
        return [r[0] for r in self.execute_rows(sql)]

    def get_columns(self, database: str | None, schema: str | None, table: str) -> list[ColumnInfo]:
        db = database or self.record.database
        sc = schema or self.record.schema_name
        sql = self.dialect.schema_columns_sql(db, sc, table)
        rows = self.execute_rows(sql)
        out: list[ColumnInfo] = []
        for r in rows:
            name, dtype, nullable, ordinal = r[0], r[1], r[2], r[3]
            # New fields (positions 4, 5, 6) - may be absent on older
            # dialect implementations that only SELECT 4 columns.
            char_max_length = r[4] if len(r) > 4 else None
            numeric_precision = r[5] if len(r) > 5 else None
            numeric_scale = r[6] if len(r) > 6 else None
            dtype_u = (dtype or "").upper()
            is_numeric = any(k in dtype_u for k in ("INT", "NUMBER", "NUMERIC", "DECIMAL", "FLOAT", "DOUBLE", "REAL", "MONEY", "BIT"))
            is_temporal = any(k in dtype_u for k in ("DATE", "TIME", "TIMESTAMP"))
            is_string = any(k in dtype_u for k in ("CHAR", "TEXT", "STRING", "CLOB", "VARCHAR"))
            out.append(ColumnInfo(
                name=name,
                data_type=dtype,
                nullable=str(nullable).upper() in ("Y", "YES", "TRUE", "1"),
                ordinal_position=ordinal,
                is_numeric=is_numeric,
                is_temporal=is_temporal,
                is_string=is_string,
                char_max_length=int(char_max_length) if char_max_length is not None else None,
                numeric_precision=int(numeric_precision) if numeric_precision is not None else None,
                numeric_scale=int(numeric_scale) if numeric_scale is not None else None,
            ))
        return out

    @property
    @abstractmethod
    def dialect(self):
        """Returns the SQL dialect instance for this connector."""
