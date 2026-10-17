"""Statement splitter tests — shared cases with frontend/src/lib/sqlSplit.test.ts."""
from app.services.sql_split import split_sql_statements as split, split_statements


def test_basic_offsets_and_trimming():
    sql = "  SELECT 1;\nSELECT 2 ;  \n\n"
    s = split_statements(sql, "postgres")
    assert [x.text for x in s] == ["SELECT 1", "SELECT 2"]
    assert sql[s[0].start:s[0].end] == "SELECT 1"
    assert sql[s[1].start:s[1].end] == "SELECT 2"


def test_literals_identifiers_and_comments_do_not_split():
    assert split("SELECT 'a;b', \"x;y\" FROM t -- c;d\n; SELECT /* e;f */ 2", "postgres") == [
        "SELECT 'a;b', \"x;y\" FROM t -- c;d",
        "SELECT /* e;f */ 2",
    ]
    assert split("SELECT 'it''s; fine'; SELECT 2", "oracle") == ["SELECT 'it''s; fine'", "SELECT 2"]


def test_comment_only_chunks_are_skipped():
    assert split("-- header\n;\n/* x */;\nSELECT 1;", "snowflake") == ["SELECT 1"]


def test_backslash_escapes_only_where_supported():
    assert split("SELECT 'a\\';b'; SELECT 2", "mysql") == ["SELECT 'a\\';b'", "SELECT 2"]
    assert split("SELECT 'C:\\'; SELECT 2", "postgres") == ["SELECT 'C:\\'", "SELECT 2"]
    assert split("SELECT E'a\\';b'; SELECT 2", "postgres") == ["SELECT E'a\\';b'", "SELECT 2"]
    assert split("SELECT 'x\\';y'; SELECT 2", "snowflake") == ["SELECT 'x\\';y'", "SELECT 2"]


def test_dollar_quoting():
    pg = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT f();"
    assert split(pg, "postgres") == [
        "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql",
        "SELECT f()",
    ]
    sf = "CREATE OR REPLACE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$ BEGIN RETURN 'x;y'; END; $$;\nCALL p();"
    assert split(sf, "snowflake") == [
        "CREATE OR REPLACE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$ BEGIN RETURN 'x;y'; END; $$",
        "CALL p()",
    ]


def test_postgres_begin_is_a_transaction():
    assert split("BEGIN; UPDATE t SET a = 1; COMMIT;", "postgres") == ["BEGIN", "UPDATE t SET a = 1", "COMMIT"]


def test_case_end_inside_statement():
    assert split("SELECT CASE WHEN a THEN 'x;' ELSE 'y' END AS c FROM t; SELECT 2", "snowflake") == [
        "SELECT CASE WHEN a THEN 'x;' ELSE 'y' END AS c FROM t",
        "SELECT 2",
    ]


def test_snowflake_scripting_block():
    sql = "BEGIN\n  LET x := 1;\n  IF (x > 0) THEN\n    RETURN 'pos';\n  END IF;\nEND;\nSELECT 3;"
    assert split(sql, "snowflake") == [
        "BEGIN\n  LET x := 1;\n  IF (x > 0) THEN\n    RETURN 'pos';\n  END IF;\nEND",
        "SELECT 3",
    ]
    assert split("BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT;", "snowflake") == [
        "BEGIN TRANSACTION", "INSERT INTO t VALUES (1)", "COMMIT",
    ]


def test_oracle_plsql_units_end_at_slash():
    sql = "\n".join([
        "CREATE OR REPLACE PROCEDURE p IS",
        "  v NUMBER;",
        "BEGIN",
        "  SELECT 1 INTO v FROM dual;",
        "END p;",
        "/",
        "SELECT * FROM dual;",
        "BEGIN",
        "  p;",
        "END;",
        "/",
    ])
    assert split(sql, "oracle") == [
        "CREATE OR REPLACE PROCEDURE p IS\n  v NUMBER;\nBEGIN\n  SELECT 1 INTO v FROM dual;\nEND p;",
        "SELECT * FROM dual",
        "BEGIN\n  p;\nEND;",
    ]
    assert split("SELECT q'[a;b]' FROM dual; SELECT 2 FROM dual", "oracle") == [
        "SELECT q'[a;b]' FROM dual",
        "SELECT 2 FROM dual",
    ]


def test_sql_server_go_modules_and_brackets():
    sql = "\n".join([
        "CREATE OR ALTER PROCEDURE dbo.p AS",
        "BEGIN",
        "  SELECT 1;",
        "  SELECT 2;",
        "END",
        "GO",
        "SELECT [a;b] FROM t; SELECT 3",
        "go",
        "BEGIN TRAN; UPDATE t SET x = 1; COMMIT;",
    ])
    assert split(sql, "sqlserver") == [
        "CREATE OR ALTER PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
        "SELECT [a;b] FROM t",
        "SELECT 3",
        "BEGIN TRAN",
        "UPDATE t SET x = 1",
        "COMMIT",
    ]
    assert split("BEGIN TRY\n SELECT 1;\nEND TRY\nBEGIN CATCH\n SELECT 2;\nEND CATCH;\nSELECT 9;", "sqlserver") == [
        "BEGIN TRY\n SELECT 1;\nEND TRY\nBEGIN CATCH\n SELECT 2;\nEND CATCH",
        "SELECT 9",
    ]


def test_mysql_delimiter_backticks_and_hash_comments():
    sql = "\n".join([
        "DELIMITER //",
        "CREATE PROCEDURE p()",
        "BEGIN",
        "  SELECT 1; SELECT 2;",
        "END //",
        "DELIMITER ;",
        "SELECT `a;b` FROM t # trailing; comment",
        ";",
        "SELECT 3;",
    ])
    assert split(sql, "mysql") == [
        "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1; SELECT 2;\nEND",
        "SELECT `a;b` FROM t # trailing; comment",
        "SELECT 3",
    ]


def test_snowflake_double_slash_comments():
    assert split("SELECT 1 // note; still comment\n; SELECT 2", "snowflake") == [
        "SELECT 1 // note; still comment",
        "SELECT 2",
    ]


def test_generic_dialect_accepts_every_quoting_style():
    assert split("SELECT 'a;''b'; SELECT \"x;y\"; SELECT [a;b]; SELECT `c;d`; SELECT $$e;f$$; SELECT q'[g;h]'") == [
        "SELECT 'a;''b'", 'SELECT "x;y"', "SELECT [a;b]", "SELECT `c;d`", "SELECT $$e;f$$", "SELECT q'[g;h]'",
    ]
    assert split("CREATE TABLE #temp (id int); INSERT INTO #temp VALUES (1); SELECT * FROM #temp;", "sqlserver") == [
        "CREATE TABLE #temp (id int)", "INSERT INTO #temp VALUES (1)", "SELECT * FROM #temp",
    ]
