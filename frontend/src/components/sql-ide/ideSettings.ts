/**
 * SQL IDE preferences (Editor Settings dialog). Stored per browser profile in
 * localStorage and shared live between every component through a tiny
 * subscription store, so changing the font size re-renders the editor without
 * prop drilling.
 */
import * as React from "react";

export type EditorThemeChoice = "app" | "github-light" | "github-dark";
export type EditorEngine = "codemirror" | "plain";

export interface IdeSettings {
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  tabSize: 2 | 4;
  wordWrap: boolean;
  lineNumbers: boolean;
  highlightStatement: boolean;
  statementRunMarkers: boolean;
  /** DBeaver "blank line is a statement delimiter: smart" for Ctrl+Enter. */
  blankLineDelimiter: boolean;
  uppercaseKeywords: boolean;
  /** Grammar-aware keyword completion (loads the SQL parser on first use). */
  contextCompletion: boolean;
  autoCloseBrackets: boolean;
  editorTheme: EditorThemeChoice;
  engine: EditorEngine;
  /** Rows kept in server memory per result set (grid pages through them). */
  maxRows: number;
  defaultAutocommit: boolean;
  stopOnError: boolean;
  /** Confirm statements that change data or schema on connections marked Production. */
  confirmModifyingOnProduction: boolean;
  productionConnections: number[];
  /** Rows shown in the Text result view. */
  textViewRows: number;
  /** Prompt for :name parameters (${name} variables are always prompted). */
  namedParameters: boolean;
}

export const DEFAULT_FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "System monospace (recommended)", value: DEFAULT_FONT_STACK },
  { label: "Cascadia Code / Consolas", value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: "Consolas", value: "Consolas, monospace" },
  { label: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
  { label: "Fira Code", value: '"Fira Code", monospace' },
  { label: "Courier New", value: '"Courier New", monospace' },
];

export const MAX_ROWS_CHOICES = [1_000, 10_000, 50_000, 200_000, 500_000, 1_000_000];

export const DEFAULT_SETTINGS: IdeSettings = {
  fontSize: 13,
  fontFamily: DEFAULT_FONT_STACK,
  lineHeight: 1.6,
  tabSize: 2,
  wordWrap: false,
  lineNumbers: true,
  highlightStatement: true,
  statementRunMarkers: true,
  blankLineDelimiter: true,
  uppercaseKeywords: true,
  contextCompletion: true,
  autoCloseBrackets: true,
  editorTheme: "app",
  engine: "codemirror",
  maxRows: 200_000,
  defaultAutocommit: true,
  stopOnError: true,
  confirmModifyingOnProduction: true,
  productionConnections: [],
  textViewRows: 2_000,
  namedParameters: true,
};

const KEY = "dv-ide-settings";
// Pre-redesign key: honour a user who had picked the plain editor.
const LEGACY_ENGINE_KEY = "dv-editor-mode";

function load(): IdeSettings {
  let stored: Partial<IdeSettings> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) ?? {};
    else if (localStorage.getItem(LEGACY_ENGINE_KEY) === "plain") stored = { engine: "plain" };
  } catch {
    /* unavailable storage → defaults */
  }
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  merged.fontSize = Math.min(24, Math.max(10, Number(merged.fontSize) || DEFAULT_SETTINGS.fontSize));
  merged.tabSize = merged.tabSize === 4 ? 4 : 2;
  if (!MAX_ROWS_CHOICES.includes(merged.maxRows)) merged.maxRows = DEFAULT_SETTINGS.maxRows;
  if (!Array.isArray(merged.productionConnections)) merged.productionConnections = [];
  if (merged.engine !== "plain") merged.engine = "codemirror";
  return merged;
}

let current: IdeSettings = load();
const listeners = new Set<() => void>();

export function getIdeSettings(): IdeSettings {
  return current;
}

export function updateIdeSettings(patch: Partial<IdeSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function resetIdeSettings(): void {
  updateIdeSettings({ ...DEFAULT_SETTINGS, productionConnections: current.productionConnections });
}

export function useIdeSettings(): IdeSettings {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function isProductionConnection(id: number | null | undefined, s: IdeSettings = current): boolean {
  return id != null && s.productionConnections.includes(id);
}

/** Small persisted layout state (panel sizes, active sidebar view). */
export interface IdeLayout {
  sidebarView: "explorer" | "scripts" | "history" | null;
  sidebarWidth: number;
  resultsHeight: number;
  resultsVisible: boolean;
  resultsMaximized: boolean;
  valuePanel: boolean;
  valuePanelWidth: number;
}

const LAYOUT_KEY = "dv-ide-layout";
const DEFAULT_LAYOUT: IdeLayout = {
  // Small screens start with the editor at full width.
  sidebarView: typeof window !== "undefined" && window.innerWidth < 1400 ? null : "explorer",
  sidebarWidth: 280,
  resultsHeight: 320,
  resultsVisible: true,
  resultsMaximized: false,
  valuePanel: false,
  valuePanelWidth: 340,
};

export function loadLayout(): IdeLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const merged = { ...DEFAULT_LAYOUT, ...(raw ? JSON.parse(raw) : {}) } as IdeLayout;
    // Older builds stored explorer width / editor height separately.
    const legacyW = parseInt(localStorage.getItem("dv-explorer-w") || "", 10);
    if (!raw && legacyW > 0) merged.sidebarWidth = legacyW + 20;
    return merged;
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function saveLayout(layout: IdeLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}
