# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the portable Datanique app: one folder with
# Datanique.exe and an _internal folder holding Python, the backend, the
# built UI and the database drivers. Nothing outside that folder is needed
# except the WebView2 runtime that ships with Windows 10 and 11.
#
# Build (the frontend must be built first, frontend/dist):
#   python -m PyInstaller desktop_py/datanique.spec --noconfirm
# or simply run desktop_py\build-exe.bat on Windows.
#
# Output: desktop_py/dist/Datanique/Datanique.exe
#
# The build contains code only. No data folder, .env, vault or database is
# ever packed: each user's data is created on first start (see app.py).

import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

HERE = Path(SPECPATH).resolve()
ROOT = HERE.parent
BACKEND = ROOT / "backend"
DIST_UI = ROOT / "frontend" / "dist"
sys.path.insert(0, str(BACKEND))

if not (DIST_UI / "index.html").exists():
    raise SystemExit("frontend/dist is missing. Run `npm ci && npm run build` in frontend first.")

APP_VERSION = re.search(r'APP_VERSION\s*=\s*"([^"]+)"', (BACKEND / "app" / "main.py").read_text("utf-8")).group(1)
Path(DISTPATH).mkdir(parents=True, exist_ok=True)
(Path(DISTPATH) / "Datanique-version.txt").write_text(APP_VERSION, "utf-8")  # read by build-exe.bat

# Packages with data files, native libraries or modules imported by name that
# static analysis misses. Missing optional packages are skipped.
_bundle = [
    "uvicorn", "fastapi", "starlette", "pydantic", "pydantic_settings", "sqlalchemy",
    "cryptography", "multipart", "dotenv",
    "duckdb", "pyarrow", "xlsxwriter", "python_calamine", "fastavro",
    "adbc_driver_manager", "adbc_driver_postgresql", "adbc_driver_snowflake", "arrow_odbc",
    "snowflake", "oracledb", "psycopg", "psycopg_binary", "pymysql",
    "keyring", "win32ctypes",
    "webview", "pythonnet", "clr_loader", "proxy_tools", "bottle",
]

datas, binaries, hiddenimports = [], [], []
for pkg in _bundle:
    try:
        d, b, h = collect_all(pkg)
    except Exception as exc:
        print(f"[spec] skipping {pkg}: {exc}")
        continue
    datas += d
    binaries += b
    hiddenimports += h

# The built UI, served by the backend from _internal/frontend_dist.
datas.append((str(DIST_UI), "frontend_dist"))

# DuckDB extensions for offline PCs, if present (backend/duckdb_extensions).
for f in (BACKEND / "duckdb_extensions").rglob("*.duckdb_extension"):
    datas.append((str(f), str(f.parent.relative_to(BACKEND))))

hiddenimports += collect_submodules("app")
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["anyio", "h11", "httptools", "websockets", "watchfiles", "email_validator", "pyodbc", "clr"]

# Never pack local data or secrets, even if they sit in the source tree.
_BLOCKED = re.compile(r"(\.db|\.sqlite3?|\.duckdb|\.dvs|\.env|\.secret_key|\.encryption_key|vault\.json)$", re.I)
datas = [(src, dst) for src, dst in datas if not _BLOCKED.search(str(src))]

# Analyse a copy of the launcher from an empty folder: PyInstaller searches
# the script's own folder first, and desktop_py/app.py there would hide the
# backend's `app` package.
import shutil
_entry = Path(workpath) / "entry"
_entry.mkdir(parents=True, exist_ok=True)
shutil.copy2(HERE / "datanique_launcher.py", _entry / "datanique_launcher.py")

a = Analysis(
    [str(_entry / "datanique_launcher.py")],
    pathex=[str(BACKEND)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter", "matplotlib", "IPython", "pytest", "_pytest", "pyspark", "py4j",
        "PIL", "PyQt5", "PyQt6", "PySide2", "PySide6", "qtpy", "gi", "playwright",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

_version_file = None
if sys.platform == "win32":
    from PyInstaller.utils.win32.versioninfo import (
        FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo, VarStruct, VSVersionInfo,
    )

    nums = tuple(int(x) for x in (re.findall(r"\d+", APP_VERSION) + ["0"] * 4)[:4])
    _version_file = VSVersionInfo(
        ffi=FixedFileInfo(filevers=nums, prodvers=nums),
        kids=[
            StringFileInfo([StringTable("040904B0", [
                StringStruct("CompanyName", "Datanique"),
                StringStruct("FileDescription", "Datanique data validation"),
                StringStruct("FileVersion", APP_VERSION),
                StringStruct("InternalName", "Datanique"),
                StringStruct("OriginalFilename", "Datanique.exe"),
                StringStruct("ProductName", "Datanique"),
                StringStruct("ProductVersion", APP_VERSION),
            ])]),
            VarFileInfo([VarStruct("Translation", [1033, 1200])]),
        ],
    )

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Datanique",
    icon=str(HERE / "datanique.ico"),
    version=_version_file,
    console=False,
    debug=False,
    strip=False,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Datanique",
)
