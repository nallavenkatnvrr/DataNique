from __future__ import annotations

from app.sql_dialects.base import SqlDialect


class SnowflakeDialect(SqlDialect):
    name = "snowflake"
    supports_approx_distinct = True

    def quote_ident(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS VARCHAR)"

    def approx_distinct(self, q_col: str) -> str:
        # APPROX_COUNT_DISTINCT is hyperloglog-based and ~10-100x cheaper than COUNT(DISTINCT)
        # on large tables. Snowflake also exposes HLL() but APPROX_COUNT_DISTINCT is portable.
        return f"APPROX_COUNT_DISTINCT({q_col})"

    def list_databases_sql(self) -> str:
        return "SELECT DATABASE_NAME FROM INFORMATION_SCHEMA.DATABASES ORDER BY DATABASE_NAME"

    def list_schemas_sql(self, database: str | None) -> str:
        if database:
            return f"SELECT SCHEMA_NAME FROM {self.quote_ident(database)}.INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME"
        return "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME"

    def list_tables_sql(self, database: str | None, schema: str | None) -> str:
        db_prefix = f"{self.quote_ident(database)}." if database else ""
        sc = (schema or "").replace("'", "''")
        return (
            f"SELECT TABLE_NAME FROM {db_prefix}INFORMATION_SCHEMA.TABLES "
            f"WHERE TABLE_SCHEMA = '{sc}' "
            f"AND TABLE_TYPE IN ('BASE TABLE', 'VIEW') "
            f"ORDER BY TABLE_NAME"
        )

    def schema_columns_sql(self, database: str | None, schema: str | None, table: str) -> str:
        db_prefix = f"{self.quote_ident(database)}." if database else ""
        sc = (schema or "").replace("'", "''")
        tb = (table or "").replace("'", "''")
        return (
            f"SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION, "
            f"CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE "
            f"FROM {db_prefix}INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_SCHEMA = '{sc}' AND TABLE_NAME = '{tb}' "
            f"ORDER BY ORDINAL_POSITION"
        )
