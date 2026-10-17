/**
 * SQL IDE workspace state: script tabs, their result tabs and run state.
 *
 * Lives at module level (not in the page component) so it survives route
 * changes: leave the IDE while a query runs, come back, and the tab, its
 * results and the still-running execution are all where you left them. Script
 * text and tab settings are also persisted to localStorage; results and
 * sessions are in-memory only.
 */
import * as React from "react";

export type ResultStatus = "idle" | "running" | "success" | "error" | "cancelled";
export type RunKind = "statement" | "script" | "explain" | "count";
export type ResultView = "grid" | "text" | "record" | "messages";

export interface IdeContext {
  /** null = the connection's default */
  database?: string | null;
  schema_name?: string | null;
  role?: string | null;
  warehouse?: string | null;
}

export interface StatementMessage {
  index: number;
  sql: string;
  status: "running" | "success" | "error" | "skipped" | "cancelled";
  rows: number;
  affected_rows: number | null;
  elapsed_ms: number;
  error: string | null;
  result_sets: number[];
  note?: string;
}

export interface ResultSetView {
  index: number;
  columns: string[];
  rows: any[][];
  /** Rows the server fetched for this set (the grid pages through them). */
  total: number;
  truncated: boolean;
  hasMore: boolean;
  title?: string;
  statementIndex?: number;
}

export interface RanStatement {
  text: string;
  /** Offsets in the editor document at the time of the run (-1 = synthetic). */
  from: number;
  to: number;
}

export interface ResultTab {
  id: string;
  label: string;
  pinned: boolean;
  sessionId: string | null;
  execId: string | null;
  status: ResultStatus;
  kind: RunKind;
  sql: string;
  statements: RanStatement[];
  /** Hash of the editor text when the run started (maps errors back to lines). */
  docHash: string | null;
  sets: ResultSetView[];
  activeSet: number;
  messages: StatementMessage[];
  errorStatementIndex: number | null;
  error: string | null;
  affectedRows: number | null;
  elapsedMs: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: { done: number; total: number } | null;
  view: ResultView;
}

export interface ScriptTab {
  id: string;
  name: string;
  connectionId: number | null;
  sql: string;
  context: IdeContext;
  autocommit: boolean;
  /** Manual-commit mode: statements ran since the last COMMIT / ROLLBACK. */
  txnPending: boolean;
  sessionId: string | null;
  /** Name in the script library once saved (Ctrl+S then saves silently). */
  libraryName: string | null;
  /** Hash of the text last saved to / opened from the library. */
  savedHash: string | null;
  results: ResultTab[];
  activeResultId: string | null;
}

export interface IdeState {
  tabs: ScriptTab[];
  activeTabId: string;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let seq = 0;
export function uid(prefix = "t"): string {
  seq += 1;
  return `${prefix}${seq.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** FNV-1a 32-bit — cheap content fingerprint for dirty tracking. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + s.length.toString(36);
}

export function isDirty(t: ScriptTab): boolean {
  return t.libraryName != null && t.savedHash !== hashText(t.sql);
}

export function newResultTab(label = "Result 1", kind: RunKind = "statement"): ResultTab {
  return {
    id: uid("r"),
    label,
    pinned: false,
    sessionId: null,
    execId: null,
    status: "idle",
    kind,
    sql: "",
    statements: [],
    docHash: null,
    sets: [],
    activeSet: 0,
    messages: [],
    errorStatementIndex: null,
    error: null,
    affectedRows: null,
    elapsedMs: 0,
    startedAt: null,
    finishedAt: null,
    progress: null,
    view: "grid",
  };
}

export function newScriptTab(init: Partial<ScriptTab> = {}): ScriptTab {
  return {
    id: uid("s"),
    name: "Script 1",
    connectionId: null,
    sql: "",
    context: {},
    autocommit: true,
    txnPending: false,
    sessionId: null,
    libraryName: null,
    savedHash: null,
    results: [],
    activeResultId: null,
    ...init,
  };
}

/** Next free "Script N" name for a connection (max+1 so numbers never repeat). */
export function nextScriptName(tabs: ScriptTab[], prefix = "Script"): string {
  let max = 0;
  const re = new RegExp(`^${prefix} (\\d+)$`);
  for (const t of tabs) {
    const m = re.exec(t.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix} ${max + 1}`;
}

export function nextResultLabel(results: ResultTab[]): string {
  let max = 0;
  for (const r of results) {
    const m = /^Result (\d+)$/.exec(r.label);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Result ${max + 1}`;
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const KEY = "dv-ide-workspace";
// Pre-redesign keys (read once for migration, never written).
const LEGACY_TABS = "dv-sql-ide-tabs";
const LEGACY_ACTIVE = "dv-sql-ide-active";

interface PersistedTab {
  id: string;
  name: string;
  connectionId: number | null;
  sql: string;
  context?: IdeContext;
  autocommit?: boolean;
  libraryName?: string | null;
  savedHash?: string | null;
}

function loadInitial(): IdeState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw) as { tabs: PersistedTab[]; activeTabId: string };
      if (Array.isArray(data?.tabs) && data.tabs.length) {
        const tabs = data.tabs.map((p) =>
          newScriptTab({
            id: p.id || uid("s"),
            name: p.name || "Script",
            connectionId: p.connectionId ?? null,
            sql: p.sql ?? "",
            context: p.context ?? {},
            autocommit: p.autocommit ?? true,
            libraryName: p.libraryName ?? null,
            savedHash: p.savedHash ?? null,
          }),
        );
        const activeTabId = tabs.some((t) => t.id === data.activeTabId) ? data.activeTabId : tabs[0].id;
        return { tabs, activeTabId };
      }
    }
    const legacy = localStorage.getItem(LEGACY_TABS);
    if (legacy) {
      const data = JSON.parse(legacy) as {
        id: string; name: string; connectionId: number | null; schemaName?: string | null; sql: string;
        snowflakeContext?: IdeContext;
      }[];
      if (Array.isArray(data) && data.length) {
        const tabs = data.map((d) =>
          newScriptTab({
            id: d.id || uid("s"),
            name: d.name || "Script",
            connectionId: d.connectionId ?? null,
            sql: d.sql ?? "",
            context: {
              ...(d.snowflakeContext ?? {}),
              schema_name: d.schemaName ?? d.snowflakeContext?.schema_name ?? null,
            },
          }),
        );
        const a = localStorage.getItem(LEGACY_ACTIVE);
        return { tabs, activeTabId: tabs.some((t) => t.id === a) ? (a as string) : tabs[0].id };
      }
    }
  } catch {
    /* corrupted storage → fresh workspace */
  }
  const t = newScriptTab();
  return { tabs: [t], activeTabId: t.id };
}

function persistNow(s: IdeState) {
  try {
    const data = {
      tabs: s.tabs.map<PersistedTab>((t) => ({
        id: t.id,
        name: t.name,
        connectionId: t.connectionId,
        sql: t.sql,
        context: t.context,
        autocommit: t.autocommit,
        libraryName: t.libraryName,
        savedHash: t.savedHash,
      })),
      activeTabId: s.activeTabId,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* quota / private mode — keep working in memory */
  }
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

let state: IdeState = loadInitial();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistedKey = "";

function persistKey(s: IdeState): string {
  // Only fields that are persisted — result churn while polling doesn't
  // trigger localStorage writes.
  let k = s.activeTabId;
  for (const t of s.tabs) {
    k += `|${t.id}\u0001${t.name}\u0001${t.connectionId}\u0001${t.sql.length}:${hashText(t.sql)}\u0001${JSON.stringify(t.context)}\u0001${t.autocommit}\u0001${t.libraryName}\u0001${t.savedHash}`;
  }
  return k;
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const k = persistKey(state);
    if (k !== lastPersistedKey) {
      lastPersistedKey = k;
      persistNow(state);
    }
  }, 400);
}

export function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistNow(state);
  lastPersistedKey = persistKey(state);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPersist);
  window.addEventListener("beforeunload", flushPersist);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersist();
  });
}

export function getIdeState(): IdeState {
  return state;
}

export function setIdeState(updater: (s: IdeState) => IdeState): void {
  const next = updater(state);
  if (next === state) return;
  state = next;
  schedulePersist();
  listeners.forEach((l) => l());
}

export function subscribeIde(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useIdeState(): IdeState {
  return React.useSyncExternalStore(subscribeIde, getIdeState);
}

export function getTab(tabId: string): ScriptTab | undefined {
  return state.tabs.find((t) => t.id === tabId);
}

export function updateTab(tabId: string, fn: (t: ScriptTab) => ScriptTab): void {
  setIdeState((s) => {
    let changed = false;
    const tabs = s.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const n = fn(t);
      if (n !== t) changed = true;
      return n;
    });
    return changed ? { ...s, tabs } : s;
  });
}

export function updateResult(tabId: string, rtId: string, fn: (r: ResultTab) => ResultTab): void {
  updateTab(tabId, (t) => {
    let changed = false;
    const results = t.results.map((r) => {
      if (r.id !== rtId) return r;
      const n = fn(r);
      if (n !== r) changed = true;
      return n;
    });
    return changed ? { ...t, results } : t;
  });
}

export function findResult(tabId: string, rtId: string): ResultTab | undefined {
  return getTab(tabId)?.results.find((r) => r.id === rtId);
}

/** True while the IDE page is mounted (completion toasts only when it isn't). */
export const pageState = { mounted: false };
