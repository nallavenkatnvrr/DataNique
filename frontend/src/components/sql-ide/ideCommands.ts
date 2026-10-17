/**
 * Single source of truth for SQL IDE commands and their keyboard shortcuts.
 * The editor keymap, the page-level shortcut handler, the command palette
 * (Ctrl+Shift+P) and the shortcuts dialog all read from here, so a binding
 * shown to the user is always the binding that works.
 *
 * Keys use CodeMirror notation: "Mod" = Ctrl (⌘ on macOS), e.g. "Mod-Shift-e".
 * Defaults follow DBeaver where the browser allows it (Ctrl+Enter, Alt+X,
 * Ctrl+Shift+F/E/X/Y, Ctrl+]) and VS Code for editor navigation.
 */

export type IdeCommandId =
  | "run.statement" | "run.script" | "run.newTab" | "run.explain" | "run.count" | "run.stop"
  | "edit.format" | "edit.comment" | "edit.blockComment" | "edit.upper" | "edit.lower"
  | "edit.find" | "edit.replace" | "edit.gotoLine" | "edit.nextStatement" | "edit.prevStatement"
  | "edit.selectStatement" | "edit.complete"
  | "script.new" | "script.close" | "script.rename" | "script.duplicate" | "script.save" | "script.saveAs"
  | "script.library" | "script.import" | "script.export" | "script.reopen"
  | "view.palette" | "view.toggleResults" | "view.maximizeResults" | "view.toggleSidebar" | "view.explorer"
  | "view.scripts" | "view.history" | "view.wordWrap" | "view.zoomIn" | "view.zoomOut" | "view.zen"
  | "view.settings" | "view.shortcuts" | "view.valuePanel" | "view.focusEditor"
  | "results.fetchAll" | "results.exportCsv" | "results.diff" | "results.closeTab"
  | "txn.commit" | "txn.rollback" | "txn.toggleMode"
  | "conn.new" | "conn.refresh" | "tools.ddl" | "tools.queryManager";

export interface IdeCommand {
  id: IdeCommandId;
  title: string;
  category: "Run" | "Edit" | "Script" | "View" | "Results" | "Transaction" | "Connection";
  keys?: string[];
  /** "editor" = only while the SQL editor has focus; default works anywhere on the page. */
  scope?: "editor" | "global";
}

export const IDE_COMMANDS: IdeCommand[] = [
  { id: "run.statement", title: "Execute statement (or selection)", category: "Run", keys: ["Mod-Enter"] },
  { id: "run.script", title: "Execute script", category: "Run", keys: ["Alt-x", "F5"] },
  { id: "run.newTab", title: "Execute statement in a new result tab", category: "Run", keys: ["Mod-\\", "Mod-Shift-Enter"] },
  { id: "run.explain", title: "Explain execution plan", category: "Run", keys: ["Mod-Shift-e"] },
  { id: "run.count", title: "Count rows of statement", category: "Run", keys: ["Mod-Alt-Shift-c"] },
  { id: "run.stop", title: "Cancel running query", category: "Run", keys: ["Mod-Alt-Backspace"] },

  { id: "edit.format", title: "Format SQL (selection or script)", category: "Edit", keys: ["Mod-Shift-f"] },
  { id: "edit.comment", title: "Toggle line comment", category: "Edit", keys: ["Mod-/"], scope: "editor" },
  { id: "edit.blockComment", title: "Toggle block comment", category: "Edit", keys: ["Mod-Shift-/"], scope: "editor" },
  { id: "edit.upper", title: "Selection to UPPER case", category: "Edit", keys: ["Mod-Shift-x"], scope: "editor" },
  { id: "edit.lower", title: "Selection to lower case", category: "Edit", keys: ["Mod-Shift-y"], scope: "editor" },
  { id: "edit.find", title: "Find", category: "Edit", keys: ["Mod-f"], scope: "editor" },
  { id: "edit.replace", title: "Find and replace", category: "Edit", keys: ["Mod-h"], scope: "editor" },
  { id: "edit.gotoLine", title: "Go to line", category: "Edit", keys: ["Mod-g"], scope: "editor" },
  { id: "edit.nextStatement", title: "Go to next statement", category: "Edit", keys: ["Alt-PageDown"], scope: "editor" },
  { id: "edit.prevStatement", title: "Go to previous statement", category: "Edit", keys: ["Alt-PageUp"], scope: "editor" },
  { id: "edit.selectStatement", title: "Select current statement", category: "Edit", keys: ["Mod-Alt-a"], scope: "editor" },
  { id: "edit.complete", title: "Trigger autocomplete", category: "Edit", keys: ["Mod-Space"], scope: "editor" },

  { id: "script.new", title: "New script", category: "Script", keys: ["Mod-]", "Alt-n"] },
  { id: "script.close", title: "Close script", category: "Script", keys: ["Alt-w"] },
  { id: "script.rename", title: "Rename script", category: "Script", keys: ["F2"] },
  { id: "script.duplicate", title: "Duplicate script", category: "Script" },
  { id: "script.save", title: "Save script to library", category: "Script", keys: ["Mod-s"] },
  { id: "script.saveAs", title: "Save script as…", category: "Script", keys: ["Mod-Shift-s"] },
  { id: "script.library", title: "Open script library", category: "Script", keys: ["Mod-o"] },
  { id: "script.import", title: "Import .sql file", category: "Script" },
  { id: "script.export", title: "Download script as .sql", category: "Script" },
  { id: "script.reopen", title: "Reopen closed script", category: "Script" },

  { id: "view.palette", title: "Command palette", category: "View", keys: ["Mod-Shift-p", "F1"] },
  { id: "view.toggleResults", title: "Show / hide results panel", category: "View", keys: ["Mod-j"] },
  { id: "view.maximizeResults", title: "Maximize / restore results panel", category: "View", keys: ["Alt-Shift-Enter"] },
  { id: "view.toggleSidebar", title: "Show / hide side bar", category: "View", keys: ["Mod-b"] },
  { id: "view.explorer", title: "Show database explorer", category: "View", keys: ["Mod-Shift-d"] },
  { id: "view.scripts", title: "Show scripts", category: "View" },
  { id: "view.history", title: "Show query history", category: "View", keys: ["Mod-Shift-h"] },
  { id: "view.wordWrap", title: "Toggle word wrap", category: "View", keys: ["Alt-z"] },
  { id: "view.zoomIn", title: "Editor font larger", category: "View" },
  { id: "view.zoomOut", title: "Editor font smaller", category: "View" },
  { id: "view.zen", title: "Toggle focus mode (hide app navigation)", category: "View", keys: ["Mod-Alt-z"] },
  { id: "view.valuePanel", title: "Toggle value panel", category: "View", keys: ["F7"] },
  { id: "view.focusEditor", title: "Focus editor", category: "View", keys: ["Mod-1"] },
  { id: "view.settings", title: "Editor settings", category: "View", keys: ["Mod-,"] },
  { id: "view.shortcuts", title: "Keyboard shortcuts", category: "View" },

  { id: "results.fetchAll", title: "Fetch all rows of active result", category: "Results", keys: ["Mod-Shift-="] },
  { id: "results.exportCsv", title: "Export active result to CSV", category: "Results" },
  { id: "results.diff", title: "Compare two results (Visual Diff)", category: "Results" },
  { id: "results.closeTab", title: "Close active result tab", category: "Results" },

  { id: "txn.commit", title: "Commit transaction", category: "Transaction", keys: ["Mod-Alt-Shift-Enter"] },
  { id: "txn.rollback", title: "Roll back transaction", category: "Transaction", keys: ["Mod-Alt-Shift-Backspace"] },
  { id: "txn.toggleMode", title: "Switch auto-commit / manual commit", category: "Transaction" },

  { id: "conn.new", title: "New connection", category: "Connection" },
  { id: "conn.refresh", title: "Refresh database explorer", category: "Connection" },
  { id: "tools.ddl", title: "Generate DDL / INSERT / EXEC", category: "Connection" },
  { id: "tools.queryManager", title: "Query manager (running and recent queries)", category: "Connection" },
];

export const COMMAND_BY_ID: Record<IdeCommandId, IdeCommand> = Object.fromEntries(
  IDE_COMMANDS.map((c) => [c.id, c]),
) as Record<IdeCommandId, IdeCommand>;

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

/** Human-readable shortcut, e.g. "Ctrl+Shift+E" (or "⌘⇧E" on macOS). */
export function formatKey(key: string): string {
  const parts = key.split(/-(?!$)/);
  const map: Record<string, string> = IS_MAC
    ? { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↩", Backspace: "⌫", PageUp: "PgUp", PageDown: "PgDn" }
    : { Mod: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Enter: "Enter", Backspace: "Backspace", PageUp: "PgUp", PageDown: "PgDn" };
  const out = parts.map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p));
  return IS_MAC ? out.join("") : out.join("+");
}

export function shortcutLabel(id: IdeCommandId): string | undefined {
  const k = COMMAND_BY_ID[id]?.keys?.[0];
  return k ? formatKey(k) : undefined;
}

/** Normalise a DOM keyboard event to CodeMirror key notation. */
export function eventToKey(e: KeyboardEvent): string {
  let name = e.key;
  if (name === " ") name = "Space";
  if (e.code === "Backslash") name = "\\";
  if (e.code === "Equal" && (e.shiftKey || e.altKey)) name = "=";
  if (e.code === "Minus" && e.altKey) name = "-";
  if (e.code === "BracketRight") name = "]";
  if (e.code === "Slash") name = "/";
  if (e.code === "Comma") name = ",";
  if (e.altKey && e.code.startsWith("Key")) name = e.code.slice(3).toLowerCase();
  if (e.code.startsWith("Digit") && (e.ctrlKey || e.metaKey)) name = e.code.slice(5);
  if (name.length === 1) name = name.toLowerCase();
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (IS_MAC && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey && name.length > 1) parts.push("Shift");
  else if (e.shiftKey && /[a-z]/.test(name)) parts.push("Shift");
  else if (e.shiftKey && (name === "/" || name === "=" || name === "\\")) parts.push("Shift");
  parts.push(name);
  return parts.join("-");
}

function normalizeBinding(key: string): string {
  const parts = key.split(/-(?!$)/);
  const last = parts.pop() as string;
  const mods = parts.filter(Boolean);
  const order = ["Mod", "Ctrl", "Alt", "Shift"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, last.length === 1 ? last.toLowerCase() : last].join("-");
}

const BINDING_INDEX: Map<string, IdeCommand> = (() => {
  const m = new Map<string, IdeCommand>();
  for (const c of IDE_COMMANDS) for (const k of c.keys ?? []) m.set(normalizeBinding(k), c);
  return m;
})();

export function commandForEvent(e: KeyboardEvent): IdeCommand | undefined {
  return BINDING_INDEX.get(normalizeBinding(eventToKey(e)));
}
