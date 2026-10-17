# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec that freezes the Datanique FastAPI backend into a single
# self-contained executable so the Electron desktop app can ship without
# requiring Python on the end-user's machine.
#
# Build:  pyinstaller datanique_backend.spec --noconfirm
# Output: backend/dist/datanique-backend/datanique-backend(.exe)
#
# We use one-DIR (not one-FILE) mode: it starts faster (no per-launch temp
# extraction of ~200MB of native libs) and plays nicely with electron-builder's
# extraResources packaging.

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

_BACKEND_DIR = Path(SPECPATH).resolve()
sys.path.insert(0, str(_BACKEND_DIR))

# ---------------------------------------------------------------------------
# Packages whose data files / dynamic libs / hidden submodules PyInstaller's
# static analysis misses. collect_all grabs datas + binaries + hiddenimports.
# ---------------------------------------------------------------------------
_bundle = [
    "uvicorn",          # ASGI server: many hidden imports (loops, protocols)
    "fastapi",
    "pydantic",
    "pydantic_settings",
    "sqlalchemy",
    "cryptography",
    "snowflake",        # snowflake-connector-python (+ vendored certs)
    "oracledb",
    "psycopg",
    "pymysql",
    "duckdb",
    "pyarrow",
    "xlsxwriter",
    "python_calamine",
    "fastavro",
    "adbc_driver_manager",
    "adbc_driver_postgresql",
    "adbc_driver_snowflake",
    "arrow_odbc",
    "keyring",
]

datas, binaries, hiddenimports = [], [], []
for pkg in _bundle:
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as exc:  # pragma: no cover - some pkgs may be absent
        print(f"[spec] skipping optional package {pkg!r}: {exc}")

# uvicorn's worker/loop/protocol modules are imported by string and must be
# forced in explicitly, plus our own app package (imported via app.main).
# Bundled DuckDB scanner extensions (offline PostgreSQL / MySQL readers)
_ext = _BACKEND_DIR / "duckdb_extensions"
if _ext.exists():
    for f in _ext.rglob("*.duckdb_extension"):
        datas.append((str(f), str(f.parent.relative_to(_BACKEND_DIR))))

hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("app")
hiddenimports += [
    "anyio",
    "h11",
    "httptools",
    "websockets",
    "watchfiles",
    "email_validator",
    # pyodbc is a single C-extension driver for SQL Server; pull it in even
    # though collect_all above doesn't list it (it has no data files).
    "pyodbc",
]

block_cipher = None

a = Analysis(
    [str(_BACKEND_DIR / "run_server.py")],
    pathex=[str(_BACKEND_DIR)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="datanique-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,   # keep a console so backend logs are visible if launched directly
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="datanique-backend",
)
