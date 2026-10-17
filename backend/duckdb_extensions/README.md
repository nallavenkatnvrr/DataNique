# Bundled DuckDB extensions (optional)

Datanique reads PostgreSQL and MySQL fastest through DuckDB's `postgres_scanner`
and `mysql_scanner` extensions, and uses `httpfs` (OpenSSL) to write encrypted
diff files. DuckDB downloads them once from extensions.duckdb.org.

For PCs without internet access, put the extension files here:

```
backend/duckdb_extensions/v<duckdb version>/<platform>/<name>.duckdb_extension
e.g. backend/duckdb_extensions/v1.5.6/windows_amd64/postgres_scanner.duckdb_extension
```

Download them on a connected machine from
`http://extensions.duckdb.org/v1.5.6/windows_amd64/<name>.duckdb_extension.gz`
and unzip. Without them Datanique falls back automatically (ADBC / cursor
readers; diff files sealed with its own AES-256-GCM).
