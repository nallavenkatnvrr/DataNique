from __future__ import annotations

import hashlib
import threading
import time

from app.connectors.base import Connector
from app.db.store import Connection as ConnectionRecord


SUPPORTED_DB_TYPES = ["snowflake", "oracle", "sqlserver", "postgres", "mysql"]


# --------------------------------------------------------------------------
# Connector instance cache
#
# Why this exists: without caching, every HTTP request (browse databases,
# browse schemas, browse tables, run compare) calls ``get_connector(record)``
# which builds a fresh Connector and hence a fresh DB login. For Snowflake
# external-browser SSO that means a browser pop-up on every single click.
#
# With caching, the first request for a given connection record performs
# the login and stashes the Connector. Subsequent requests reuse it -
# including the now-persistent underlying DB connection inside the Connector
# (see ``Connector._conn`` in base.py).
#
# Invalidation:
#   * The connection record is edited      -> ``evict_connector(id)``
#   * The connection record is deleted     -> ``evict_connector(id)``
#   * Process restart                      -> cache is empty, full re-login
#
# We also key the cache on a fingerprint of the record's connection-affecting
# fields, so if the record is edited via a code path that forgets to call
# ``evict_connector``, the cached entry is still detected as stale and
# rebuilt rather than silently using the old credentials.
# --------------------------------------------------------------------------

# Cache key is (record_id, purpose). Each (record, section) pair gets its
# OWN Connector instance with its OWN underlying DB session. This isolates:
#
#   - SQL IDE session state (USE WAREHOUSE, session vars, temp tables)
#     from Compare runs and from metadata browsing
#   - Long-running Compare runs from short metadata/SQL-IDE work
#     (different lock instances = no head-of-line blocking)
#
# Edit/delete of a connection record evicts ALL purposes for that record.
#
# Default purposes used across the codebase:
#   - "sql_ide:<session_id>" — isolated SQL IDE tab execution/session state
#   - "sql_ide"   — SQL IDE generation helpers
#   - "compare"   — Compare engines (DuckDB / Pandas / Spark / Trino)
#   - "metadata"  — list databases/schemas/tables/columns + Snowflake context
#   - "test"      — Test Connection endpoint (kept separate so failed tests
#                   don't poison the operational sessions)
#   - "default"   — fallback if a caller doesn't specify
#
# Snowflake-specific note: with token caching (client_store_temporary_
# credential=True) the first SSO browser pop covers ALL purposes for that
# account; subsequent logins are silent.
# --------------------------------------------------------------------------

_cache_lock = threading.Lock()
_connector_cache: dict[tuple[int, str], tuple[Connector, str]] = {}

# Per-(record_id, purpose) creation locks so two concurrent requests for
# the same (connection, section) don't both build a fresh Connector (and
# both pop a browser for SSO). Different (record, purpose) combos can
# still be built concurrently.
_creation_locks: dict[tuple[int, str], threading.Lock] = {}
_creation_locks_lock = threading.Lock()


def _record_fingerprint(record: ConnectionRecord) -> str:
    """Hash of the fields that, if changed, must invalidate the cached connector."""
    parts: list[str] = [
        record.db_type or "",
        record.host or "",
        str(record.port or ""),
        record.username or "",
        record.database or "",
        record.schema_name or "",
        str(record.extra or {}),
        record.password_enc or "",
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _lock_for(record_id: int, purpose: str) -> threading.Lock:
    """Return (creating if needed) the per-(record_id, purpose) creation lock."""
    key = (record_id, purpose)
    with _creation_locks_lock:
        lock = _creation_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _creation_locks[key] = lock
        return lock


def _build_connector(record: ConnectionRecord) -> Connector:
    """Construct a Connector for the given record (no caching)."""
    db_type = (record.db_type or "").lower()
    if db_type == "snowflake":
        from app.connectors.snowflake_conn import SnowflakeConnector
        return SnowflakeConnector(record)
    if db_type == "oracle":
        from app.connectors.oracle_conn import OracleConnector
        return OracleConnector(record)
    if db_type == "sqlserver":
        from app.connectors.sqlserver_conn import SqlServerConnector
        return SqlServerConnector(record)
    if db_type == "postgres":
        from app.connectors.postgres_conn import PostgresConnector
        return PostgresConnector(record)
    if db_type == "mysql":
        from app.connectors.mysql_conn import MySqlConnector
        return MySqlConnector(record)
    raise ValueError(f"Unsupported db_type: {db_type!r}")


def get_connector(record: ConnectionRecord, purpose: str = "default") -> Connector:
    """Return a cached Connector for this (record, purpose), building one if needed.

    ``purpose`` namespaces the cache so each section of the app gets its own
    isolated DB session. Callers should pass one of the well-known purpose
    strings ("sql_ide", "compare", "metadata", "test") so the maintenance
    behaviour (heartbeat, eviction, logging) can reason about them. Custom
    strings work too — they just become their own slot.

    ``record.id <= 0`` (used by the "test unsaved connection" endpoint) is
    treated as uncacheable - each call builds a fresh Connector that the
    caller is responsible for disposing.
    """
    if record.id is None or record.id <= 0:
        return _build_connector(record)

    fingerprint = _record_fingerprint(record)
    cache_key = (record.id, purpose)

    # Fast path: already cached AND fingerprint matches.
    with _cache_lock:
        cached = _connector_cache.get(cache_key)
        if cached and cached[1] == fingerprint:
            return cached[0]

    # Slow path: serialize per-(record, purpose) so two concurrent requests
    # don't both build a Connector (and for SSO both pop a browser). A
    # different (record, purpose) combo can still build concurrently.
    old_connector: Connector | None = None
    creation_lock = _lock_for(record.id, purpose)
    with creation_lock:
        # Re-check inside the creation lock - another waiter may have built it.
        with _cache_lock:
            cached = _connector_cache.get(cache_key)
            if cached and cached[1] == fingerprint:
                return cached[0]
            if cached:
                old_connector = cached[0]

        new_connector = _build_connector(record)

        with _cache_lock:
            _connector_cache[cache_key] = (new_connector, fingerprint)

    # Dispose any superseded connector outside the locks.
    if old_connector is not None:
        try:
            old_connector.dispose()
        except Exception:
            pass

    # Lazy-start the background heartbeat the first time we cache
    # anything. Idempotent — safe to call repeatedly.
    _start_heartbeat_thread()

    return new_connector


# --------------------------------------------------------------------------
# Optional connection pooling (opt-in via DV_CONNECTION_POOL_ENABLED)
#
# The default model is one connector per (record_id, purpose). When pooling
# is enabled, the "compare" purpose for a password-auth DB can hand out up to
# ``connection_pool_size`` connectors so concurrent compare runs against the
# SAME connection don't serialize on a single connector lock.
#
# Pool slots are stored in the regular cache under purposes "compare#0",
# "compare#1", ... so eviction (which matches on record_id) and the heartbeat
# both pick them up for free. Snowflake is excluded — extra sessions risk an
# SSO browser pop-up — and always uses the single shared "compare" slot.
# --------------------------------------------------------------------------

_POOLABLE_PURPOSES = {"compare"}


def _pool_enabled() -> tuple[bool, int]:
    try:
        from app.config import settings
        return bool(getattr(settings, "connection_pool_enabled", False)), \
            max(1, int(getattr(settings, "connection_pool_size", 2) or 2))
    except Exception:
        return False, 1


def _get_pooled_connector(record: ConnectionRecord, purpose: str) -> Connector:
    """Return an idle connector from the (record, purpose) pool, growing it up
    to ``pool_size``. If every slot is busy, fall back to the least-recently
    contended slot (round-robin) so callers never block here — the connector's
    own lock still serializes actual query execution on that slot.
    """
    _enabled, pool_size = _pool_enabled()
    fingerprint = _record_fingerprint(record)

    # 1) Reuse an existing idle slot (lock not currently held).
    existing_slots: list[int] = []
    with _cache_lock:
        for (rid, pur), (_conn, _fp) in _connector_cache.items():
            if rid == record.id and pur.startswith(purpose + "#") and _fp == fingerprint:
                try:
                    rest = pur[len(purpose) + 1:]
                    if "#" in rest:
                        continue  # another role's slot (e.g. compare#src#0 vs compare#src)
                    existing_slots.append(int(rest))
                except ValueError:
                    continue
    existing_slots.sort()

    for slot in existing_slots:
        slot_purpose = f"{purpose}#{slot}"
        with _cache_lock:
            cached = _connector_cache.get((record.id, slot_purpose))
        if not cached:
            continue
        conn = cached[0]
        lock = getattr(conn, "_conn_lock", None)
        if lock is None:
            return conn
        # Probe without blocking — if free right now, take it.
        if lock.acquire(timeout=0.0):
            lock.release()
            return conn

    # 2) Grow the pool if there's room.
    if len(existing_slots) < pool_size:
        next_slot = 0
        used = set(existing_slots)
        while next_slot in used:
            next_slot += 1
        return get_connector(record, purpose=f"{purpose}#{next_slot}")

    # 3) All slots busy — round-robin to spread load (execution still
    #    serializes on whichever slot's lock, but never blocks here).
    import random
    chosen = random.choice(existing_slots) if existing_slots else 0
    return get_connector(record, purpose=f"{purpose}#{chosen}")


def get_compare_connector(
    record: ConnectionRecord,
    role: str | None = None,
) -> Connector:
    """Connector for a compare run.

    ``role`` (e.g. ``"src"``, ``"tgt"``) gives each side of a compare
    its own DB session.  This is **critical** when source and target share
    the same connection record: without it, the Connector's ``_conn_lock``
    forces the two fetches to serialize on one TCP session, doubling total
    fetch time and exposing the idle connection to network-level timeouts
    (firewalls, NAT, load-balancers) that produce ``"The cursor's
    connection has been closed"``.

    When ``role`` is set the purpose becomes ``"compare#<role>"`` so each
    side gets a separate cache slot (and thus a separate underlying DB
    session).  Eviction and heartbeat cover these slots automatically
    because they match on ``record_id``.

    When the opt-in pool (``DV_CONNECTION_POOL_ENABLED``) is also on, the
    pool logic runs on top of the role-scoped purpose — the two features
    compose safely.
    """
    purpose = f"compare#{role}" if role else "compare"
    enabled, _size = _pool_enabled()
    db_type = (getattr(record, "db_type", "") or "").lower()
    if (enabled and "compare" in _POOLABLE_PURPOSES
            and db_type != "snowflake"
            and record.id is not None and record.id > 0):
        try:
            return _get_pooled_connector(record, purpose)
        except Exception:
            # Any pooling hiccup → fall back to the single shared connector.
            pass
    return get_connector(record, purpose=purpose)


def evict_connector(connection_id: int, purpose: str | None = None, force: bool = True) -> None:
    """Drop cached Connectors for this record.

    If ``purpose`` is None (the default), ALL purposes for this record
    are evicted. This is what router code wants on connection edit/delete
    — every cached derivative of that record must go.

    Pass a specific purpose only when you want to surgically invalidate
    just one slot (e.g. an SQL IDE session ended and is being cleaned up).

    ``force=True`` (default): bypass the connector's internal lock when
    disposing. Essential when a connector is wedged (cursor hung inside
    the driver, holding the lock). Without force, dispose() would block
    waiting for the same lock and the eviction itself would hang.
    Setting force=False is only useful in rare cases where you know the
    connector is idle.
    """
    to_dispose: list = []
    with _cache_lock:
        if purpose is not None:
            key = (connection_id, purpose)
            cached = _connector_cache.pop(key, None)
            if cached is not None:
                to_dispose.append(cached[0])
        else:
            for key in list(_connector_cache.keys()):
                if key[0] == connection_id:
                    cached = _connector_cache.pop(key, None)
                    if cached is not None:
                        to_dispose.append(cached[0])
    for c in to_dispose:
        try:
            c.dispose(force=force)
        except Exception:
            pass


def evict_compare_connectors(connection_id: int, force: bool = True) -> list[str]:
    """Evict comparison-only slots for one connection and return their purposes.

    This covers the standard ``compare`` slot, role/pool descendants such as
    ``compare#src#0``, the explicit ``checksum`` slot, and the legacy ``default``
    slot used by the current checksum engine. SQL IDE, metadata, and test slots
    are left untouched. ``force`` is passed to each connector disposal.
    """
    to_dispose: list[tuple[str, Connector]] = []
    with _cache_lock:
        for key in list(_connector_cache):
            record_id, purpose = key
            if record_id != connection_id:
                continue
            is_compare_slot = (
                purpose == "compare"
                or purpose.startswith("compare#")
                or purpose == "checksum"
                or purpose.startswith("checksum#")
                or purpose == "default"
            )
            if is_compare_slot:
                cached = _connector_cache.pop(key, None)
                if cached is not None:
                    to_dispose.append((purpose, cached[0]))
    for _purpose, connector in to_dispose:
        try:
            connector.dispose(force=force)
        except Exception:
            pass
    return [purpose for purpose, _connector in to_dispose]


def evict_all(force: bool = True) -> None:
    """Drop every cached Connector. Useful on shutdown or full reset."""
    with _cache_lock:
        items = list(_connector_cache.values())
        _connector_cache.clear()
    for conn, _ in items:
        try:
            conn.dispose(force=force)
        except Exception:
            pass


# --------------------------------------------------------------------------
# Background heartbeat
#
# Why: even with driver-level TCP keepalives, some corporate networks
# (firewalls, NAT timeouts, load balancers) drop sessions that don't
# move APPLICATION-LEVEL traffic for N minutes. The DuckDB compare flow
# is particularly vulnerable: while we fetch source for 5-15 min, the
# target connection sits idle. By the time we go to use it, the server
# may have already closed it.
#
# Our existing ``validate_before_use`` ping catches this lazily on the
# next use — but a fresh login takes several seconds and (for SSO) can
# pop a browser. Better to send a cheap ``SELECT 1`` proactively every
# few minutes so the connection never goes silent.
#
# This is one daemon thread that walks the cache and pings each
# Connector in turn, holding each Connector's lock just for the
# millisecond the ping takes. A long-running query holds the lock for
# the duration of the query, so the heartbeat is naturally skipped
# while real work is in progress (the lock acquisition blocks; we time
# out fast and move on to the next connector). Result: the thread is
# self-throttling and never disrupts active operations.
# --------------------------------------------------------------------------

_heartbeat_thread: threading.Thread | None = None
_heartbeat_stop = threading.Event()

# Per-(record_id, purpose) timestamp of the last successful ping. Used
# by /api/health/detailed so the user can see which cached connectors
# are healthy vs stale.
_last_heartbeat_per_key: dict[tuple[int, str], float] = {}


def get_cache_snapshot() -> list[dict]:
    """Read-only snapshot of the connector cache for diagnostics. No
    locks held while returning — caller gets immutable point-in-time
    data."""
    with _cache_lock:
        entries = list(_connector_cache.items())
    now = time.time()
    out: list[dict] = []
    for (record_id, purpose), (connector, fp) in entries:
        last_hb = _last_heartbeat_per_key.get((record_id, purpose))
        lock = getattr(connector, "_conn_lock", None)
        # Probe lock without blocking — tells us if a query is in flight
        in_use = False
        if lock is not None:
            in_use = not lock.acquire(timeout=0.0)
            if not in_use:
                lock.release()
        out.append({
            "connection_id": record_id,
            "purpose": purpose,
            "db_type": getattr(connector, "db_type", None),
            "has_open_conn": getattr(connector, "_conn", None) is not None,
            "in_use_right_now": in_use,
            "last_heartbeat_ms_ago": int((now - last_hb) * 1000) if last_hb else None,
            "fingerprint_short": (fp or "")[:12],
        })
    return out


def is_heartbeat_alive() -> bool:
    """For diagnostics — whether the background heartbeat thread is running."""
    return _heartbeat_thread is not None and _heartbeat_thread.is_alive()


def _heartbeat_loop() -> None:
    """Main heartbeat loop. Wrapped in a defensive try/except at every
    level so an unexpected exception in ONE iteration doesn't silently
    kill the whole thread — the watchdog can also restart it if it
    does die. We log every crash so it's never invisible."""
    import logging
    log = logging.getLogger("dv.heartbeat")

    try:
        from app.config import settings
    except Exception:
        settings = None  # type: ignore

    while not _heartbeat_stop.is_set():
        try:
            try:
                interval = int(getattr(settings, "heartbeat_seconds", 240) or 0) if settings else 0
            except Exception:
                interval = 240

            if interval <= 0:
                if _heartbeat_stop.wait(60):
                    return
                continue

            if _heartbeat_stop.wait(interval):
                return

            # Snapshot the cache so we don't hold _cache_lock while pinging.
            with _cache_lock:
                entries = list(_connector_cache.items())

            for cache_key, (connector, _fp) in entries:
                if _heartbeat_stop.is_set():
                    return
                try:
                    lock = getattr(connector, "_conn_lock", None)
                    if lock is None:
                        continue
                    acquired = lock.acquire(timeout=1.0)
                    if not acquired:
                        continue
                    try:
                        if getattr(connector, "_conn", None) is None:
                            continue
                        # NOTE: ping success and timestamp recording are
                        # split into TWO try blocks. Bookkeeping failures
                        # (e.g., a future bug in _last_heartbeat_per_key)
                        # must NEVER look like a ping failure — that would
                        # cause us to drop a perfectly healthy connection.
                        # See phase 4.24: this was the exact bug that
                        # silently killed cached connectors when a missing
                        # `import time` made `time.time()` throw NameError
                        # right after a successful ping.
                        ping_ok = False
                        try:
                            cur = connector._conn.cursor()
                            try:
                                cur.execute(connector.dialect.ping_sql())
                                cur.fetchone()
                                ping_ok = True
                            finally:
                                try:
                                    cur.close()
                                except Exception:
                                    pass
                        except Exception as ping_exc:
                            log.warning(
                                "Connector %s ping failed: %s — dropping cached conn",
                                cache_key, ping_exc,
                            )
                            try:
                                connector._drop_conn()
                            except Exception:
                                pass

                        # Bookkeeping is best-effort and isolated from the
                        # ping outcome.
                        if ping_ok:
                            try:
                                _last_heartbeat_per_key[cache_key] = time.time()
                            except Exception as rec_exc:
                                log.warning(
                                    "Failed to record heartbeat timestamp for %s "
                                    "(this is harmless, connection stays cached): %s",
                                    cache_key, rec_exc,
                                )
                    finally:
                        lock.release()
                except Exception as inner_exc:
                    # Single-connector failure — log and continue, never propagate.
                    log.exception("Heartbeat error for %s: %s", cache_key, inner_exc)
        except Exception as outer_exc:
            # Catastrophic per-iteration failure — log and keep looping.
            # The thread MUST NOT die silently.
            log.exception("Heartbeat iteration crashed (continuing): %s", outer_exc)
            # Brief pause so a wedged failure doesn't tight-loop
            if _heartbeat_stop.wait(10):
                return


def _start_heartbeat_thread() -> None:
    """Start the background heartbeat if it's not running. Safe to call
    repeatedly; idempotent."""
    global _heartbeat_thread
    if _heartbeat_thread is not None and _heartbeat_thread.is_alive():
        return
    _heartbeat_stop.clear()
    _heartbeat_thread = threading.Thread(
        target=_heartbeat_loop,
        name="dv-conn-heartbeat",
        daemon=True,
    )
    _heartbeat_thread.start()


def stop_heartbeat_thread() -> None:
    """Stop the heartbeat. Used on graceful shutdown."""
    _heartbeat_stop.set()


def db_type_metadata() -> list[dict]:
    return [
        {
            "type": "snowflake",
            "label": "Snowflake",
            "fields": [
                {"key": "extra.account", "label": "Account", "required": True, "placeholder": "abc-xy12345"},
                {"key": "username", "label": "User", "required": False},
                {
                    "key": "extra.authenticator",
                    "label": "Authenticator",
                    "required": False,
                    "default": "snowflake",
                    "options": [
                        {"value": "snowflake",       "label": "Password (default)"},
                        {"value": "externalbrowser", "label": "SSO - external browser"},
                        {"value": "oauth",           "label": "OAuth (token in password field)"},
                        {"value": "snowflake_jwt",   "label": "Key-pair (JWT)"},
                        {"value": "okta_url",        "label": "Native Okta URL (paste below)"},
                    ],
                    "help": (
                        "Choose 'SSO - external browser' for Okta/Azure-AD SSO. "
                        "Browser-based SSO opens on the machine running the backend. "
                        "The SSO token is cached so the browser pops at most once per session."
                    ),
                },
                {
                    "key": "password",
                    "label": "Password / OAuth token / Key passphrase",
                    "required": False,
                    "secret": True,
                    "help": (
                        "Leave blank for externalbrowser. For OAuth paste the bearer token. "
                        "For snowflake_jwt, optional passphrase for the private key."
                    ),
                },
                {"key": "database", "label": "Database", "required": True},
                {"key": "schema_name", "label": "Schema", "required": False},
                {"key": "extra.warehouse", "label": "Warehouse", "required": False},
                {"key": "extra.role", "label": "Role", "required": False},
                {
                    "key": "extra.private_key_path",
                    "label": "Private key path (snowflake_jwt only)",
                    "required": False,
                    "placeholder": "/path/to/rsa_key.p8",
                },
                {
                    "key": "extra.login_timeout",
                    "label": "Login timeout (sec)",
                    "required": False,
                    "type": "number",
                    "default": 120,
                },
            ],
        },
        {
            "type": "oracle",
            "label": "Oracle",
            "fields": [
                {"key": "host", "label": "Host", "required": True},
                {"key": "port", "label": "Port", "required": False, "default": 1521, "type": "number"},
                {"key": "username", "label": "User", "required": True},
                {"key": "password", "label": "Password", "required": True, "secret": True},
                {"key": "extra.service_name", "label": "Service Name", "required": False},
                {"key": "extra.sid", "label": "SID (if no service)", "required": False},
                {"key": "extra.dsn", "label": "Raw DSN (overrides host/service)", "required": False},
            ],
        },
        {
            "type": "sqlserver",
            "label": "SQL Server",
            "fields": [
                {"key": "host", "label": "Host", "required": True,
                 "placeholder": "HOSTNAME or HOSTNAME\\INSTANCE"},
                {"key": "port", "label": "Port", "required": False, "default": 1433, "type": "number",
                 "placeholder": "leave blank for named-instance Browser service"},
                {"key": "extra.auth_mode", "label": "Authentication", "required": False,
                 "default": "sql",
                 "options": [
                    {"value": "sql", "label": "SQL Server Authentication"},
                    {"value": "windows", "label": "Windows Authentication (Trusted_Connection)"},
                    {"value": "ntlm", "label": "NTLM (domain user + password, like DBeaver)"},
                    {"value": "ad_password", "label": "Active Directory - Password"},
                    {"value": "ad_integrated", "label": "Active Directory - Integrated"},
                    {"value": "ad_interactive", "label": "Active Directory - Interactive (MFA)"},
                    {"value": "ad_msi", "label": "Active Directory - MSI"},
                    {"value": "ad_service_principal", "label": "Active Directory - Service Principal"},
                 ]},
                {"key": "username", "label": "User", "required": False,
                 "placeholder": "ignored for Windows/Integrated/MSI modes"},
                {"key": "password", "label": "Password", "required": False, "secret": True,
                 "placeholder": "ignored for Windows/Integrated/MSI modes"},
                {"key": "extra.domain", "label": "Domain (NTLM)", "required": False,
                 "placeholder": "e.g. CORP — only for NTLM auth",
                 "help": "NTLM domain. Folded into the username as DOMAIN\\user."},
                {"key": "extra.use_integrated_security", "label": "Use integrated security (NTLM)",
                 "type": "boolean", "default": False,
                 "help": "NTLM: authenticate as the current Windows session (SSPI) and ignore the username/password. Enables the fast ConnectorX path."},
                {"key": "database", "label": "Database", "required": True},
                {"key": "extra.driver", "label": "ODBC Driver", "required": False,
                 "placeholder": "leave blank to auto-detect newest installed"},
                {"key": "extra.encrypt", "label": "Encrypt", "required": False, "default": "yes"},
                {"key": "extra.trust_server_certificate", "label": "Trust Server Certificate",
                 "required": False, "default": "yes"},
            ],
        },
        {
            "type": "postgres",
            "label": "PostgreSQL",
            "fields": [
                {"key": "host", "label": "Host", "required": True},
                {"key": "port", "label": "Port", "required": False, "default": 5432, "type": "number"},
                {"key": "username", "label": "User", "required": True},
                {"key": "password", "label": "Password", "required": True, "secret": True},
                {"key": "database", "label": "Database", "required": True},
                {"key": "schema_name", "label": "Default Schema", "required": False, "default": "public"},
            ],
        },
        {
            "type": "mysql",
            "label": "MySQL",
            "fields": [
                {"key": "host", "label": "Host", "required": True},
                {"key": "port", "label": "Port", "required": False, "default": 3306, "type": "number"},
                {"key": "username", "label": "User", "required": True},
                {"key": "password", "label": "Password", "required": True, "secret": True},
                {"key": "database", "label": "Database", "required": True},
            ],
        },
    ]
