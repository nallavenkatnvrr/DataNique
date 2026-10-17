from __future__ import annotations

from app.sql_dialects.base import SqlDialect


class MySqlDialect(SqlDialect):
    name = "mysql"
    supports_checksum_bucketing = True

    def hash_prefix_to_int(self, hash_expr: str, start: int = 1) -> str:
        # 14 hex chars from offset `start` -> 56-bit unsigned integer.
        # CONV(hex,16,10) parses the hex string to a decimal integer. Matches
        # Oracle's TO_NUMBER(...,'XXXXXXXXXXXXXX') result exactly.
        return f"CONV(SUBSTRING({hash_expr}, {int(start)}, 14), 16, 10)"

    def quote_ident(self, ident: str) -> str:
        return "`" + ident.replace("`", "``") + "`"

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS CHAR)"

    def md5_hex(self, expr: str) -> str:
        return f"LOWER(MD5({expr}))"

    def concat_with_sep(self, parts: list[str], sep: str = "||") -> str:
        if not parts:
            return "''"
        sep_lit = "'" + sep.replace("'", "''") + "'"
        return f"CONCAT_WS({sep_lit}, {', '.join(parts)})"

    def fq_table(self, database: str | None, schema: str | None, table: str) -> str:
        db = database or schema
        parts = [p for p in (db, table) if p]
        return ".".join(self.quote_ident(p) for p in parts)

    def list_databases_sql(self) -> str:
        return (
            "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA "
            "WHERE SCHEMA_NAME NOT IN ('mysql','sys','information_schema','performance_schema') "
            "ORDER BY SCHEMA_NAME"
        )

    def list_schemas_sql(self, database: str | None) -> str:
        return self.list_databases_sql()

    def list_tables_sql(self, database: str | None, schema: str | None) -> str:
        sc = (database or schema or "").replace("'", "''")
        return (
            f"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES "
            f"WHERE TABLE_SCHEMA = '{sc}' "
            f"AND TABLE_TYPE IN ('BASE TABLE','VIEW') "
            f"ORDER BY TABLE_NAME"
        )

    def schema_columns_sql(self, database: str | None, schema: str | None, table: str) -> str:
        sc = (database or schema or "").replace("'", "''")
        tb = (table or "").replace("'", "''")
        return (
            f"SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION, "
            f"CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE "
            f"FROM INFORMATION_SCHEMA.COLUMNS "
            f"WHERE TABLE_SCHEMA = '{sc}' AND TABLE_NAME = '{tb}' "
            f"ORDER BY ORDINAL_POSITION"
        )
