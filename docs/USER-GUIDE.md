# Datanique user guide

A walk through every part of the app with screenshots. The data in them is made up: a demo PostgreSQL database with a `crm` schema (the source system) and a `dw` schema (a warehouse copy with a few planted differences), plus a CSV and an Excel export.

Contents

1. [Install and first launch](#1-install-and-first-launch)
2. [Add a connection](#2-add-a-connection)
3. [Compare two tables](#3-compare-two-tables)
4. [Read the result](#4-read-the-result)
5. [Compare a file with a table](#5-compare-a-file-with-a-table)
6. [Bulk compare a whole schema](#6-bulk-compare-a-whole-schema)
7. [History and templates](#7-history-and-templates)
8. [SQL IDE](#8-sql-ide)
9. [Settings and shortcuts](#9-settings-and-shortcuts)

## 1. Install and first launch

**Easiest: the portable app.** Download `Datanique-<version>-windows-portable.zip` from the [latest release](https://github.com/nallavenkatnvrr/DataNique/releases/latest), unzip it (right-click > Extract All) and double-click `Datanique.exe`. Nothing else to install. Windows may show "Windows protected your PC" the first time because the exe is not signed; click More info > Run anyway.

Your data goes to your own Windows account's folder, so colleagues can run the same copy and each sees only their own connections and history. Settings > Storage shows the folder. The README's [Portable app](../README.md#portable-app) section lists the other places it can keep data.

**From source**, you need Python 3.10 or newer and Node.js 20 or newer on Windows.

1. Get the code: download the ZIP from GitHub (Code > Download ZIP) and unzip it, or `git clone https://github.com/nallavenkatnvrr/DataNique.git`.
2. Build the screens once:

   ```
   cd frontend
   npm install
   npm run build
   ```

3. Double-click `start-app.bat` in the main folder. The first start creates a Python environment and installs the packages, which takes a few minutes. After that it opens in a few seconds.

On the first start Datanique asks you to create a master password. Everything sensitive (saved database passwords, run history, saved differences, templates) is encrypted with a key that this password unlocks.

![First launch](gifs/first-launch.gif)

| Create the master password | Save the recovery key |
|---|---|
| ![Master password](images/first-launch-password.png) | ![Recovery key](images/first-launch-recovery-key.png) |

The recovery key is shown only once. Copy it or save it as a file. If you forget the master password, "Forgot password?" on the unlock screen lets you set a new one with this key.

Next time you open the app you only type the password. On Windows you can tick "Remember on this computer" to skip it; the key is then kept in Windows Credential Manager for your Windows account.

![Unlock](images/unlock.png)

## 2. Add a connection

Go to **Connections** and click **New connection**. Pick the database type, fill in host, port, user, password and database, and click **Test edits** to check it before saving. Then click **Create**.

![Add a connection](gifs/add-connection.gif)

| The form | Saved connections |
|---|---|
| ![Connection form](images/connection-form.png) | ![Connections](images/connections.png) |

Notes per database:

- Snowflake: password, key pair, OAuth token or SSO in the browser (Okta, Azure AD). Warehouse and role are optional.
- Oracle: host, port and service name. No Oracle client install is needed.
- SQL Server: needs the Microsoft ODBC Driver for SQL Server on the PC. Windows login works too.
- The default schema you set here is what the compare screen and the SQL IDE start with.

## 3. Compare two tables

Open **Compare**. Each side can be a **Table**, a **Query** or a **File**. For two tables pick the connection, schema and table on both sides. The name at the top is optional.

![Compare two tables](gifs/compare-tables.gif)

![Pick the tables](images/compare-tables.png)

Below the sides, **Columns & keys** shows how the columns line up. Columns are matched by name (ignoring case and underscores), or by position if you switch to "By position". For each pair you can choose:

- **Key**: used to line up rows. Taken from the primary key automatically when there is one.
- **Compare**: the values are compared.
- **Skip**: left out.

No key at all is fine too. Then whole rows are compared as a set.

![Columns and keys](images/compare-columns.png)

**Options** decides what counts as the same value. With the defaults on, 12.50 equals 12.5, '007' equals 7, a DATE equals the same TIMESTAMP at midnight and true, 1 and Y are the same. Trimming spaces, ignoring case, treating empty text as NULL, a numeric tolerance and the timestamp precision are here as well. "Where to compare" can push the work into the database for very large tables on one connection.

![Options](images/compare-options.png)

Click **Run compare** (or press Ctrl+Enter). The run continues in the background, so you can leave the page. The live view shows rows read per side, the current step and the log.

![Live progress](images/live-job.png)

## 4. Read the result

The top of the result page gives the verdict and the counts:

- **Equal**: rows that match on every compared column.
- **Changed**: same key, at least one value differs. "3 columns affected" tells you how many columns had differences.
- **Only in source** and **Only in target**: rows missing on the other side.

The strip under the counts shows which reader was used for each side and where the time went.

![Result](images/result.png)

**Differences** lists every difference that was found. Changed rows show the source value (red dot) above the target value (blue dot). "Differing columns" hides the columns that are equal everywhere. You can search values and export to Excel, CSV, Parquet or JSON. The key columns stay on the left when you scroll sideways.

![Changed rows](images/differences-changed.png)

![Rows only in the source](images/differences-only-in-source.png)

**Columns** shows how each column was compared and how many rows differ per column. Click a column name to see only the rows where that column differs. **Excel report** at the top downloads a workbook with the summary and the differences, with changed cells highlighted.

![Columns](images/result-columns.png)

## 5. Compare a file with a table

Switch a side to **File** and either upload the file or type a path on the PC (Browse helps you pick it). Supported: CSV, TSV, PSV, TXT, DAT (also zipped or gzipped), Excel, Parquet, JSON, Avro, ORC, Arrow and fixed width. Datanique detects the format, delimiter, header and encoding and shows a preview. Change any of it if the guess is wrong.

Here a CSV export of the first 100,000 customers is compared with the CRM table. **Add a row filter** limits the table to the same 100,000 rows.

![CSV file vs table](gifs/file-vs-table.gif)

![CSV against a filtered table](images/compare-csv-file.png)

The CSV has Y/N where the table has true/false, and dates as text. These still count as equal. Only the 24 rows with a real balance difference show up.

![CSV result](images/result-csv-file.png)

Excel works the same way. Pick the sheet if the workbook has more than one. Column names like "Product ID" match `product_id` automatically.

| Excel against a table | Result |
|---|---|
| ![Excel file vs table](images/compare-excel-file.png) | ![Excel result](images/result-excel-file.png) |

## 6. Bulk compare a whole schema

**Bulk** compares many tables in one go. Pick a source and a target schema (or two folders of files) and click **Find pairs**. Tables are paired by name; "Ignore name prefixes" helps when one side uses names like `stg_customers`. Untick pairs you don't want, set keys if a table has no primary key, and click **Run**.

![Bulk compare](gifs/bulk-compare.gif)

![Pairs](images/bulk-pairs.png)

The compares run a few at a time in the background. When they finish, **Batch report** gives one summary for the whole batch.

| Running | Batch report |
|---|---|
| ![Bulk running](images/bulk-running.png) | ![Batch report](images/bulk-report.png) |

## 7. History and templates

Every run is kept in **History**. Filter by result or by kind, search by name, open a run, or select several and delete them. Bulk batches have their own tab.

![History](images/history.png)

**Save as template** on the compare screen keeps the whole setup (sides, keys, options). **Templates** lists them. Run one, run all of them as a batch, or open one in the compare screen to change it.

![Templates](images/templates.png)

## 8. SQL IDE

**SQL IDE** is for everyday querying. Choose a connection at the top. The explorer on the left lists tables, views and procedures.

- Ctrl+Enter runs the statement under the cursor, Alt+X runs the whole script.
- Completion knows your tables and columns. Ctrl+Shift+F formats the SQL.
- The result grid supports keyboard navigation, range selection with totals, copying as CSV, JSON, INSERT statements and more, filters and export.
- Each tab has its own session. Manual commit mode and a red status bar for production connections help avoid mistakes.

![SQL IDE](gifs/sql-ide.gif)

![SQL IDE](images/sql-ide.png)

## 9. Settings and shortcuts

**Settings** has the security options (remember on this computer, lock after inactivity, change the master password, new recovery key), the reader chain per database, storage and the theme. **Visual effects > Light** turns off shadows and animations if the app feels slow, for example on a virtual desktop.

![Settings](images/settings.png)

Ctrl+K opens the command menu to jump to any page or recent run. Ctrl+Shift+L locks the app. There is a light theme too.

| Command menu | Light theme |
|---|---|
| ![Command menu](images/command-menu.png) | ![Light theme](images/result-light-theme.png) |
