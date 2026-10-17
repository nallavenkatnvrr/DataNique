/**
 * Map a database error message back to a location inside the statement that
 * failed, so the editor can underline it (DBeaver / SqlDbx "go to error").
 *
 * Each driver reports positions differently:
 *   Postgres   LINE 2: SELECT * FORM orders      + a caret line under it
 *   Snowflake  syntax error line 1 at position 9 unexpected 'FORM'.
 *   MySQL      ... near 'FORM orders' at line 1
 *   Oracle     ... Error at Line: 3 Column: 7   (SQL*Plus style, when present)
 *   SQL Server Incorrect syntax near 'FORM'.
 *   generic    position: 15  (1-based character offset)
 */

export interface ErrorLocation {
  /** 1-based line within the statement. */
  line?: number;
  /** 0-based column within that line. */
  col?: number;
  /** Text the error points at ("near '...'"). */
  token?: string;
  /** 0-based character offset within the statement. */
  offset?: number;
}

export function parseErrorLocation(message: string): ErrorLocation | null {
  if (!message) return null;
  const loc: ErrorLocation = {};

  // Snowflake: "line 1 at position 9"
  const sf = /\bline (\d+) at position (\d+)/i.exec(message);
  if (sf) {
    loc.line = Number(sf[1]);
    loc.col = Number(sf[2]);
  }

  // Postgres: "LINE 2: <text>\n<spaces>^"
  if (loc.line == null) {
    const pg = /^(LINE (\d+): )(.*)$/m.exec(message);
    if (pg) {
      loc.line = Number(pg[2]);
      const after = message.slice((pg.index ?? 0) + pg[0].length);
      const caretLine = /^\r?\n([ \t]*)\^/.exec(after);
      if (caretLine && !pg[3].startsWith("...")) {
        loc.col = Math.max(0, caretLine[1].length - pg[1].length);
      }
    }
  }

  // Oracle / SQL*Plus style: "Line: 3 Column: 7", "line 3, column 7"
  if (loc.line == null) {
    const ora = /\bline:?\s*(\d+)\s*,?\s*column:?\s*(\d+)/i.exec(message);
    if (ora) {
      loc.line = Number(ora[1]);
      loc.col = Math.max(0, Number(ora[2]) - 1);
    }
  }

  // MySQL: "... at line 3"
  if (loc.line == null) {
    const my = /\bat line (\d+)\b/i.exec(message);
    if (my) loc.line = Number(my[1]);
  }

  // "near 'xyz'" (MySQL, SQL Server, SQLite)
  const near = /\bnear ['"`]([^'"`\n]{1,200})['"`]/i.exec(message) ?? /\bat or near "([^"\n]{1,200})"/i.exec(message);
  if (near && near[1].trim()) loc.token = near[1];
  // Snowflake "unexpected 'FORM'"
  if (!loc.token) {
    const unexpected = /\bunexpected '([^'\n]{1,200})'/i.exec(message);
    if (unexpected && unexpected[1].trim() && unexpected[1] !== "<EOF>") loc.token = unexpected[1];
  }

  if (loc.line == null && loc.token == null) {
    const pos = /\bposition:?\s+(\d+)\b/i.exec(message);
    if (pos) loc.offset = Math.max(0, Number(pos[1]) - 1);
  }

  return loc.line != null || loc.token != null || loc.offset != null ? loc : null;
}

/**
 * Resolve an error inside `stmt` (which starts at `stmtFrom` in the document)
 * to a document range. Falls back to the statement's first line.
 */
export function errorRange(
  message: string,
  stmt: string,
  stmtFrom: number,
): { from: number; to: number } {
  const loc = parseErrorLocation(message);
  const lines = stmt.split("\n");
  const lineStart = (n: number) => {
    let off = 0;
    for (let i = 0; i < n - 1 && i < lines.length; i++) off += lines[i].length + 1;
    return off;
  };
  const wordEnd = (text: string, at: number) => {
    const m = /^[\w$#@."]+|^\S/.exec(text.slice(at));
    return at + (m ? m[0].length : 1);
  };
  const firstLine = () => {
    const l = lines[0] ?? "";
    const lead = l.length - l.trimStart().length;
    return { from: stmtFrom + lead, to: stmtFrom + Math.max(lead + 1, l.trimEnd().length) };
  };

  if (!loc) return firstLine();

  if (loc.offset != null && loc.offset < stmt.length) {
    return { from: stmtFrom + loc.offset, to: stmtFrom + wordEnd(stmt, loc.offset) };
  }

  if (loc.line != null && loc.line >= 1 && loc.line <= lines.length) {
    const ls = lineStart(loc.line);
    const text = lines[loc.line - 1];
    if (loc.col != null && loc.col < text.length) {
      return { from: stmtFrom + ls + loc.col, to: stmtFrom + ls + wordEnd(text, loc.col) };
    }
    if (loc.token) {
      const i = text.toLowerCase().indexOf(loc.token.toLowerCase());
      if (i >= 0) return { from: stmtFrom + ls + i, to: stmtFrom + ls + i + loc.token.length };
    }
    const lead = text.length - text.trimStart().length;
    return { from: stmtFrom + ls + lead, to: stmtFrom + ls + Math.max(lead + 1, text.trimEnd().length) };
  }

  if (loc.token) {
    const i = stmt.toLowerCase().indexOf(loc.token.toLowerCase());
    if (i >= 0) return { from: stmtFrom + i, to: stmtFrom + i + loc.token.length };
  }
  return firstLine();
}
