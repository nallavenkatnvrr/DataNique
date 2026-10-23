r"""
Datanique desktop launcher (pywebview).

Runs the FastAPI backend on a loopback port in a background thread and shows
the UI in a native window that uses the WebView2 runtime built into Windows
10 and 11. The same file runs from source (start-app.bat, through app.py) and as the frozen
Datanique.exe (see desktop_py/README.md and datanique.spec). The file is not
called app.py so it never shadows the backend's ``app`` package.

Every Windows user gets their own data folder: the metadata database,
master-password vault, run history, diff stores, scripts, exports, window
profile and logs all live there, and nothing is shared between accounts.

Where the data folder is, first match wins:

  1. Datanique.exe --data-dir "D:\some\folder"
  2. the DV_DATA_DIR environment variable (or DV_DATA_DIR in a .env file
     beside Datanique.exe)
  3. portable mode, when a file named "portable" sits beside Datanique.exe
     or --portable is passed: <exe folder>\data\<Windows user name>
  4. otherwise %APPDATA%\Datanique\backend-data (the same place earlier
     versions and start-app.bat use)

Only one Datanique can run per data folder; starting it again brings the open
window to the front.

Other switches:
  --self-test   start the backend, check it, write self-test.json to the data
                folder and exit (0 = passed). Used by the build.
  --browser     open the UI in the default web browser instead of a window.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
import zlib
from pathlib import Path

APP_NAME = "Datanique"
LEGACY_PORT = 38417
_T0 = time.time()


def _since() -> str:
    return f"+{time.time() - _T0:.1f}s"

_backend_server = None
# No dialogs during --self-test: it runs unattended (build-exe.bat) and a
# message box nobody can click would block it forever.
QUIET = False


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def exe_dir() -> Path:
    """Folder of Datanique.exe when frozen, else the repository root."""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def _project_paths() -> tuple[Path, Path]:
    """Return (backend_dir, frontend_dist)."""
    if is_frozen():
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        return base, base / "frontend_dist"
    root = Path(__file__).resolve().parent.parent
    return root / "backend", root / "frontend" / "dist"


def safe_user_name(name: str | None = None) -> str:
    """Windows account name made safe for a folder name."""
    if name is None:
        name = os.environ.get("USERNAME") or os.environ.get("USER")
        if not name:
            try:
                import getpass

                name = getpass.getuser()
            except Exception:
                name = ""
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "").strip(" .")
    return name or "user"


def _writable(folder: Path) -> bool:
    try:
        folder.mkdir(parents=True, exist_ok=True)
        probe = folder / f".write-test-{os.getpid()}"
        probe.write_bytes(b"")
        probe.unlink()
        return True
    except OSError:
        return False


def default_data_dir(environ: dict | None = None) -> Path:
    env = os.environ if environ is None else environ
    base = env.get("APPDATA") or str(Path.home())
    return Path(base) / APP_NAME / "backend-data"


def resolve_data_dir(
    cli_dir: str | None = None,
    portable_flag: bool = False,
    environ: dict | None = None,
    base_dir: Path | None = None,
    user: str | None = None,
) -> tuple[Path, str]:
    """Pick the data folder. Returns (folder, how it was chosen)."""
    env = os.environ if environ is None else environ
    if cli_dir:
        return Path(os.path.expandvars(cli_dir)).expanduser().resolve(), "command line"
    if env.get("DV_DATA_DIR"):
        return Path(os.path.expandvars(env["DV_DATA_DIR"])).expanduser().resolve(), "DV_DATA_DIR"
    base = base_dir or exe_dir()
    if portable_flag or (base / "portable").exists() or (base / "portable.txt").exists():
        folder = base / "data" / safe_user_name(user)
        if _writable(folder):
            return folder, "portable"
        return default_data_dir(env), "portable folder not writable, using AppData"
    return default_data_dir(env), "AppData"


# ---------------------------------------------------------------------------
# One instance per data folder
# ---------------------------------------------------------------------------
class InstanceLock:
    """An OS file lock held for the life of the process. Released by the OS
    if the app crashes, so a stale lock file never blocks the next start."""

    def __init__(self, folder: Path):
        self.path = folder / ".instance.lock"
        self._fh = None

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.path, "a+b")
        try:
            if os.name == "nt":
                import msvcrt

                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self._fh.seek(0)
                msvcrt.locking(self._fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        self._fh.close()
        self._fh = None


# ---------------------------------------------------------------------------
# Port
# ---------------------------------------------------------------------------
# Browser storage (open SQL IDE scripts, history, editor settings) belongs to
# the page origin, and the origin includes the port. So each data folder keeps
# the same port on every launch. Ports are shared by every user signed in to
# the machine (a terminal server, say), so each folder gets its own port.
def stable_port(folder: Path) -> int:
    key = str(folder).replace("\\", "/").rstrip("/").lower().encode("utf-8")
    return 20000 + zlib.crc32(key) % 15000


def _port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if os.name != "nt":
            # Same as uvicorn: connections from the last run in TIME_WAIT do
            # not make the port busy. (On Windows they never do.)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _random_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def port_candidates(folder: Path, environ: dict | None = None) -> list[int]:
    env = os.environ if environ is None else environ
    out: list[int] = []
    if env.get("DV_DESKTOP_PORT"):
        out.append(int(env["DV_DESKTOP_PORT"]))
    try:
        saved = json.loads((folder / "desktop.json").read_text("utf-8")).get("port")
        if isinstance(saved, int):
            out.append(saved)
    except (OSError, ValueError):
        # A window profile made before ports were saved used the fixed port.
        if (folder / "webview").exists():
            out.append(LEGACY_PORT)
    out.append(stable_port(folder))
    return list(dict.fromkeys(out))


def choose_port(folder: Path, wait: float = 3.0) -> int:
    candidates = port_candidates(folder)
    deadline = time.time() + wait
    while True:
        p = next((c for c in candidates if _port_free(c)), None)
        if p is not None or time.time() >= deadline:
            break
        time.sleep(0.25)  # a window that was just closed may still be letting go
    if p is None:
        return _random_port()  # this launch only; the saved port is kept
    try:
        state = folder / "desktop.json"
        data = json.loads(state.read_text("utf-8")) if state.exists() else {}
        if not isinstance(data.get("port"), int):  # the first port sticks
            data["port"] = p
            state.write_text(json.dumps(data), "utf-8")
    except (OSError, ValueError):
        pass
    return p


# ---------------------------------------------------------------------------
# Messages and logs
# ---------------------------------------------------------------------------
def message_box(text: str, title: str = APP_NAME, error: bool = False) -> None:
    print(f"[datanique] {text}")
    if os.name == "nt" and is_frozen() and not QUIET:
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, text, title, 0x10 if error else 0x40)
        except Exception:
            pass


def focus_existing_window() -> bool:
    if os.name != "nt":
        return False
    try:
        import ctypes

        user32 = ctypes.windll.user32
        hwnd = user32.FindWindowW(None, APP_NAME)
        if not hwnd:
            return False
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        return True
    except Exception:
        return False


def redirect_output(folder: Path) -> Path:
    """A windowed exe has no console (stdout and stderr are None, which some
    libraries trip over), so send output to logs/datanique.log."""
    logs = folder / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    log = logs / "datanique.log"
    try:
        if log.exists() and log.stat().st_size > 5 * 1024 * 1024:
            log.replace(logs / "datanique.1.log")
    except OSError:
        pass
    fh = open(log, "a", encoding="utf-8", buffering=1, errors="replace")
    fh.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} Datanique starting (pid {os.getpid()}) =====\n")
    sys.stdout = fh
    sys.stderr = fh
    return log


# ---------------------------------------------------------------------------
# Backend
# ---------------------------------------------------------------------------
def _load_env_file(backend_dir: Path) -> None:
    candidates = (exe_dir() / ".env", Path.cwd() / ".env") if is_frozen() else (backend_dir / ".env", Path.cwd() / ".env")
    for env_file in candidates:
        if env_file.is_file():
            from dotenv import load_dotenv

            load_dotenv(env_file, override=False)
            return


def _configure_env(port: int, folder: Path, backend_dir: Path, frontend_dist: Path) -> None:
    os.environ["DV_BIND_HOST"] = "127.0.0.1"
    os.environ["DV_BIND_PORT"] = str(port)
    os.environ["DV_API_TOKEN"] = ""
    os.environ["DV_ADMIN_TOKEN"] = ""
    os.environ["DV_DATA_DIR"] = str(folder)
    os.environ["DV_SECRET_KEY_FILE"] = str(folder / ".secret_key")
    os.environ["DV_STATIC_DIR"] = str(frontend_dist)
    os.environ["DV_DESKTOP"] = "1"
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    for p in (str(backend_dir), getattr(sys, "_MEIPASS", "")):
        if p and p not in sys.path:
            sys.path.insert(0, p)


def _run_backend(port: int) -> None:
    global _backend_server
    import uvicorn
    from app.main import app  # imported after sys.path and env are set

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", workers=1, use_colors=False)
    _backend_server = uvicorn.Server(config)
    _backend_server.run()


def _shutdown_backend(thread: threading.Thread) -> None:
    if _backend_server is not None:
        _backend_server.should_exit = True
    if thread.is_alive():
        thread.join(timeout=10)
    if thread.is_alive():
        print("[datanique] Backend server did not stop within 10 seconds.")


def _wait_for_health(port: int, thread: threading.Thread, timeout: float = 90.0) -> bool:
    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline and thread.is_alive():
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def _self_test(port: int, folder: Path, frontend_dist: Path) -> int:
    checks: dict[str, object] = {}

    def check(name: str, fn, timeout: float = 60.0) -> None:
        # Each check runs in its own thread with a time limit, so one that
        # hangs is reported instead of stopping the self-test.
        print(f"[self-test] {name} ...", flush=True)
        box: dict = {}

        def run() -> None:
            try:
                box["r"] = {"ok": True, "detail": fn()}
            except BaseException as exc:  # report every failure, not just the first
                box["r"] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}"}

        th = threading.Thread(target=run, daemon=True)
        th.start()
        th.join(timeout)
        checks[name] = box.get("r") or {"ok": False, "detail": f"no answer within {timeout:.0f} s"}
        print(f"[self-test] {name}: {'ok' if checks[name]['ok'] else 'FAILED'} {checks[name]['detail']}", flush=True)

    def health():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=5) as r:
            return json.loads(r.read())

    def ui():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=5) as r:
            body = r.read(4096).decode("utf-8", "replace")
        if 'id="root"' not in body:
            raise RuntimeError("index.html not served")
        return "index.html served"

    def database():
        db = folder / "data_validator.db"
        if not db.exists():
            raise RuntimeError(f"{db} was not created")
        return str(db)

    def duckdb_engine():
        import duckdb

        con = duckdb.connect()
        n = con.execute("select count(*) from range(1000)").fetchone()[0]
        return f"duckdb {duckdb.__version__}, {n} rows"

    def extensions():
        from app.engine.readers import _ext_dir

        d = _ext_dir()
        found = sorted(p.name for p in d.rglob("*.duckdb_extension")) if d.exists() else []
        return f"{d} ({len(found)} files)"

    def drivers():
        import importlib

        out = {}
        for mod in ("snowflake.connector", "oracledb", "pyodbc", "psycopg", "pymysql", "pyarrow", "python_calamine", "keyring"):
            try:
                importlib.import_module(mod)
                out[mod] = "ok"
            except Exception as exc:
                out[mod] = f"missing: {exc}"
        bad = [k for k, v in out.items() if v != "ok" and k not in ("pyodbc",)]
        if bad:
            raise RuntimeError(f"cannot import {', '.join(bad)}")
        return out

    def window():
        import webview  # noqa: F401

        if os.name == "nt":
            import webview.platforms.edgechromium  # noqa: F401  (pythonnet + WebView2 loader)
        return f"pywebview {getattr(webview, '__version__', '')}".strip()

    check("health", health)
    check("ui", ui)
    check("database", database)
    check("duckdb", duckdb_engine)
    check("duckdb_extensions", extensions)
    check("drivers", drivers)
    check("window", window)
    ok = all(c["ok"] for c in checks.values())  # type: ignore[index]
    report = {"passed": ok, "frozen": is_frozen(), "data_dir": str(folder), "port": port, "frontend": str(frontend_dist), "checks": checks}
    (folder / "self-test.json").write_text(json.dumps(report, indent=2), "utf-8")
    print(json.dumps(report, indent=2))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# Window
# ---------------------------------------------------------------------------
class _JsApi:
    """Exposed to the UI as ``window.pywebview.api``."""

    def __init__(self, folder: Path):
        self._folder = folder

    def pick_folder(self) -> str:
        try:
            import webview

            result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
            if result:
                return result[0] if isinstance(result, (list, tuple)) else str(result)
        except Exception:
            pass
        return ""

    def open_data_folder(self) -> bool:
        try:
            if os.name == "nt":
                os.startfile(str(self._folder))  # type: ignore[attr-defined]
            else:
                webbrowser.open(self._folder.as_uri())
            return True
        except Exception:
            return False


_SPLASH = """<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2430;--muted:#6b7280;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--fg:#e6e8ee;--muted:#8b93a7;--accent:#818cf8}}
html,body{height:100%;margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
body{display:grid;place-items:center}
.box{display:grid;justify-items:center;gap:14px}
.name{font-size:22px;font-weight:600;letter-spacing:-.01em}
.msg{color:var(--muted);font-size:13px}
.bar{width:180px;height:3px;border-radius:3px;background:color-mix(in srgb,var(--accent) 18%,transparent);overflow:hidden}
.bar i{display:block;width:40%;height:100%;border-radius:3px;background:var(--accent);animation:m 1.1s ease-in-out infinite}
@keyframes m{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
</style></head><body><div class="box"><div class="name">Datanique</div><div class="bar"><i></i></div><div class="msg" id="m">Starting</div></div></body></html>"""


def _error_page(log: Path) -> str:
    import html

    return (
        _SPLASH.replace('<div class="bar"><i></i></div>', "")
        .replace('id="m">Starting', 'id="m">Datanique could not start.<br>Details are in<br>' + html.escape(str(log)))
    )


def _show_window(port: int, folder: Path, backend: threading.Thread) -> None:
    """Open the window at once with a small start screen and switch to the
    app when the backend answers. The window (WebView2) and the backend start
    at the same time instead of one after the other."""
    import webview

    window = webview.create_window(
        APP_NAME,
        html=_SPLASH,
        width=1440,
        height=900,
        min_size=(1024, 640),
        confirm_close=False,
        background_color="#0f1117" if _prefers_dark() else "#ffffff",
        js_api=_JsApi(folder),
    )
    window.events.shown += lambda: print(f"[datanique] window shown {_since()}", flush=True)

    def switch_to_app() -> None:
        if _wait_for_health(port, backend):
            print(f"[datanique] backend ready {_since()}", flush=True)
            window.events.loaded += lambda: print(f"[datanique] page loaded {_since()}", flush=True)
            window.load_url(f"http://127.0.0.1:{port}/")
        else:
            log = folder / "logs" / "datanique.log"
            print(f"[datanique] backend did not start {_since()}", flush=True)
            window.load_html(_error_page(log))

    # pywebview cancels every download unless this is on (CSV, JSON and Excel
    # exports and Diff & Merge saves all use browser downloads).
    webview.settings["ALLOW_DOWNLOADS"] = True
    # A persistent profile in the user's own data folder keeps browser storage
    # (open SQL IDE tabs, history, theme) between launches.
    storage = folder / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    clear_stale_web_cache(folder, storage, _project_paths()[1])
    webview.start(switch_to_app, gui=None, private_mode=False, storage_path=str(storage))


def clear_stale_web_cache(folder: Path, storage: Path, frontend_dist: Path) -> bool:
    """After an update, empty the window's HTTP cache (not its storage).

    The window keeps a disk cache of the UI. A cached index.html from the
    previous version asks for script files the new build no longer has
    ("Failed to fetch dynamically imported module"). The UI build is
    identified by a hash of index.html; when it differs from the last start,
    the cache folders are removed. Browser storage (SQL IDE tabs, history,
    theme) lives elsewhere in the profile and is kept."""
    import hashlib
    import shutil

    try:
        build = hashlib.sha256((frontend_dist / "index.html").read_bytes()).hexdigest()[:16]
    except OSError:
        return False
    state_file = folder / "desktop.json"
    try:
        state = json.loads(state_file.read_text("utf-8")) if state_file.exists() else {}
    except (OSError, ValueError):
        state = {}
    if state.get("ui_build") == build:
        return False
    cleared = False
    for profile in storage.glob("EBWebView/*"):
        for name in ("Cache", "Code Cache", "Service Worker"):
            d = profile / name
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
                cleared = True
    state["ui_build"] = build
    try:
        state_file.write_text(json.dumps(state), "utf-8")
    except OSError:
        pass
    print(f"[datanique] new UI build {build}; window cache {'cleared' if cleared else 'empty'}", flush=True)
    return cleared


def _prefers_dark() -> bool:
    """Windows app theme, so the start screen doesn't flash white in dark mode."""
    if os.name != "nt":
        return False
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def _parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="Datanique", add_help=True)
    p.add_argument("--data-dir", help="folder for this user's database, vault, runs and logs")
    p.add_argument("--portable", action="store_true", help="keep data beside the exe, in data\\<user name>")
    p.add_argument("--browser", action="store_true", help="open in the default browser instead of a window")
    p.add_argument("--self-test", action="store_true", help="check the build and exit")
    args, _unknown = p.parse_known_args(argv)
    return args


def main(argv: list[str] | None = None) -> int:
    global QUIET
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    backend_dir, frontend_dist = _project_paths()
    _load_env_file(backend_dir)

    folder, how = resolve_data_dir(args.data_dir, args.portable)
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        message_box(f"Cannot create the data folder\n{folder}\n\n{exc}", error=True)
        return 2
    if args.self_test:
        QUIET = True
    if is_frozen():
        redirect_output(folder)
    print(f"[datanique] data folder: {folder} ({how})")

    lock = InstanceLock(folder)
    if not lock.acquire():
        if args.self_test:
            print("[datanique] another instance is using this data folder")
            return 3
        if not focus_existing_window():
            message_box(f"Datanique is already running for this data folder:\n{folder}")
        return 0

    try:
        if not (frontend_dist / "index.html").exists():
            print(f"[datanique] Frontend build not found at {frontend_dist}. Run `npm run build` in the frontend folder.")

        port = choose_port(folder)
        _configure_env(port, folder, backend_dir, frontend_dist)
        t = threading.Thread(target=_run_backend, args=(port,), daemon=True)
        t.start()
        fell_back = False
        try:
            if not args.self_test and not args.browser:
                try:
                    _show_window(port, folder, t)
                    return 0
                except Exception as exc:
                    # No WebView2 runtime (rare on Windows 10/11): use the browser.
                    print(f"[datanique] native window failed: {exc!r}")
                    fell_back = True
            if not _wait_for_health(port, t, timeout=60.0 if args.self_test else 90.0):
                log = folder / "logs" / "datanique.log"
                message_box(f"Datanique could not start.\n\nDetails are in\n{log}", error=True)
                return 1
            print(f"[datanique] backend ready {_since()}", flush=True)
            if args.self_test:
                return _self_test(port, folder, frontend_dist)
            _browser_mode(port, reason="The Datanique window could not open, so it opened in your web browser instead." if fell_back else "")
            return 0
        finally:
            _shutdown_backend(t)
    finally:
        lock.release()
    return 0


def _browser_mode(port: int, reason: str = "") -> None:
    webbrowser.open(f"http://127.0.0.1:{port}/")
    text = (reason + "\n\n" if reason else "") + "Datanique is running in your web browser.\nClick OK to stop it."
    if os.name == "nt" and is_frozen():
        message_box(text)
    else:
        print(f"[datanique] http://127.0.0.1:{port}/  (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass


def hard_exit(code: int) -> None:
    """End the process without any teardown.

    On Windows even os._exit() goes through ExitProcess, which runs the
    shutdown routine of every loaded DLL. The .NET runtime behind the window
    (pythonnet) can deadlock there, leaving an invisible Datanique.exe that
    holds the data folder lock. TerminateProcess skips those routines; by now
    the backend has stopped, the database is closed and the lock released."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.TerminateProcess.argtypes = (wintypes.HANDLE, wintypes.UINT)
            k32.TerminateProcess(k32.GetCurrentProcess(), code & 0xFFFFFFFF)
        except Exception:
            pass
    os._exit(code)


def run() -> None:
    """Entry point. Ends with hard_exit: by then the backend has shut down and
    the lock is released, and skipping interpreter and DLL teardown avoids
    native libraries (DuckDB, drivers, .NET) hanging or aborting on the way out."""
    try:
        code = main()
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else 1
    except BaseException:
        import traceback

        traceback.print_exc()
        code = 1
    print(f"[datanique] exit {code}")
    hard_exit(code)


if __name__ == "__main__":
    run()
