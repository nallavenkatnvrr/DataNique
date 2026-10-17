import { test } from "node:test";
import assert from "node:assert/strict";
import { findParams, paramNames, substituteParams } from "./sqlParams.ts";

const names = (sql: string, named = true) => paramNames(findParams(sql, { named }));

test("variables and named parameters", () => {
  assert.deepEqual(names("SELECT * FROM t WHERE id = :id AND d > ${since}"), ["id", "since"]);
  assert.deepEqual(names("SELECT :a, :a, :b"), ["a", "b"]);
});

test("ignores casts, assignments, strings, comments, dollar bodies", () => {
  assert.deepEqual(names("SELECT x::int, '2020-01-01 10:30' FROM t -- :nope\n/* :nope */"), []);
  assert.deepEqual(names("SELECT $$ :nope ${nope} $$, \"col:nope\""), []);
  assert.deepEqual(names("v_x := 5"), []);
  assert.deepEqual(names("SELECT a[1:2] FROM t"), []);
});

test("named parameters are off in trigger / PL/SQL bodies", () => {
  assert.deepEqual(names("CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW BEGIN :new.x := 1; END;"), []);
  assert.deepEqual(names("BEGIN :out := 1; END;"), []);
  assert.deepEqual(names("CREATE TRIGGER t ... ${var}"), ["var"]);
});

test("named parameters can be disabled", () => {
  assert.deepEqual(names("SELECT :id, ${v}", false), ["v"]);
});

test("substitution", () => {
  const sql = "SELECT * FROM t WHERE id = :id AND c = '${x}' AND d = ${x}";
  const refs = findParams(sql);
  assert.equal(substituteParams(sql, refs, { id: "42", x: "'a'" }), "SELECT * FROM t WHERE id = 42 AND c = '${x}' AND d = 'a'");
});
