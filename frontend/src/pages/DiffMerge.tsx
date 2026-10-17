import * as React from "react";
import { toast } from "sonner";
import {
  Download, Trash2, ArrowRight, ArrowLeft, ArrowDown, ArrowUp,
  FileUp, RotateCcw,
  ChevronsRight, ChevronsLeft, Diff, ArrowLeftRight, Search, X,
  Code2, Columns2, Rows, Filter, FileText, Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiffLine =
  | { type: "equal"; left: string; right: string; leftNum: number; rightNum: number }
  | { type: "delete"; left: string; leftNum: number }
  | { type: "insert"; right: string; rightNum: number }
  | { type: "modify"; left: string; right: string; leftNum: number; rightNum: number };

interface Hunk {
  id: number;
  startLine: number;
  lines: DiffLine[];
}

interface CharSpan { text: string; changed: boolean }

// ---------------------------------------------------------------------------
// LCS diff algorithm
// ---------------------------------------------------------------------------

const MAX_LINE_LCS_CELLS = 8_000_000;
const MAX_WORD_LCS_CELLS = 1_000_000;

function exceedsLcsCellBudget(leftLength: number, rightLength: number, maxCells: number): boolean {
  const rows = leftLength + 1;
  const columns = rightLength + 1;
  return rows > maxCells || columns > Math.floor(maxCells / rows);
}

function computeDiff(leftText: string, rightText: string): DiffLine[] {
  const leftLines = leftText.split("\n");
  const rightLines = rightText.split("\n");
  const n = leftLines.length;
  const m = rightLines.length;

  if (exceedsLcsCellBudget(n, m, MAX_LINE_LCS_CELLS)) return simpleDiff(leftLines, rightLines);

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const rowOffset = i * width;
    const previousRowOffset = rowOffset - width;
    for (let j = 1; j <= m; j++) {
      const index = rowOffset + j;
      dp[index] = leftLines[i - 1] === rightLines[j - 1]
        ? dp[previousRowOffset + j - 1] + 1
        : Math.max(dp[previousRowOffset + j], dp[rowOffset + j - 1]);
    }
  }

  let i = n, j = m;
  const stack: DiffLine[] = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && leftLines[i - 1] === rightLines[j - 1]) {
      stack.push({ type: "equal", left: leftLines[i - 1], right: rightLines[j - 1], leftNum: i, rightNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i * width + j - 1] >= dp[(i - 1) * width + j])) {
      stack.push({ type: "insert", right: rightLines[j - 1], rightNum: j });
      j--;
    } else {
      stack.push({ type: "delete", left: leftLines[i - 1], leftNum: i });
      i--;
    }
  }
  stack.reverse();

  const result: DiffLine[] = [];
  let k = 0;
  while (k < stack.length) {
    const cur = stack[k];
    const next = stack[k + 1];
    if (cur.type === "delete" && next?.type === "insert") {
      result.push({ type: "modify", left: cur.left, right: next.right, leftNum: cur.leftNum, rightNum: next.rightNum });
      k += 2;
    } else { result.push(cur); k++; }
  }
  return result;
}

function simpleDiff(leftLines: string[], rightLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  const max = Math.max(leftLines.length, rightLines.length);
  for (let i = 0; i < max; i++) {
    const l = i < leftLines.length ? leftLines[i] : undefined;
    const r = i < rightLines.length ? rightLines[i] : undefined;
    if (l !== undefined && r !== undefined) {
      if (l === r) result.push({ type: "equal", left: l, right: r, leftNum: i + 1, rightNum: i + 1 });
      else result.push({ type: "modify", left: l, right: r, leftNum: i + 1, rightNum: i + 1 });
    } else if (l !== undefined) {
      result.push({ type: "delete", left: l, leftNum: i + 1 });
    } else if (r !== undefined) {
      result.push({ type: "insert", right: r, rightNum: i + 1 });
    }
  }
  return result;
}

function groupIntoHunks(diff: DiffLine[], context: number = 3): Hunk[] {
  const hunks: Hunk[] = [];
  let hunkId = 0;
  let currentHunk: DiffLine[] = [];
  let hunkStart = -1;
  let trailingContext = 0;

  for (let i = 0; i < diff.length; i++) {
    const line = diff[i];
    if (line.type !== "equal") {
      if (currentHunk.length === 0) {
        const start = Math.max(0, i - context);
        hunkStart = start;
        for (let c = start; c < i; c++) currentHunk.push(diff[c]);
      }
      currentHunk.push(line);
      trailingContext = 0;
    } else if (currentHunk.length > 0) {
      trailingContext++;
      currentHunk.push(line);
      if (trailingContext >= context * 2) {
        const trimmed = currentHunk.slice(0, currentHunk.length - (trailingContext - context));
        hunks.push({ id: hunkId++, startLine: hunkStart, lines: trimmed });
        currentHunk = [];
        hunkStart = -1;
        trailingContext = 0;
      }
    }
  }
  if (currentHunk.length > 0) {
    while (currentHunk.length > 0 && currentHunk[currentHunk.length - 1].type === "equal") {
      if (trailingContext > context) { currentHunk.pop(); trailingContext--; } else break;
    }
    hunks.push({ id: hunkId++, startLine: hunkStart, lines: currentHunk });
  }
  return hunks;
}

// ---------------------------------------------------------------------------
// Word-level char diff
// ---------------------------------------------------------------------------

function wordDiff(a: string, b: string): { left: CharSpan[]; right: CharSpan[] } {
  const aWords = tokenize(a);
  const bWords = tokenize(b);
  const n = aWords.length, m = bWords.length;
  if (exceedsLcsCellBudget(n, m, MAX_WORD_LCS_CELLS)) return prefixSuffixDiff(a, b);

  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const rowOffset = i * width;
    const previousRowOffset = rowOffset - width;
    for (let j = 1; j <= m; j++) {
      const index = rowOffset + j;
      dp[index] = aWords[i - 1] === bWords[j - 1]
        ? dp[previousRowOffset + j - 1] + 1
        : Math.max(dp[previousRowOffset + j], dp[rowOffset + j - 1]);
    }
  }

  const ops: { type: "eq" | "del" | "ins"; text: string }[] = [];
  let ii = n, jj = m;
  while (ii > 0 || jj > 0) {
    if (ii > 0 && jj > 0 && aWords[ii - 1] === bWords[jj - 1]) {
      ops.push({ type: "eq", text: aWords[ii - 1] }); ii--; jj--;
    } else if (jj > 0 && (ii === 0 || dp[ii * width + jj - 1] >= dp[(ii - 1) * width + jj])) {
      ops.push({ type: "ins", text: bWords[jj - 1] }); jj--;
    } else {
      ops.push({ type: "del", text: aWords[ii - 1] }); ii--;
    }
  }
  ops.reverse();

  const left: CharSpan[] = [], right: CharSpan[] = [];
  let lBuf = "", rBuf = "", lChanged = false, rChanged = false;
  function flushL() { if (lBuf) { left.push({ text: lBuf, changed: lChanged }); lBuf = ""; } }
  function flushR() { if (rBuf) { right.push({ text: rBuf, changed: rChanged }); rBuf = ""; } }

  for (const op of ops) {
    if (op.type === "eq") {
      if (lChanged) flushL();
      if (rChanged) flushR();
      lChanged = false; rChanged = false;
      lBuf += op.text; rBuf += op.text;
    } else if (op.type === "del") {
      if (!lChanged) flushL();
      lChanged = true; lBuf += op.text;
    } else {
      if (!rChanged) flushR();
      rChanged = true; rBuf += op.text;
    }
  }
  flushL(); flushR();
  if (left.length === 0) left.push({ text: "", changed: false });
  if (right.length === 0) right.push({ text: "", changed: false });
  return { left, right };
}

function tokenize(s: string): string[] {
  return s.match(/\S+|\s+/g) || [];
}

function prefixSuffixDiff(a: string, b: string): { left: CharSpan[]; right: CharSpan[] } {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const left: CharSpan[] = [], right: CharSpan[] = [];
  if (prefix > 0) { left.push({ text: a.slice(0, prefix), changed: false }); right.push({ text: b.slice(0, prefix), changed: false }); }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA) left.push({ text: midA, changed: true });
  if (midB) right.push({ text: midB, changed: true });
  if (suffix > 0) { left.push({ text: a.slice(a.length - suffix), changed: false }); right.push({ text: b.slice(b.length - suffix), changed: false }); }
  if (left.length === 0) left.push({ text: "", changed: false });
  if (right.length === 0) right.push({ text: "", changed: false });
  return { left, right };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsText(file);
  });
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderWhitespace(text: string): React.ReactNode {
  if (!text) return text;
  // Show tabs as → and trailing spaces as ·
  const replaced = text.replace(/\t/g, "→   ");
  const trailing = replaced.length - replaced.trimEnd().length;
  if (trailing === 0) return replaced;
  return (
    <>
      {replaced.trimEnd()}
      <span className="text-amber-400/60" title={`${trailing} trailing space(s)`}>{"·".repeat(trailing)}</span>
    </>
  );
}

// ---------------------------------------------------------------------------
// SQL-aware helpers
// ---------------------------------------------------------------------------

/** Strip SQL comments: line comments starting with two dashes, and
 *  block comments delimited by slash-star ... star-slash. Newlines
 *  are preserved so line numbers stay aligned with the original.
 *  String literals are left alone - we don't strip comments inside quotes. */
function stripSqlComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    // String literal: single or double quotes
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += ch; i++;
      while (i < n) {
        const c = text[i];
        out += c;
        if (c === "\\" && i + 1 < n) { out += text[i + 1]; i += 2; continue; }
        if (c === q) { i++; break; }
        i++;
      }
      continue;
    }
    // Line comment: -- ...
    if (ch === "-" && next === "-") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n) {
        if (text[i] === "*" && text[i + 1] === "/") { i += 2; break; }
        if (text[i] === "\n") out += "\n"; // preserve newlines inside block comments
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** SQL reserved keywords (subset - covers the common ones used in dialect-agnostic SQL). */
const SQL_KEYWORDS = new Set([
  "SELECT","FROM","WHERE","AND","OR","NOT","IN","IS","NULL","LIKE","BETWEEN",
  "INSERT","INTO","VALUES","UPDATE","SET","DELETE","CREATE","TABLE","VIEW",
  "PROCEDURE","FUNCTION","TRIGGER","INDEX","SEQUENCE","SCHEMA","DATABASE",
  "DROP","ALTER","ADD","COLUMN","CONSTRAINT","PRIMARY","KEY","FOREIGN",
  "REFERENCES","UNIQUE","CHECK","DEFAULT","CASCADE","RESTRICT","ON","AS",
  "JOIN","INNER","OUTER","LEFT","RIGHT","FULL","CROSS","NATURAL","USING",
  "GROUP","BY","HAVING","ORDER","ASC","DESC","LIMIT","OFFSET","FETCH","FIRST",
  "ROWS","ONLY","DISTINCT","ALL","UNION","INTERSECT","EXCEPT","MINUS",
  "CASE","WHEN","THEN","ELSE","END","IF","BEGIN","COMMIT","ROLLBACK",
  "WITH","RECURSIVE","WINDOW","PARTITION","OVER","RANGE","UNBOUNDED","PRECEDING",
  "FOLLOWING","CURRENT","ROW","TRUE","FALSE","EXISTS","ANY","SOME",
  "GRANT","REVOKE","TO","USAGE","REPLACE","OF","EACH","STATEMENT","DECLARE",
  "RETURN","RETURNS","CALL","EXECUTE","TRUNCATE","MERGE","USING","MATCHED",
]);

/** Normalize SQL keywords to upper-case while leaving identifiers and
 *  literals unchanged. Preserves whitespace and line breaks. */
function normalizeSqlKeywords(text: string): string {
  return text.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
    const upper = word.toUpperCase();
    return SQL_KEYWORDS.has(upper) ? upper : word;
  });
}

/** Strip blank lines (consisting only of whitespace) - returns the same
 *  text without those lines. Affects line numbering on purpose. */
function stripBlankLines(text: string): string {
  return text.split("\n").filter((ln) => ln.trim().length > 0).join("\n");
}

/** Generate a unified diff patch in standard format (compatible with
 *  GNU diff / git apply). Includes 3 lines of context around each hunk. */
function generateUnifiedDiff(
  leftName: string, rightName: string,
  diff: DiffLine[],
  context: number = 3,
): string {
  if (!diff.length) return "";
  const header = `--- ${leftName}\n+++ ${rightName}\n`;
  const hunks = groupIntoHunks(diff, context);
  if (!hunks.length) return header;
  const parts: string[] = [header];
  for (const h of hunks) {
    // Compute hunk header @@ -srcStart,srcLen +tgtStart,tgtLen @@
    let srcStart = 0, srcLen = 0, tgtStart = 0, tgtLen = 0;
    const lines: string[] = [];
    for (const ln of h.lines) {
      if (ln.type === "equal") {
        if (!srcStart) srcStart = ln.leftNum;
        if (!tgtStart) tgtStart = ln.rightNum;
        srcLen++; tgtLen++;
        lines.push(" " + ln.left);
      } else if (ln.type === "delete") {
        if (!srcStart) srcStart = ln.leftNum;
        if (!tgtStart) tgtStart = (h.lines.find((x) => "rightNum" in x) as any)?.rightNum || 1;
        srcLen++;
        lines.push("-" + ln.left);
      } else if (ln.type === "insert") {
        if (!srcStart) srcStart = (h.lines.find((x) => "leftNum" in x) as any)?.leftNum || 1;
        if (!tgtStart) tgtStart = ln.rightNum;
        tgtLen++;
        lines.push("+" + ln.right);
      } else if (ln.type === "modify") {
        if (!srcStart) srcStart = ln.leftNum;
        if (!tgtStart) tgtStart = ln.rightNum;
        srcLen++; tgtLen++;
        lines.push("-" + ln.left);
        lines.push("+" + ln.right);
      }
    }
    parts.push(`@@ -${srcStart || 1},${srcLen} +${tgtStart || 1},${tgtLen} @@\n`);
    parts.push(lines.join("\n") + "\n");
  }
  return parts.join("");
}

/** Generate a self-contained HTML diff report for sharing / archiving. */
function generateHtmlReport(
  leftName: string, rightName: string,
  diff: DiffLine[],
  stats: { added: number; deleted: number; modified: number; equal: number },
  similarity: number,
  approximate: boolean,
): string {
  const rows = diff.map((ln) => {
    const l = "left" in ln ? ln.left : "";
    const r = "right" in ln ? ln.right : "";
    const lnNum = "leftNum" in ln ? ln.leftNum : "";
    const rnNum = "rightNum" in ln ? ln.rightNum : "";
    const cls = ln.type === "delete" ? "del" : ln.type === "insert" ? "ins"
              : ln.type === "modify" ? "mod" : "eq";
    const escape = (s: string) => s
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<tr class="${cls}"><td class="num">${lnNum}</td><td>${escape(l)}</td><td class="num">${rnNum}</td><td>${escape(r)}</td></tr>`;
  }).join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Diff: ${escapeHtml(leftName)} vs ${escapeHtml(rightName)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f9fafb}
h1{margin:0 0 8px;font-size:18px}
.meta{color:#6b7280;font-size:12px;margin-bottom:12px}
.notice{color:#92400e;background:#fef3c7;padding:8px;margin-bottom:12px;font-size:12px}
.stats{display:flex;gap:8px;margin-bottom:12px}
.stats span{padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600}
.stats .a{background:#dcfce7;color:#166534}
.stats .d{background:#fee2e2;color:#991b1b}
.stats .m{background:#fef3c7;color:#92400e}
.stats .s{background:#e5e7eb;color:#374151}
table{width:100%;border-collapse:collapse;font-family:Consolas,Monaco,monospace;font-size:12px;background:white}
td{padding:2px 8px;vertical-align:top;border-bottom:1px solid #f3f4f6;white-space:pre-wrap;word-break:break-all}
td.num{width:40px;text-align:right;color:#9ca3af;background:#f3f4f6;user-select:none}
tr.del td{background:#fef2f2}
tr.ins td{background:#f0fdf4}
tr.mod td{background:#fffbeb}
</style></head><body>
<h1>Diff &amp; Merge Report</h1>
<div class="meta">${escapeHtml(leftName)} (left) vs ${escapeHtml(rightName)} (right)</div>
${approximate ? '<div class="notice">A positional fallback was used because the inputs exceeded the exact LCS memory budget; review this diff manually.</div>' : ""}
<div class="stats">
  <span class="a">+${stats.added}</span>
  <span class="d">-${stats.deleted}</span>
  <span class="m">~${stats.modified}</span>
  <span class="s">${similarity}% similar</span>
</div>
<table><tbody>${rows}</tbody></table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// SQL IDE tab loader (reads from localStorage so the user can compare
// against any script they have open in the IDE - no copy-paste needed)
// ---------------------------------------------------------------------------

interface IdeScript { id: string; name: string; sql: string }

function loadIdeScripts(): IdeScript[] {
  try {
    const raw = localStorage.getItem("dv-sql-ide-tabs");
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((d: any) => d && typeof d.sql === "string" && d.sql.trim())
      .map((d: any) => ({ id: String(d.id || ""), name: String(d.name || "Script"), sql: d.sql }));
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type ViewMode = "split" | "unified";
type ChangeFilter = "all" | "add" | "del" | "mod";

export function DiffMergePage() {
  const [leftText, setLeftText] = React.useState("");
  const [rightText, setRightText] = React.useState("");
  const [leftName, setLeftName] = React.useState("Left");
  const [rightName, setRightName] = React.useState("Right");
  const [diff, setDiff] = React.useState<DiffLine[] | null>(null);
  const [approximateDiff, setApproximateDiff] = React.useState(false);
  const [hunks, setHunks] = React.useState<Hunk[]>([]);
  const [mergedLeft, setMergedLeft] = React.useState<string[]>([]);
  const [mergedRight, setMergedRight] = React.useState<string[]>([]);
  const [showUnchanged, setShowUnchanged] = React.useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = React.useState(false);
  const [ignoreCase, setIgnoreCase] = React.useState(false);
  // Phase 4.44: SQL-aware comparison options
  const [ignoreSqlComments, setIgnoreSqlComments] = React.useState(false);
  const [ignoreBlankLines, setIgnoreBlankLines] = React.useState(false);
  const [normalizeSqlKw, setNormalizeSqlKw] = React.useState(false);
  // View mode + change-type filter
  const [viewMode, setViewMode] = React.useState<ViewMode>("split");
  const [changeFilter, setChangeFilter] = React.useState<ChangeFilter>("all");
  // IDE script picker dropdown
  const [idePickerOpen, setIdePickerOpen] = React.useState<"left" | "right" | null>(null);
  const [ideScripts, setIdeScripts] = React.useState<IdeScript[]>([]);
  // Export menu
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);

  const [stats, setStats] = React.useState({ added: 0, deleted: 0, modified: 0, equal: 0 });
  const [currentHunkIdx, setCurrentHunkIdx] = React.useState(-1);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchHits, setSearchHits] = React.useState<number[]>([]);
  const [searchHitIdx, setSearchHitIdx] = React.useState(-1);
  const diffScrollRef = React.useRef<HTMLDivElement>(null);

  // Refresh IDE scripts list whenever the picker is opened
  React.useEffect(() => {
    if (idePickerOpen) setIdeScripts(loadIdeScripts());
  }, [idePickerOpen]);

  // ---- Diff computation ----
  function runDiff() {
    const l = leftText, r = rightText;
    const anyNorm = ignoreWhitespace || ignoreCase || ignoreSqlComments
                 || ignoreBlankLines || normalizeSqlKw;

    if (!anyNorm) {
      const leftLines = l.split("\n");
      const rightLines = r.split("\n");
      setApproximateDiff(exceedsLcsCellBudget(leftLines.length, rightLines.length, MAX_LINE_LCS_CELLS));
      const d = computeDiff(l, r);
      setDiff(d); setHunks(groupIntoHunks(d)); updateStats(d);
      setMergedLeft(l.split("\n"));
      setMergedRight(r.split("\n"));
      setCurrentHunkIdx(-1);
      setSearchQuery(""); setSearchHits([]); setSearchHitIdx(-1);
      return;
    }

    // Normalize each side. We must keep a mapping from normalized-line
    // index back to the original line index so the diff display still
    // shows original text. The normalizer can DROP lines (when
    // ignoreBlankLines is on), so we track a parallel index array.
    const normalize = (s: string): { lines: string[]; origIdx: number[] } => {
      let text = s;
      if (ignoreSqlComments) text = stripSqlComments(text);
      if (normalizeSqlKw) text = normalizeSqlKeywords(text);
      const rawLines = text.split("\n");
      const outLines: string[] = [];
      const idx: number[] = [];
      for (let i = 0; i < rawLines.length; i++) {
        let ln = rawLines[i];
        if (ignoreWhitespace) ln = ln.replace(/\s+/g, " ").trim();
        if (ignoreCase) ln = ln.toLowerCase();
        if (ignoreBlankLines && ln.trim().length === 0) continue;
        outLines.push(ln);
        idx.push(i);
      }
      return { lines: outLines, origIdx: idx };
    };

    const ln = normalize(l);
    const rn = normalize(r);
    setApproximateDiff(exceedsLcsCellBudget(ln.lines.length, rn.lines.length, MAX_LINE_LCS_CELLS));
    const d = computeDiff(ln.lines.join("\n"), rn.lines.join("\n"));

    // Re-map line numbers and re-attach ORIGINAL text from the un-normalized
    // sources, so the side-by-side display shows what the user actually
    // wrote (including comments / case / whitespace), while the diff
    // structure reflects the normalized comparison.
    const origL = l.split("\n");
    const origR = r.split("\n");
    for (const line of d) {
      if ("leftNum" in line && line.leftNum) {
        const origIdx0 = ln.origIdx[line.leftNum - 1];
        if (origIdx0 !== undefined) {
          line.leftNum = origIdx0 + 1;
          (line as any).left = origL[origIdx0] ?? (line as any).left;
        }
      }
      if ("rightNum" in line && line.rightNum) {
        const origIdx0 = rn.origIdx[line.rightNum - 1];
        if (origIdx0 !== undefined) {
          line.rightNum = origIdx0 + 1;
          (line as any).right = origR[origIdx0] ?? (line as any).right;
        }
      }
    }
    setDiff(d); setHunks(groupIntoHunks(d)); updateStats(d);
    setMergedLeft(l.split("\n"));
    setMergedRight(r.split("\n"));
    setCurrentHunkIdx(-1);
    setSearchQuery(""); setSearchHits([]); setSearchHitIdx(-1);
  }

  function loadFromIde(side: "left" | "right", script: IdeScript) {
    if (side === "left") { setLeftText(script.sql); setLeftName(script.name); }
    else { setRightText(script.sql); setRightName(script.name); }
    setIdePickerOpen(null);
    toast.success(`Loaded ${script.name} from SQL IDE`);
  }

  function exportUnifiedPatch() {
    if (!diff) return;
    const patch = generateUnifiedDiff(leftName, rightName, diff);
    downloadText(patch, `${leftName}_vs_${rightName}.patch`);
    setExportMenuOpen(false);
    toast.success("Patch exported");
  }

  function exportHtmlReport() {
    if (!diff) return;
    const html = generateHtmlReport(leftName, rightName, diff, stats, similarity, approximateDiff);
    downloadText(html, `${leftName}_vs_${rightName}.html`);
    setExportMenuOpen(false);
    toast.success("HTML report exported");
  }

  function updateStats(d: DiffLine[]) {
    let added = 0, deleted = 0, modified = 0, equal = 0;
    for (const line of d) {
      if (line.type === "equal") equal++;
      else if (line.type === "insert") added++;
      else if (line.type === "delete") deleted++;
      else modified++;
    }
    setStats({ added, deleted, modified, equal });
  }

  const similarity = React.useMemo(() => {
    const total = stats.added + stats.deleted + stats.modified + stats.equal;
    return total > 0 ? Math.round((stats.equal / total) * 100) : 100;
  }, [stats]);

  // ---- File loading (button + drag-and-drop) ----
  function loadFile(side: "left" | "right") {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await readFileAsText(file);
      if (side === "left") { setLeftText(text); setLeftName(file.name); }
      else { setRightText(text); setRightName(file.name); }
      toast.success(`Loaded ${file.name}`);
    };
    input.click();
  }

  function handleDrop(e: React.DragEvent, side: "left" | "right") {
    e.preventDefault(); e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    readFileAsText(file).then((text) => {
      if (side === "left") { setLeftText(text); setLeftName(file.name); }
      else { setRightText(text); setRightName(file.name); }
      toast.success(`Loaded ${file.name}`);
    });
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); }

  // ---- Swap sides ----
  // Re-run the diff after state changes have rendered (swap / accept):
  // calling runDiff() directly would read the previous texts.
  const [rediffTick, setRediffTick] = React.useState(0);
  React.useEffect(() => {
    if (rediffTick) runDiff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rediffTick]);

  function swapSides() {
    setLeftText(rightText); setRightText(leftText);
    setLeftName(rightName); setRightName(leftName);
    if (diff) setRediffTick((t) => t + 1);
  }

  /** Rebuild one side from the whole diff, taking ``hunk`` from the other
   *  side. Works on the diff lines themselves, so line numbers never drift. */
  function rebuild(target: "left" | "right", hunk: Hunk): string[] {
    const inHunk = new Set<DiffLine>(hunk.lines);
    const out: string[] = [];
    for (const line of diff ?? []) {
      const takeLeft = inHunk.has(line) ? target === "right" : target === "left";
      if (takeLeft) {
        if (line.type === "equal" || line.type === "delete" || line.type === "modify") out.push(line.left);
      } else if (line.type === "equal" || line.type === "insert" || line.type === "modify") {
        out.push(line.right);
      }
    }
    return out;
  }

  // ---- Merge helpers ----
  function acceptHunkLeft(hunk: Hunk) {
    if (ignoreBlankLines) toast.warning("Blank lines hidden by “ignore blank lines” are not kept in the merged text");
    const merged = rebuild("right", hunk);
    setMergedRight(merged); setRightText(merged.join("\n"));
    setRediffTick((t) => t + 1);
    toast.success("Accepted left → right");
  }

  function acceptHunkRight(hunk: Hunk) {
    if (ignoreBlankLines) toast.warning("Blank lines hidden by “ignore blank lines” are not kept in the merged text");
    const merged = rebuild("left", hunk);
    setMergedLeft(merged); setLeftText(merged.join("\n"));
    setRediffTick((t) => t + 1);
    toast.success("Accepted right → left");
  }

  // ---- Navigation: prev/next diff hunk ----
  function goToHunk(idx: number) {
    if (!hunks.length || idx < 0 || idx >= hunks.length) return;
    setCurrentHunkIdx(idx);
    const hunk = hunks[idx];
    const firstChangedLine = hunk.lines.find(l => l.type !== "equal");
    if (firstChangedLine) {
      const rowId = `diff-row-${"leftNum" in firstChangedLine ? firstChangedLine.leftNum : ""}-${"rightNum" in firstChangedLine ? firstChangedLine.rightNum : ""}`;
      document.getElementById(rowId)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function nextDiff() { goToHunk(Math.min(currentHunkIdx + 1, hunks.length - 1)); }
  function prevDiff() { goToHunk(Math.max(currentHunkIdx - 1, 0)); }

  // ---- Search within diff ----
  function runSearch(query: string) {
    setSearchQuery(query);
    if (!query.trim() || !diff) { setSearchHits([]); setSearchHitIdx(-1); return; }
    const q = query.toLowerCase();
    const hits: number[] = [];
    diff.forEach((line, i) => {
      const l = ("left" in line ? line.left : "").toLowerCase();
      const r = ("right" in line ? line.right : "").toLowerCase();
      if (l.includes(q) || r.includes(q)) hits.push(i);
    });
    setSearchHits(hits);
    setSearchHitIdx(hits.length > 0 ? 0 : -1);
    if (hits.length > 0) scrollToSearchHit(hits, 0);
  }

  function scrollToSearchHit(hits: number[], idx: number) {
    if (idx < 0 || idx >= hits.length || !diff) return;
    const line = diff[hits[idx]];
    const rowId = `diff-row-${"leftNum" in line ? line.leftNum : ""}-${"rightNum" in line ? line.rightNum : ""}`;
    document.getElementById(rowId)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function nextSearchHit() {
    if (!searchHits.length) return;
    const next = (searchHitIdx + 1) % searchHits.length;
    setSearchHitIdx(next);
    scrollToSearchHit(searchHits, next);
  }

  function prevSearchHit() {
    if (!searchHits.length) return;
    const prev = (searchHitIdx - 1 + searchHits.length) % searchHits.length;
    setSearchHitIdx(prev);
    scrollToSearchHit(searchHits, prev);
  }

  // ---- Keyboard shortcuts ----
  React.useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (!diff) return;
      if (e.key === "F7" && !e.shiftKey) { e.preventDefault(); nextDiff(); }
      if (e.key === "F7" && e.shiftKey) { e.preventDefault(); prevDiff(); }
      if ((e.ctrlKey || e.metaKey) && e.key === "f" && diff) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });

  // ---- Display lines (hunks or all, filtered by change type) ----
  const displayLines = React.useMemo(() => {
    if (!diff) return [];
    const filterFn = (l: DiffLine): boolean => {
      if (changeFilter === "all") return true;
      if (changeFilter === "add") return l.type === "insert";
      if (changeFilter === "del") return l.type === "delete";
      if (changeFilter === "mod") return l.type === "modify";
      return true;
    };
    // When filtering by a specific change type, ignore hunk-context and
    // show exactly the matching rows (no separators - they don't add
    // info when we're already filtering).
    if (changeFilter !== "all") {
      return diff.filter(filterFn);
    }
    if (showUnchanged) return diff;
    const hunkLineSet = new Set<number>();
    for (const h of hunks) {
      for (const l of h.lines) {
        const idx = diff.indexOf(l);
        if (idx >= 0) hunkLineSet.add(idx);
      }
    }
    const result: (DiffLine | { type: "separator" })[] = [];
    let lastIdx = -1;
    for (const idx of Array.from(hunkLineSet).sort((a, b) => a - b)) {
      if (lastIdx >= 0 && idx > lastIdx + 1) result.push({ type: "separator" } as any);
      result.push(diff[idx]);
      lastIdx = idx;
    }
    return result;
  }, [diff, hunks, showUnchanged, changeFilter]);

  // ---- Minimap data ----
  const minimapData = React.useMemo(() => {
    if (!diff) return [];
    return diff.map(l => l.type);
  }, [diff]);

  // ---- Copy hunk to clipboard ----
  function copyHunk(hunk: Hunk, side: "left" | "right") {
    const lines = hunk.lines
      .map(l => side === "left" ? ("left" in l ? l.left : "") : ("right" in l ? l.right : ""))
      .join("\n");
    navigator.clipboard?.writeText(lines).then(() =>
      toast.success(`Copied ${side} side of hunk (${hunk.lines.length} lines)`, { duration: 1500 }),
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] overflow-hidden">
      {/* ========== TOOLBAR ========== */}
      <div className="border-b px-2 py-1.5 flex items-center gap-1.5 shrink-0 flex-wrap bg-muted/30">
        <Diff className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm mr-1">Diff &amp; Merge</span>

        {/* Load: File or IDE script for each side */}
        <LoadButtonGroup
          side="left"
          loadFile={loadFile}
          openIdePicker={() => setIdePickerOpen("left")}
          ideOpen={idePickerOpen === "left"}
          ideScripts={ideScripts}
          onPick={(s) => loadFromIde("left", s)}
          onClose={() => setIdePickerOpen(null)}
        />
        <LoadButtonGroup
          side="right"
          loadFile={loadFile}
          openIdePicker={() => setIdePickerOpen("right")}
          ideOpen={idePickerOpen === "right"}
          ideScripts={ideScripts}
          onPick={(s) => loadFromIde("right", s)}
          onClose={() => setIdePickerOpen(null)}
        />
        <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5" onClick={swapSides} title="Swap left ↔ right">
          <ArrowLeftRight className="h-3.5 w-3.5" />
        </Button>

        <div className="h-4 border-l mx-0.5" />

        <Button size="sm" className="h-7 text-xs" onClick={runDiff} disabled={!leftText && !rightText}>
          <Diff className="h-3 w-3 mr-1" /> Compare
        </Button>

        {diff && (
          <>
            {/* View mode toggle */}
            <div className="h-4 border-l mx-0.5" />
            <div className="flex border rounded overflow-hidden h-7 bg-background">
              <button
                onClick={() => setViewMode("split")}
                className={cn(
                  "text-[11px] px-2 flex items-center gap-1 transition-colors",
                  viewMode === "split" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
                title="Side-by-side view"
              >
                <Columns2 className="h-3 w-3" /> Split
              </button>
              <button
                onClick={() => setViewMode("unified")}
                className={cn(
                  "text-[11px] px-2 flex items-center gap-1 border-l transition-colors",
                  viewMode === "unified" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
                title="Unified (git-style) view"
              >
                <Rows className="h-3 w-3" /> Unified
              </button>
            </div>

            {/* Hunk navigation */}
            <div className="h-4 border-l mx-0.5" />
            <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5" onClick={prevDiff} title="Previous diff (Shift+F7)">
              <ArrowUp className="h-3 w-3" />
            </Button>
            <span className="text-[10px] text-muted-foreground tabular-nums w-12 text-center">
              {currentHunkIdx >= 0 ? currentHunkIdx + 1 : "-"}/{hunks.length}
            </span>
            <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5" onClick={nextDiff} title="Next diff (F7)">
              <ArrowDown className="h-3 w-3" />
            </Button>

            {/* Change-type filter */}
            <div className="h-4 border-l mx-0.5" />
            <div className="flex items-center gap-0.5 border rounded h-7 px-1 bg-background" title="Filter rows by change type">
              <Filter className="h-3 w-3 text-muted-foreground mr-0.5" />
              <FilterChip active={changeFilter === "all"} onClick={() => setChangeFilter("all")} color="muted">All</FilterChip>
              <FilterChip active={changeFilter === "add"} onClick={() => setChangeFilter("add")} color="green">+{stats.added}</FilterChip>
              <FilterChip active={changeFilter === "del"} onClick={() => setChangeFilter("del")} color="red">−{stats.deleted}</FilterChip>
              <FilterChip active={changeFilter === "mod"} onClick={() => setChangeFilter("mod")} color="amber">~{stats.modified}</FilterChip>
            </div>

            {/* Merge actions */}
            <div className="h-4 border-l mx-0.5" />
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setRightText(leftText); setMergedRight(leftText.split("\n")); toast.success("All L→R"); }} title="Copy all left → right">
              <ChevronsRight className="h-3 w-3 mr-0.5" /> L→R
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setLeftText(rightText); setMergedLeft(rightText.split("\n")); toast.success("All R→L"); }} title="Copy all right → left">
              <ChevronsLeft className="h-3 w-3 mr-0.5" /> R→L
            </Button>

            {/* Export menu + search */}
            <div className="h-4 border-l mx-0.5" />
            <div className="relative">
              <Button
                size="sm" variant="outline" className="h-7 text-xs gap-1 px-2"
                onClick={() => setExportMenuOpen((v) => !v)}
                title="Export merged files or diff report"
              >
                <Download className="h-3 w-3" /> Export
              </Button>
              {exportMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-30 bg-background border rounded shadow-lg text-xs min-w-[220px]"
                  onMouseLeave={() => setExportMenuOpen(false)}
                >
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2 border-b"
                    onClick={() => { downloadText(mergedLeft.join("\n"), `merged_${leftName}`); setExportMenuOpen(false); toast.success("Saved"); }}
                  >
                    <Download className="h-3 w-3" /> Save merged left
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2 border-b"
                    onClick={() => { downloadText(mergedRight.join("\n"), `merged_${rightName}`); setExportMenuOpen(false); toast.success("Saved"); }}
                  >
                    <Download className="h-3 w-3" /> Save merged right
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2 border-b"
                    onClick={exportUnifiedPatch}
                  >
                    <FileText className="h-3 w-3" /> Unified diff patch (.patch)
                  </button>
                  <button
                    className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"
                    onClick={exportHtmlReport}
                  >
                    <Eye className="h-3 w-3" /> HTML diff report
                  </button>
                </div>
              )}
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs px-1.5" onClick={() => setSearchOpen(!searchOpen)} title="Search (Ctrl+F)">
              <Search className="h-3 w-3" />
            </Button>
          </>
        )}

        <div className="ml-auto flex items-center gap-2 text-xs">
          {/* Generic options */}
          <label className="flex items-center gap-1 cursor-pointer" title="Normalize whitespace before comparing">
            <input type="checkbox" checked={ignoreWhitespace} onChange={(e) => setIgnoreWhitespace(e.target.checked)} className="h-3 w-3" />
            Whitespace
          </label>
          <label className="flex items-center gap-1 cursor-pointer" title="Case-insensitive comparison">
            <input type="checkbox" checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)} className="h-3 w-3" />
            Case
          </label>
          <label className="flex items-center gap-1 cursor-pointer" title="Skip lines containing only whitespace">
            <input type="checkbox" checked={ignoreBlankLines} onChange={(e) => setIgnoreBlankLines(e.target.checked)} className="h-3 w-3" />
            Blank lines
          </label>
          {/* SQL-aware options - visually grouped */}
          <div className="flex items-center gap-1 text-[11px] border-l pl-2">
            <Code2 className="h-3 w-3 text-cyan-500" />
            <label className="flex items-center gap-1 cursor-pointer" title="Strip SQL line and block comments (-- and /* */) before comparing">
              <input type="checkbox" checked={ignoreSqlComments} onChange={(e) => setIgnoreSqlComments(e.target.checked)} className="h-3 w-3" />
              Comments
            </label>
            <label className="flex items-center gap-1 cursor-pointer" title="Normalize SQL keywords (SELECT, FROM, etc.) to uppercase">
              <input type="checkbox" checked={normalizeSqlKw} onChange={(e) => setNormalizeSqlKw(e.target.checked)} className="h-3 w-3" />
              Keywords
            </label>
          </div>
          <label className="flex items-center gap-1 cursor-pointer" title="Show all lines including unchanged">
            <input type="checkbox" checked={showUnchanged} onChange={(e) => setShowUnchanged(e.target.checked)} className="h-3 w-3" />
            All lines
          </label>
          {diff && (
            <div className="flex gap-1 text-[10px] items-center">
              <Badge className="bg-green-100 text-green-800 h-4 px-1">+{stats.added}</Badge>
              <Badge className="bg-red-100 text-red-800 h-4 px-1">-{stats.deleted}</Badge>
              <Badge className="bg-amber-100 text-amber-800 h-4 px-1">~{stats.modified}</Badge>
              <span className="text-muted-foreground ml-0.5">{similarity}% similar</span>
              {approximateDiff ? (
                <Badge variant="warning" className="h-4 px-1" title="Large input used a positional fallback instead of exact LCS; review manually">approximate</Badge>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* ========== SEARCH BAR ========== */}
      {searchOpen && diff && (
        <div className="border-b px-3 py-1 flex items-center gap-2 bg-muted/50 shrink-0">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-xs outline-none font-mono"
            placeholder="Search in diff..."
            value={searchQuery}
            onChange={(e) => runSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) nextSearchHit();
              if (e.key === "Enter" && e.shiftKey) prevSearchHit();
              if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); setSearchHits([]); }
            }}
          />
          {searchHits.length > 0 && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {searchHitIdx + 1}/{searchHits.length}
            </span>
          )}
          <Button size="sm" variant="ghost" className="h-5 px-1" onClick={prevSearchHit}><ArrowUp className="h-3 w-3" /></Button>
          <Button size="sm" variant="ghost" className="h-5 px-1" onClick={nextSearchHit}><ArrowDown className="h-3 w-3" /></Button>
          <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => { setSearchOpen(false); setSearchQuery(""); setSearchHits([]); }}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* ========== MAIN CONTENT ========== */}
      {!diff ? (
        <div className="flex-1 flex min-h-0">
          {/* Left input pane */}
          <div
            className="flex-1 flex flex-col border-r min-w-0"
            onDrop={(e) => handleDrop(e, "left")}
            onDragOver={handleDragOver}
          >
            <div className="flex items-center gap-2 px-3 py-1 bg-muted border-b text-xs">
              <span className="font-medium truncate flex-1">{leftName}</span>
              {leftText && <span className="text-muted-foreground">{leftText.split("\n").length} lines</span>}
              <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => { setLeftText(""); setLeftName("Left"); }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <textarea
              className="flex-1 p-3 font-mono text-xs resize-none bg-background focus:outline-none"
              value={leftText}
              onChange={(e) => setLeftText(e.target.value)}
              placeholder={"Paste text here, or drag & drop a file...\n\nSupports any text file: .txt, .csv, .sql, .json, .xml, .py, .log, etc."}
              spellCheck={false}
            />
          </div>
          {/* Center swap button */}
          <div className="flex items-center px-0.5 bg-muted/30">
            <Button size="sm" variant="ghost" className="h-8 w-6 px-0" onClick={swapSides} title="Swap sides">
              <ArrowLeftRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          {/* Right input pane */}
          <div
            className="flex-1 flex flex-col min-w-0"
            onDrop={(e) => handleDrop(e, "right")}
            onDragOver={handleDragOver}
          >
            <div className="flex items-center gap-2 px-3 py-1 bg-muted border-b text-xs">
              <span className="font-medium truncate flex-1">{rightName}</span>
              {rightText && <span className="text-muted-foreground">{rightText.split("\n").length} lines</span>}
              <Button size="sm" variant="ghost" className="h-5 px-1" onClick={() => { setRightText(""); setRightName("Right"); }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <textarea
              className="flex-1 p-3 font-mono text-xs resize-none bg-background focus:outline-none"
              value={rightText}
              onChange={(e) => setRightText(e.target.value)}
              placeholder={"Paste text here, or drag & drop a file...\n\nSupports any text file: .txt, .csv, .sql, .json, .xml, .py, .log, etc."}
              spellCheck={false}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {/* Diff content */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Column headers - same for both views, layout differs */}
            {viewMode === "split" ? (
              <div className="flex items-center border-b text-xs shrink-0">
                <div className="flex-1 px-3 py-1 bg-red-50/50 font-medium truncate border-r flex items-center gap-1">
                  <span className="truncate">{leftName}</span>
                  <span className="text-muted-foreground ml-auto shrink-0">{mergedLeft.length} lines</span>
                </div>
                <div className="flex-1 px-3 py-1 bg-green-50/50 font-medium truncate flex items-center gap-1">
                  <span className="truncate">{rightName}</span>
                  <span className="text-muted-foreground ml-auto shrink-0">{mergedRight.length} lines</span>
                </div>
              </div>
            ) : (
              <div className="flex items-center border-b text-xs shrink-0 px-3 py-1 bg-muted/50 gap-3">
                <span className="font-medium">Unified diff</span>
                <span className="text-red-600 font-mono">- {leftName}</span>
                <span className="text-green-600 font-mono">+ {rightName}</span>
                <span className="text-muted-foreground ml-auto">
                  {mergedLeft.length} → {mergedRight.length} lines
                </span>
              </div>
            )}
            {/* Scrollable diff */}
            <div ref={diffScrollRef} className="flex-1 overflow-auto scrollbar-thin">
              {viewMode === "split" ? (
                <table className="w-full text-xs font-mono border-collapse" style={{ tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "44px" }} />
                    <col />
                    <col style={{ width: "32px" }} />
                    <col style={{ width: "44px" }} />
                    <col />
                  </colgroup>
                  <tbody>
                    {displayLines.map((line, i) => {
                      if ((line as any).type === "separator") {
                        return (
                          <tr key={`sep-${i}`}>
                            <td colSpan={5} className="text-center py-0.5 text-muted-foreground bg-muted/50 text-[10px] select-none">
                              ⋯ unchanged lines hidden ⋯
                            </td>
                          </tr>
                        );
                      }
                      const dl = line as DiffLine;
                      const hunkForLine = hunks.find(h => h.lines.includes(dl) && dl.type !== "equal");
                      return (
                        <DiffRow
                          key={i}
                          line={dl}
                          hunk={hunkForLine}
                          onAcceptLeft={acceptHunkLeft}
                          onAcceptRight={acceptHunkRight}
                          onCopyHunk={copyHunk}
                          searchQuery={searchQuery}
                        />
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <UnifiedDiffView lines={displayLines} searchQuery={searchQuery} />
              )}
            </div>
            {/* Footer */}
            <div className="border-t px-2 py-1 flex items-center gap-2 shrink-0 text-xs">
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => { setDiff(null); setHunks([]); setSearchOpen(false); setChangeFilter("all"); }}>
                <RotateCcw className="h-3 w-3 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={runDiff}>
                <Diff className="h-3 w-3 mr-1" /> Re-compare
              </Button>
              {changeFilter !== "all" && (
                <Badge variant="outline" className="h-5 text-[10px]">
                  Filter: {changeFilter === "add" ? "added only" : changeFilter === "del" ? "deleted only" : "modified only"}
                  <button onClick={() => setChangeFilter("all")} className="ml-1 hover:text-foreground" title="Clear filter">
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">
                F7 / Shift+F7 = next/prev diff &nbsp;|&nbsp; Ctrl+F = search &nbsp;|&nbsp; Arrow buttons = merge hunks
              </span>
            </div>
          </div>

          {/* ========== MINIMAP ========== */}
          <Minimap data={minimapData} scrollRef={diffScrollRef} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffRow
// ---------------------------------------------------------------------------

const DiffRow = React.memo(function DiffRow({
  line, hunk, onAcceptLeft, onAcceptRight, onCopyHunk, searchQuery,
}: {
  line: DiffLine;
  hunk: Hunk | undefined;
  onAcceptLeft: (h: Hunk) => void;
  onAcceptRight: (h: Hunk) => void;
  onCopyHunk: (h: Hunk, side: "left" | "right") => void;
  searchQuery: string;
}) {
  const leftNum = "leftNum" in line ? line.leftNum : null;
  const rightNum = "rightNum" in line ? line.rightNum : null;
  const leftContent = "left" in line ? line.left : "";
  const rightContent = "right" in line ? line.right : "";

  let leftBg = "", rightBg = "";
  if (line.type === "delete") { leftBg = "bg-red-100/60"; rightBg = "bg-red-50/20"; }
  else if (line.type === "insert") { leftBg = "bg-green-50/20"; rightBg = "bg-green-100/60"; }
  else if (line.type === "modify") { leftBg = "bg-amber-100/50"; rightBg = "bg-amber-100/50"; }

  let leftSpans: CharSpan[] | null = null, rightSpans: CharSpan[] | null = null;
  if (line.type === "modify") {
    const cd = wordDiff(leftContent, rightContent);
    leftSpans = cd.left;
    rightSpans = cd.right;
  }

  const gutterContent = line.type !== "equal" && hunk ? (
    <div className="flex flex-col items-center gap-px">
      {(line.type === "delete" || line.type === "modify") && (
        <button onClick={() => onAcceptLeft(hunk)} className="text-muted-foreground hover:text-primary" title="Accept left → right">
          <ArrowRight className="h-2.5 w-2.5" />
        </button>
      )}
      {(line.type === "insert" || line.type === "modify") && (
        <button onClick={() => onAcceptRight(hunk)} className="text-muted-foreground hover:text-primary" title="Accept right → left">
          <ArrowLeft className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  ) : null;

  const rowId = `diff-row-${leftNum ?? ""}-${rightNum ?? ""}`;

  function highlightSearch(text: string): React.ReactNode {
    if (!searchQuery || !text) return text;
    const q = searchQuery.toLowerCase();
    const tl = text.toLowerCase();
    const idx = tl.indexOf(q);
    if (idx < 0) return text;
    return (<>{text.slice(0, idx)}<mark className="bg-yellow-300/80 rounded-sm">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>);
  }

  return (
    <tr id={rowId} className={cn("border-b border-border/20 leading-[18px]", line.type !== "equal" && "")}>
      <td className={cn("px-1 py-0 text-right text-muted-foreground/60 select-none border-r text-[10px] tabular-nums", leftBg)}>
        {leftNum ?? ""}
      </td>
      <td className={cn("px-1.5 py-0 whitespace-pre-wrap break-all overflow-hidden", leftBg)}>
        {line.type === "modify" && leftSpans ? (
          leftSpans.map((s, i) => <span key={i} className={s.changed ? "bg-red-300/60 rounded-sm" : ""}>{renderWhitespace(s.text)}</span>)
        ) : line.type === "insert" ? null : (
          searchQuery ? highlightSearch(leftContent) : renderWhitespace(leftContent)
        )}
      </td>
      <td className="px-0 py-0 text-center border-x bg-muted/20">{gutterContent}</td>
      <td className={cn("px-1 py-0 text-right text-muted-foreground/60 select-none border-r text-[10px] tabular-nums", rightBg)}>
        {rightNum ?? ""}
      </td>
      <td className={cn("px-1.5 py-0 whitespace-pre-wrap break-all overflow-hidden", rightBg)}>
        {line.type === "modify" && rightSpans ? (
          rightSpans.map((s, i) => <span key={i} className={s.changed ? "bg-green-300/60 rounded-sm" : ""}>{renderWhitespace(s.text)}</span>)
        ) : line.type === "delete" ? null : (
          searchQuery ? highlightSearch(rightContent) : renderWhitespace(rightContent)
        )}
      </td>
    </tr>
  );
});

// ---------------------------------------------------------------------------
// LoadButtonGroup: a compact button group with File + From-IDE dropdown
// per side. The dropdown lets the user pick any saved SQL IDE script
// without copy-pasting.
// ---------------------------------------------------------------------------

function LoadButtonGroup({
  side, loadFile, openIdePicker, ideOpen, ideScripts, onPick, onClose,
}: {
  side: "left" | "right";
  loadFile: (side: "left" | "right") => void;
  openIdePicker: () => void;
  ideOpen: boolean;
  ideScripts: IdeScript[];
  onPick: (s: IdeScript) => void;
  onClose: () => void;
}) {
  const label = side === "left" ? "Left" : "Right";
  return (
    <div className="relative inline-flex">
      <Button
        size="sm" variant="outline"
        className="h-7 text-xs rounded-r-none border-r-0"
        onClick={() => loadFile(side)}
        title={`Load a file into the ${label.toLowerCase()} pane`}
      >
        <FileUp className="h-3 w-3 mr-1" /> {label}
      </Button>
      <Button
        size="sm" variant="outline"
        className="h-7 text-xs rounded-l-none px-1.5"
        onClick={openIdePicker}
        title={`Load a SQL IDE script into the ${label.toLowerCase()} pane`}
      >
        <Code2 className="h-3 w-3" />
      </Button>
      {ideOpen && (
        <div
          className="absolute left-0 top-full mt-1 z-30 bg-background border rounded shadow-lg text-xs min-w-[240px] max-w-[380px] max-h-[280px] overflow-y-auto"
          onMouseLeave={onClose}
        >
          <div className="sticky top-0 bg-background border-b px-2 py-1.5 flex items-center justify-between gap-2">
            <span className="font-medium">Pick a SQL IDE script ({label})</span>
            <button className="text-muted-foreground hover:text-foreground" onClick={onClose}>
              <X className="h-3 w-3" />
            </button>
          </div>
          {ideScripts.length === 0 ? (
            <div className="px-3 py-3 text-muted-foreground text-[11px]">
              No saved SQL IDE scripts found. Open the SQL IDE and type into
              a tab - it auto-saves to local storage.
            </div>
          ) : (
            ideScripts.map((s) => (
              <button
                key={s.id}
                className="w-full text-left px-2 py-1.5 hover:bg-accent border-b border-border/40 last:border-b-0"
                onClick={() => onPick(s)}
              >
                <div className="font-medium truncate">{s.name}</div>
                <div className="text-[10px] text-muted-foreground font-mono truncate">
                  {s.sql.split("\n")[0].slice(0, 80) || "<empty>"}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5">
                  {s.sql.split("\n").length} lines, {s.sql.length} chars
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterChip: small toggleable pill in the filter group
// ---------------------------------------------------------------------------

function FilterChip({
  active, onClick, color, children,
}: {
  active: boolean;
  onClick: () => void;
  color: "muted" | "green" | "red" | "amber";
  children: React.ReactNode;
}) {
  const palette: Record<string, string> = {
    muted: active ? "bg-muted-foreground/20 text-foreground" : "text-muted-foreground hover:bg-accent",
    green: active ? "bg-green-200 text-green-900" : "text-green-700 hover:bg-green-100",
    red:   active ? "bg-red-200 text-red-900"     : "text-red-700 hover:bg-red-100",
    amber: active ? "bg-amber-200 text-amber-900" : "text-amber-700 hover:bg-amber-100",
  };
  return (
    <button
      onClick={onClick}
      className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium tabular-nums transition-colors", palette[color])}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// UnifiedDiffView: git-style single-column diff display.
// Lines are prefixed with " ", "-", "+", with appropriate background colors.
// Modify rows expand to two lines (- then +) so word-diff highlights remain
// useful.
// ---------------------------------------------------------------------------

function UnifiedDiffView({
  lines, searchQuery,
}: {
  lines: (DiffLine | { type: "separator" })[];
  searchQuery: string;
}) {
  function highlight(text: string): React.ReactNode {
    if (!searchQuery || !text) return text;
    const q = searchQuery.toLowerCase();
    const tl = text.toLowerCase();
    const idx = tl.indexOf(q);
    if (idx < 0) return text;
    return (<>{text.slice(0, idx)}<mark className="bg-yellow-300/80 rounded-sm">{text.slice(idx, idx + q.length)}</mark>{text.slice(idx + q.length)}</>);
  }

  // Render a single content row given a sign (" ", "-", "+"), line numbers,
  // text, and an optional word-level CharSpan array for highlighting changes.
  function row(
    key: string, sign: " " | "-" | "+",
    leftNum: number | null, rightNum: number | null,
    text: string, spans: CharSpan[] | null,
  ) {
    let bg = "";
    let signColor = "text-muted-foreground/60";
    if (sign === "-") { bg = "bg-red-100/60"; signColor = "text-red-700"; }
    else if (sign === "+") { bg = "bg-green-100/60"; signColor = "text-green-700"; }
    return (
      <tr key={key} className={cn("border-b border-border/20 leading-[18px]", bg)}>
        <td className="px-1 py-0 text-right text-muted-foreground/60 select-none text-[10px] tabular-nums w-[44px]">
          {leftNum ?? ""}
        </td>
        <td className="px-1 py-0 text-right text-muted-foreground/60 select-none text-[10px] tabular-nums w-[44px] border-r">
          {rightNum ?? ""}
        </td>
        <td className={cn("px-1 text-center select-none font-bold w-[20px]", signColor)}>{sign}</td>
        <td className="px-1.5 py-0 whitespace-pre-wrap break-all overflow-hidden">
          {spans ? spans.map((s, i) => (
            <span key={i} className={s.changed ? (sign === "-" ? "bg-red-300/60 rounded-sm" : "bg-green-300/60 rounded-sm") : ""}>
              {renderWhitespace(s.text)}
            </span>
          )) : (searchQuery ? highlight(text) : renderWhitespace(text))}
        </td>
      </tr>
    );
  }

  return (
    <table className="w-full text-xs font-mono border-collapse" style={{ tableLayout: "fixed" }}>
      <colgroup>
        <col style={{ width: "44px" }} />
        <col style={{ width: "44px" }} />
        <col style={{ width: "20px" }} />
        <col />
      </colgroup>
      <tbody>
        {lines.map((line, i) => {
          if ((line as any).type === "separator") {
            return (
              <tr key={`sep-${i}`}>
                <td colSpan={4} className="text-center py-0.5 text-muted-foreground bg-muted/50 text-[10px] select-none">
                  ⋯ unchanged lines hidden ⋯
                </td>
              </tr>
            );
          }
          const dl = line as DiffLine;
          if (dl.type === "equal") {
            return row(`eq-${i}`, " ", dl.leftNum, dl.rightNum, dl.left, null);
          }
          if (dl.type === "delete") {
            return row(`del-${i}`, "-", dl.leftNum, null, dl.left, null);
          }
          if (dl.type === "insert") {
            return row(`ins-${i}`, "+", null, dl.rightNum, dl.right, null);
          }
          // modify: render two rows with word-level diff
          const cd = wordDiff(dl.left, dl.right);
          return (
            <React.Fragment key={`mod-${i}`}>
              {row(`mod-${i}-l`, "-", dl.leftNum, null, dl.left, cd.left)}
              {row(`mod-${i}-r`, "+", null, dl.rightNum, dl.right, cd.right)}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Minimap: scrollbar-style overview of diff locations
// ---------------------------------------------------------------------------

function Minimap({ data, scrollRef }: { data: string[]; scrollRef: React.RefObject<HTMLDivElement> }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const height = 600; // CSS height; canvas draws at 2x for retina
  const width = 14;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data.length) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const lineH = Math.max(1, height / data.length);
    data.forEach((type, i) => {
      const y = (i / data.length) * height;
      if (type === "equal") return;
      ctx.fillStyle = type === "delete" ? "#ef444480" : type === "insert" ? "#22c55e80" : "#f59e0b80";
      ctx.fillRect(0, y, width, Math.max(lineH, 1.5));
    });
  }, [data]);

  function handleClick(e: React.MouseEvent) {
    if (!scrollRef.current || !data.length) return;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    const pct = (e.clientY - rect.top) / rect.height;
    const scrollMax = scrollRef.current.scrollHeight - scrollRef.current.clientHeight;
    scrollRef.current.scrollTop = pct * scrollMax;
  }

  if (!data.length) return null;
  return (
    <div
      className="w-[14px] shrink-0 border-l bg-muted/30 cursor-pointer"
      onClick={handleClick}
      title="Click to scroll - colors show diff locations"
    >
      <canvas ref={canvasRef} style={{ width, height: "100%" }} />
    </div>
  );
}
