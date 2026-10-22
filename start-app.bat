@echo off
setlocal
cd /d "%~dp0backend"

if not exist .venv (
    echo Creating virtualenv...
    python -m venv .venv
)

.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install -r "%~dp0desktop_py\requirements-desktop.txt"

set "PYTHONDONTWRITEBYTECODE=1"

echo Starting app
"%~dp0backend\.venv\Scripts\python.exe" "%~dp0desktop_py\app.py"

endlocal