# Datanique Desktop (pywebview)

A native desktop build of Datanique that works on **locked-down corporate
networks** where Electron cannot be installed (its prebuilt binary download
from GitHub is blocked).

Instead of Electron, this uses **[pywebview]** - a small Python package that
renders the UI in the **WebView2 runtime already built into Windows 10/11**.
Everything installs from **PyPI** (reachable via your corporate proxy), with
**no GitHub binary downloads**.

## Why this over Electron

| | Electron | pywebview (this) |
|---|---|---|
| Download source | GitHub releases (**blocked here**) | PyPI (**works here**) |
| Renderer | bundles Chromium (~150 MB) | uses built-in Windows WebView2 |
| Language | Node | Python (already installed) |
| Freeze to .exe | electron-builder | PyInstaller (already set up) |

## How it works

```
desktop_py/app.py
  ├─ picks a free loopback port
  ├─ sets DV_STATIC_DIR -> frontend/dist  (so FastAPI serves the built UI)
  ├─ starts uvicorn(app.main:app) in a background thread
  │     the backend serves BOTH /api/* and the React SPA, same-origin
  ├─ waits for GET /api/health
  └─ opens a native WebView2 window at http://127.0.0.1:<port>/
```

Because the UI is served **same-origin** by the backend, the app's relative
`/api` calls and `BrowserRouter` work unchanged - no `__API_BASE__` / HashRouter
needed (those remain only for the Electron variant).

The DB + encryption key are stored under `%APPDATA%\Datanique\backend-data` via
`DV_DATA_DIR` / `DV_SECRET_KEY_FILE`, so they survive updates. The embedded
backend binds to loopback and clears API/admin token gates; it relies on the
local desktop account and must not be exposed on a network interface.

## Prerequisites (already done on this machine)

```powershell
# pywebview + env-file loader (from PyPI)
..\backend\.venv\Scripts\python.exe -m pip install pywebview==5.4 python-dotenv==1.0.1
```

Python 3.12 venv with the backend requirements is assumed at `..\backend\.venv`.

## Run from source (native window)

```powershell
# from data-validator\frontend  (one-time / after UI changes)
npm run build

# from data-validator\desktop_py
..\backend\.venv\Scripts\python.exe app.py
```

A native Datanique window opens. Closing it requests a graceful Uvicorn shutdown
before the launcher exits. Source runs load `backend/.env` (or `.env` in the
current directory); frozen builds load `.env` beside `Datanique.exe` (or from
the current directory). Keep secrets in that external file, not in the build.

## Freeze to a distributable .exe directory (PyInstaller)

The launcher and backend must be analyzed together: `--paths` makes the backend
package importable to PyInstaller, `--collect-all` includes packages with
runtime-loaded modules or native data, and the hidden imports mirror
`..\backend\datanique_backend.spec`. The backend source is not added as data.

```powershell
..\backend\.venv\Scripts\python.exe -m pip install pyinstaller

# from data-validator\desktop_py
..\backend\.venv\Scripts\python.exe -m PyInstaller `
  --name Datanique `
  --windowed `
  --paths "..\backend" `
  --add-data "..\frontend\dist;frontend_dist" `
  --collect-all webview `
  --collect-all uvicorn `
  --collect-all fastapi `
  --collect-all pydantic `
  --collect-all pydantic_settings `
  --collect-all sqlalchemy `
  --collect-all cryptography `
  --collect-all snowflake `
  --collect-all oracledb `
  --collect-all psycopg `
  --collect-all pymysql `
  --collect-all duckdb `
  --collect-all polars `
  --collect-all pandas `
  --collect-all pyarrow `
  --collect-all xlsxwriter `
  --collect-all connectorx `
  --collect-all xxhash `
  --collect-all dotenv `
  --collect-submodules app `
  --hidden-import anyio `
  --hidden-import h11 `
  --hidden-import email_validator `
  --hidden-import httptools `
  --hidden-import websockets `
  --hidden-import watchfiles `
  --hidden-import pyodbc `
  --exclude-module pyspark `
  --exclude-module py4j `
  app.py
```

`app.py` resolves `frontend_dist` under `sys._MEIPASS` when frozen, and
`--paths ..\backend` lets PyInstaller package the backend's Python modules and
their imports. Spark is intentionally unavailable in this desktop build:
PySpark and its JVM bridge are excluded, matching the Electron backend spec.
Output: `dist\Datanique\Datanique.exe` (one-dir). Ship that folder, or wrap it
with an installer (Inno Setup / NSIS) if you want Start-Menu shortcuts.

## Auto-update

pywebview has no built-in updater (unlike electron-updater). Recommended path:

- **Now (local):** distribute the built folder / installer manually.
- **Later (internet):** add a lightweight check on startup - the app calls a
  version endpoint (GitHub Releases API or an S3 `latest.json`), and if a newer
  build exists, downloads the new installer and launches it. This is ~40 lines
  and can be added when the GitHub/S3 hosting is decided.

## Files

| File | Purpose |
|---|---|
| `app.py` | Launcher: starts backend thread + opens WebView2 window |
| `../backend/app/main.py` `_mount_spa()` | Serves the built React UI same-origin (inert without a build) |

[pywebview]: https://pywebview.flowrl.com/
