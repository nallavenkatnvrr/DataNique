from __future__ import annotations

from app.sql_dialects.base import SqlDialect


class OracleDialect(SqlDialect):
    name = "oracle"
    # APPROX_COUNT_DISTINCT was introduced in 12.1.0.2 (2014). Modern Oracle
    # instances all support it.
    supports_approx_distinct = True
    supports_checksum_bucketing = True

    def hash_prefix_to_int(self, hash_expr: str, start: int = 1) -> str:
        # 14 hex chars from offset `start` -> 56-bit unsigned int (positive).
        # TO_NUMBER with an X format mask parses hex digit-for-digit.
        return f"TO_NUMBER(SUBSTR({hash_expr}, {int(start)}, 14), 'XXXXXXXXXXXXXX')"

    def quote_ident(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS VARCHAR2(4000))"

    def md5_hex(self, expr: str) -> str:
        return f"LOWER(STANDARD_HASH({expr}, 'MD5'))"

    def approx_distinct(self, q_col: str) -> str:
        return f"APPROX_COUNT_DISTINCT({q_col})"

    def limit_clause(self, n: int) -> str:
        return f"FETCH FIRST {int(n)} ROWS ONLY"

    def fq_table(self, database: str | None, schema: str | None, table: str) -> str:
        parts = [p for p in (schema, table) if p]
        return ".".join(self.quote_ident(p) for p in parts)

    def ping_sql(self) -> str:
        return "SELECT 1 FROM DUAL"

    def list_databases_sql(self) -> str:
        return (
            "SELECT NAME FROM V$DATABASE "
            "UNION ALL "
            "SELECT NAME FROM V$PDBS WHERE OPEN_MODE = 'READ WRITE'"
        )

    def list_schemas_sql(self, database: str | None) -> str:
        return "SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME"

    def list_tables_sql(self, database: str | None, schema: str | None) -> str:
        sc = (schema or "").replace("'", "''").upper()
        return (
            f"SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = '{sc}' "
            f"UNION ALL "
            f"SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = '{sc}' "
            f"ORDER BY 1"
        )

    def schema_columns_sql(self, database: str | None, schema: str | None, table: str) -> str:
        sc = (schema or "").replace("'", "''").upper()
        tb = (table or "").replace("'", "''").upper()
        return (
            f"SELECT COLUMN_NAME, DATA_TYPE, "
            f"CASE NULLABLE WHEN 'Y' THEN 'YES' ELSE 'NO' END AS IS_NULLABLE, "
            f"COLUMN_ID AS ORDINAL_POSITION, "
            f"CHAR_LENGTH AS CHARACTER_MAXIMUM_LENGTH, "
            f"DATA_PRECISION AS NUMERIC_PRECISION, "
            f"DATA_SCALE AS NUMERIC_SCALE "
            f"FROM ALL_TAB_COLUMNS "
            f"WHERE OWNER = '{sc}' AND TABLE_NAME = '{tb}' "
            f"ORDER BY COLUMN_ID"
        )
