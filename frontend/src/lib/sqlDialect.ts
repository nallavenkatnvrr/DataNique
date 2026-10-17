// Maps our connection db_type to:
//   1. A CodeMirror @codemirror/lang-sql SQLDialect (keyword set + quoting).
//   2. A dt-sql-parser grammar for context-aware completion (MySQL and
//      PostgreSQL only).

import {
  StandardSQL,
  PostgreSQL,
  MySQL,
  MSSQL,
  PLSQL,
  type SQLDialect,
} from "@codemirror/lang-sql";
import type { DbType } from "@/api/client";

// ---- CodeMirror dialect ----------------------------------------------------

export function cmDialectFor(dbType: DbType | undefined | null): SQLDialect {
  switch (dbType) {
    case "postgres":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "sqlserver":
      return MSSQL;
    case "oracle":
      return PLSQL;
    case "snowflake":
      // No dedicated Snowflake dialect; ANSI StandardSQL is the closest fit
      // (double-quoted identifiers, standard keyword set).
      return StandardSQL;
    default:
      return StandardSQL;
  }
}

// ---- dt-sql-parser language --------------------------------------------------
//
// Grammar-aware completion uses dt-sql-parser, which ships exact grammars for
// MySQL and PostgreSQL only (its Trino/Spark/Hive grammars mis-suggest for
// Snowflake, Oracle and SQL Server, so those engines use keyword + schema
// completion instead). Each grammar is imported on its own - the package
// root would pull every dialect (~7 MB) into the bundle.

export type DtParserName = "MySQL" | "PostgreSQL";

export function dtParserNameFor(dbType: DbType | undefined | null): DtParserName | null {
  if (dbType === "mysql") return "MySQL";
  if (dbType === "postgres") return "PostgreSQL";
  return null;
}

const LOADERS: Record<DtParserName, () => Promise<new () => any>> = {
  PostgreSQL: () => import("dt-sql-parser/dist/parser/postgresql").then((m) => m.PostgreSQL),
  MySQL: () => import("dt-sql-parser/dist/parser/mysql").then((m) => m.MySQL),
};

// Parser instances are cached - constructing the antlr-backed parser is not free.
const _parserCache = new Map<DtParserName, any>();

export interface DtBundle {
  parser: any;
  // EntityContextType values we care about, resolved from the module so we
  // never hard-code numeric enum values that could shift between versions.
  tableTypes: number[];
  columnTypes: number[];
}

export async function getDt(name: DtParserName | null): Promise<DtBundle | null> {
  if (!name) return null;
  try {
    let parser = _parserCache.get(name);
    if (!parser) {
      const Ctor = await LOADERS[name]();
      parser = new Ctor();
      _parserCache.set(name, parser);
    }
    const types: any = await import("dt-sql-parser/dist/parser/common/types");
    const ECT = types.EntityContextType ?? {};
    const pick = (...keys: string[]) =>
      keys.map((k) => ECT[k]).filter((v) => typeof v === "number") as number[];
    return {
      parser,
      tableTypes: pick("TABLE", "TABLE_CREATE", "VIEW", "VIEW_CREATE"),
      columnTypes: pick("COLUMN", "COLUMN_CREATE"),
    };
  } catch {
    return null;
  }
}
