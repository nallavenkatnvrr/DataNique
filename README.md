# Datanique

A web application to connect to multiple databases, validate data between tables or custom SQL queries, and work as a full SQL IDE — all from one interface.

Supports **Snowflake, Oracle, SQL Server, PostgreSQL, MySQL** with cross-engine comparisons (e.g. Oracle vs Snowflake).

## Features

### Data Validation
- **Any side, any combination** — a table, a SQL query or a file on each side: table vs table, query vs table, file vs table, file vs file, across Snowflake, Oracle, SQL Server, PostgreSQL and MySQL
- **Files** — CSV / TSV / PSV / TXT / DAT (+ .gz, .zst, .zip), Excel (.xlsx .xlsm .xlsb .xls .ods), Parquet (files or folders), JSON / NDJSON, Avro, ORC, Arrow / Feather, fixed width; upload them or read them in place by path
- **One engine** — DuckDB-based: both sides are read concurrently through the fastest available reader, compared with a single hash join, and every difference is saved encrypted for browsing and export
- **Fast readers** — DuckDB postgres/mysql scanners, ADBC (PostgreSQL, Snowflake, SQL Server and MySQL via dbc), Arrow ODBC, Oracle and Snowflake Arrow fetch, with automatic fallback; the run log names the reader used
- **In-database strategy** — for very large tables on one connection, the database joins them and returns only the differing rows
- **Type-aware comparison** — 12.50 = 12.5, '007' = 7, DATE = midnight TIMESTAMP, time zones to UTC, doubles to 15 significant digits, true = 1 = Y; optional trims, case, NULL = '', numeric tolerance, timestamp precision
- **Keys** — chosen, taken from the primary key, or none (whole-row multiset compare); duplicate keys are paired, not multiplied
- **Results** — verdict, equal / changed / only-in-source / only-in-target, rows that differ per column, column statistics, file format checks (line endings, BOM, checksums), full difference browser with search and column filter, exports to Excel / CSV / Parquet / JSON, Excel report
- **Bulk** — pair whole schemas or folders by name, run with bounded concurrency in the background
- **Background jobs** — runs continue when you leave the page; live progress and cancel
- **Security** — master password vault (scrypt + AES-256-GCM), recovery key, optional "remember on this computer" (Windows Credential Manager), encrypted history / diffs / templates / passwords, API locked until unlocked

### SQL IDE (DBeaver-like)
- **Editor** — CodeMirror 6 with a GitHub light/dark theme that follows the app, dialect-aware highlighting, completion of tables, columns, keywords and templates (`sel`, `selw`, `grp`, `dupes`, `cte`, `merge`, …), grammar-aware completion for PostgreSQL / MySQL, multi-cursor, rectangular selection, folding, find & replace, go to line, formatter (Ctrl+Shift+F), upper/lower case, per-tab undo history
- **Statement-aware execution** — a dialect-aware splitter (strings, comments, `$$` bodies, `BEGIN … END`, Oracle `/`, SQL Server `GO`, MySQL `DELIMITER`) drives Ctrl+Enter (statement at cursor / selection), Alt+X (script), the ▶ run markers in the gutter and the current-statement highlight
- **Errors in place** — a failing statement is underlined at the reported line/position; the Messages view lists every statement with status, rows and timing
- **Results** — virtualized grid (keyboard navigation, range selection, Count/Sum/Avg/Min/Max of the selection, copy as TSV/CSV/JSON/Markdown/INSERT/IN-list/WHERE, value filters, quick filter), Text and Record views, value panel (F7, pretty JSON), pinned result tabs, per-result-set tabs for scripts, paging from server memory, Fetch all, exports
- **Explain plan** (Ctrl+Shift+E) and **Count rows** per dialect; **parameters** (`:name`, `${var}`) are prompted and remembered
- **Transactions** — auto-commit or manual commit per tab with Commit / Rollback; production connections get a red status bar and a confirmation before data-changing statements
- **Workspace** — script tabs (rename, reorder, duplicate, reopen closed), versioned script library per connection, database explorer (columns, quick queries, DDL / INSERT / EXEC generators, drag names into the editor), persistent query history, command palette (Ctrl+Shift+P), keyboard shortcuts dialog, editor settings (Ctrl+,), focus mode
- **Sessions** — one server session per tab, closed when the tab closes or the page unloads, expired after 8 idle hours; cancelling a statement interrupts it through the driver and keeps the session
- **Visual Diff / Quick Diff** — compare any two result sets side-by-side (cell-level diff, Excel export)
- **Query manager** — running and recent queries from every IDE session, with cancel

### UI
- Dark and light themes, command menu (Ctrl+K), lock (Ctrl+Shift+L), live job indicator, virtualized grids

## Architecture

- **Backend**: Python FastAPI (0.3.0)
  - `app/engine/` — compare engine: `spec` (request model), `readers` (database reader chains), `files` (file formats), `canon` (canonical comparison types), `core` (diff), `pushdown` (in-database strategy), `jobs` (background jobs, bulk), `diffstore` / `report` (encrypted diff stores, exports, Excel)
  - `app/security/` — `vault` (master password, AES-256-GCM, sessions), `vault_migrate`, `crypto`
  - `app/connectors/`, `app/sql_dialects/` — database drivers and SQL per database
  - `app/services/query_session.py` — SQL IDE sessions
  - `app/routers/` — jobs, files, compare history, vault, connections, metadata, sql-ide, templates, settings
  - `app/db/` — SQLite store with encrypted columns
- **Frontend**: React + TypeScript + Vite + Tailwind
  - `components/shell/` — app frame, command menu; `components/vault/` — setup / unlock / recovery
  - `pages/Compare.tsx` + `components/compare/` — composer; `pages/Job.tsx` — live run; `pages/Run.tsx` + `components/run/DiffBrowser.tsx` — results
  - `pages/Bulk.tsx`, `History.tsx`, `Batch.tsx`, `Templates.tsx`, `Connections.tsx`, `Settings.tsx`
  - `pages/SqlIde.tsx` + `components/sql-ide/` — SQL IDE

## Quick start (Windows)

```powershell
# 1. Backend
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# 2. Frontend (in a second terminal)
cd frontend
npm install
npm run dev
```

Then open http://localhost:5173.

### Network and API tokens

The backend binds to loopback by default. Setting `DV_BIND_HOST` to a non-loopback address requires `DV_API_TOKEN`; protected admin actions can additionally use `DV_ADMIN_TOKEN`. A separately built web frontend sends these as `X-API-Token` / `X-Admin-Token` headers when `VITE_API_TOKEN` / `VITE_ADMIN_TOKEN` are configured. Those Vite values are public in the browser bundle and are only shared-secret gates, not multi-user authentication. Embedded desktop launchers bind to loopback and clear both token gates.

### Offline machines

The PostgreSQL and MySQL scanners are DuckDB extensions. They are loaded from
`backend/duckdb_extensions/v<duckdb version>/<platform>/` when present,
otherwise downloaded once from extensions.duckdb.org. Without either, those
databases fall back to ADBC or the cursor reader automatically.

## Project layout

```
data-validator/
  backend/
    app/
      engine/          # compare engine (readers, files, diff, jobs, diff stores)
      security/        # vault, encryption
      connectors/      # DB drivers
      sql_dialects/    # SQL per database
      services/        # SQL IDE sessions, DDL generation, settings
      routers/         # FastAPI routes
      db/              # SQLite store (encrypted columns)
      reports/         # Excel report for runs from older versions
    duckdb_extensions/ # bundled DuckDB scanners (optional)
  frontend/
    src/
      components/      # shell, vault, compare, run, sql-ide, kit
      pages/           # Home, Compare, Job, Run, Bulk, History, Batch, Templates, Connections, SQL IDE, Settings
      api/             # API client, engine API, session
```

## Testing

The backend ships a pure-logic unit test suite (no live database required):

```powershell
cd backend
pip install -r requirements-dev.txt
python -m pytest
```

Covers the compare engine on every file format, normalization rules, keyed
and whole-row diffs, duplicates, mappings, diff stores and exports, bulk jobs,
the vault and encrypted storage, routers, the SQL IDE services and dialects.
Set `DV_TEST_PG=host:port/db/user[/password]` to also run the PostgreSQL
reader tests (local and in-database strategies).

## Observability

- Every HTTP response carries an `X-Request-ID` header. Unhandled server errors
  return a clean JSON envelope `{ "error", "detail", "request_id" }` and are
  logged with the same id, so a user-reported failure can be traced in the logs.
- Slow (>5s) and `5xx` responses are logged with timing; successful hot-path
  requests are not, to keep logs quiet.

## Notes

- On first launch you create a master password. Saved passwords, history, diffs and templates are encrypted with it; keep the recovery key it shows. Passwords saved by older versions are re-encrypted automatically and the old `backend/.secret_key` is deleted.
- The Oracle driver uses `oracledb` in thin mode (no Oracle Instant Client needed).
- The SQL Server driver uses `pyodbc` and requires the Microsoft ODBC Driver for SQL Server installed on the host running the backend.
- For very large tables on one connection, the in-database strategy is chosen automatically (DV_PUSHDOWN_MIN_ROWS); a row limit per side gives a quick sampled check.
- SQL IDE sessions and results are stored in memory. Restarting the backend clears active sessions; the IDE opens a new session on the next run (a pending manual transaction is rolled back). Script text, query history and editor settings live in the browser's local storage.
