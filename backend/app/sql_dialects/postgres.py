from __future__ import annotations

from app.sql_dialects.base import SqlDialect


class PostgresDialect(SqlDialect):
    name = "postgres"
    supports_checksum_bucketing = True
    # A Postgres connection is bound to a single database — you cannot join a
    # table in another database within one query. So when source/target live
    # in different databases the engine must use the cross-DB sort-merge path.
    supports_cross_database_join = False

    def hash_prefix_to_int(self, hash_expr: str, start: int = 1) -> str:
        # 14 hex chars from offset `start` -> 56-bit unsigned integer. Cast the
        # hex string to a 56-bit bit-string then to bigint (always positive).
        # Matches Oracle's TO_NUMBER(...,'XXXXXXXXXXXXXX') result exactly.
        return f"(('x' || SUBSTRING({hash_expr} FROM {int(start)} FOR 14))::bit(56)::bigint)"

    def quote_ident(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS VARCHAR)"

    def md5_hex(self, expr: str) -> str:
        return f"MD5({expr})"

    def list_databases_sql(self) -> str:
        return "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"

    def list_schemas_sql(self, database: str | None) -> str:
        return (
            "SELECT schema_name FROM information_schema.schemata "
            "WHERE schema_name NOT IN ('pg_catalog','information_schema') "
            "AND schema_name NOT LIKE 'pg_toast%' "
            "ORDER BY schema_name"
        )

    def list_tables_sql(self, database: str | None, schema: str | None) -> str:
        sc = (schema or "public").replace("'", "''")
        return (
            f"SELECT table_name FROM information_schema.tables "
            f"WHERE table_schema = '{sc}' "
            f"AND table_type IN ('BASE TABLE','VIEW') "
            f"ORDER BY table_name"
        )

    def schema_columns_sql(self, database: str | None, schema: str | None, table: str) -> str:
        sc = (schema or "public").replace("'", "''")
        tb = (table or "").replace("'", "''")
        return (
            f"SELECT column_name, data_type, is_nullable, ordinal_position, "
            f"character_maximum_length, numeric_precision, numeric_scale "
            f"FROM information_schema.columns "
            f"WHERE table_schema = '{sc}' AND table_name = '{tb}' "
            f"ORDER BY ordinal_position"
        )
