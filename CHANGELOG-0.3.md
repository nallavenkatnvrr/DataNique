# Datanique 0.3.4 - portable Windows app

Date: 22 Oct 2026.

- **Datanique.exe**: a portable Windows build. Unzip
  `Datanique-0.3.4-windows-portable.zip` anywhere (a USB stick or a shared
  folder works too) and run `Datanique.exe`. Python, Node.js and admin rights
  are not needed; the window uses the WebView2 runtime that comes with
  Windows 10 and 11. Database drivers and the DuckDB PostgreSQL / MySQL /
  httpfs extensions are inside, so it works without internet access.
- **Every Windows user has their own data**: connections, master-password
  vault, run history, scripts, exports and logs go to that user's
  `%APPDATA%\Datanique\backend-data`, the same folder `start-app.bat` uses,
  so existing data shows up in the exe. Options: `--data-dir "D:\folder"`,
  or a file named `portable` beside the exe to keep data in
  `data\<user name>` next to it.
- Only one Datanique runs per data folder; starting it again brings the
  open window to the front. Each data folder keeps its own port, so two
  people signed in to the same server do not collide and the SQL IDE tabs
  survive restarts.
- If the window cannot open (no WebView2), Datanique opens in the default
  browser instead. `--browser` does that on purpose.
- Settings → Storage shows your data folder, with an Open folder button.
- Build it on your own PC with `desktop_py\build-exe.bat`: installs the
  packages, freezes the app, runs `Datanique.exe --self-test` (at most 5
  minutes, its log is printed if it fails) and zips it.
- **Python 3.14**: requirements moved to versions with ready-made Windows
  wheels for 3.14 (pydantic 2.12, SQLAlchemy 2.0.45, cryptography 46,
  snowflake-connector-python 4.4, pyodbc 5.3, psycopg 3.2.10, pyarrow 22+,
  oracledb 3.3+); `desktop_py\requirements-desktop.txt` holds pywebview and
  pythonnet 3.2. Tests pass on 3.12 and 3.14; CI runs both.

# Datanique 0.3.3

Date: 17 Oct 2026.

- A finished compare is marked done only after it is saved to history. On a
  slow PC the live page could open the result a moment too early and show
  "Run not found".
- Compare page: Clear keeps the default connection on table and query sides,
  so you can pick a table straight away.
- README rewritten, user guide with screenshots (docs/USER-GUIDE.md), plain
  hyphens instead of em dashes in docs and comments.

# Datanique 0.3.2 - smoother UI on slow PCs and virtual desktops

Date: 16 Oct 2026. Measured in Chromium with the CPU slowed 4× and no GPU
acceleration (like a virtual desktop):

| | before | after |
|---|---|---|
| Difference grid, scrolling | 35 fps, 12 frames > 50 ms | 44 fps, 6 frames > 50 ms |
| Side rail, hover | 50 fps, layout on every frame | 60 fps |
| Live job page | redrawn 5× a second | elapsed time ticks on its own |
| SQL IDE results, scrolling | 39 fps, 9 frames > 50 ms | 43 fps, 6 frames > 50 ms |

- **Difference grid**: draws only the rows *and columns* on screen (wide
  tables with 60+ columns no longer lay out every column), keys
  and row numbers stay pinned on the left while scrolling sideways, rows are
  recycled instead of re-created, one render per frame.
- **Style recalculation halved everywhere**: Tailwind's per-element CSS
  variables (`*, ::before, ::after { --tw-…}`) are declared once with
  `@property` instead (as Tailwind 4 does). Screens are pixel-identical.
- No more blur behind the top bar, rail, grid headers and dialogs; the big
  blurred glows on Home and the lock screen are plain gradients.
- Rail opens after a short hover pause instead of on every pass of the mouse.
- **Settings → Visual effects**: Automatic / Full / Light. Light turns off
  shadows, transitions and animations; Automatic picks it when the browser
  has no graphics acceleration (software renderer).
- Compare drafts are saved after you pause typing, not on every key.

# Datanique 0.3.1 - fixes from the first Windows runs

Date: 16 Oct 2026.

- **"DuckDB currently has a read-only crypto module loaded"**: DuckDB writes
  encrypted files only with OpenSSL from its httpfs extension. Datanique now
  loads httpfs (from the DuckDB cache, `backend/duckdb_extensions`, or a
  one-time install). If httpfs can't be loaded, the diff file is written as
  a working file and sealed with Datanique's own AES-256-GCM right after the
  run (`runs/<id>.dvs`); browsing decrypts a temporary copy that is removed
  after 15 idle minutes, when the vault locks and at start-up. Without httpfs,
  temporary spill files of very large compares are not encrypted; they are
  deleted when the run ends. `/api/version` shows which mode is in use.
- **Snowflake fast reader**: "ArrowInvalid: Schema at index N was different"
  made Snowflake fall back to the slow row-by-row reader (about 9,000 rows/s).
  Cause: inside one result chunk the connector converts a batch that holds a
  date like 9999-12-31 to microsecond timestamps and the others to
  nanoseconds (also integer widths, nullability). Batches are now cast to one
  schema, so the Arrow reader keeps working.
- Batches whose types change between chunks (narrow → wide integers, ns → us
  timestamps, a column NULL in the first chunk) no longer fail or overflow.
- Progress: Oracle / Snowflake / cursor readers now show a percentage from
  the table's catalog row count instead of 0%.

# Datanique 0.3 - new compare engine, encryption, redesigned app

Date: 16 Oct 2026. Builds on the SQL IDE update (CHANGELOG-SQL-IDE.md).

## Compare engine (replaces standard, checksum, pandas, polars, duckdb, spark)

One DuckDB-based engine for every comparison. Each side is a **table**, a
**SQL query** or a **file**, in any combination.

- **Readers** (first that works is used; the run log names it):
  PostgreSQL - DuckDB scanner (parallel binary COPY) → ADBC → cursor ·
  MySQL - DuckDB scanner → ADBC (dbc) → ConnectorX → cursor ·
  SQL Server - ADBC (dbc `mssql`) → Arrow ODBC → ConnectorX → cursor ·
  Snowflake - ADBC (password logins) → connector Arrow batches (SSO keeps its
  session) → cursor · Oracle - python-oracledb Arrow batches → ConnectorX →
  cursor. Both sides are read at the same time. Override the order with
  `DV_READER_ORDER_<DB>`.
- **Files:** CSV / TSV / PSV / TXT / DAT (+ .gz .zst .zip, any encoding),
  Excel (.xlsx .xlsm .xlsb .xls .ods; sheet picker), Parquet (file or
  folder), JSON / NDJSON, Avro, ORC, Arrow / Feather, fixed width. Upload, or
  read in place by path (folder browser), no size cap in memory.
- **Comparison:** both sides are projected to the same canonical type per
  column: 12.50 = 12.5, '007' = 7, DATE = midnight TIMESTAMP, time zones in
  UTC, doubles to 15 significant digits, true = 1 = Y. Optional: trim, ignore
  case, empty = NULL, numeric tolerance, timestamp precision. Strict mode by
  switching the rules off.
- **Keys:** chosen columns, column positions, the table's primary key
  (automatic), or none (whole-row multiset compare). Duplicate keys are
  paired by value instead of multiplied. Manual column mapping with key /
  compare / skip roles, match by name or position.
- **Diff:** one hash join; per-column counts of rows that differ; schema
  drift (columns on one side only, type differences) is reported but is not
  part of the verdict.
- **In-database strategy:** for two tables on one connection (PostgreSQL,
  SQL Server, Oracle, Snowflake) the database does the join and returns only
  the differing rows. Chosen automatically above `DV_PUSHDOWN_MIN_ROWS`
  (20 million) or on request.
- **Every difference is kept** (up to 5 million rows per kind, configurable)
  in an encrypted per-run DuckDB file: browse, search, filter by column,
  export to Excel / CSV / Parquet / JSON, Excel report with highlighted cells.
- **File format checks** for two text files: line endings, BOM, trailing
  spaces, line lengths, SHA-256, first differing lines.
- **Background jobs:** runs continue when you leave the page; live progress
  (rows, %, phase), cancel; up to `DV_MAX_PARALLEL_COMPARES` at once.
- **Bulk:** pair whole schemas or folders by name (prefix stripping),
  per-pair keys, shared options, bounded concurrency, batch report.
- Old API endpoints (`/api/compare/run`, `/run/stream`, `/query/run/stream`)
  still work on the new engine; old templates load in the new composer.

### Measured (2M rows per side, 12 columns, local PostgreSQL, 2 vCPU)

| Engine | Time |
|---|---|
| old checksum | not finished after 25 min |
| old standard | failed (column-name case bug) |
| old pandas | 109 s |
| old polars | 52 s |
| old duckdb | 21 s |
| **new, local** | **12.5 s** |
| **new, in-database** | **10.1 s** |

## Encryption (vault)

- First launch asks for a **master password**. It unlocks a random 256-bit
  key (scrypt + AES-256-GCM) that encrypts saved database passwords, compare
  history, diff files, templates and the uploaded-file spill files.
- **Recovery key** shown once at setup; "Forgot password?" sets a new
  password with it. "Start over" deletes encrypted data but keeps
  connections (passwords must be re-entered).
- **Remember on this computer** keeps the key in Windows Credential Manager
  for your Windows account. **Auto-lock** after idle time, **Lock now**
  (Ctrl+Shift+L).
- While locked the API refuses everything (423). Each window gets a session
  token; requests without it are refused (401), which also blocks other web
  pages from using the local API. Unknown Host headers are refused (DNS
  rebinding).
- Existing data is encrypted on first setup; passwords saved with the old
  Fernet key are re-encrypted and `backend/.secret_key` is deleted.
- `DV_VAULT_PASSWORD` unlocks unattended servers.

## New UI (whole app)

Graphite dark / light themes, icon rail, command menu (Ctrl+K), live job
indicator. Pages: Home, Compare (composer), live job, result (verdict,
spectrum, sides, time breakdown, columns, statistics, file checks, log,
difference browser), Bulk, History (virtualized, filters, multi-delete,
batches), Batch report, Templates (run one / run all), Connections (test
inline), Settings (security, reader chains, storage, theme), vault screens.
The SQL IDE keeps its editor and gets the new frame.

## Fixes from the code review

- Diff & Merge: accepting a hunk produced wrong text (e.g. [A,B] / [Z,A] →
  [B,A]); swap compared the old texts.
- SQL Server: ODBC values with ; { } in passwords broke the connection string.
- Pool slots for role connections never grew; auth / dead-connection hints
  (e.g. "Unclosed quotation mark" was treated as a dead connection).
- Oracle fetch tuning now applies; Snowflake login timeout honours settings;
  PostgreSQL statement timeout from DV_QUERY_TIMEOUT.
- A failed connection test no longer drops running compares and IDE sessions.
- DDL generator keeps lengths and precision; CSV export no longer prefixes
  negative numbers; downloads aren't revoked before they start; buttons no
  longer submit forms by default; connection form keeps fields when the type
  changes and shows defaults.
- Refused requests carry CORS headers; unknown /api paths return 404 JSON;
  `backend/.env` is read regardless of the working folder; watchdog false
  "heartbeat dead" warning at start-up.
- Everything else in the review that concerned the removed engines, File
  Compare, Batch, ComparisonResult or MappingCanvas is gone with that code.

## Removed

pandas / polars / spark / checksum / standard / old duckdb engines, File
Compare and Batch pages (now Compare and Bulk), Spark files (hadoop, JDBC
jars), PATCH_NOTES.md, the stray `backend/1.0.0` file.

## Requirements

New Python packages (installed by start-app.bat / start-backend.bat):
duckdb 1.5.6 (pinned), python-calamine, fastavro, adbc-driver-manager,
adbc-driver-postgresql, adbc-driver-snowflake, arrow-odbc, keyring.
Optional: `dbc install mssql` / `dbc install mysql` (Columnar) for ADBC on
SQL Server / MySQL; connectorx.

The PostgreSQL / MySQL DuckDB scanners download once from
extensions.duckdb.org; if that site is blocked those databases use ADBC or the
cursor reader automatically.

## Verification

- Backend: 201 tests passed (pytest), including live PostgreSQL reader tests
  (local and in-database), every file format, vault and encryption at rest.
- Frontend: strict tsc, 31 unit tests, production build.
- End to end in Chromium (dark and light, dev and production build): vault
  setup with migration of existing data, compare 2M-row tables, result and
  difference browser, column filter, Excel report, file upload vs table,
  bulk, history, settings, lock / unlock, Diff & Merge, all SQL IDE suites.
- Not run here: Snowflake, Oracle, SQL Server and MySQL servers, the Windows
  desktop shell and Windows Credential Manager.
