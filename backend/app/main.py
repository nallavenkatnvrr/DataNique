from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.store import init_db
from app.routers import connections as connections_router
from app.routers import metadata as metadata_router
from app.routers import compare as compare_router
from app.routers import compare_history as compare_history_router
from app.routers import templates as templates_router
from app.routers import metrics as metrics_router
from app.routers import sql_ide as sql_ide_router
from app.routers import snowflake_meta as snowflake_meta_router
from app.routers import health_admin as health_admin_router
from app.routers import jobs as jobs_router
from app.routers import files as files_router
from app.routers import settings as settings_router
from app.routers import scripts as scripts_router
from app.routers import vault as vault_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    from app.logging_config import configure_logging
    configure_logging()
    init_db()
    from app.security.vault import vault as _vault

    def _on_vault_change(state: str) -> None:
        if state != "unlocked":
            try:
                from app.connectors.factory import evict_all
                evict_all(force=True)
            except Exception:
                pass
            try:
                from app.engine.storeseal import purge_cache
                purge_cache()
            except Exception:
                pass

    _vault.on_change(_on_vault_change)
    try:
        _vault.try_auto_unlock()
    except Exception:
        pass
    try:
        from app.engine.files import purge_uploads
        purge_uploads(24)
        import shutil
        shutil.rmtree(settings.data_dir / "tmp", ignore_errors=True)
        from app.engine.storeseal import purge_all_work
        purge_all_work()
    except Exception:
        pass
    # Find out once, off the request path, whether DuckDB can write encrypted
    # files (httpfs / OpenSSL); a blocked one-time INSTALL can take a while.
    try:
        import threading as _th

        def _probe_crypto():
            import duckdb
            from app.engine.core import enable_native_crypto
            con = duckdb.connect(":memory:")
            try:
                enable_native_crypto(con)
            finally:
                con.close()
        _th.Thread(target=_probe_crypto, daemon=True, name="dv-crypto-probe").start()
    except Exception:
        pass
    # Start the watchdog - self-heals other background threads.
    try:
        from app.services.watchdog import start_watchdog
        start_watchdog()
    except Exception:
        pass
    # Warm the /api/version cache off the request path. The engine/driver probe
    # imports pandas/duckdb/polars/snowflake once (~7s cold); doing it in a
    # daemon thread at startup means the dashboard's first version() call is
    # already served from cache and returns in ~5ms instead of blocking.
    try:
        import threading
        threading.Thread(target=version, daemon=True).start()
    except Exception:
        pass
    yield
    # Shutdown
    from app.services.query_session import query_manager
    try:
        query_manager.shutdown(timeout=2.0)
    except Exception:
        pass
    try:
        from app.services.watchdog import stop_watchdog
        stop_watchdog()
    except Exception:
        pass
    try:
        import threading
        from app.connectors.factory import stop_heartbeat_thread, evict_all
        stop_heartbeat_thread()
        connector_cleanup = threading.Thread(
            target=evict_all, kwargs={"force": True},
            name="connector-cache-shutdown-evict", daemon=True,
        )
        connector_cleanup.start()
        connector_cleanup.join(2.0)
    except Exception:
        pass


APP_VERSION = "0.3.4"
app = FastAPI(title=settings.app_name, version=APP_VERSION, lifespan=lifespan)



# Access control.
#
#  * The vault (app.security.vault) must be unlocked, and every /api/* call
#    must carry the session token issued at unlock (X-DV-Session). Custom
#    headers cannot be sent cross-site without a CORS preflight, so this also
#    stops other web pages from driving the local API.
#  * Host header must be a loopback name unless the app is deliberately
#    bound to another interface (DNS-rebinding protection).
#  * DV_API_TOKEN (X-API-Token) still works for scripted access, in place of
#    a session token; the vault must be unlocked either way.
#  * DV_ADMIN_TOKEN independently guards admin operations.
from fastapi.responses import JSONResponse
from app.security.api_token import should_block_admin, tokens_match
from app.security.vault import vault

_VAULT_OPEN = frozenset({
    "/api/health",
    "/api/vault/status",
    "/api/vault/setup",
    "/api/vault/unlock",
    "/api/vault/resume",
    "/api/vault/recover",
    "/api/vault/reset",
    "/api/vault/password-check",
})
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _host_ok(host_header: str | None) -> bool:
    if settings.bind_host not in ("127.0.0.1", "localhost", "::1"):
        return True
    host = (host_header or "").strip().lower()
    if host.startswith("["):
        host = host.split("]")[0] + "]"
    else:
        host = host.split(":")[0]
    extra = {h.strip().lower() for h in (settings.allowed_hosts or "").split(",") if h.strip()}
    return host in _LOOPBACK_HOSTS or host in extra


@app.middleware("http")
async def _access_control(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    if not _host_ok(request.headers.get("host")):
        return JSONResponse({"detail": "Host not allowed"}, status_code=421)
    if settings.admin_token and should_block_admin(
        path, request.headers.get("X-Admin-Token"), settings.admin_token
    ):
        return JSONResponse({"detail": "Missing or invalid admin token"}, status_code=401)
    if path in _VAULT_OPEN or path.startswith("/api/downloads/"):
        return await call_next(request)
    state = vault.state
    if state != "unlocked":
        return JSONResponse(
            {"detail": "Datanique is locked" if state == "locked" else "Set a master password first",
             "code": "vault_locked" if state == "locked" else "vault_setup"},
            status_code=423,
        )
    api_tok = request.headers.get("X-API-Token")
    if not vault.check_session(request.headers.get("X-DV-Session")) and not (
        settings.api_token and tokens_match(api_tok, settings.api_token)
    ):
        if vault.state != "unlocked":
            return JSONResponse({"detail": "Datanique is locked", "code": "vault_locked"}, status_code=423)
        return JSONResponse({"detail": "Session expired. Unlock again.", "code": "session_required"}, status_code=401)
    vault.touch()
    return await call_next(request)

# CORS is added after the access-control middleware so it wraps it: refused
# (401/423) responses still carry CORS headers.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Request-ID tracing + clean JSON envelope for unhandled 500s (additive -
# successful responses pass through unchanged).
from app.logging_config import install_observability
install_observability(app)


import time as _time
_START_TIME = _time.time()


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "app": settings.app_name,
        "uptime_seconds": int(_time.time() - _START_TIME),
        "vault": vault.state,
    }


_VERSION_CACHE: dict | None = None


def _crypto_status() -> dict:
    """How diff stores are encrypted: by DuckDB (httpfs/OpenSSL) or sealed by
    the app (``native`` false); ``None`` until the start-up probe finished."""
    from app.engine.core import crypto_status
    st = crypto_status()
    return {"mode": {True: "duckdb", False: "app-sealed", None: "checking"}[st["native"]], "detail": st["reason"]}


@app.get("/api/version")
def version() -> dict:
    """Build / runtime info and the reader chain each database will use."""
    global _VERSION_CACHE
    if _VERSION_CACHE is not None:
        return {**_VERSION_CACHE, "uptime_seconds": int(_time.time() - _START_TIME), "diff_store_encryption": _crypto_status()}

    import os
    import sys
    import platform

    def _probe(mod: str) -> str | None:
        try:
            m = __import__(mod, fromlist=["__version__"])
            return getattr(m, "__version__", "installed")
        except Exception:
            return None

    from app.engine.readers import available_readers

    _VERSION_CACHE = {
        "app": settings.app_name,
        "app_version": APP_VERSION,
        "uptime_seconds": int(_time.time() - _START_TIME),
        "python": sys.version.split()[0],
        "platform": platform.system() + " " + platform.release(),
        "engine": "v2",
        "libraries": {name: _probe(mod) for name, mod in [
            ("duckdb", "duckdb"), ("pyarrow", "pyarrow"), ("python-calamine", "python_calamine"),
            ("fastavro", "fastavro"), ("adbc-driver-manager", "adbc_driver_manager"),
            ("adbc-driver-postgresql", "adbc_driver_postgresql"), ("adbc-driver-snowflake", "adbc_driver_snowflake"),
            ("arrow-odbc", "arrow_odbc"), ("connectorx", "connectorx"), ("keyring", "keyring"),
        ]},
        "drivers": {name: _probe(mod) for name, mod in [
            ("oracledb", "oracledb"), ("psycopg", "psycopg"), ("pymysql", "pymysql"),
            ("pyodbc", "pyodbc"), ("snowflake-connector-python", "snowflake.connector"),
        ]},
        "readers": available_readers(),
        # This user's data folder (database, vault, runs, scripts, logs).
        "data_dir": str(settings.data_dir),
        "desktop": os.environ.get("DV_DESKTOP") == "1",
    }
    return {**_VERSION_CACHE, "uptime_seconds": int(_time.time() - _START_TIME), "diff_store_encryption": _crypto_status()}


app.include_router(connections_router.router)
app.include_router(metadata_router.router)
app.include_router(compare_router.router)
app.include_router(compare_history_router.router)
app.include_router(templates_router.router)
app.include_router(metrics_router.router)
app.include_router(sql_ide_router.router)
app.include_router(snowflake_meta_router.router)
app.include_router(health_admin_router.router)
app.include_router(jobs_router.router)
app.include_router(files_router.router)
app.include_router(compare_history_router.downloads)
app.include_router(settings_router.router)
app.include_router(scripts_router.router)
app.include_router(vault_router.router)


# ---------------------------------------------------------------------------
# Optional: serve the built React SPA same-origin.
#
# When a frontend build is present (``DV_STATIC_DIR`` env var, else the sibling
# ``frontend/dist``) we mount it at ``/`` so the desktop shell (pywebview) can
# load the whole app from a single loopback origin. Because it's same-origin,
# the UI's relative ``/api`` calls and BrowserRouter work with zero changes.
#
# This is additive and inert for the plain web/dev workflow: if no build dir
# exists, nothing is mounted and the backend stays API-only (Vite serves the UI
# in dev). The mount is added LAST, after all /api routers, so API routes always
# take precedence; a catch-all returns index.html for client-side routes.
# ---------------------------------------------------------------------------
def _mount_spa() -> None:
    import os
    import gzip
    import logging
    import mimetypes
    import threading
    from pathlib import Path
    from fastapi.responses import FileResponse

    logger = logging.getLogger(__name__)

    static_dir = os.environ.get("DV_STATIC_DIR", "")
    dist = Path(static_dir) if static_dir else settings.backend_dir.parent / "frontend" / "dist"
    dist = dist.resolve()
    index = dist / "index.html"
    if not index.exists():
        return  # no build → API-only mode

    # brotli is optional; gzip is always available (stdlib).
    try:
        import brotli  # type: ignore
        _have_brotli = True
    except Exception:  # pragma: no cover - depends on optional dep
        brotli = None  # type: ignore
        _have_brotli = False

    # Text-like assets worth compressing. Binary (png/woff2/…) is already
    # compressed, so we skip it.
    _COMPRESSIBLE = {".js", ".css", ".html", ".svg", ".json", ".map", ".txt", ".xml", ".wasm", ".ico"}

    def _fresh(variant: Path, src_ns: int) -> bool:
        """A .gz/.br variant is valid only if it carries its source's exact
        mtime (set when it is written). Comparing "newer than" is not enough:
        copying a new build over an old one keeps the old, newer-looking
        variants, which would keep serving the previous index.html."""
        try:
            return variant.stat().st_mtime_ns == src_ns
        except OSError:
            return False

    def _precompress(root: Path) -> None:
        """Write .gz (+ .br if available) next to each compressible asset, once.

        Skips regeneration when an up-to-date sibling already exists (keyed on
        mtime), so only the first startup after a build pays the cost. Runs in a
        daemon thread - until a variant exists the responder just serves the
        next-best encoding, so nothing blocks on this."""
        for p in root.rglob("*"):
            try:
                if not p.is_file() or p.suffix.lower() not in _COMPRESSIBLE:
                    continue
                src_ns = p.stat().st_mtime_ns
                gz = p.with_name(p.name + ".gz")
                if not _fresh(gz, src_ns):
                    with gzip.open(gz, "wb", compresslevel=9) as f:
                        f.write(p.read_bytes())
                    os.utime(gz, ns=(src_ns, src_ns))
                if _have_brotli:
                    br = p.with_name(p.name + ".br")
                    if not _fresh(br, src_ns):
                        br.write_bytes(brotli.compress(p.read_bytes(), quality=11))
                        os.utime(br, ns=(src_ns, src_ns))
            except Exception:
                logger.debug("precompress skipped for %s", p, exc_info=True)

    threading.Thread(target=_precompress, args=(dist,), daemon=True).start()

    def _within(candidate: Path) -> bool:
        try:
            candidate.resolve().relative_to(dist)
            return True
        except Exception:
            return False

    def _negotiate(path: Path, request: Request) -> FileResponse:
        """Serve the best precompressed variant the client accepts, falling back
        to the raw file. Content-Type stays the ORIGINAL type; Content-Encoding
        + Vary are set so browsers transparently decompress and caches key
        correctly."""
        accept = request.headers.get("accept-encoding", "")
        media = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        try:
            src_ns = path.stat().st_mtime_ns
        except OSError:
            src_ns = -1
        if _have_brotli and "br" in accept:
            br = path.with_name(path.name + ".br")
            if _fresh(br, src_ns):
                return FileResponse(br, media_type=media, headers={"Content-Encoding": "br", "Vary": "Accept-Encoding"})
        if "gzip" in accept:
            gz = path.with_name(path.name + ".gz")
            if _fresh(gz, src_ns):
                return FileResponse(gz, media_type=media, headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
        return FileResponse(path, media_type=media, headers={"Vary": "Accept-Encoding"})

    @app.get("/", include_in_schema=False)
    def _spa_root(request: Request):
        return _negotiate(index, request)

    # SPA fallback: any non-/api path that maps to a real build file is served
    # (compression-negotiated); anything else returns index.html so deep links /
    # refreshes resolve to the client router.
    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa_fallback(full_path: str, request: Request):
        if full_path == "api" or full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = dist / full_path
        if _within(candidate) and candidate.is_file():
            return _negotiate(candidate, request)
        return _negotiate(index, request)


_mount_spa()


if __name__ == "__main__":
    import uvicorn
    # Defaults to 127.0.0.1 (loopback only) - see config.bind_host. Set
    # DV_BIND_HOST=0.0.0.0 to expose beyond localhost, ideally together with
    # DV_API_TOKEN so the open SQL IDE isn't reachable unauthenticated.
    uvicorn.run(
        "app.main:app",
        host=settings.bind_host,
        port=settings.bind_port,
        reload=True,
        reload_dirs=["app"],
    )
