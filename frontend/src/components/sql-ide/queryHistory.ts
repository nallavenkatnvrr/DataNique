/**
 * Persistent query history (DBeaver "Query Manager" / SqlDbx "SQL History"):
 * every statement the IDE runs, newest first, kept in localStorage so it
 * survives restarts. Capped by count and total size.
 */
import * as React from "react";

export interface HistoryEntry {
  id: string;
  at: string;                 // ISO timestamp (finished)
  connectionId: number | null;
  connectionName: string;
  dbType?: string;
  database?: string | null;
  schema?: string | null;
  sql: string;
  status: "success" | "error" | "cancelled";
  rows?: number | null;
  affectedRows?: number | null;
  elapsedMs?: number | null;
  error?: string | null;
  scriptName?: string;
}

const KEY = "dv-ide-history";
const MAX_ENTRIES = 1000;
const MAX_SQL_CHARS = 20_000;
const MAX_TOTAL_CHARS = 2_000_000;

function load(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const data = raw ? JSON.parse(raw) : [];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

let entries: HistoryEntry[] = load();
const listeners = new Set<() => void>();

function persist() {
  let total = 0;
  const kept: HistoryEntry[] = [];
  for (const e of entries) {
    total += e.sql.length + (e.error?.length ?? 0) + 200;
    if (kept.length >= MAX_ENTRIES || total > MAX_TOTAL_CHARS) break;
    kept.push(e);
  }
  entries = kept;
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* quota: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function addHistory(items: Omit<HistoryEntry, "id">[]): void {
  if (!items.length) return;
  const stamped = items.map((it, i) => ({
    ...it,
    sql: it.sql.length > MAX_SQL_CHARS ? it.sql.slice(0, MAX_SQL_CHARS) + "\n-- …truncated" : it.sql,
    error: it.error ? it.error.slice(0, 2000) : it.error,
    id: `${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`,
  }));
  entries = [...stamped.reverse(), ...entries];
  persist();
}

export function removeHistory(id: string): void {
  entries = entries.filter((e) => e.id !== id);
  persist();
}

export function clearHistory(connectionId?: number | null): void {
  entries = connectionId == null ? [] : entries.filter((e) => e.connectionId !== connectionId);
  persist();
}

export function useQueryHistory(): HistoryEntry[] {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => entries,
  );
}
