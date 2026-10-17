"""Self-healing watchdog.

A single daemon thread that periodically:

  1. Restarts the connection heartbeat if it has silently died.
  2. Restarts the Spark heartbeat if applicable.
  3. Marks long-running query executions as "stuck" (visibility, not
     auto-kill — we don't want to abort the user's real work).
  4. Logs structured warnings about resource state so problems are
     visible in the backend console even if no one's looking at the
     health endpoint.

Why this exists: in phase 4.15 we added the heartbeat thread for
connection keepalives. In phase 4.16 we added the Spark heartbeat.
Both run forever as daemons. If either thread crashes (an exception
in its loop), the heartbeat stops, and nothing notices. The
connector cache then goes stale, and the next compare or SQL IDE
query hangs trying to reuse a dead socket. The user sees "backend
hung" with no obvious cause.

This watchdog catches that. It runs INDEPENDENTLY (separate thread)
and only does cheap "is it alive?" checks — never holds locks, never
talks to databases. If something's dead, log loudly and restart it.

Watchdog itself is also defensively coded: every iteration wraps its
own body in try/except so the watchdog itself can never die silently.
"""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("dv.watchdog")

# Watchdog interval — every minute is fine. The things it watches change
# slowly.
_INTERVAL_S = 60

# How long an execution needs to run before we flag it as "stuck"
# (for visibility only — we don't auto-kill user work).
_STUCK_EXECUTION_MINUTES = 30


_watchdog_thread: threading.Thread | None = None
_watchdog_stop = threading.Event()

# Track watchdog liveness for diagnostics
_last_watchdog_tick: float = 0.0


def get_last_tick_ms_ago() -> int | None:
    if _last_watchdog_tick == 0:
        return None
    return int((time.time() - _last_watchdog_tick) * 1000)


def is_watchdog_alive() -> bool:
    return _watchdog_thread is not None and _watchdog_thread.is_alive()


def _check_connector_heartbeat() -> None:
    """Restart the connection-heartbeat thread if it died."""
    try:
        from app.connectors import factory
        if getattr(factory, "_heartbeat_thread", None) is None:
            return  # not started yet: it starts with the first cached connection
        if not factory.is_heartbeat_alive():
            log.warning("Connection heartbeat thread is DEAD — restarting")
            factory._start_heartbeat_thread()
            # Verify restart
            if factory.is_heartbeat_alive():
                log.info("Connection heartbeat thread RESTARTED")
            else:
                log.error("Heartbeat restart attempted but thread still not alive")
    except Exception as exc:
        log.exception("Watchdog: heartbeat check failed: %s", exc)


def _check_stuck_executions() -> None:
    """Identify long-running query executions and log them. NO auto-kill —
    the user might have legitimate long jobs (10M-row compare etc.)."""
    try:
        from app.services.query_session import query_manager, ExecStatus
        threshold_s = _STUCK_EXECUTION_MINUTES * 60
        with query_manager._lock:
            for session in query_manager._sessions.values():
                for exec_id, ex in session.executions.items():
                    if ex.status != ExecStatus.RUNNING:
                        continue
                    if not ex.started_at:
                        continue
                    try:
                        # started_at is ISO format; parse defensively
                        from datetime import datetime
                        dt = datetime.fromisoformat(ex.started_at.replace("Z", "+00:00"))
                        elapsed_s = (datetime.now(dt.tzinfo) - dt).total_seconds()
                    except Exception:
                        continue
                    if elapsed_s > threshold_s:
                        log.warning(
                            "Long-running execution: session=%s exec=%s elapsed=%dmin",
                            session.session_id, exec_id, int(elapsed_s / 60),
                        )
    except Exception as exc:
        log.exception("Watchdog: stuck execution check failed: %s", exc)


def _watchdog_loop() -> None:
    """Main loop. Defensively wrapped — no failure within an iteration
    can ever kill this thread."""
    global _last_watchdog_tick
    log.info("Watchdog started (interval=%ds)", _INTERVAL_S)
    while not _watchdog_stop.is_set():
        try:
            _last_watchdog_tick = time.time()
            _check_connector_heartbeat()
            _check_stuck_executions()
        except Exception as exc:
            log.exception("Watchdog loop iteration crashed (continuing): %s", exc)
        # Sleep until next tick or shutdown
        if _watchdog_stop.wait(_INTERVAL_S):
            break
    log.info("Watchdog stopped")


def start_watchdog() -> None:
    """Start the watchdog. Idempotent — safe to call multiple times."""
    global _watchdog_thread
    if _watchdog_thread is not None and _watchdog_thread.is_alive():
        return
    _watchdog_stop.clear()
    _watchdog_thread = threading.Thread(
        target=_watchdog_loop,
        name="dv-watchdog",
        daemon=True,
    )
    _watchdog_thread.start()


def stop_watchdog(timeout: float = 1.0) -> None:
    """Stop the watchdog and wait only a bounded time for its thread."""
    _watchdog_stop.set()
    thread = _watchdog_thread
    if thread is not None and thread is not threading.current_thread():
        thread.join(max(0.0, timeout))


def get_status() -> dict:
    """Read-only diagnostic snapshot of the watchdog itself."""
    return {
        "alive": is_watchdog_alive(),
        "last_tick_ms_ago": get_last_tick_ms_ago(),
        "interval_seconds": _INTERVAL_S,
        "stuck_threshold_minutes": _STUCK_EXECUTION_MINUTES,
    }
