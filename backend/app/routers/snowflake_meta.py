"""Snowflake-specific metadata endpoints.

Snowsight (Snowflake's modern web UI) shows the user dropdown pickers for
Role / Warehouse / Database / Schema, populated from the live account.
This router exposes the same lists so the SQL IDE can offer the same UX.

The endpoints are deliberately namespaced under
``/api/connections/{id}/snowflake/`` so they don't clash with the generic
``/databases`` / ``/schemas`` endpoints in ``metadata.py`` - those work
for every connector, while these only make sense for Snowflake.

Important privilege note: Snowflake's SHOW commands are filtered by
your active role's grants:
  - SHOW WAREHOUSES - only warehouses with USAGE granted to your role
  - SHOW ROLES      - only roles granted to your user
  - SHOW DATABASES  - only databases with USAGE granted to your role
  - SHOW SCHEMAS    - only schemas with USAGE granted to your role
So if you "only see warehouses with my username in them", it's because
those are the only ones your account has access to - not a bug here.

Timing model (phase 4.18):
  - WARM-UP step has its own 90s budget - covers the FIRST SSO browser
    handshake or token-cache refresh that a freshly-created "metadata"
    purpose connector (introduced in phase 4.16) needs to perform.
  - Once warm, SHOW queries run sequentially with 10s each - they're
    sub-second on a warm connection.
  - On warm-up timeout, the user sees a CLEAR error saying "Snowflake
    login did not complete in 90s; check for a hidden browser popup",
    not a vague "Timed out after 15s".
"""
from __future__ import annotations

import concurrent.futures
import logging
import time

from fastapi import APIRouter, HTTPException

from app.connectors.factory import get_connector
from app.db.store import Connection as ConnectionRecord, get_session

log = logging.getLogger(__name__)


router = APIRouter(prefix="/api/connections", tags=["snowflake-meta"])


# Dedicated worker pool so SHOW queries from the picker don't share
# threads with the compare engines or query execution.
_META_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=8, thread_name_prefix="dv-sf-meta"
)


# Budgets. WARM-UP is generous because SSO needs it; per-SHOW was 10s
# but enterprise accounts with hundreds of roles/databases can take
# 15-20s (especially over VPN), so 30s is the safe default.
_WARMUP_TIMEOUT_S = 90
_PER_SHOW_TIMEOUT_S = 30


def _load(conn_id: int) -> ConnectionRecord:
    session = get_session()
    try:
        rec = session.get(ConnectionRecord, conn_id)
        if not rec:
            raise HTTPException(404, "Connection not found")
        return rec
    finally:
        session.close()


def _require_snowflake(rec: ConnectionRecord) -> None:
    if (rec.db_type or "").lower() != "snowflake":
        raise HTTPException(
            400,
            f"This endpoint is only valid for Snowflake connections (got {rec.db_type!r})"
        )


def _show_by_name(connector, sql: str) -> list[str]:
    """Run ``SHOW`` and return values from the ``name`` column.

    Snowflake's SHOW commands return varying column layouts (e.g. SHOW
    WAREHOUSES has ``name`` as column 0; SHOW ROLES has it as column 1).
    Looking up by column name is the only robust way.
    """
    with connector.cursor() as cur:
        cur.execute(sql)
        desc = cur.description or []
        rows = cur.fetchall() or []
    name_idx = None
    for i, d in enumerate(desc):
        col_name = (d[0] if isinstance(d, (list, tuple)) else getattr(d, "name", "")) or ""
        if col_name.lower() == "name":
            name_idx = i
            break
    if name_idx is None:
        name_idx = 0
    return [str(r[name_idx]) for r in rows if r[name_idx] is not None]


def _warm_up_connection(connector, budget_s: int = _WARMUP_TIMEOUT_S) -> tuple[bool, str | None, int]:
    """Force the connector to perform its full login + ping cycle.

    This is the step that takes 10-30s on a fresh "metadata" purpose
    slot (phase 4.16 introduced separate slots per section). On a
    warm connector this returns in ~10ms.

    Returns (ok, error_message, elapsed_ms). Times out cleanly at the
    budget - no perpetual hang.
    """
    t0 = time.perf_counter()
    log.info("[snowflake-meta] Warming up connector (budget=%ds)...", budget_s)
    future = _META_POOL.submit(
        lambda: connector.execute_one("SELECT CURRENT_SESSION()")
    )
    try:
        future.result(timeout=budget_s)
        elapsed = int((time.perf_counter() - t0) * 1000)
        log.info("[snowflake-meta] Warm-up OK in %d ms", elapsed)
        return True, None, elapsed
    except concurrent.futures.TimeoutError:
        elapsed = int((time.perf_counter() - t0) * 1000)
        msg = (
            f"Snowflake login did not complete within {budget_s}s. "
            f"For SSO (externalbrowser): a browser popup may have opened "
            f"on the backend machine but is hidden or was dismissed - "
            f"check the backend console for a Snowflake login URL, or "
            f"look for an open browser window. "
            f"For password/OAuth: check credentials and account URL."
        )
        log.warning("[snowflake-meta] Warm-up TIMED OUT after %d ms: %s", elapsed, msg)
        return False, msg, elapsed
    except Exception as exc:
        elapsed = int((time.perf_counter() - t0) * 1000)
        msg = f"{type(exc).__name__}: {exc!s:.300}"
        log.warning("[snowflake-meta] Warm-up FAILED in %d ms: %s", elapsed, msg)
        return False, msg, elapsed


@router.get("/{conn_id}/snowflake/context")
def get_snowflake_context(conn_id: int, database: str | None = None) -> dict:
    """List warehouses, roles, databases, schemas, plus current session context.

    Two-phase execution:

    1. WARM-UP (up to 90s) - forces the connector to complete its login
       cycle. This is where SSO popups happen on first call to a new
       section-scoped slot.

    2. SHOW queries (10s each, sequential) - only run if warm-up
       succeeded. They share the connector's lock so parallel dispatch
       wouldn't help anyway.

    Each step's result is reported separately in ``diagnostics`` so the
    frontend can show "Warming up..." vs "Querying lists..." vs the
    final result. If warm-up fails, the lists are returned empty with
    a clear error explaining the SSO/login situation - no perpetual
    "Loading..." spinner.

    Privilege filtering is Snowflake's own: SHOW WAREHOUSES returns only
    warehouses the active role can USE, SHOW ROLES returns roles granted
    to the user, etc. An empty list means "your role has no access".
    """
    rec = _load(conn_id)
    _require_snowflake(rec)
    connector = get_connector(rec, purpose="metadata")

    # --- Phase 1: warm-up. The first call to a freshly cached
    #     "metadata" connector may need to do SSO. Give it a real
    #     budget instead of bleeding it from the SHOW timeouts.
    warm_ok, warm_err, warm_ms = _warm_up_connection(connector)

    if not warm_ok:
        # The connector is wedged - almost always because a previous
        # query (typically SHOW WAREHOUSES) is stuck inside the
        # snowflake driver, holding the connector's lock. Auto-evict
        # with force=True so the next call gets a fresh connector.
        # This is the escape hatch for the driver-level deadlock that
        # phases 4.17-4.19 left the user stuck inside.
        log.warning(
            "[snowflake-meta] Warm-up failed - force-evicting wedged 'metadata' "
            "connector so the next call starts fresh. (conn_id=%s)", conn_id,
        )
        try:
            from app.connectors.factory import evict_connector
            evict_connector(conn_id, purpose="metadata", force=True)
        except Exception as exc:
            log.warning("[snowflake-meta] Force-evict failed: %s", exc)

        # Don't even attempt SHOW queries - they'd hit the same lock.
        # Tell the user clearly: a previous query is stuck, NOT that
        # SSO failed. The connector has been evicted; tell them to
        # retry.
        return {
            "warehouses": [], "roles": [], "databases": [], "schemas": [],
            "current": {"warehouse": None, "role": None, "database": None, "schema": None},
            "diagnostics": {
                "warmup":     {"ok": False, "error": warm_err, "elapsed_ms": warm_ms},
                "warehouses": {"ok": False, "error": "Skipped: connector wedged",  "elapsed_ms": 0},
                "roles":      {"ok": False, "error": "Skipped: connector wedged",  "elapsed_ms": 0},
                "databases":  {"ok": False, "error": "Skipped: connector wedged",  "elapsed_ms": 0},
                "schemas":    None,
                "current":    {"ok": False, "error": "Skipped: connector wedged"},
            },
            # NEW flag: the connector has been force-evicted, so the
            # next call to /context starts with a fresh connection.
            # The frontend can auto-retry once when it sees this.
            "evicted_and_ready_for_retry": True,
            "note": (
                "The Snowflake metadata connection got wedged - most likely a "
                "previous SHOW query hung inside the driver. The connector has "
                "been force-evicted and the next call will start fresh. Click "
                "refresh once and the lists should populate. If it wedges "
                "AGAIN, your role's SHOW WAREHOUSES is timing out at the "
                "Snowflake server - try changing role to one with simpler "
                "warehouse grants (or SYSADMIN if available)."
            ),
        }

    # --- Phase 2: SHOW queries, on a known-warm connection.
    tasks: list[tuple[str, callable]] = [
        ("warehouses", lambda: _show_by_name(connector, "SHOW WAREHOUSES")),
        ("roles",      lambda: _show_by_name(connector, "SHOW ROLES")),
        ("databases",  lambda: _show_by_name(connector, "SHOW DATABASES")),
    ]
    if database:
        db_quoted = '"' + database.replace('"', '""') + '"'
        tasks.append(("schemas",
                      lambda dbq=db_quoted: _show_by_name(connector, f"SHOW SCHEMAS IN DATABASE {dbq}")))

    results: dict[str, dict] = {}
    saw_timeout = False
    for label, fn in tasks:
        t0 = time.perf_counter()
        future = _META_POOL.submit(fn)
        try:
            data = future.result(timeout=_PER_SHOW_TIMEOUT_S)
            elapsed = int((time.perf_counter() - t0) * 1000)
            log.info("[snowflake-meta] SHOW %s OK: %d rows in %d ms", label, len(data), elapsed)
            results[label] = {"ok": True, "data": data, "error": None, "elapsed_ms": elapsed}
        except concurrent.futures.TimeoutError:
            saw_timeout = True
            results[label] = {
                "ok": False, "data": [],
                "error": (
                    f"SHOW {label.upper()} timed out after {_PER_SHOW_TIMEOUT_S}s. "
                    f"The Snowflake server is taking unusually long for this "
                    f"command - possibly your role's grants make the result "
                    f"set very large, or there's a Snowflake-side hang. The "
                    f"connector has been evicted; click refresh to retry."
                ),
                "elapsed_ms": _PER_SHOW_TIMEOUT_S * 1000,
            }
            log.warning("[snowflake-meta] SHOW %s TIMED OUT - will force-evict connector", label)
        except Exception as exc:
            results[label] = {
                "ok": False, "data": [],
                "error": f"{type(exc).__name__}: {exc!s:.300}",
                "elapsed_ms": int((time.perf_counter() - t0) * 1000),
            }
            log.warning("[snowflake-meta] SHOW %s FAILED: %s", label, exc)

    # If any SHOW timed out, the connector is wedged (the timed-out
    # query is still holding the lock). Force-evict it so the next
    # /context call starts fresh, instead of compounding the wedge.
    if saw_timeout:
        log.warning("[snowflake-meta] Force-evicting wedged metadata connector after SHOW timeout(s)")
        try:
            from app.connectors.factory import evict_connector
            evict_connector(conn_id, purpose="metadata", force=True)
        except Exception as exc:
            log.warning("[snowflake-meta] Force-evict failed: %s", exc)

    # Current session context - quick query on warm connection
    try:
        t0 = time.perf_counter()
        future = _META_POOL.submit(
            lambda: connector.execute_one(
                "SELECT CURRENT_WAREHOUSE(), CURRENT_ROLE(), CURRENT_DATABASE(), CURRENT_SCHEMA()"
            )
        )
        row = future.result(timeout=_PER_SHOW_TIMEOUT_S)
        current = {
            "warehouse": (str(row[0]) if row and row[0] else None),
            "role":      (str(row[1]) if row and row[1] else None),
            "database":  (str(row[2]) if row and row[2] else None),
            "schema":    (str(row[3]) if row and row[3] else None),
        }
        current_error = None
        log.info("[snowflake-meta] CURRENT_* OK: role=%s warehouse=%s db=%s schema=%s",
                 current["role"], current["warehouse"], current["database"], current["schema"])
    except Exception as exc:
        current = {"warehouse": None, "role": None, "database": None, "schema": None}
        current_error = f"{type(exc).__name__}: {exc!s:.300}"
        log.warning("[snowflake-meta] CURRENT_* FAILED: %s", exc)

    return {
        # Lists in the shape the frontend expects (always present):
        "warehouses": results["warehouses"]["data"],
        "roles":      results["roles"]["data"],
        "databases":  results["databases"]["data"],
        "schemas":    results.get("schemas", {}).get("data", []),
        "current":    current,
        "diagnostics": {
            "warmup":     {"ok": True, "error": None, "elapsed_ms": warm_ms},
            "warehouses": {k: v for k, v in results["warehouses"].items() if k != "data"},
            "roles":      {k: v for k, v in results["roles"].items() if k != "data"},
            "databases":  {k: v for k, v in results["databases"].items() if k != "data"},
            "schemas":    ({k: v for k, v in results["schemas"].items() if k != "data"}
                           if "schemas" in results else None),
            "current":    {"ok": current_error is None, "error": current_error},
        },
        # Set when a SHOW timed out and we force-evicted the connector.
        # The frontend can auto-retry once when it sees this true.
        "evicted_and_ready_for_retry": saw_timeout,
        "note": (
            "Snowflake's SHOW commands filter by your active role's grants. "
            "If a list is empty or shorter than expected, your role likely "
            "lacks USAGE on the others - switch to a more privileged role "
            "(e.g. SYSADMIN) and click refresh."
        ),
    }


@router.get("/{conn_id}/snowflake/diagnose")
def diagnose_snowflake(conn_id: int) -> dict:
    """Step-by-step diagnostic for a wedged Snowflake picker.

    Runs each piece independently with its own timeout and returns
    detailed info for every step. Designed for when the regular
    /context endpoint isn't working and you need to see exactly which
    step is failing.

    Steps:
      1. Load connection record
      2. Build/fetch the "metadata" Connector
      3. Warm-up SELECT 1 (covers SSO login + ping)
      4. SHOW WAREHOUSES
      5. SHOW ROLES
      6. SHOW DATABASES
      7. CURRENT_* context

    Each step records: ok, elapsed_ms, error (if any). Returns ALL
    steps' results, even if early steps failed - so you see the
    cascade.
    """
    steps: list[dict] = []

    def _record(name, ok, elapsed_ms, error=None, data=None):
        steps.append({"step": name, "ok": ok, "elapsed_ms": elapsed_ms,
                      "error": error, "data": data})

    # Step 1: record
    t0 = time.perf_counter()
    try:
        rec = _load(conn_id)
        _require_snowflake(rec)
        _record("load_record", True, int((time.perf_counter() - t0) * 1000),
                data={"name": rec.name, "db_type": rec.db_type,
                      "user": rec.username, "account": (rec.extra or {}).get("account") or rec.host,
                      "role_in_record": (rec.extra or {}).get("role"),
                      "warehouse_in_record": (rec.extra or {}).get("warehouse"),
                      "authenticator": (rec.extra or {}).get("authenticator") or "snowflake"})
    except Exception as exc:
        _record("load_record", False, int((time.perf_counter() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc!s:.300}")
        return {"steps": steps, "summary": "Failed at load_record"}

    # Step 2: connector
    t0 = time.perf_counter()
    try:
        connector = get_connector(rec, purpose="metadata")
        _record("get_connector", True, int((time.perf_counter() - t0) * 1000))
    except Exception as exc:
        _record("get_connector", False, int((time.perf_counter() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc!s:.300}")
        return {"steps": steps, "summary": "Failed at get_connector"}

    # Step 3: warm-up
    ok, err, ms = _warm_up_connection(connector)
    _record("warmup", ok, ms, error=err)
    if not ok:
        return {"steps": steps, "summary": "Failed at warmup (SSO / credentials)"}

    # Steps 4-7: SHOW queries
    for name, sql in [
        ("show_warehouses", "SHOW WAREHOUSES"),
        ("show_roles", "SHOW ROLES"),
        ("show_databases", "SHOW DATABASES"),
    ]:
        t0 = time.perf_counter()
        future = _META_POOL.submit(lambda s=sql: _show_by_name(connector, s))
        try:
            data = future.result(timeout=_PER_SHOW_TIMEOUT_S)
            _record(name, True, int((time.perf_counter() - t0) * 1000),
                    data={"count": len(data), "sample": data[:5]})
        except concurrent.futures.TimeoutError:
            _record(name, False, _PER_SHOW_TIMEOUT_S * 1000,
                    error=f"Timed out after {_PER_SHOW_TIMEOUT_S}s")
        except Exception as exc:
            _record(name, False, int((time.perf_counter() - t0) * 1000),
                    error=f"{type(exc).__name__}: {exc!s:.300}")

    # Step 7: current context
    t0 = time.perf_counter()
    future = _META_POOL.submit(
        lambda: connector.execute_one(
            "SELECT CURRENT_WAREHOUSE(), CURRENT_ROLE(), CURRENT_DATABASE(), CURRENT_SCHEMA()"
        )
    )
    try:
        row = future.result(timeout=_PER_SHOW_TIMEOUT_S)
        _record("current_context", True, int((time.perf_counter() - t0) * 1000),
                data={"warehouse": row[0], "role": row[1], "database": row[2], "schema": row[3]})
    except Exception as exc:
        _record("current_context", False, int((time.perf_counter() - t0) * 1000),
                error=f"{type(exc).__name__}: {exc!s:.300}")

    last_ok = all(s["ok"] for s in steps)
    summary = "All steps OK" if last_ok else (
        "Failed at " + next(s["step"] for s in steps if not s["ok"])
    )
    return {"steps": steps, "summary": summary}


@router.get("/{conn_id}/snowflake/schemas")
def get_snowflake_schemas_for_db(conn_id: int, database: str) -> dict:
    """Cheap follow-up endpoint: when the user changes the database in the
    picker, the frontend calls this to refresh just the schemas list
    rather than re-fetching everything via /context.
    """
    rec = _load(conn_id)
    _require_snowflake(rec)
    connector = get_connector(rec, purpose="metadata")

    t0 = time.perf_counter()
    db_quoted = '"' + database.replace('"', '""') + '"'
    future = _META_POOL.submit(
        lambda: _show_by_name(connector, f"SHOW SCHEMAS IN DATABASE {db_quoted}")
    )
    try:
        schemas = future.result(timeout=_PER_SHOW_TIMEOUT_S)
        return {
            "schemas": schemas,
            "elapsed_ms": int((time.perf_counter() - t0) * 1000),
        }
    except concurrent.futures.TimeoutError:
        return {"schemas": [], "error": f"Timed out after {_PER_SHOW_TIMEOUT_S}s"}
    except Exception as exc:
        return {"schemas": [], "error": f"{type(exc).__name__}: {exc!s:.250}"}

