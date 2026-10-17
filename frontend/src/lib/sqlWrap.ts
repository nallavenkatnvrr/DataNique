/**
 * Statement rewrites behind the IDE's "Explain plan" and "Count rows"
 * commands, per dialect (DBeaver: Ctrl+Shift+E / Ctrl+Alt+Shift+C).
 */
import type { SplitDialect } from "@/lib/sqlSplit";

/** Drop trailing semicolons / whitespace (the splitter already excludes the delimiter). */
export function stripTrailingDelimiter(stmt: string): string {
  return stmt.replace(/[\s;]+$/, "");
}

export interface WrappedRun {
  statements: string[];
  /** Keep running later statements after an error (needed to switch SHOWPLAN off again). */
  stopOnError: boolean;
  /** Index of the statement whose result is the plan. */
  resultStatement: number;
}

export function explainStatements(dialect: SplitDialect, stmt: string): WrappedRun {
  const s = stripTrailingDelimiter(stmt);
  switch (dialect) {
    case "snowflake":
      return { statements: [`EXPLAIN USING TABULAR\n${s}`], stopOnError: true, resultStatement: 0 };
    case "oracle":
      return {
        statements: [`EXPLAIN PLAN FOR\n${s}`, "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())"],
        stopOnError: true,
        resultStatement: 1,
      };
    case "sqlserver":
      // SHOWPLAN_TEXT must be the only statement in its batch; OFF always runs
      // so a failing statement can't leave the session in plan-only mode.
      return { statements: ["SET SHOWPLAN_TEXT ON", s, "SET SHOWPLAN_TEXT OFF"], stopOnError: false, resultStatement: 1 };
    case "mysql":
    case "postgres":
    case "generic":
    default:
      return { statements: [`EXPLAIN\n${s}`], stopOnError: true, resultStatement: 0 };
  }
}

export function countStatement(stmt: string): string {
  return `SELECT COUNT(*) AS row_count FROM (\n${stripTrailingDelimiter(stmt)}\n) dv_count`;
}

/** Whether a statement is a query whose rows can be counted. */
export function isCountable(stmt: string): boolean {
  const t = stmt.replace(/^(\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, "");
  return /^(SELECT|WITH|VALUES|\()/i.test(t);
}

// ---------------------------------------------------------------------------
// Identifier quoting and quick-select templates (Database Explorer)
// ---------------------------------------------------------------------------

const RESERVED = new Set(
  "select from where group order by having limit offset table view user index key primary foreign check default column constraint create drop alter insert update delete merge into values and or not null is in like between case when then else end join inner left right full outer cross on as union all distinct with grant revoke to desc asc date time timestamp level size comment".split(" "),
);

/** Quote an identifier only when it needs it (mixed/odd case, spaces, reserved words). */
export function quoteIdent(name: string, dialect: SplitDialect): string {
  const plain = /^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name);
  const caseOk =
    dialect === "postgres" ? name === name.toLowerCase()
    : dialect === "oracle" || dialect === "snowflake" ? name === name.toUpperCase()
    : true;
  if (plain && caseOk && !RESERVED.has(name.toLowerCase())) return name;
  switch (dialect) {
    case "sqlserver":
      return `[${name.replace(/]/g, "]]")}]`;
    case "mysql":
      return "`" + name.replace(/`/g, "``") + "`";
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/** Qualified "schema.table" (each part quoted as needed). */
export function qualify(name: string, schema: string | null | undefined, dialect: SplitDialect): string {
  // Names from the explorer may already be qualified ("dbo.orders").
  if (!schema || name.includes(".")) return name.includes(".") ? name : quoteIdent(name, dialect);
  return `${quoteIdent(schema, dialect)}.${quoteIdent(name, dialect)}`;
}

export function selectTop(dialect: SplitDialect, table: string, n: number, columns = "*"): string {
  switch (dialect) {
    case "sqlserver":
      return `SELECT TOP ${n} ${columns}\nFROM ${table}`;
    case "oracle":
      return `SELECT ${columns}\nFROM ${table}\nFETCH FIRST ${n} ROWS ONLY`;
    default:
      return `SELECT ${columns}\nFROM ${table}\nLIMIT ${n}`;
  }
}
