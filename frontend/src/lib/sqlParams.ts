/**
 * Script variables and named parameters (DBeaver "SQL parameters"):
 *   ${name}  - variable, always recognised
 *   :name    - named parameter (optional; off for statements that create
 *              triggers/procedures, where :new / :old are real syntax)
 *
 * Occurrences inside string literals, quoted identifiers, comments and
 * dollar-quoted bodies are ignored, as are Postgres casts (::type) and
 * PL/SQL assignments (:=). Values are substituted as typed (raw SQL text).
 */

export interface ParamRef {
  name: string;
  kind: "variable" | "named";
  from: number;
  to: number;
}

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

export function findParams(sql: string, opts: { named?: boolean } = {}): ParamRef[] {
  const named = opts.named ?? true;
  const allowNamed = named && !/^\s*(--[^\n]*\n\s*)*(CREATE|ALTER)\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?(TRIGGER|PROCEDURE|FUNCTION|PACKAGE|TYPE)\b/i.test(sql)
    && !/^\s*(DECLARE|BEGIN)\b/i.test(sql);
  const out: ParamRef[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    // comments
    if (c === "-" && next === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // quoted strings / identifiers
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        if (sql[j] === "\\" && c === "'" ) j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "[") {
      const e = sql.indexOf("]", i + 1);
      // [ ... ] is a SQL Server identifier only when it has no spaces-less operators;
      // treat it as opaque to stay safe.
      i = e < 0 ? n : e + 1;
      continue;
    }
    // dollar quoting $$...$$ / $tag$...$tag$
    if (c === "$" && next !== "{") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const e = sql.indexOf(tag, i + tag.length);
        i = e < 0 ? n : e + tag.length;
        continue;
      }
    }
    // ${variable}
    if (c === "$" && next === "{") {
      const e = sql.indexOf("}", i + 2);
      const name = e > 0 ? sql.slice(i + 2, e).trim() : "";
      if (name && /^[A-Za-z_][\w.]*$/.test(name)) {
        out.push({ name, kind: "variable", from: i, to: e + 1 });
        i = e + 1;
        continue;
      }
    }
    // :name
    if (c === ":" && allowNamed && next !== ":" && next !== "=" && sql[i - 1] !== ":") {
      const prev = sql[i - 1];
      if (!prev || !/[A-Za-z0-9_\]\)"`.]/.test(prev)) {
        NAME.lastIndex = i + 1;
        const m = NAME.exec(sql);
        if (m) {
          out.push({ name: m[0], kind: "named", from: i, to: i + 1 + m[0].length });
          i += 1 + m[0].length;
          continue;
        }
      }
    }
    i++;
  }
  return out;
}

/** Replace every reference with its value (raw text). Unknown names are left as-is. */
export function substituteParams(sql: string, refs: ParamRef[], values: Record<string, string>): string {
  let out = "";
  let last = 0;
  for (const r of refs) {
    if (!(r.name in values)) continue;
    out += sql.slice(last, r.from) + values[r.name];
    last = r.to;
  }
  return out + sql.slice(last);
}

/** Distinct parameter names in order of first appearance. */
export function paramNames(refs: ParamRef[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of refs) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      names.push(r.name);
    }
  }
  return names;
}
