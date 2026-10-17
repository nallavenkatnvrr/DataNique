"""Deep health + admin endpoints.

Three classes of endpoints:

  1. ``GET /api/health/detailed`` - comprehensive state snapshot.
     Shows cached connectors, background thread liveness, running
     query executions, and approximate resource use. Protected by the
     configured token gates because it includes SQL previews.

  2. ``POST /api/admin/evict-connector/{conn_id}`` - manually drop
     cached connectors for a connection. Use when a connection is
     misbehaving and you want to force a fresh login on next use.
     Optional ``?purpose=X`` to drop just one section's slot.

  3. ``POST /api/admin/kill-execution/{exec_id}`` - cancel a SQL
     execution and force-evict its per-session connector if it is blocked.

Privileged routes require ``DV_ADMIN_TOKEN`` when configured. Detailed health
is also covered by the regular API-token gate.
"""
from __future__ import annotations

import os
import sys
import time
import threading

from fastapi import APIRouter, HTTPException

from app.connectors import factory as connector_factory
from app.services import watchdog


router = APIRouter(tags=["health-admin"])


@router.get("/api/health/detailed")
def detailed_health() -> dict:
    """Comprehensive snapshot of backend state for diagnostics.

    Reports:
      - Process info (pid, uptime, thread count, memory if psutil installed)
      - Background threads (heartbeat, watchdog, query workers) - alive?
      - Cached connectors per (connection_id, purpose) - last ping, in-use
      - Running query executions - sql preview, age
      - Spark availability
    """
    # ---- Process info ----
    process_info: dict = {
        "pid": os.getpid(),
        "thread_count": threading.active_count(),
        "thread_names": sorted(set(t.name for t in threading.enumerate())),
    }
    # psutil is optional - show memory if available, skip silently if not.
    try:
        import psutil  # type: ignore
        p = psutil.Process()
        process_info["rss_mb"] = round(p.memory_info().rss / (1024 * 1024), 1)
        process_info["cpu_percent_1s"] = p.cpu_percent(interval=0.5)
    except Exception:
        pass

    # ---- Background threads ----
    threads: dict = {
        "connector_heartbeat": {
            "alive": connector_factory.is_heartbeat_alive(),
        },
        "watchdog": watchdog.get_status(),
    }
    try:
        from app.engine.jobs import manager
        threads["compare_jobs"] = {"active": len(manager.list(active_only=True))}
    except Exception:
        pass

    # ---- Cached connectors ----
    try:
        connectors = connector_factory.get_cache_snapshot()
    except Exception as exc:
        connectors = [{"error": f"snapshot failed: {exc!s:.200}"}]

    # ---- Query executions ----
    executions: list[dict] = []
    try:
        from app.services.query_session import query_manager, ExecStatus
        from datetime import datetime
        with query_manager._lock:
            for session in query_manager._sessions.values():
                for exec_id, ex in session.executions.items():
                    if ex.status not in (ExecStatus.RUNNING, ExecStatus.QUEUED):
                        continue
                    elapsed_s = None
                    if ex.started_at:
                        try:
                            dt = datetime.fromisoformat(ex.started_at.replace("Z", "+00:00"))
                            elapsed_s = int((datetime.now(dt.tzinfo) - dt).total_seconds())
                        except Exception:
                            elapsed_s = None
                    executions.append({
                        "exec_id": exec_id,
                        "session_id": session.session_id,
                        "connection_id": ex.connection_id,
                        "status": ex.status.value if hasattr(ex.status, "value") else str(ex.status),
                        "sql_preview": (ex.sql or "")[:120],
                        "elapsed_seconds": elapsed_s,
                        "stuck": (elapsed_s or 0) > watchdog._STUCK_EXECUTION_MINUTES * 60,
                    })
    except Exception as exc:
        executions = [{"error": f"snapshot failed: {exc!s:.200}"}]

    # ---- Library availability ----
    engines: dict = {}
    for mod, name in [("duckdb", "duckdb"), ("pyarrow", "pyarrow"),
                      ("adbc_driver_manager", "adbc"), ("python_calamine", "calamine"),
                      ("oracledb", "oracledb")]:
        try:
            m = __import__(mod)
            engines[name] = {"available": True, "version": getattr(m, "__version__", None)}
        except ImportError:
            engines[name] = {"available": False}

    # ---- Python info ----
    python_info = {
        "version": sys.version.split()[0],
        "executable": sys.executable,
    }

    return {
        "process": process_info,
        "python": python_info,
        "threads": threads,
        "connectors": connectors,
        "running_executions": executions,
        "engines": engines,
    }


@router.post("/api/admin/evict-connector/{conn_id}")
def admin_evict_connector(conn_id: int, purpose: str | None = None) -> dict:
    """Force-drop cached Connectors for a connection record.

    If ``purpose`` is given, drops only that section's slot
    (sql_ide / compare / metadata / test). Otherwise drops ALL slots
    for the connection.

    Use this when a cached connection is misbehaving and you want to
    force a clean reconnect on the next operation.
    """
    before = connector_factory.get_cache_snapshot()
    connector_factory.evict_connector(conn_id, purpose=purpose)
    after = connector_factory.get_cache_snapshot()
    dropped = len(before) - len(after)
    return {
        "ok": True,
        "dropped_count": dropped,
        "remaining_count": len(after),
    }


@router.post("/api/admin/kill-execution/{exec_id}")
def admin_kill_execution(exec_id: str) -> dict:
    """Force-cancel a running query execution.

    Sets the execution's cancel flag and cancels its future. If the query is
    running, its per-session connector is force-evicted to interrupt a blocked
    driver call without closing other SQL IDE sessions' connectors.
    """
    try:
        from app.services.query_session import query_manager
        # Find the session that owns this exec
        with query_manager._lock:
            owner_session = None
            for sess in query_manager._sessions.values():
                if exec_id in sess.executions:
                    owner_session = sess
                    break
        if owner_session is None:
            raise HTTPException(404, f"Execution {exec_id} not found")
        ok = query_manager.cancel_execution(owner_session.session_id, exec_id)
        return {"ok": ok, "session_id": owner_session.session_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to cancel: {type(exc).__name__}: {exc!s:.200}")


@router.post("/api/admin/restart-watchdog")
def admin_restart_watchdog() -> dict:
    """Stop and re-start the watchdog. Usually not needed (it's
    self-healing), but useful if you want to force a fresh check
    cycle immediately."""
    watchdog.stop_watchdog()
    # Brief pause for the thread to exit
    time.sleep(0.2)
    watchdog.start_watchdog()
    return {"ok": True, "alive": watchdog.is_watchdog_alive()}
