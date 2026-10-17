import { test } from "node:test";
import assert from "node:assert/strict";
import { errorRange, parseErrorLocation } from "./sqlErrors.ts";
import { countStatement, explainStatements, quoteIdent, selectTop, isCountable } from "./sqlWrap.ts";

test("postgres LINE + caret", () => {
  const msg = 'syntax error at or near "FORM"\nLINE 1: SELECT * FORM orders\n                 ^';
  const loc = parseErrorLocation(msg);
  assert.equal(loc?.line, 1);
  assert.equal(loc?.col, 9);
  const stmt = "SELECT * FORM orders";
  const r = errorRange(msg, stmt, 100);
  assert.equal(stmt.slice(r.from - 100, r.to - 100), "FORM");
});

test("postgres second line", () => {
  const msg = 'column "nme" does not exist\nLINE 2: WHERE nme = 1\n              ^';
  const stmt = "SELECT *\nWHERE nme = 1";
  const r = errorRange(msg, stmt, 0);
  assert.equal(stmt.slice(r.from, r.to), "nme");
});

test("snowflake line/position", () => {
  const msg = "001003 (42000): SQL compilation error:\nsyntax error line 2 at position 5 unexpected 'FORM'.";
  const stmt = "SELECT *\n  x  FORM t";
  const r = errorRange(msg, stmt, 10);
  assert.equal(stmt.slice(r.from - 10, r.to - 10), "FORM");
});

test("mysql near ... at line", () => {
  const msg = "(1064, \"You have an error in your SQL syntax; check the manual near 'FORM t' at line 2\")";
  const stmt = "SELECT 1,\n 2 FORM t";
  const r = errorRange(msg, stmt, 0);
  assert.equal(stmt.slice(r.from, r.to), "FORM t");
});

test("sql server near token", () => {
  const msg = "('42000', \"[42000] [Microsoft][ODBC Driver 18 for SQL Server][SQL Server]Incorrect syntax near 'FORM'. (102)\")";
  const stmt = "SELECT TOP 5 * FORM dbo.t";
  const r = errorRange(msg, stmt, 3);
  assert.equal(stmt.slice(r.from - 3, r.to - 3), "FORM");
});

test("no location → first line", () => {
  const stmt = "  SELECT *\nFROM missing_table";
  const r = errorRange('relation "missing_table" does not exist', stmt, 0);
  assert.equal(stmt.slice(r.from, r.to), "SELECT *");
});

test("explain per dialect", () => {
  assert.deepEqual(explainStatements("postgres", "SELECT 1;").statements, ["EXPLAIN\nSELECT 1"]);
  assert.equal(explainStatements("oracle", "SELECT 1 FROM dual").statements.length, 2);
  const ss = explainStatements("sqlserver", "SELECT 1");
  assert.equal(ss.statements[2], "SET SHOWPLAN_TEXT OFF");
  assert.equal(ss.stopOnError, false);
  assert.match(explainStatements("snowflake", "SELECT 1").statements[0], /^EXPLAIN USING TABULAR/);
});

test("count wraps statement", () => {
  assert.equal(countStatement("SELECT * FROM t;"), "SELECT COUNT(*) AS row_count FROM (\nSELECT * FROM t\n) dv_count");
  assert.ok(isCountable("-- c\nWITH x AS (SELECT 1) SELECT * FROM x"));
  assert.ok(!isCountable("DELETE FROM t"));
});

test("identifier quoting", () => {
  assert.equal(quoteIdent("orders", "postgres"), "orders");
  assert.equal(quoteIdent("Orders", "postgres"), '"Orders"');
  assert.equal(quoteIdent("ORDERS", "oracle"), "ORDERS");
  assert.equal(quoteIdent("order", "mysql"), "`order`");
  assert.equal(quoteIdent("my table", "sqlserver"), "[my table]");
  assert.equal(selectTop("sqlserver", "t", 10), "SELECT TOP 10 *\nFROM t");
  assert.equal(selectTop("oracle", "t", 10), "SELECT *\nFROM t\nFETCH FIRST 10 ROWS ONLY");
});
