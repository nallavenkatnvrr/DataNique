# Datanique desktop app

The desktop app runs the FastAPI backend on a loopback port and shows the UI
in a native window. The window is [pywebview], which uses the WebView2
runtime that comes with Windows 10 and 11, so there is no Electron and no
browser to bundle. Everything installs from PyPI.

| File | What it is |
|---|---|
| `datanique_launcher.py` | The launcher: picks the data folder and port, starts the backend, opens the window |
| `app.py` | Runs the launcher from source (`start-app.bat` uses it) |
| `datanique.spec` | PyInstaller recipe for the portable `Datanique.exe` |
| `build-exe.bat` | Builds, self-tests and zips the portable app on Windows |
| `requirements-desktop.txt` | pywebview, pythonnet and python-dotenv |
| `datanique.ico` | App icon |

## Portable Datanique.exe

Build it on Windows from the repository root:

```
desktop_py\build-exe.bat
```

It needs Python 3.10 to 3.14 on PATH (it reuses `backend\.venv` if it exists), and Node.js 20+ only if `frontend\dist` is not
built yet. The script creates `backend\.venv` if needed, installs the
requirements plus pywebview and PyInstaller, freezes the app, runs
`Datanique.exe --self-test` and zips it:

```
desktop_py\dist\Datanique\Datanique.exe
desktop_py\dist\Datanique\_internal\...          Python, drivers, UI
desktop_py\dist\Datanique-<version>-windows-portable.zip
```

Ship the zip, or the whole `Datanique` folder. `Datanique.exe` does not work
without the `_internal` folder next to it. One folder starts in a couple of
seconds; a single-file exe would unpack 700 MB to a temp folder on every
start, so it is not offered.

To include the DuckDB PostgreSQL / MySQL scanners and httpfs for PCs without
internet access, put them in `backend\duckdb_extensions` before building (see
the README there).

If the self-test fails, the script prints the exe's log
(`logs\datanique.log` in the test data folder) and `self-test.json`, which
names the check that failed.

The build never contains a database, vault, `.env` or key file: the spec
filters them out even if they sit in the source tree.

## One data folder per user

Everything a user creates (the metadata database `data_validator.db`, the
master-password vault, run history and diff stores, scripts, exports, the
window profile with the SQL IDE tabs, and `logs\datanique.log`) lives in
their data folder. The first match wins:

1. `Datanique.exe --data-dir "D:\some folder"`
2. `DV_DATA_DIR` in the environment, or in a `.env` file beside the exe
3. Portable mode, when a file named `portable` (or `portable.txt`) is next to
   the exe or `--portable` is given: `<exe folder>\data\<Windows user name>`.
   If that folder is not writable (a read-only share), it falls back to 4.
4. `%APPDATA%\Datanique\backend-data`, the folder `start-app.bat` has always
   used

Every Windows account therefore gets its own database and its own master
password, even when everyone starts the same copy from a shared drive.

Only one Datanique runs per data folder (an OS file lock,
`.instance.lock`, released automatically if the app crashes). Starting it a
second time brings the open window to the front.

The UI's browser storage belongs to its origin, which includes the port, so
each data folder keeps one port (saved in `desktop.json`). Ports are shared by
everyone signed in to a machine, which is why each folder gets its own instead
of one fixed number. `DV_DESKTOP_PORT` overrides it.

## Options

```
Datanique.exe [--data-dir FOLDER] [--portable] [--browser] [--self-test]
```

| Option | |
|---|---|
| `--data-dir FOLDER` | Use this data folder |
| `--portable` | Keep data in `data\<user name>` beside the exe |
| `--browser` | Open in the default browser; a small dialog stops it |
| `--self-test` | Start the backend, check the UI, database, DuckDB, extensions, drivers and window libraries, write `self-test.json` to the data folder, exit 0 when everything passed |

If the WebView2 window cannot open, Datanique falls back to the browser by
itself. A `.env` beside the exe is read for other `DV_` settings (see
`backend/app/config.py`). The embedded backend always binds to 127.0.0.1;
the vault session token protects the API from other local users.

## Run from source

```
start-app.bat
```

or, with the backend environment already set up:

```
backend\.venv\Scripts\python.exe desktop_py\app.py
```

Build the frontend first (`npm run build` in `frontend`); the backend serves
`frontend\dist` on the same origin as the API.

[pywebview]: https://pywebview.flowrl.com/
