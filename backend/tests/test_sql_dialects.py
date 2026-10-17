"""Unit tests for the per-engine SQL dialect layer."""
from __future__ import annotations

import pytest

from app.sql_dialects.base import SqlDialect, _normalize_buckets, HEX_CHARS
from app.sql_dialects.postgres import PostgresDialect
from app.sql_dialects.mysql import MySqlDialect
from app.sql_dialects.oracle import OracleDialect
from app.sql_dialects.snowflake import SnowflakeDialect
from app.sql_dialects.sqlserver import SqlServerDialect


ALL_DIALECTS = [
    PostgresDialect(), MySqlDialect(), OracleDialect(),
    SnowflakeDialect(), SqlServerDialect(),
]


# ---------------------------------------------------------------- quote_ident

def test_quote_ident_per_dialect():
    assert PostgresDialect().quote_ident("c") == '"c"'
    assert SnowflakeDialect().quote_ident("c") == '"c"'
    assert OracleDialect().quote_ident("c") == '"c"'
    assert MySqlDialect().quote_ident("c") == "`c`"
    assert SqlServerDialect().quote_ident("c") == "[c]"
    assert PostgresDialect().quote_ident('a"b') == '"a""b"'
    assert SnowflakeDialect().quote_ident('a"b') == '"a""b"'
    assert OracleDialect().quote_ident('a"b') == '"a""b"'
    assert MySqlDialect().quote_ident("a`b") == "`a``b`"
    assert SqlServerDialect().quote_ident("a]b") == "[a]]b]"


# ------------------------------------------------------------------- fq_table

def test_fq_table_postgres_all_parts():
    assert PostgresDialect().fq_table("db", "public", "t") == '"db"."public"."t"'


def test_fq_table_oracle_drops_database():
    # Oracle addresses by schema.table (owner), no database part.
    assert OracleDialect().fq_table("ignored", "APP", "T") == '"APP"."T"'


def test_fq_table_mysql_uses_db_or_schema():
    assert MySqlDialect().fq_table("mydb", None, "t") == "`mydb`.`t`"
    assert MySqlDialect().fq_table(None, "mydb", "t") == "`mydb`.`t`"


def test_fq_table_sqlserver_brackets():
    assert SqlServerDialect().fq_table("db", "dbo", "t") == "[db].[dbo].[t]"


# ----------------------------------------------------------------- limit_clause

def test_limit_clause_variants():
    assert PostgresDialect().limit_clause(10) == "LIMIT 10"
    assert OracleDialect().limit_clause(10) == "FETCH FIRST 10 ROWS ONLY"
    assert SqlServerDialect().limit_clause(10) == ""  # uses TOP in sample_rows_sql


def test_sqlserver_sample_rows_uses_top():
    sql = SqlServerDialect().sample_rows_sql("[t]", ["a", "b"], 5)
    assert "TOP 5" in sql


# --------------------------------------------------------------- md5 / hashing

def test_md5_hex_per_dialect():
    assert PostgresDialect().md5_hex("x") == "MD5(x)"
    assert MySqlDialect().md5_hex("x") == "LOWER(MD5(x))"
    assert "STANDARD_HASH" in OracleDialect().md5_hex("x")
    assert "HASHBYTES" in SqlServerDialect().md5_hex("x")


def test_row_hash_expr_wraps_md5():
    d = PostgresDialect()
    expr = d.row_hash_expr([d.quote_ident("a"), d.quote_ident("b")])
    assert expr.startswith("MD5(")
    assert "CASE WHEN" in expr
    assert "REPLACE" in expr


# --------------------------------------------------------------- concat_with_sep

def test_concat_with_sep_default_pipe():
    assert PostgresDialect().concat_with_sep(["a", "b"]) == "a || '||' || b"


def test_concat_with_sep_mysql_concat_ws():
    out = MySqlDialect().concat_with_sep(["a", "b"])
    assert out == "CONCAT_WS('||', a, b)"


def test_concat_with_sep_sqlserver_concat():
    out = SqlServerDialect().concat_with_sep(["a", "b"])
    assert out.startswith("CONCAT(")


def test_concat_with_sep_empty():
    for d in ALL_DIALECTS:
        assert d.concat_with_sep([]) == "''"


# ------------------------------------------------------- checksum bucketing flags

def test_checksum_bucketing_support_flags():
    assert PostgresDialect().supports_checksum_bucketing is True
    assert MySqlDialect().supports_checksum_bucketing is True
    assert OracleDialect().supports_checksum_bucketing is True
    assert SqlServerDialect().supports_checksum_bucketing is True
    # Snowflake does not implement hash_prefix_to_int
    assert SnowflakeDialect().supports_checksum_bucketing is False


def test_hash_prefix_to_int_reads_14_chars():
    for d in [PostgresDialect(), MySqlDialect(), OracleDialect(), SqlServerDialect()]:
        expr = d.hash_prefix_to_int("row_hash", 1)
        assert "14" in expr


def test_hash_prefix_to_int_unsupported_raises():
    with pytest.raises(NotImplementedError):
        SnowflakeDialect().hash_prefix_to_int("row_hash", 1)


# --------------------------------------------------------------- bucket helper

def test_normalize_buckets_filters_and_sorts():
    assert _normalize_buckets(["b", "a", "0", "f"]) == ["0", "a", "b", "f"]


def test_normalize_buckets_rejects_non_hex():
    # multi-char / non-hex inputs are dropped, not truncated
    assert _normalize_buckets(["bogus", "g", "10", "3"]) == ["3"]


def test_normalize_buckets_dedupes():
    assert _normalize_buckets(["a", "A", "a"]) == ["a"]


def test_normalize_buckets_empty():
    assert _normalize_buckets(None) == []
    assert _normalize_buckets([]) == []


# --------------------------------------------------------------- aggregate hash

def test_aggregate_hash_sql_has_16_buckets():
    d = PostgresDialect()
    sql = d.aggregate_hash_sql('"t"', [d.quote_ident("a")])
    for c in HEX_CHARS:
        assert f"b_{c}" in sql
    assert "COUNT(*) AS row_count" in sql


# ------------------------------------------------------ key_hash_pairs stable order

def test_key_hash_pairs_stable_order_emits_key_sort():
    d = PostgresDialect()
    sql = d.key_hash_pairs_sql('"t"', ["id"], ["id", "v"], stable_order=True)
    assert "key_sort" in sql
    assert "ORDER BY 1, 2, 3" in sql


def test_key_hash_pairs_bucket_filter_applied():
    d = PostgresDialect()
    sql = d.key_hash_pairs_sql('"t"', ["id"], ["id", "v"], bucket_filter=["a", "b"])
    assert "IN ('a', 'b')" in sql


def test_serialized_sql_fields_escape_delimiter_and_null_sentinel():
    from app.services.normalize import NULL_SENTINEL

    for dialect in ALL_DIALECTS:
        expr = dialect.coalesce_string(dialect.quote_ident("value"))
        assert "REPLACE" in expr
        assert "%7C" in expr and "%3C" in expr and "%3E" in expr
        assert NULL_SENTINEL in expr


def test_checksum_fingerprint_includes_key_columns():
    d = PostgresDialect()
    sql = d.bucketed_fingerprint_sql('"t"', ["id"], ["id", "payload"])
    inner = sql.split("SELECT ", 2)[-1]
    assert d.quote_ident("id") in inner
    assert d.quote_ident("payload") in inner


def test_decimal_range_fingerprint_preserves_fractional_bounds():
    from decimal import Decimal

    sql = PostgresDialect().range_fingerprint_sql(
        '"t"', "amount", ["amount", "payload"],
        Decimal("1.25"), Decimal("9.75"), 4,
    )
    assert '"amount" >= 1.25' in sql
    assert '"amount" <= 9.75' in sql
    assert "1.25" in sql and "9.75" in sql


def test_sqlserver_hashing_uses_max_length_strings():
    sql = SqlServerDialect().row_hash_expr(["[large_value]"])
    assert "NVARCHAR(MAX)" in sql
    assert "NVARCHAR(4000)" not in sql


def test_mysql_hashing_does_not_impose_a_fixed_character_limit():
    sql = MySqlDialect().row_hash_expr(["`large_value`"])
    assert "CAST(`large_value` AS CHAR)" in sql
    assert "CHAR(4000)" not in sql


def test_normalization_is_explicit_per_sql_generation_call():
    from app.services.normalize import NormalizeOptions

    d = PostgresDialect()
    enabled = d.coalesce_string(
        '"name"', normalize=NormalizeOptions(enabled=True, case_insensitive=True),
    )
    disabled = d.coalesce_string('"name"', normalize=NormalizeOptions.disabled())
    assert "UPPER" in enabled
    assert "UPPER" not in disabled
