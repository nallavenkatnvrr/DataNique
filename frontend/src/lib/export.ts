/** Utilities for exporting query results in various formats. */

import { apiAuthHeaders } from "@/api/client";

function spreadsheetSafeString(value: any): string {
  const text = String(value);
  if (typeof value !== "string") return text;
  // Neutralise spreadsheet formulas, but leave plain numbers ("-12.5") alone.
  if (/^[-+]?\d[\d,]*(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim())) return text;
  return /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function escapeCsvCell(v: any): string {
  if (v === null || v === undefined) return "";
  const s = spreadsheetSafeString(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(columns: string[], rows: any[][]): string {
  const header = columns.map(escapeCsvCell).join(",");
  const body = rows.map((r) => r.map(escapeCsvCell).join(",")).join("\n");
  return body ? `${header}\n${body}` : header;
}

export function toJson(columns: string[], rows: any[][], pretty = true): string {
  const objs = rows.map((r) => {
    const o: Record<string, any> = {};
    columns.forEach((c, i) => { o[c] = r[i]; });
    return o;
  });
  return pretty ? JSON.stringify(objs, null, 2) : JSON.stringify(objs);
}

export function toTsv(columns: string[], rows: any[][]): string {
  // Tab-separated, simple - for pasting into Excel/Sheets.
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    const text = String(v).replace(/\t/g, " ").replace(/\n/g, " ").replace(/\r/g, "");
    return spreadsheetSafeString(typeof v === "string" ? text : v);
  };
  const header = columns.map(escape).join("\t");
  const body = rows.map((r) => r.map(escape).join("\t")).join("\n");
  return body ? `${header}\n${body}` : header;
}

/** GitHub-flavored Markdown table - handy for pasting into docs/PRs/tickets. */
export function toMarkdown(columns: string[], rows: any[][]): string {
  const esc = (v: any) =>
    v === null || v === undefined
      ? ""
      : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const header = `| ${columns.map(esc).join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
  return body ? `${header}\n${sep}\n${body}` : `${header}\n${sep}`;
}

function sqlLiteral(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** INSERT statements - one per row. DBeaver "Copy as SQL / INSERT" equivalent. */
export function toInsert(columns: string[], rows: any[][], table = "table"): string {
  const cols = columns.join(", ");
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map(sqlLiteral).join(", ")});`)
    .join("\n");
}

export function downloadBlob(content: string, filename: string, mime = "text/plain"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // revoking immediately can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Fetch a binary endpoint (e.g. an Excel report) and trigger a browser
 * download. Use this instead of a plain ``<a href>`` when the link is wrapped
 * around a ``<button>`` (invalid HTML - the button swallows the click so the
 * anchor never navigates and "nothing happens") or when the request may need
 * headers a navigation can't carry. Throws on a non-OK response so the caller
 * can surface an error toast.
 */
export async function downloadFromUrl(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { headers: apiAuthHeaders() });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const t = await res.text();
      if (t) msg += `: ${t.slice(0, 200)}`;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get("Content-Disposition") || "";
  const m = cd.match(/filename="?([^"]+)"?/);
  const filename = m?.[1] ?? fallbackName;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objUrl), 30_000);
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    // Fallback for older browsers
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
