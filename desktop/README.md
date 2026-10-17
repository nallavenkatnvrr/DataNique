# Datanique Desktop

Native Windows desktop build of Datanique (Electron shell) that bundles the
existing React UI and the FastAPI backend into one installable app with
**auto-updates over the internet**.

Nothing in the web app is duplicated — the desktop shell reuses:
- the **React UI** from `../frontend` (built with Vite),
- the **FastAPI backend** from `../backend` (frozen with PyInstaller).

## How it works

```
Electron main.js
  ├─ picks a free loopback port (8123–8299)
  ├─ spawns the backend:
  │     dev  → ..\backend\.venv\Scripts\python.exe run_server.py
  │     prod → resources\backend\datanique-backend.exe   (frozen)
  ├─ waits for GET /api/health
  ├─ opens the built React app from http://127.0.0.1:<port>/ in production
  │     FastAPI serves the packaged resources/renderer via DV_STATIC_DIR, so the
  │     UI and API share one origin (no file:// CORS failure)
  │     preload.js injects window.__API_BASE__ for frontend API requests
  └─ electron-updater checks the feed and self-updates
```

The backend's DB + encryption key live under the per-user Electron data dir
(`%APPDATA%\Datanique\backend-data`) via `DV_DATA_DIR` / `DV_SECRET_KEY_FILE`,
so they survive updates and the app never writes into its read-only install dir. The embedded backend is loopback-only and disables API/admin token gates; it relies on the desktop user's local account and must not be exposed on a network interface.

## One-time prerequisites

Already present on this machine: **Node.js** (v24), **Python 3.12** (in
`..\backend\.venv`). Still needed:

```powershell
# 1. PyInstaller in the backend venv (freezes the backend to an .exe)
..\backend\.venv\Scripts\python.exe -m pip install pyinstaller

# 2. Electron toolchain (local to this folder — no global/system install)
npm install
```

No admin rights, no Rust/MSVC, no code-signing cert required. (Without a cert,
Windows SmartScreen shows an "unknown publisher" prompt on first install;
auto-update still works.)

## Develop (fast loop, no packaging)

```powershell
# Terminal A — Vite dev server
cd ..\frontend; npm run dev            # http://localhost:5173

# Terminal B — Electron pointing at Vite + reusing a running backend
$env:DATANIQUE_DEV = "1"
$env:DATANIQUE_VITE_URL = "http://localhost:5173"
npm run dev
```

In dev, if a backend is already running on `:8000` it is reused; otherwise the
shell spawns one from the venv.

## Build the installer

```powershell
# from data-validator\desktop
./build-desktop.ps1            # -> dist\Datanique Setup <version>.exe
./build-desktop.ps1 -Publish   # also writes latest.yml for auto-update
```

The script: freezes the backend → builds the UI → stages both into
`renderer/` and `resources/backend/` → runs electron-builder.

## Auto-update

### Now — local machine

`electron-builder.yml` uses the **generic** provider at
`http://127.0.0.1:8080/`. To test the update flow locally:

```powershell
# 1. Build+publish version 0.1.0
./build-desktop.ps1 -Publish

# 2. Serve the dist folder over HTTP (this is the "feed")
cd dist; npx --yes http-server -p 8080 .

# 3. Install the 0.1.0 setup exe, run the app.
# 4. Bump "version" in package.json to 0.1.1, rebuild+publish, refresh the feed.
#    The running 0.1.0 app will detect, download, and prompt to restart.
```

The published feed contents (`latest.yml` + `*.exe`) are what a real host serves.

### Later — internet (GitHub / AWS S3)

Only the `publish:` block in `electron-builder.yml` changes; `main.js` is
provider-agnostic:

```yaml
# GitHub Releases
publish:
  - provider: github
    owner: <org>
    repo: datanique

# AWS S3
publish:
  - provider: s3
    bucket: <bucket>
    region: us-east-1
    path: datanique/updates
```

Then `./build-desktop.ps1 -Publish` uploads directly (GitHub needs `GH_TOKEN`;
S3 needs AWS creds in the environment).

## Files

| File | Purpose |
|---|---|
| `main.js` | Electron main: spawns backend, window, auto-updater |
| `preload.js` | Injects `window.__API_BASE__` (loopback backend URL) |
| `package.json` | Electron deps + scripts |
| `electron-builder.yml` | Packaging + auto-update feed config |
| `build-desktop.ps1` | One-command build orchestrator |
| `../backend/run_server.py` | Programmatic uvicorn entry (frozen-safe) |
| `../backend/datanique_backend.spec` | PyInstaller freeze spec |
