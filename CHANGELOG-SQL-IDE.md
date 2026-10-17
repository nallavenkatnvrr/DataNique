# SQL IDE redesign — changelog

Date: 16 Oct 2026. Scope: the SQL IDE page (layout, editor, results, explorer,
history), its backend session/execution service, the pywebview desktop shell,
and the frontend build. Other pages are unchanged apart from the version label
and the shortcuts dialog.

The design follows GitHub's code editor (Primer colours, typography, gutter)
and the day-to-day feature set of DBeaver and SqlDbx.

## Layout

- Activity bar (Database explorer, Scripts, History, command palette,
  shortcuts, settings, focus mode) and a resizable side bar.
- Script tabs in VS Code style: connection colour dot, unsaved dot for library
  scripts, running spinner, "txn" badge for an open manual transaction, inline
  rename (double-click / F2), middle-click close, drag to reorder, context menu
  (close others / to the right / all, duplicate, save, download), Undo after
  closing, "Reopen closed script".
- One-row toolbar: Run split button (statement / new result tab / script /
  explain / count), script, cancel, explain, format, save; connection,
  database, schema and (Snowflake) role / warehouse pickers with search;
  auto-commit / manual mode with Commit and Rollback; max rows; overflow menu.
  It sheds secondary buttons when the editor column is narrow.
- Status bar: connection, context, transaction state, cursor line/column and
  selection, "statement i of n", run state and time, word wrap, tab size,
  dialect. It turns red for connections marked Production.
- Results panel can be resized, hidden (Ctrl+J) or maximised (Alt+Shift+Enter).
  Focus mode (Ctrl+Alt+Z) hides the app navigation.
- The page now fills the window exactly (the old layout left a strip under the
  status bar).

## Editor

- One CodeMirror 6 editor driven directly (no React wrapper). Each tab keeps
  its own document state, so undo history, selection and scroll survive tab
  switches, and stale-prop overwrites are impossible.
- GitHub Light / Dark theme that follows the app, or forced in settings; font,
  size, line height, tab size, word wrap, line numbers configurable (Ctrl+,).
- Dialect-aware statement splitter shared with the backend (strings, quoted
  identifiers, comments, `$$` bodies, `q'[...]'`, `BEGIN … END` / `CASE … END`,
  Oracle `/`, SQL Server `GO` and module bodies, MySQL `DELIMITER`, optional
  "blank line ends a statement").
- Current-statement highlight, ▶ run marker per statement in the gutter, flash
  of the executed range, failing token underlined with the error on hover.
- Completion: tables and columns of the active schema, keywords, and SQL
  templates (`sel`, `selw`, `sc`, `grp`, `dupes`, `nulls`, `minus`, `ins`, `upd`,
  `del`, `cte`, `join`, `ljoin`, `case`, `rn`, `exists`, `crt`, `ctas`, `merge`).
  Tab accepts; Enter only accepts an item picked with the arrow keys.
  Grammar-aware keyword completion for PostgreSQL and MySQL parses only the
  current statement.
- Formatter (Ctrl+Shift+F, selection or script), upper/lower case
  (Ctrl+Shift+X / Y), line and block comments, find / replace, go to line,
  next / previous / select statement, folding, multi-cursor, rectangular
  selection.
- Parameters: `:name` and `${var}` are detected (ignoring casts, strings,
  comments and PL/SQL bodies), prompted for, and remembered.
- Plain text editor fallback with the same commands.
- Removed: Monaco, Prism, react-simple-code-editor, @uiw/react-codemirror,
  react-resizable-panels, theme-one-dark.

## Running SQL

- Ctrl+Enter runs the statement at the cursor or the selection; Alt+X / F5 the
  script; Ctrl+\ into a new result tab; Ctrl+Shift+E explain plan (per dialect:
  Snowflake `EXPLAIN USING TABULAR`, Oracle `EXPLAIN PLAN` + `DBMS_XPLAN`,
  SQL Server `SHOWPLAN_TEXT`, PostgreSQL / MySQL `EXPLAIN`);
  Ctrl+Alt+Shift+C counts the rows of a query.
- Statements are sent pre-split; each gets its own entry in the Messages view
  (status, rows or rows affected, time, error) and its own result set.
  "Stop at first error" is configurable.
- Manual-commit mode per tab with Commit / Rollback; closing a tab, switching
  connection or going back to auto-commit with an open transaction asks first.
- Production connections: red status bar and a confirmation before INSERT,
  UPDATE, DELETE, MERGE, DDL, GRANT and similar statements.
- Polling backs off, survives transient errors, detects an expired session and
  re-creates it, and keeps running when you leave the IDE page (results are
  there when you come back).
- Cancel interrupts the statement through the driver (PostgreSQL, Oracle,
  SQL Server) and keeps the session; other drivers fall back to closing the
  connection.

## Results

- Virtualized grid with resizable / auto-fit columns, right-aligned numbers,
  NULL and control characters shown, sticky row numbers, keyboard navigation
  (arrows, Shift+arrows, Home/End, PageUp/Down, Ctrl+A), Ctrl+C / Ctrl+Shift+C.
- Selection statistics: count, distinct, sum, average, min, max.
- Context menu: copy as CSV / JSON / Markdown / INSERT / IN list / WHERE
  condition, column names, value filters (= / ≠ / IS NULL), sort, record view,
  value panel, export selection.
- Quick filter over loaded rows; Text view; Record view (Enter or double-click
  a row number); value panel with pretty JSON (F7).
- Result tabs can be pinned; scripts with several result sets get a set picker.
- Infinite scroll, Fetch all (with progress and stop), exports of every fetched
  row (CSV, JSON, Markdown, SQL INSERT, clipboard).
- Visual Diff now tells NULL, empty string and a missing row apart.

## Workspace

- Database explorer for the active connection and context: tables and views
  expand to columns with types; double-click inserts, drag drops into the
  editor; "Read data" / "Count rows" open in a new tab and run; dialect-correct
  `TOP` / `LIMIT` / `FETCH FIRST`; identifiers quoted when needed; DDL, INSERT,
  view / routine definitions, EXEC / CALL generators.
- Scripts view: open editors, and every connection's versioned script library
  with version history. Ctrl+S saves silently once a script has a library
  name; Ctrl+Shift+S saves as.
- Query history (persisted, searchable, per connection / failed only): click to
  insert, double-click to open, run again in a new tab.
- Command palette (Ctrl+Shift+P / F1) with every command, script and
  connection. Shortcuts dialog generated from the same command list.
- Query manager: running and recent queries of every session, with cancel.

## Backend

- `app/services/sql_split.py`: the shared splitter (same rules and test cases
  as the frontend).
- `query_session.py`: client-split statements, per-statement messages and
  result sets, error statement index, auto-commit / manual transactions,
  commit / rollback, bulk close, 8-hour idle reaper, progress counters,
  driver-level cancel, lossless values (DECIMAL keeps its scale, big integers
  and NaN become strings, JSON columns become JSON text, binary becomes hex).
- `routers/sql_ide.py`: `POST /sessions/close`, `/sessions/{id}/commit`,
  `/sessions/{id}/rollback`; the Visual Diff Excel export no longer turns
  values into formulas or links.
- MySQL connector: removed `compress=True` (PyMySQL rejects it, so every MySQL
  connection failed) and enabled autocommit.
- `main.py`: precompressed `.gz` / `.br` copies of the frontend are served only
  when they match their source file. Before, copying a new build over an old
  one kept serving the old `index.html` (and so the old IDE). Also defines the
  logger the precompress thread used.

## Desktop app (pywebview)

- Downloads enabled (exports used to be cancelled silently).
- Persistent browser profile and a stable local port, so open scripts,
  history and settings survive restarts.

## Build

- Stale `vite.config.js` / `.d.ts` / timestamp files removed and
  `tsconfig.node.json` set to `noEmit`, so `vite.config.ts` is used.
- Only the PostgreSQL and MySQL grammars are loaded, on first use (the old
  bundle pulled every dialect into one 7.4 MB chunk).
- `npm test` runs the splitter, error-location, wrapping and parameter tests.

## Upgrading

Extract the update over your `data-validator` folder (replace existing files),
then run `remove-obsolete-files.ps1` from that folder. It deletes the files
listed in `REMOVED_FILES.txt` and old build files in `frontend/dist` that are
not in `DIST_MANIFEST.txt`. Restart the app afterwards. `frontend/dist` is rebuilt, so `start-app.bat` works without
running npm. To build yourself: `cd frontend && npm install && npm run build`.

Open script tabs from the old IDE are migrated automatically on first load
(names, SQL, connection, schema / database). Results were never persisted.

## Verification

- Backend: 213 passed, 1 skipped (pytest), ruff clean on changed files.
- Frontend: strict `tsc` clean, 31 unit tests, production build.
- End-to-end in Chromium against PostgreSQL 16 (light and dark themes,
  1600 px and 1100 px wide): statement / script / explain / count runs, error
  underline, messages, completion, templates, formatting, explorer actions,
  parameters, manual transaction rollback, production confirmation, cancel
  with session kept, 25,000-row paging, Fetch all and CSV export, record /
  text / value views, library save and reopen, history, tab close + undo and
  server session cleanup, Visual Diff, focus mode, plain editor, migration of
  old saved tabs.
- Not run here: Snowflake, Oracle, SQL Server and MySQL servers, and the
  Windows desktop shell.
