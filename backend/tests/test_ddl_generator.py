"""Unit tests for app.services.ddl_generator."""
from __future__ import annotations

from app.services.ddl_generator import (
    generate_ddl,
    generate_insert,
    generate_exec_proc,
)
from app.sql_dialects.postgres import PostgresDialect
from app.sql_dialects.sqlserver import SqlServerDialect
from app.sql_dialects.oracle import OracleDialect
from tests.conftest import FakeConnector


# ----------------------------------------------------------------- generate_ddl

def test_generate_ddl_basic():
    cols = [
        {"name": "ID", "data_type": "INTEGER", "nullable": False},
        {"name": "NAME", "data_type": "VARCHAR(50)", "nullable": True},
    ]
    conn = FakeConnector(PostgresDialect(), cols)
    ddl = generate_ddl(conn, None, "public", "users")
    assert ddl.startswith("CREATE TABLE")
    assert '"ID" INTEGER NOT NULL' in ddl
    assert '"NAME" VARCHAR(50) NULL' in ddl
    assert '"public"."users"' in ddl


def test_generate_ddl_defaults_missing_type():
    cols = [{"name": "X", "nullable": True}]
    conn = FakeConnector(PostgresDialect(), cols)
    ddl = generate_ddl(conn, None, None, "t")
    assert "VARCHAR(255)" in ddl


# -------------------------------------------------------------- generate_insert

def test_generate_insert_no_rows():
    conn = FakeConnector(PostgresDialect(), [{"name": "ID"}], rows=[])
    out = generate_insert(conn, None, "public", "t")
    assert out.startswith("-- No data found")


def test_generate_insert_bool_renders_as_1_0():
    """Regression: bool must render as 1/0, not the literal 'True'/'False'.

    ``bool`` subclasses ``int`` so the type dispatch order matters.
    """
    cols = [{"name": "FLAG"}]
    conn = FakeConnector(PostgresDialect(), cols, rows=[[True], [False]])
    out = generate_insert(conn, None, "public", "t")
    assert "VALUES (1)" in out
    assert "VALUES (0)" in out
    assert "True" not in out
    assert "False" not in out


def test_generate_insert_null_and_string_escaping():
    cols = [{"name": "NAME"}]
    conn = FakeConnector(PostgresDialect(), cols, rows=[[None], ["O'Brien"]])
    out = generate_insert(conn, None, "public", "t")
    assert "VALUES (NULL)" in out
    assert "'O''Brien'" in out


def test_generate_insert_numeric_unquoted():
    cols = [{"name": "AMT"}]
    conn = FakeConnector(PostgresDialect(), cols, rows=[[12.5], [42]])
    out = generate_insert(conn, None, "public", "t")
    assert "VALUES (12.5)" in out
    assert "VALUES (42)" in out


def test_generate_insert_bytes_hex():
    cols = [{"name": "DATA"}]
    conn = FakeConnector(PostgresDialect(), cols, rows=[[b"\x01\x02"]])
    out = generate_insert(conn, None, "public", "t")
    assert "0x0102" in out


# ------------------------------------------------------------ generate_exec_proc

def test_exec_proc_sqlserver_no_params():
    out = generate_exec_proc("sqlserver", "db", "dbo", "usp_run")
    assert out == "EXEC db.dbo.usp_run;"


def test_exec_proc_sqlserver_with_params():
    out = generate_exec_proc(
        "sqlserver", None, "dbo", "usp_run",
        params=[{"name": "id", "value": "5"}, {"name": "nm", "value": "abc"}],
    )
    assert out == "EXEC dbo.usp_run 5, 'abc';"


def test_exec_proc_sqlserver_out_param():
    out = generate_exec_proc(
        "sqlserver", None, None, "p",
        params=[{"name": "res", "direction": "OUT"}],
    )
    assert "@res OUTPUT" in out


def test_exec_proc_oracle_block():
    out = generate_exec_proc("oracle", None, "APP", "do_it", params=[{"name": "x", "value": "1"}])
    assert out.startswith("BEGIN")
    assert "APP.do_it(1)" in out
    assert out.rstrip().endswith("/")


def test_exec_proc_postgres_call():
    out = generate_exec_proc("postgres", None, "public", "p", params=[{"name": "x", "value": "abc"}])
    assert out == "CALL public.p('abc');"


def test_exec_proc_mysql_call_empty():
    out = generate_exec_proc("mysql", None, None, "p")
    assert out == "CALL p();"


def test_exec_proc_snowflake_call():
    out = generate_exec_proc("snowflake", "DB", "SC", "p", params=[{"name": "x", "value": "1"}])
    assert out == "CALL DB.SC.p(1);"


def test_exec_proc_empty_value_is_null():
    out = generate_exec_proc("postgres", None, None, "p", params=[{"name": "x", "value": ""}])
    assert out == "CALL p(NULL);"
