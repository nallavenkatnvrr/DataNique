// Run with: npm test   (node --experimental-strip-types --test)
// Shared cases with backend/tests/test_sql_split.py - keep both in sync.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSqlStatements, statementAt, isModifyingStatement, lineOf } from "./sqlSplit.ts";

const texts = (sql: string, d?: string, blank = false) =>
  splitSqlStatements(sql, d, { blankLineDelimiter: blank }).map((s) => s.text);

test("basic semicolons, offsets and trimming", () => {
  const sql = "  SELECT 1;\nSELECT 2 ;  \n\n";
  const s = splitSqlStatements(sql, "postgres");
  assert.deepEqual(s.map((x) => x.text), ["SELECT 1", "SELECT 2"]);
  assert.equal(sql.slice(s[0].from, s[0].to), "SELECT 1");
  assert.equal(sql.slice(s[1].from, s[1].to), "SELECT 2");
});

test("semicolons inside strings, identifiers and comments do not split", () => {
  assert.deepEqual(texts("SELECT 'a;b', \"x;y\" FROM t -- c;d\n; SELECT /* e;f */ 2", "postgres"), [
    "SELECT 'a;b', \"x;y\" FROM t -- c;d",
    "SELECT /* e;f */ 2",
  ]);
  assert.deepEqual(texts("SELECT 'it''s; fine'; SELECT 2", "oracle"), ["SELECT 'it''s; fine'", "SELECT 2"]);
});

test("comment-only chunks are skipped", () => {
  assert.deepEqual(texts("-- header\n;\n/* x */;\nSELECT 1;", "snowflake"), ["SELECT 1"]);
});

test("backslash escapes only where the dialect has them", () => {
  assert.deepEqual(texts("SELECT 'a\\';b'; SELECT 2", "mysql"), ["SELECT 'a\\';b'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 'C:\\'; SELECT 2", "postgres"), ["SELECT 'C:\\'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT E'a\\';b'; SELECT 2", "postgres"), ["SELECT E'a\\';b'", "SELECT 2"]);
  assert.deepEqual(texts("SELECT 'x\\';y'; SELECT 2", "snowflake"), ["SELECT 'x\\';y'", "SELECT 2"]);
});

test("dollar quoting (Postgres functions, Snowflake procedures)", () => {
  const pg = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql; SELECT f();";
  assert.deepEqual(texts(pg, "postgres"), [
    "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql",
    "SELECT f()",
  ]);
  const sf = "CREATE OR REPLACE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$ BEGIN RETURN 'x;y'; END; $$;\nCALL p();";
  assert.deepEqual(texts(sf, "snowflake"), [
    "CREATE OR REPLACE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$ BEGIN RETURN 'x;y'; END; $$",
    "CALL p()",
  ]);
});

test("Postgres BEGIN is a transaction, not a block", () => {
  assert.deepEqual(texts("BEGIN; UPDATE t SET a = 1; COMMIT;", "postgres"), ["BEGIN", "UPDATE t SET a = 1", "COMMIT"]);
});

test("CASE ... END inside a statement", () => {
  assert.deepEqual(texts("SELECT CASE WHEN a THEN 'x;' ELSE 'y' END AS c FROM t; SELECT 2", "snowflake"), [
    "SELECT CASE WHEN a THEN 'x;' ELSE 'y' END AS c FROM t",
    "SELECT 2",
  ]);
});

test("Snowflake scripting block keeps its inner semicolons", () => {
  const sql = "BEGIN\n  LET x := 1;\n  IF (x > 0) THEN\n    RETURN 'pos';\n  END IF;\nEND;\nSELECT 3;";
  assert.deepEqual(texts(sql, "snowflake"), [
    "BEGIN\n  LET x := 1;\n  IF (x > 0) THEN\n    RETURN 'pos';\n  END IF;\nEND",
    "SELECT 3",
  ]);
  assert.deepEqual(texts("BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT;", "snowflake"), [
    "BEGIN TRANSACTION", "INSERT INTO t VALUES (1)", "COMMIT",
  ]);
});

test("Oracle PL/SQL units end at a slash line", () => {
  const sql = [
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
  ].join("\n");
  assert.deepEqual(texts(sql, "oracle"), [
    "CREATE OR REPLACE PROCEDURE p IS\n  v NUMBER;\nBEGIN\n  SELECT 1 INTO v FROM dual;\nEND p;",
    "SELECT * FROM dual",
    "BEGIN\n  p;\nEND;",
  ]);
  assert.deepEqual(texts("SELECT q'[a;b]' FROM dual; SELECT 2 FROM dual", "oracle"), [
    "SELECT q'[a;b]' FROM dual",
    "SELECT 2 FROM dual",
  ]);
});

test("SQL Server GO batches, modules and brackets", () => {
  const sql = [
    "CREATE OR ALTER PROCEDURE dbo.p AS",
    "BEGIN",
    "  SELECT 1;",
    "  SELECT 2;",
    "END",
    "GO",
    "SELECT [a;b] FROM t; SELECT 3",
    "go",
    "BEGIN TRAN; UPDATE t SET x = 1; COMMIT;",
  ].join("\n");
  assert.deepEqual(texts(sql, "sqlserver"), [
    "CREATE OR ALTER PROCEDURE dbo.p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
    "SELECT [a;b] FROM t",
    "SELECT 3",
    "BEGIN TRAN",
    "UPDATE t SET x = 1",
    "COMMIT",
  ]);
  assert.deepEqual(texts("BEGIN TRY\n SELECT 1;\nEND TRY\nBEGIN CATCH\n SELECT 2;\nEND CATCH;\nSELECT 9;", "sqlserver"), [
    "BEGIN TRY\n SELECT 1;\nEND TRY\nBEGIN CATCH\n SELECT 2;\nEND CATCH",
    "SELECT 9",
  ]);
});

test("MySQL DELIMITER, backticks and # comments", () => {
  const sql = [
    "DELIMITER //",
    "CREATE PROCEDURE p()",
    "BEGIN",
    "  SELECT 1; SELECT 2;",
    "END //",
    "DELIMITER ;",
    "SELECT `a;b` FROM t # trailing; comment",
    ";",
    "SELECT 3;",
  ].join("\n");
  assert.deepEqual(texts(sql, "mysql"), [
    "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1; SELECT 2;\nEND",
    "SELECT `a;b` FROM t # trailing; comment",
    "SELECT 3",
  ]);
});

test("Snowflake // comments", () => {
  assert.deepEqual(texts("SELECT 1 // note; still comment\n; SELECT 2", "snowflake"), [
    "SELECT 1 // note; still comment",
    "SELECT 2",
  ]);
});

test("smart blank-line delimiter", () => {
  const sql = "SELECT *\nFROM a\n\nSELECT *\nFROM b\nWHERE x = 1\n\n\nupdate c set y = 2";
  assert.deepEqual(texts(sql, "postgres", true), ["SELECT *\nFROM a", "SELECT *\nFROM b\nWHERE x = 1", "update c set y = 2"]);
  // Without the option, blank lines never split.
  assert.equal(texts(sql, "postgres", false).length, 1);
  // A CTE followed by its main query is not split.
  const cte = "WITH x AS (\n  SELECT 1 AS a\n)\n\nSELECT * FROM x";
  assert.deepEqual(texts(cte, "postgres", true), [cte]);
  // A trailing comma means the statement continues.
  const cont = "SELECT a,\n\nb FROM t";
  assert.deepEqual(texts(cont, "postgres", true), [cont]);
  // Inside parentheses never splits.
  const paren = "SELECT * FROM t WHERE id IN (\n\nSELECT id FROM u)";
  assert.deepEqual(texts(paren, "postgres", true), [paren]);
});

test("statementAt picks the statement for the cursor", () => {
  const doc = "SELECT 1;  \nSELECT 2\nFROM t;\n\n\nSELECT 3;";
  const s = splitSqlStatements(doc, "postgres");
  assert.equal(statementAt(s, 3, doc)?.text, "SELECT 1");
  assert.equal(statementAt(s, doc.indexOf(";") + 2, doc)?.text, "SELECT 1"); // after ; on same line
  assert.equal(statementAt(s, doc.indexOf("FROM"), doc)?.text, "SELECT 2\nFROM t");
  assert.equal(statementAt(s, doc.length, doc)?.text, "SELECT 3");
  assert.equal(statementAt([], 0, ""), null);
});

test("isModifyingStatement", () => {
  assert.equal(isModifyingStatement("-- note\n/* x */ DELETE FROM t"), true);
  assert.equal(isModifyingStatement("select * from t"), false);
  assert.equal(isModifyingStatement("WITH x AS (SELECT 1) SELECT * FROM x"), false);
  assert.equal(isModifyingStatement("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"), true);
  assert.equal(isModifyingStatement("truncate table t"), true);
});

test("lineOf", () => {
  assert.equal(lineOf("a\nb\nc", 0), 1);
  assert.equal(lineOf("a\nb\nc", 2), 2);
  assert.equal(lineOf("a\nb\nc", 4), 3);
});

test("generic dialect accepts every quoting style", () => {
  assert.deepEqual(
    texts("SELECT 'a;''b'; SELECT \"x;y\"; SELECT [a;b]; SELECT `c;d`; SELECT $$e;f$$; SELECT q'[g;h]'"),
    ["SELECT 'a;''b'", 'SELECT "x;y"', "SELECT [a;b]", "SELECT `c;d`", "SELECT $$e;f$$", "SELECT q'[g;h]'"],
  );
  assert.deepEqual(texts("CREATE TABLE #temp (id int); INSERT INTO #temp VALUES (1); SELECT * FROM #temp;", "sqlserver"), [
    "CREATE TABLE #temp (id int)", "INSERT INTO #temp VALUES (1)", "SELECT * FROM #temp",
  ]);
});
