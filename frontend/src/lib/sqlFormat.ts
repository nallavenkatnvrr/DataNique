/**
 * SQL formatting (Ctrl+Shift+F) via sql-formatter, loaded on first use so it
 * never weighs on the initial bundle. Only the five dialects this app talks
 * to are imported.
 */
import type { SplitDialect } from "@/lib/sqlSplit";

export interface FormatOptions {
  tabWidth?: number;
  keywordCase?: "upper" | "lower" | "preserve";
}

export async function formatSql(sql: string, dialect: SplitDialect, opts: FormatOptions = {}): Promise<string> {
  const mod = await import("sql-formatter");
  const lang =
    dialect === "snowflake" ? mod.snowflake
    : dialect === "oracle" ? mod.plsql
    : dialect === "sqlserver" ? mod.transactsql
    : dialect === "mysql" ? mod.mysql
    : dialect === "postgres" ? mod.postgresql
    : mod.sql;
  return mod.formatDialect(sql, {
    dialect: lang,
    tabWidth: opts.tabWidth ?? 2,
    keywordCase: opts.keywordCase ?? "upper",
    linesBetweenQueries: 1,
  });
}
