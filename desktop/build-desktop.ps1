# Datanique desktop build orchestrator (Windows / PowerShell).
#
# End-to-end: freeze backend -> build React UI -> stage into desktop -> package
# the Windows installer (with the auto-update latest.yml) into desktop/dist.
#
# Usage (from the data-validator/desktop folder):
#     ./build-desktop.ps1              # build installer, no publish
#     ./build-desktop.ps1 -Publish     # also emit latest.yml for auto-update
#
# Prereqs (one-time):
#     backend venv:  ..\backend\.venv  with requirements.txt installed
#     pyinstaller:   ..\backend\.venv\Scripts\python.exe -m pip install pyinstaller
#     node deps:     npm install  (in this desktop folder)

param(
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$Desktop = $PSScriptRoot
$Root = Split-Path $Desktop -Parent
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Py = Join-Path $Backend ".venv\Scripts\python.exe"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# 1. Freeze the FastAPI backend with PyInstaller ------------------------------
Step "Freezing backend (PyInstaller)"
if (-not (Test-Path $Py)) { throw "Backend venv python not found at $Py. Create it and pip install -r requirements.txt." }
& $Py -m PyInstaller (Join-Path $Backend "datanique_backend.spec") --noconfirm --distpath (Join-Path $Backend "dist") --workpath (Join-Path $Backend "build")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }

# 2. Build the React UI -------------------------------------------------------
Step "Building frontend (vite)"
Push-Location $Frontend
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Frontend build failed" }
Pop-Location

# 3. Stage artifacts into the desktop project ---------------------------------
Step "Staging renderer + backend into desktop/"
$Renderer = Join-Path $Desktop "renderer"
$ResBackend = Join-Path $Desktop "resources\backend"
if (Test-Path $Renderer) { Remove-Item $Renderer -Recurse -Force }
if (Test-Path $ResBackend) { Remove-Item $ResBackend -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Renderer | Out-Null
New-Item -ItemType Directory -Force -Path $ResBackend | Out-Null

Copy-Item (Join-Path $Frontend "dist\*") $Renderer -Recurse -Force
Copy-Item (Join-Path $Backend "dist\datanique-backend\*") $ResBackend -Recurse -Force

# 4. Package the installer ----------------------------------------------------
Step "Packaging Electron installer (electron-builder)"
Push-Location $Desktop
if ($Publish) { npm run publish } else { npm run dist }
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "electron-builder failed" }

Step "Done"
Write-Host "Installer + latest.yml are in: $(Join-Path $Desktop 'dist')" -ForegroundColor Green
