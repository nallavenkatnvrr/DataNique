r"""
Datanique desktop launcher (pywebview).

A lightweight native-window alternative to Electron that works on locked-down
corporate networks: it uses the **WebView2 runtime already built into Windows**
and installs from PyPI only (no GitHub binary downloads).

What it does:
  1. Starts the existing FastAPI backend (uvicorn) on a free loopback port, in a
     background thread. The backend also serves the built React UI same-origin
     (see app.main._mount_spa), so the whole app lives behind one http origin.
  2. Waits for /api/health, then opens a native window pointing at it.
  3. Persists the DB + encryption key under the per-user AppData dir so a frozen
     build has a writable, stable home.

Run from source:
    ..\backend\.venv\Scripts\python.exe app.py
Freeze with PyInstaller: see desktop_py/README.md.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request
from pathlib import Path

APP_NAME = "Datanique"
_backend_server = None


def _project_paths() -> tuple[Path, Path, bool]:
    """Return (backend_dir, frontend_dist, is_frozen)."""
    if getattr(sys, "frozen", False):
        # PyInstaller: bundled files live under sys._MEIPASS.
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return base / "backend", base / "frontend_dist", True
    here = Path(__file__).resolve().parent
    root = here.parent
    return root / "backend", root / "frontend" / "dist", False


def _load_env_file(backend_dir: Path) -> None:
    if getattr(sys, "frozen", False):
        candidates = (
            Path(sys.executable).resolve().parent / ".env",
            Path.cwd() / ".env",
        )
    else:
        candidates = (backend_dir / ".env", Path.cwd() / ".env")

    for env_file in candidates:
        if env_file.is_file():
            from dotenv import load_dotenv

            load_dotenv(env_file, override=False)
            return


# Browser storage (open SQL IDE scripts, history, settings) is scoped to the
# page origin, which includes the port, so the app prefers the same port on
# every launch and only falls back to a random one when it is taken.
PREFERRED_PORT = int(os.environ.get("DV_DESKTOP_PORT", "38417"))


def _free_port() -> int:
    for candidate in (PREFERRED_PORT, 0):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(("127.0.0.1", candidate))
                return s.getsockname()[1]
        except OSError:
            continue
    raise RuntimeError("No free local port for the backend")


def _user_data_dir() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    d = Path(base) / APP_NAME / "backend-data"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _configure_env(port: int, backend_dir: Path, frontend_dist: Path) -> None:
    data_dir = _user_data_dir()
    os.environ["DV_BIND_HOST"] = "127.0.0.1"
    os.environ["DV_BIND_PORT"] = str(port)
    os.environ["DV_API_TOKEN"] = ""
    os.environ["DV_ADMIN_TOKEN"] = ""
    os.environ["DV_DATA_DIR"] = str(data_dir)
    os.environ["DV_SECRET_KEY_FILE"] = str(data_dir / ".secret_key")
    os.environ["DV_STATIC_DIR"] = str(frontend_dist)
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    # Ensure `import app...` resolves whether frozen or from source.
    for p in (str(backend_dir), getattr(sys, "_MEIPASS", "")):
        if p and p not in sys.path:
            sys.path.insert(0, p)


def _run_backend(port: int) -> None:
    global _backend_server
    import uvicorn
    from app.main import app  # imported after sys.path/env are set

    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", workers=1
    )
    _backend_server = uvicorn.Server(config)
    _backend_server.run()


def _shutdown_backend(thread: threading.Thread) -> None:
    if _backend_server is not None:
        _backend_server.should_exit = True
    if thread.is_alive():
        thread.join(timeout=10)
    if thread.is_alive():
        print("[datanique] Backend server did not stop within 10 seconds.")


def _wait_for_health(port: int, timeout: float = 60.0) -> bool:
    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def main() -> None:
    backend_dir, frontend_dist, _ = _project_paths()
    _load_env_file(backend_dir)

    if not (frontend_dist / "index.html").exists():
        print(
            f"[datanique] Frontend build not found at {frontend_dist}.\n"
            f"            Run `npm run build` in the frontend folder first."
        )
        # Still launch — the backend serves the API; the window will show a
        # helpful message from the SPA fallback only if a build exists.

    port = _free_port()
    _configure_env(port, backend_dir, frontend_dist)

    t = threading.Thread(target=_run_backend, args=(port,), daemon=True)
    t.start()

    try:
        if not _wait_for_health(port):
            print("[datanique] Backend did not become healthy in time.")
            sys.exit(1)

        import webview  # imported late so backend import errors surface first

        class _JsApi:
            """Bridge exposed to the SPA as ``window.pywebview.api``.

            Lets the Settings page open a native OS folder picker (WebView2 can't
            do this from plain JS) so the user can choose where scripts/exports are
            stored. Returns the selected absolute path, or "" if cancelled.
            """

            def pick_folder(self) -> str:
                try:
                    win = webview.windows[0]
                    result = win.create_file_dialog(webview.FOLDER_DIALOG)
                    if result:
                        return result[0] if isinstance(result, (list, tuple)) else str(result)
                except Exception:
                    pass
                return ""

        webview.create_window(
            APP_NAME,
            url=f"http://127.0.0.1:{port}/",
            width=1440,
            height=900,
            min_size=(1024, 640),
            confirm_close=False,
            js_api=_JsApi(),
        )
        # pywebview cancels every download unless this is on (CSV / JSON /
        # Excel exports, Diff & Merge saves all use browser downloads).
        webview.settings["ALLOW_DOWNLOADS"] = True
        # A persistent profile keeps localStorage between launches (open SQL
        # IDE scripts, query history, editor settings, theme). The default
        # private mode wipes it every time the app starts.
        storage = _user_data_dir() / "webview"
        storage.mkdir(parents=True, exist_ok=True)
        # gui=None lets pywebview pick EdgeChromium (WebView2) on Windows.
        webview.start(gui=None, private_mode=False, storage_path=str(storage))
    finally:
        _shutdown_backend(t)


if __name__ == "__main__":
    main()
