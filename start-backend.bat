@echo off
setlocal
cd /d "%~dp0backend"

if not exist .venv (
    echo Creating virtualenv...
    python -m venv .venv
)

.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt

REM Prevent Python from writing .pyc files into app\__pycache__\ - those
REM writes were the main thing triggering watchfiles' reload storm.
set "PYTHONDONTWRITEBYTECODE=1"

REM Bind to loopback by default - the app has no login and the SQL IDE runs
REM arbitrary SQL. To expose beyond localhost set DV_BIND_HOST=0.0.0.0 (and
REM ideally DV_API_TOKEN=...), then override the --host below accordingly.
if not defined DV_BIND_HOST set "DV_BIND_HOST=127.0.0.1"
if not defined DV_BIND_PORT set "DV_BIND_PORT=8000"
echo Starting backend on http://%DV_BIND_HOST%:%DV_BIND_PORT% ...
.venv\Scripts\python.exe -m uvicorn app.main:app --host %DV_BIND_HOST% --port %DV_BIND_PORT%

endlocal