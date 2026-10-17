"""Centralized logging + request-tracing helpers.

Additive and side-effect-free until explicitly called from ``main.py``:

* :func:`configure_logging` installs a single, consistently-formatted stream
  handler on the root logger (idempotent - safe to call more than once).
* :func:`install_observability` wires a request-ID middleware and a global
  exception handler onto a FastAPI app so every unhandled error returns a
  clean JSON envelope (instead of a bare stack trace) and is logged with a
  correlation id the frontend can surface to the user.

None of this changes existing endpoint behavior - successful responses pass
through untouched; only the *shape of unhandled 500s* and *log output* change.
"""
from __future__ import annotations

import logging
import time
import uuid

logger = logging.getLogger("datanique")

_CONFIGURED = False


def configure_logging(level: str = "INFO") -> None:
    """Install a single formatted handler on the root logger (idempotent)."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    root = logging.getLogger()
    # Don't stack duplicate handlers if uvicorn already configured one.
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s [%(name)s] %(message)s",
            datefmt="%H:%M:%S",
        ))
        root.addHandler(handler)
    try:
        root.setLevel(getattr(logging, level.upper(), logging.INFO))
    except Exception:
        root.setLevel(logging.INFO)
    _CONFIGURED = True


def install_observability(app) -> None:
    """Attach request-ID middleware + a catch-all exception handler."""
    from fastapi import Request
    from fastapi.responses import JSONResponse

    @app.middleware("http")
    async def _request_context(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
        request.state.request_id = request_id
        start = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:  # noqa: BLE001 - re-raised to the handler below
            # Let the registered exception handler build the response so the
            # body shape is consistent; just log timing here.
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.exception(
                "unhandled error %s %s (req=%s, %.0fms)",
                request.method, request.url.path, request_id, elapsed_ms,
            )
            raise
        elapsed_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Request-ID"] = request_id
        # Only log the slow / error responses to avoid noise on hot paths.
        if response.status_code >= 500 or elapsed_ms > 5000:
            logger.warning(
                "%s %s -> %s (req=%s, %.0fms)",
                request.method, request.url.path, response.status_code,
                request_id, elapsed_ms,
            )
        return response

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):
        request_id = getattr(request.state, "request_id", None)
        return JSONResponse(
            status_code=500,
            content={
                "error": "internal_server_error",
                "detail": str(exc),
                "request_id": request_id,
            },
            headers={"X-Request-ID": request_id} if request_id else None,
        )
