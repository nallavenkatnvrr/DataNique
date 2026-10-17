from __future__ import annotations

from app.sql_dialects.base import SqlDialect


class SqlServerDialect(SqlDialect):
    name = "sqlserver"
    # APPROX_COUNT_DISTINCT was introduced in SQL Server 2019. If you target
    # 2017 or earlier, flip this to False (or override approx_distinct).
    supports_approx_distinct = True
    supports_checksum_bucketing = True

    def hash_prefix_to_int(self, hash_expr: str, start: int = 1) -> str:
        # 14 hex chars (7 bytes) from offset `start` -> 56-bit unsigned int.
        # CONVERT style 1 parses a '0x...' hex string into VARBINARY; CONVERT to
        # BIGINT reads it as an integer. 56 bits is always positive in BIGINT and
        # matches Oracle's TO_NUMBER(...,'XXXXXXXXXXXXXX') result exactly.
        return (
            f"CONVERT(BIGINT, CONVERT(VARBINARY(8), "
            f"'0x' + SUBSTRING({hash_expr}, {int(start)}, 14), 1))"
        )

    def quote_ident(self, ident: str) -> str:
        return "[" + ident.replace("]", "]]" ) + "]"

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS NVARCHAR(MAX))"

    def md5_hex(self, expr: str) -> str:
        return f"LOWER(CONVERT(VARCHAR(32), HASHBYTES('MD5', {expr}), 2))"

    def approx_distinct(self, q_col: str) -> str:
        return f"APPROX_COUNT_DISTINCT({q_col})"

    def substr(self, expr: str, start: int, length: int) -> str:
        return f"SUBSTRING({expr}, {start}, {length})"

    def limit_clause(self, n: int) -> str:
        return ""

    def concat_with_sep(self, parts: list[str], sep: str = "||") -> str:
        if not parts:
            return "''"
        sep_lit = "'" + sep.replace("'", "''") + "'"
        interleaved: list[str] = []
        for i, p in enumerate(parts):
            if i > 0:
                interleaved.append(sep_lit)
            interleaved.append(p)
        return f"CONCAT({', '.join(interleaved)})"

    def sample_rows_sql(self, fq_table, columns, limit, filter_sql=None) -> str:
        cols = ", ".join(self.quote_ident(c) for c in columns)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        return f"SELECT TOP {int(limit)} {cols} FROM {fq_table} {where}"

    def fq_table(self, database: str | None, schema: str | None, table: str) -> str:
        parts = [p for p in (database, schema, table) if p]
        return ".".join(self.quote_ident(p) for p in parts)

    def list_databases_sql(self) -> str:
        return "SELECT name FROM sys.databases WHERE state_desc = 'ONLINE' ORDER BY name"

    def list_schemas_sql(self, database: str | None) -> str:
        if database:
            return (
                f"SELECT SCHEMA_NAME FROM {self.quote_ident(database)}.INFORMATION_SCHEMA.SCHEMATA "
                f"ORDER BY SCHEMA_NAME"
            )
        return "SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA ORDER BY SCHEMA_NAME"

    def list_tables_sql(self, database: str | None, schema: str | None) -> str:
        db_prefix = f"{self.quote_ident(database)}." if database else ""
        sc = (schema or "").replace("'", "''")
        return (
            f"SELECT TABLE_NAME FROM {db_prefix}INFORMATION_SCHEMA.TABLES "
            f"WHERE TABLE_SCHEMA = '{sc}' "
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
