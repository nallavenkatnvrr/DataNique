import * as React from "react";

// ---------------------------------------------------------------------------
// Control character visualization (phase 4.36)
//
// SQL Server / Oracle / etc. legitimately store non-printable bytes — NUL
// (0x00), CR (0x0D), TAB (0x09), and so on — inside VARCHAR columns. The
// data is real; the bytes matter for downstream consumers; but the UI
// renders them as nothing visible. That makes diffs in the Visual Diff
// panel look broken: cells are highlighted as different but the user
// can't see *why*.
//
// `renderControlChars` converts each non-printable char into a small
// inline badge ([NUL], [TAB], [LF], etc.) so the user can see WHICH
// bytes are present. The rest of the string is rendered as plain text;
// the helper bails out on its fast path when there are no control chars
// so the cost is one regex test per cell for the common case.
//
// `escapeControlCharsPlain` is the plain-text equivalent for use in
// tooltips, titles, log lines, and anywhere React nodes aren't usable.
// ---------------------------------------------------------------------------

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

function controlCharLabel(code: number): string {
  // Use the standard ASCII control-char mnemonics. They're widely
  // recognized — anyone who's dealt with raw text streams knows what
  // NUL/CR/LF/TAB/etc. mean.
  switch (code) {
    case 0x00: return "NUL";
    case 0x07: return "BEL";
    case 0x08: return "BS";
    case 0x09: return "TAB";
    case 0x0A: return "LF";
    case 0x0B: return "VT";
    case 0x0C: return "FF";
    case 0x0D: return "CR";
    case 0x1B: return "ESC";
    case 0x7F: return "DEL";
    default:   return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }
}

function ControlCharBadge({ code }: { code: number }) {
  const label = controlCharLabel(code);
  return (
    <span
      className="inline-block px-1 mx-0.5 bg-yellow-300/80 text-yellow-950 rounded-sm text-[8px] font-bold align-middle leading-tight py-0.5 border border-yellow-700/40 select-all"
      title={`Control char 0x${code.toString(16).toUpperCase().padStart(2, "0")} (decimal ${code})`}
    >
      {label}
    </span>
  );
}

/**
 * Render a string with non-printable control characters made visible as
 * yellow inline badges. Returns a React node (string when fast-path, fragment
 * when there are control chars to highlight).
 *
 * Use directly in JSX:
 *   <td>{renderControlChars(cell.value)}</td>
 */
export function renderControlChars(value: string | null | undefined): React.ReactNode {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!CONTROL_CHAR_RE.test(s)) return s;  // fast path
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) {
      if (i > last) parts.push(s.slice(last, i));
      parts.push(<ControlCharBadge key={i} code={code} />);
      last = i + 1;
    }
  }
  if (last < s.length) parts.push(s.slice(last));
  return <>{parts}</>;
}

/**
 * Plain-text version: NUL → `[NUL]`, TAB → `[TAB]`, etc. Used in HTML
 * `title` attributes, log lines, and anywhere a React node won't fit.
 */
export function escapeControlCharsPlain(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (!CONTROL_CHAR_RE.test(s)) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1F || code === 0x7F) {
      out += `[${controlCharLabel(code)}]`;
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Does a string contain any non-printable control char? Cheap predicate
 * for conditional logic (e.g., showing a "contains hidden chars" warning).
 */
export function hasControlChars(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return CONTROL_CHAR_RE.test(String(value));
}
