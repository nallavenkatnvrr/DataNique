/**
 * Dialect-aware SQL statement splitter for the SQL IDE.
 *
 * One scanner drives everything that needs statement boundaries: "run the
 * statement under the cursor" (Ctrl+Enter), "run script" (each statement is
 * sent to the backend separately so results and errors map back to the right
 * statement), the gutter run markers and the current-statement highlight.
 *
 * What it understands (per dialect, mirroring DBeaver / SQL*Plus / sqlcmd):
 *   - strings: '...' with '' escapes; backslash escapes for MySQL, Snowflake
 *     and Postgres E'...' strings; Oracle q'[...]' quotes
 *   - quoted identifiers: "..." everywhere, `...` (MySQL), [...] (SQL Server)
 *   - comments: -- and block comments everywhere, # (MySQL), // (Snowflake);
 *     nested block comments (Postgres)
 *   - dollar quoting $$...$$ / $tag$...$tag$ (Postgres, Snowflake)
 *   - procedural blocks: BEGIN ... END / CASE ... END depth (semicolons inside
 *     a block do not split), Oracle PL/SQL units terminated by a "/" line,
 *     SQL Server modules (CREATE PROCEDURE/FUNCTION/TRIGGER/VIEW) and the
 *     "GO" batch separator, MySQL DELIMITER commands
 *   - optional "smart" blank-line delimiting (DBeaver's "blank line is a
 *     statement delimiter: smart") for scripts written without semicolons
 *
 * Offsets are in UTF-16 code units of the input string (what CodeMirror and
 * textarea selection APIs use).
 *
 * Keep in sync with backend/app/services/sql_split.py — both implement the
 * same rules and share test cases.
 */

export type SplitDialect = "snowflake" | "oracle" | "sqlserver" | "postgres" | "mysql" | "generic";

export interface SqlStatement {
  /** Statement text, trimmed. Never includes the delimiter, a GO line or a "/" line. */
  text: string;
  /** Offset of the first character of `text` in the input. */
  from: number;
  /** Offset just past the last character of `text` in the input. */
  to: number;
}

export interface SplitOptions {
  /** Treat a blank line as a statement boundary when the next line starts a
   *  new statement (default false). Meant for interactive "run statement at
   *  cursor"; script execution keeps strict delimiters. */
  blankLineDelimiter?: boolean;
}

const STATEMENT_START = /^(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC|EXECUTE|USE|SET|SHOW|DESCRIBE|DESC|EXPLAIN|DECLARE|BEGIN|COMMIT|ROLLBACK|VALUES|COPY|PUT|GET|LIST|REMOVE|UNLOAD|ANALYZE|VACUUM|COMMENT|REFRESH|UNDROP|PRAGMA)\b/i;
const NOT_A_BLOCK_AFTER_BEGIN = new Set(["TRAN", "TRANSACTION", "WORK", "DISTRIBUTED", "NAME", "ISOLATION", "READ"]);
const END_KEEPS_DEPTH = new Set(["IF", "LOOP", "WHILE", "REPEAT", "FOR"]);

export function normalizeDialect(dbType?: string | null): SplitDialect {
  const d = (dbType || "").toLowerCase();
  if (d === "snowflake" || d === "oracle" || d === "sqlserver" || d === "mysql") return d;
  if (d === "postgres" || d === "postgresql") return "postgres";
  if (d === "mariadb") return "mysql";
  return "generic";
}

function isIdentStart(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9") || c === "$" || c === "#";
}

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";
}

/** Returns [lineStart, lineEnd) bounds of the line containing `pos`. */
function lineBounds(sql: string, pos: number): [number, number] {
  let s = pos;
  while (s > 0 && sql[s - 1] !== "\n") s--;
  let e = pos;
  while (e < sql.length && sql[e] !== "\n") e++;
  return [s, e];
}

/** Classify the leading keywords of a statement. */
function classify(words: string[], dialect: SplitDialect): { plsql: boolean; tsqlModule: boolean } {
  const w = words.slice(0, 6);
  let i = 0;
  let plsql = false;
  let tsqlModule = false;
  if (dialect === "oracle") {
    if (w[0] === "DECLARE" || w[0] === "BEGIN") plsql = true;
    if (w[0] === "CREATE") {
      i = 1;
      if (w[i] === "OR" && w[i + 1] === "REPLACE") i += 2;
      if (w[i] === "EDITIONABLE" || w[i] === "NONEDITIONABLE") i += 1;
      if (["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY"].includes(w[i])) plsql = true;
    }
  }
  if (dialect === "sqlserver") {
    if (w[0] === "CREATE" || w[0] === "ALTER") {
      i = 1;
      if (w[0] === "CREATE" && w[i] === "OR" && w[i + 1] === "ALTER") i += 2;
      if (["PROC", "PROCEDURE", "FUNCTION", "TRIGGER", "VIEW"].includes(w[i])) tsqlModule = true;
    }
  }
  return { plsql, tsqlModule };
}

export function splitSqlStatements(sql: string, dbType?: string | null, opts: SplitOptions = {}): SqlStatement[] {
  const dialect = normalizeDialect(dbType);
  const n = sql.length;
  const out: SqlStatement[] = [];

  const backslashInSingle = dialect === "mysql" || dialect === "snowflake";
  const dollarQuotes = dialect === "postgres" || dialect === "snowflake" || dialect === "generic";
  const hashComments = dialect === "mysql";
  const slashComments = dialect === "snowflake";
  const bracketIdents = dialect === "sqlserver" || dialect === "generic";
  const backtickIdents = dialect === "mysql" || dialect === "generic";
  const nestedComments = dialect === "postgres";
  const qQuotes = dialect === "oracle" || dialect === "generic";
  const countBegin = dialect !== "postgres";
  const goSeparator = dialect === "sqlserver";
  const slashTerminator = dialect === "oracle";
  const delimiterCommand = dialect === "mysql";

  let delimiter = ";";
  let stmtStart = 0;
  let hasCode = false;      // non-comment, non-whitespace content seen in current statement
  let words: string[] = []; // leading keywords of the current statement
  let mode = { plsql: false, tsqlModule: false };
  let depth = 0;            // BEGIN/CASE ... END depth
  let parens = 0;
  let lastCodeChar = "";    // last non-space code character (for blank-line heuristics)
  let i = 0;

  const resetStatement = (next: number) => {
    stmtStart = next;
    hasCode = false;
    words = [];
    mode = { plsql: false, tsqlModule: false };
    depth = 0;
    parens = 0;
    lastCodeChar = "";
  };

  const emit = (end: number) => {
    if (hasCode) {
      let a = stmtStart;
      let b = end;
      while (a < b && isSpace(sql[a])) a++;
      while (b > a && isSpace(sql[b - 1])) b--;
      if (b > a) out.push({ text: sql.slice(a, b), from: a, to: b });
    }
  };

  const atLineStart = (pos: number): boolean => {
    let p = pos - 1;
    while (p >= 0 && (sql[p] === " " || sql[p] === "\t")) p--;
    return p < 0 || sql[p] === "\n";
  };

  /** If a whole-line command (GO, "/", DELIMITER) starts at `pos`, return its line end. */
  const lineCommandEnd = (pos: number): { end: number; kind: "go" | "slash" | "delimiter"; arg?: string } | null => {
    if (!atLineStart(pos)) return null;
    const [, le] = lineBounds(sql, pos);
    const line = sql.slice(pos, le).replace(/\r$/, "");
    if (goSeparator && /^GO(\s+\d+)?\s*$/i.test(line)) return { end: le, kind: "go" };
    if (slashTerminator && /^\/\s*$/.test(line)) return { end: le, kind: "slash" };
    if (delimiterCommand && !hasCode) {
      const m = /^DELIMITER\s+(\S+)\s*$/i.exec(line);
      if (m) return { end: le, kind: "delimiter", arg: m[1] };
    }
    return null;
  };

  const peekWord = (pos: number): { word: string; at: number } => {
    let p = pos;
    while (p < n && isSpace(sql[p])) p++;
    if (p < n && isIdentStart(sql[p])) {
      let e = p + 1;
      while (e < n && isIdentPart(sql[e])) e++;
      return { word: sql.slice(p, e).toUpperCase(), at: p };
    }
    return { word: p < n ? sql[p] : "", at: p };
  };

  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : "";

    // ---- whole-line commands (only meaningful outside strings/comments) ----
    if (c === "G" || c === "g" || c === "/" || c === "D" || c === "d") {
      const cmd = lineCommandEnd(i);
      if (cmd) {
        if (cmd.kind === "delimiter") {
          delimiter = cmd.arg || ";";
          resetStatement(cmd.end);
          i = cmd.end;
          continue;
        }
        emit(i);
        resetStatement(cmd.end);
        i = cmd.end;
        continue;
      }
    }

    // ---- comments ----
    if ((c === "-" && c2 === "-") || (hashComments && c === "#") || (slashComments && c === "/" && c2 === "/")) {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (nestedComments && sql[i] === "/" && sql[i + 1] === "*") { d++; i += 2; continue; }
        if (sql[i] === "*" && sql[i + 1] === "/") { d--; i += 2; continue; }
        i++;
      }
      continue;
    }

    // ---- custom delimiter (MySQL DELIMITER) ----
    if (delimiter !== ";" && sql.startsWith(delimiter, i)) {
      emit(i);
      i += delimiter.length;
      resetStatement(i);
      continue;
    }

    // ---- strings and quoted identifiers ----
    if (qQuotes && (c === "q" || c === "Q") && c2 === "'" && i + 2 < n && !(i > 0 && isIdentPart(sql[i - 1]))) {
      const open = sql[i + 2];
      const close = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
      const endTok = close + "'";
      const end = sql.indexOf(endTok, i + 3);
      hasCode = true;
      lastCodeChar = "'";
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === "'") {
      const eString = dialect === "postgres" && i > 0 && (sql[i - 1] === "E" || sql[i - 1] === "e") && !(i > 1 && isIdentPart(sql[i - 2]));
      const allowBackslash = backslashInSingle || eString;
      i++;
      while (i < n) {
        const ch = sql[i];
        if (allowBackslash && ch === "\\") { i += 2; continue; }
        if (ch === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      hasCode = true;
      lastCodeChar = "'";
      continue;
    }
    if (c === '"' || (backtickIdents && c === "`") || (bracketIdents && c === "[")) {
      const close = c === "[" ? "]" : c;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      hasCode = true;
      lastCodeChar = close;
      continue;
    }
    if (dollarQuotes && c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !(i > 0 && isIdentPart(sql[i - 1]))) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        hasCode = true;
        lastCodeChar = "$";
        i = end < 0 ? n : end + tag.length;
        continue;
      }
    }

    // ---- words (keywords drive block detection) ----
    if (isIdentStart(c) && !(i > 0 && isIdentPart(sql[i - 1]))) {
      let e = i + 1;
      while (e < n && isIdentPart(sql[e])) e++;
      const word = sql.slice(i, e).toUpperCase();
      hasCode = true;
      lastCodeChar = sql[e - 1];
      if (words.length < 6) {
        words.push(word);
        if (words.length <= 6) mode = classify(words, dialect);
      }
      if (word === "CASE") depth++;
      else if (word === "BEGIN") {
        const next = peekWord(e).word;
        const isBlock =
          (countBegin && next !== ";" && next !== "" && !NOT_A_BLOCK_AFTER_BEGIN.has(next)) ||
          (dialect === "postgres" && next === "ATOMIC");
        if (isBlock) depth++;
      } else if (word === "END") {
        const next = peekWord(e).word;
        if (!END_KEEPS_DEPTH.has(next) && depth > 0) depth--;
      }
      i = e;
      continue;
    }

    // ---- structure ----
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);

    if (c === ";" && delimiter === ";") {
      if (!mode.plsql && !mode.tsqlModule && depth === 0) {
        emit(i);
        resetStatement(i + 1);
        i++;
        continue;
      }
    }

    // ---- smart blank-line delimiter ----
    if (c === "\n" && opts.blankLineDelimiter && hasCode && depth === 0 && parens === 0 && !mode.plsql && !mode.tsqlModule) {
      let p = i + 1;
      while (p < n && (sql[p] === " " || sql[p] === "\t" || sql[p] === "\r")) p++;
      if (p < n && sql[p] === "\n") {
        let q = p;
        while (q < n && isSpace(sql[q])) q++;
        const rest = sql.slice(q, q + 24);
        const startsStatement = STATEMENT_START.test(rest);
        const continues = /[,(+\-*/=<>|]$/.test(lastCodeChar) || lastCodeChar === "";
        const cteBody = words[0] === "WITH" && /^(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(rest);
        if (startsStatement && !continues && !cteBody) {
          emit(i);
          resetStatement(q);
          i = q;
          continue;
        }
      }
    }

    if (!isSpace(c)) {
      hasCode = true;
      lastCodeChar = c;
    }
    i++;
  }
  emit(n);
  return out;
}

/**
 * Pick the statement the cursor belongs to (DBeaver semantics): the statement
 * containing the cursor; else the one that ended earlier on the cursor's line
 * (cursor right after the semicolon); else the next statement when only
 * whitespace (no blank line) separates the cursor from it.
 */
export function statementAt(stmts: SqlStatement[], pos: number, doc: string): SqlStatement | null {
  let prev: SqlStatement | null = null;
  for (const s of stmts) {
    if (pos >= s.from && pos <= s.to) return s;
    if (s.to < pos) prev = s;
    if (s.from > pos) {
      if (prev) {
        const between = doc.slice(prev.to, pos);
        if (!between.includes("\n")) return prev;
      }
      const gap = doc.slice(pos, s.from);
      if (!/\n[ \t\r]*\n/.test(gap) && /^[\s;]*$/.test(gap)) return s;
      return prev && !doc.slice(prev.to, pos).match(/\n[ \t\r]*\n/) ? prev : null;
    }
  }
  if (prev) {
    const between = doc.slice(prev.to, pos);
    if (!/\n[ \t\r]*\n/.test(between)) return prev;
  }
  return null;
}

/** 1-based line number of an offset. */
export function lineOf(doc: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < doc.length; i++) if (doc.charCodeAt(i) === 10) line++;
  return line;
}

const MODIFYING = /^\s*(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|RENAME|COMMENT|CALL|EXEC|EXECUTE|COPY|PUT|REMOVE|UNDROP)\b/i;

/** Strip leading comments, then report whether a statement changes data or schema. */
export function isModifyingStatement(text: string): boolean {
  let t = text;
  for (;;) {
    const s = t.replace(/^\s+/, "");
    if (s.startsWith("--")) { const nl = s.indexOf("\n"); t = nl < 0 ? "" : s.slice(nl + 1); continue; }
    if (s.startsWith("/*")) { const e = s.indexOf("*/"); t = e < 0 ? "" : s.slice(e + 2); continue; }
    t = s;
    break;
  }
  if (/^WITH\b/i.test(t)) return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(t);
  return MODIFYING.test(t);
}
