/**
 * Query execution for the SQL IDE: session lifecycle, submit, poll, cancel,
 * paging and manual transactions. Module-level (like ideStore) so a running
 * query keeps being tracked while the user is on another page.
 */
import { toast } from "sonner";
import { api, type Connection, type SnowflakeContext, type SqlExecution } from "@/api/client";
import { formatDuration, formatNumber } from "@/lib/utils";
import { addHistory } from "./queryHistory";
import { getIdeSettings } from "./ideSettings";
import {
  type RanStatement, type ResultSetView, type ResultTab, type RunKind, type ScriptTab, type StatementMessage,
  findResult, getIdeState, getTab, newResultTab, nextResultLabel, pageState, updateResult, updateTab,
} from "./ideStore";

export const RESULT_PAGE_SIZE = 200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNotFound = (e: unknown) => /^404\b/.test(String((e as any)?.message ?? ""));
const errText = (e: unknown) => String((e as any)?.message ?? e).replace(/^\d{3} [^:]*: /, "");

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

/** Which context pickers make sense per engine (what the backend can apply). */
export function contextFields(dbType?: string | null): { database: boolean; schema: boolean; roleWarehouse: boolean } {
  switch (dbType) {
    case "snowflake":
      return { database: true, schema: true, roleWarehouse: true };
    case "sqlserver":
      return { database: true, schema: true, roleWarehouse: false };
    case "mysql":
      return { database: true, schema: false, roleWarehouse: false };
    case "postgres":
    case "oracle":
      return { database: false, schema: true, roleWarehouse: false };
    default:
      return { database: false, schema: false, roleWarehouse: false };
  }
}

export function effectiveContext(tab: Pick<ScriptTab, "context">, conn?: Connection | null) {
  const database = tab.context.database || conn?.database || null;
  const schema =
    tab.context.schema_name || (database === (conn?.database || null) ? conn?.schema_name : null) || null;
  return { database, schema };
}

function contextToSend(tab: ScriptTab, conn: Connection): SnowflakeContext | undefined {
  const { database, schema } = effectiveContext(tab, conn);
  const f = contextFields(conn.db_type);
  const ctx: SnowflakeContext = {};
  if (f.database && database) ctx.database = database;
  if (f.schema && schema) ctx.schema_name = schema;
  if (f.roleWarehouse) {
    if (tab.context.role) ctx.role = tab.context.role;
    if (tab.context.warehouse) ctx.warehouse = tab.context.warehouse;
  }
  return Object.keys(ctx).length ? ctx : undefined;
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

const sessionPromises = new Map<string, Promise<string>>();

async function ensureSession(tabId: string, conn: Connection): Promise<string> {
  const tab = getTab(tabId);
  if (!tab) throw new Error("Script tab was closed");
  if (tab.sessionId) return tab.sessionId;
  let p = sessionPromises.get(tabId);
  if (!p) {
    p = api
      .createSession(conn.id, tab.name)
      .then((s) => {
        updateTab(tabId, (t) => ({ ...t, sessionId: s.session_id }));
        return s.session_id;
      })
      .finally(() => sessionPromises.delete(tabId));
    sessionPromises.set(tabId, p);
  }
  return p;
}

/** Close sessions server-side (frees their dedicated DB connections). */
export function closeSessions(ids: (string | null | undefined)[], keepalive = false): void {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return;
  api.closeSessions(list, keepalive).catch(() => {});
}

/** Point a tab at another connection: its old session (and transaction) is closed. */
export function changeTabConnection(tabId: string, connectionId: number | null): void {
  const tab = getTab(tabId);
  if (!tab || tab.connectionId === connectionId) return;
  stopPolling(tab.results.map((r) => r.id));
  closeSessions([tab.sessionId]);
  updateTab(tabId, (t) => ({
    ...t,
    connectionId,
    sessionId: null,
    txnPending: false,
    context: {},
    results: t.results.map((r) => (r.status === "running" ? { ...r, status: "cancelled", progress: null } : r)),
  }));
}

if (typeof window !== "undefined") {
  // Leaving the app (close / reload): end every IDE session so its database
  // connection and any open manual transaction are released right away
  // instead of waiting for the server's idle reaper.
  window.addEventListener("pagehide", (e) => {
    if ((e as PageTransitionEvent).persisted) return;
    closeSessions(getIdeState().tabs.map((t) => t.sessionId), true);
  });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface RunRequest {
  tabId: string;
  conn: Connection;
  statements: RanStatement[];
  kind: RunKind;
  /** Always open a new result tab (Ctrl+\). */
  newResultTab?: boolean;
  /** Label for a new result tab. */
  label?: string;
  docHash?: string | null;
  stopOnError?: boolean;
}

type RunListener = (e: { tabId: string; result: ResultTab }) => void;
const finishListeners = new Set<RunListener>();
/** Called whenever an execution reaches a terminal state. */
export function onRunFinished(cb: RunListener): () => void {
  finishListeners.add(cb);
  return () => finishListeners.delete(cb);
}

const cancelRequested = new Set<string>();

export async function runStatements(req: RunRequest): Promise<void> {
  const tab = getTab(req.tabId);
  if (!tab) return;
  const settings = getIdeSettings();
  const texts = req.statements.map((s) => s.text).filter((s) => s.trim());
  if (!texts.length) {
    toast.info("Nothing to run", { description: "Place the cursor in a statement or select some SQL." });
    return;
  }

  // Target result tab (DBeaver semantics): reuse the active result unless it
  // is pinned or running, or a new tab was asked for. Plans and row counts
  // always open their own tab, and a query never overwrites one of them —
  // it reuses the most recent ordinary result instead.
  const isData = (k: RunKind) => k === "statement" || k === "script";
  const reusable = (r: ResultTab | undefined): r is ResultTab =>
    !!r && !r.pinned && r.status !== "running" && isData(r.kind) && isData(req.kind);
  const active = tab.results.find((r) => r.id === tab.activeResultId);
  const candidate = req.newResultTab
    ? undefined
    : reusable(active)
      ? active
      : [...tab.results].reverse().find(reusable);
  const reuse = !!candidate;
  const target: ResultTab = candidate ?? newResultTab(req.label ?? nextResultLabel(tab.results), req.kind);
  const sql = texts.length === 1 ? texts[0] : texts.join(";\n");
  const started: ResultTab = {
    ...newResultTab(target.label, req.kind),
    id: target.id,
    label: target.label,
    status: "running",
    sql,
    statements: req.statements,
    docHash: req.docHash ?? null,
    startedAt: Date.now(),
    progress: { done: 0, total: texts.length },
    view: target.view === "messages" ? "grid" : target.view,
  };
  updateTab(req.tabId, (t) => ({
    ...t,
    results: reuse ? t.results.map((r) => (r.id === target.id ? started : r)) : [...t.results, started],
    activeResultId: started.id,
  }));

  const opts = {
    connectionId: req.conn.id,
    maxRows: settings.maxRows,
    context: contextToSend(tab, req.conn),
    statements: texts,
    autocommit: tab.autocommit,
    stopOnError: req.stopOnError ?? settings.stopOnError,
  };

  try {
    let sid = await ensureSession(req.tabId, req.conn);
    let ex: SqlExecution;
    try {
      ex = await api.executeQuery(sid, sql, opts);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      // Session expired (idle reaper) or the server restarted.
      const hadTxn = getTab(req.tabId)?.txnPending;
      updateTab(req.tabId, (t) => ({ ...t, sessionId: null, txnPending: false }));
      if (hadTxn) {
        toast.warning("The previous session ended", {
          description: "Its uncommitted transaction was rolled back by the server.",
        });
      }
      sid = await ensureSession(req.tabId, req.conn);
      ex = await api.executeQuery(sid, sql, opts);
    }
    if (!findResult(req.tabId, started.id)) {
      api.cancelExecution(sid, ex.exec_id).catch(() => {});
      return;
    }
    updateResult(req.tabId, started.id, (r) => ({ ...r, sessionId: sid, execId: ex.exec_id }));
    if (cancelRequested.delete(started.id)) api.cancelExecution(sid, ex.exec_id).catch(() => {});
    void poll(req.tabId, started.id, sid, ex.exec_id, req.conn);
  } catch (e) {
    cancelRequested.delete(started.id);
    finish(req.tabId, started.id, (r) => ({
      ...r,
      status: "error",
      error: errText(e),
      finishedAt: Date.now(),
      elapsedMs: Date.now() - (r.startedAt ?? Date.now()),
      progress: null,
      view: "messages",
    }));
  }
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

const polls = new Map<string, { stop: boolean }>();

export function stopPolling(rtIds: string[]): void {
  for (const id of rtIds) {
    const p = polls.get(id);
    if (p) p.stop = true;
    polls.delete(id);
  }
}

async function poll(tabId: string, rtId: string, sid: string, execId: string, conn: Connection) {
  const token = { stop: false };
  const prev = polls.get(rtId);
  if (prev) prev.stop = true;
  polls.set(rtId, token);
  let delay = 120;
  let failures = 0;
  try {
    while (!token.stop) {
      await sleep(delay);
      if (token.stop || !findResult(tabId, rtId)) return;
      let summary: SqlExecution;
      try {
        summary = await api.getExecution(sid, execId, { lightweight: true });
        failures = 0;
      } catch (e) {
        if (isNotFound(e)) {
          finish(tabId, rtId, (r) => ({
            ...r,
            status: "error",
            error: "The query session ended (server restarted or the session expired). Run the statement again.",
            progress: null,
            finishedAt: Date.now(),
            view: "messages",
          }));
          updateTab(tabId, (t) => (t.sessionId === sid ? { ...t, sessionId: null, txnPending: false } : t));
          return;
        }
        failures += 1;
        if (failures >= 8) {
          finish(tabId, rtId, (r) => ({
            ...r,
            status: "error",
            error: `Lost contact with the server while the query was running: ${errText(e)}`,
            progress: null,
            finishedAt: Date.now(),
            view: "messages",
          }));
          return;
        }
        delay = Math.min(delay * 2, 4000);
        continue;
      }

      if (summary.status === "queued" || summary.status === "running") {
        updateResult(tabId, rtId, (r) => {
          const total = summary.statement_total ?? r.progress?.total ?? r.statements.length;
          const done = Math.max(0, (summary.statement_count ?? 0) - (summary.status === "running" ? 1 : 0));
          if (r.progress && r.progress.done === done && r.progress.total === total && r.elapsedMs === summary.elapsed_ms) return r;
          return { ...r, progress: { done, total }, elapsedMs: summary.elapsed_ms };
        });
        delay = Math.min(1000, Math.round(delay * 1.35));
        continue;
      }

      // Terminal: fetch the first page of every result set once.
      let full: SqlExecution | null = null;
      for (let attempt = 0; attempt < 3 && !full; attempt++) {
        try {
          full = await api.getExecution(sid, execId, { offset: 0, limit: RESULT_PAGE_SIZE });
        } catch (e) {
          if (attempt === 2) {
            finish(tabId, rtId, (r) => ({
              ...r,
              status: "error",
              error: `Query finished but its result could not be loaded: ${errText(e)}`,
              progress: null,
              finishedAt: Date.now(),
            }));
            return;
          }
          await sleep(400 * (attempt + 1));
        }
      }
      if (!full || token.stop) return;
      applyFinal(tabId, rtId, full, conn);
      return;
    }
  } finally {
    if (polls.get(rtId) === token) polls.delete(rtId);
  }
}

function toSets(ex: SqlExecution): ResultSetView[] {
  const sets: ResultSetView[] = (ex.result_sets ?? []).map((rs) => ({
    index: rs.index,
    columns: rs.columns,
    rows: rs.rows,
    total: rs.total_rows ?? rs.row_count,
    truncated: rs.truncated,
    hasMore: rs.has_more ?? false,
    title: rs.title,
    statementIndex: rs.statement_index,
  }));
  if (!sets.length && ex.columns?.length) {
    sets.push({
      index: 0,
      columns: ex.columns,
      rows: ex.rows,
      total: ex.total_rows ?? ex.row_count,
      truncated: false,
      hasMore: ex.has_more ?? false,
    });
  }
  return sets;
}

function applyFinal(tabId: string, rtId: string, ex: SqlExecution, conn: Connection) {
  const sets = toSets(ex);
  const messages = (ex.messages ?? []) as StatementMessage[];
  const status = (ex.status === "queued" ? "running" : ex.status) as ResultTab["status"];
  const tab = getTab(tabId);
  const before = findResult(tabId, rtId);
  finish(tabId, rtId, (r) => ({
    ...r,
    status,
    sets,
    activeSet: 0,
    messages,
    errorStatementIndex: ex.error_statement_index ?? null,
    error: ex.error,
    affectedRows: ex.affected_rows,
    elapsedMs: ex.elapsed_ms,
    finishedAt: Date.now(),
    progress: null,
    view: sets.length === 0 ? "messages" : r.view === "messages" ? "grid" : r.view,
  }));

  if (tab && !tab.autocommit && messages.some((m) => m.status === "success" || m.status === "error")) {
    updateTab(tabId, (t) => ({ ...t, txnPending: true }));
  }

  // Query history (user statements only — not the EXPLAIN / COUNT wrappers).
  if (tab && before && (before.kind === "statement" || before.kind === "script")) {
    const { database, schema } = effectiveContext(tab, conn);
    const at = new Date().toISOString();
    const base = {
      at, connectionId: conn.id, connectionName: conn.name, dbType: conn.db_type, database, schema, scriptName: tab.name,
    };
    const items = messages
      .filter((m) => m.status !== "skipped" && m.status !== "running")
      .map((m) => ({
        ...base,
        sql: before.statements[m.index]?.text ?? m.sql,
        status: (m.status === "error" ? "error" : m.status === "cancelled" ? "cancelled" : "success") as
          "error" | "cancelled" | "success",
        rows: m.rows,
        affectedRows: m.affected_rows,
        elapsedMs: m.elapsed_ms,
        error: m.error,
      }));
    if (!items.length) {
      items.push({
        ...base,
        sql: before.sql,
        status: status === "error" ? "error" : status === "cancelled" ? "cancelled" : "success",
        rows: ex.row_count,
        affectedRows: ex.affected_rows,
        elapsedMs: ex.elapsed_ms,
        error: ex.error,
      });
    }
    addHistory(items);
  }

  // Notify when the user is elsewhere (another page or another window).
  const away = !pageState.mounted || (typeof document !== "undefined" && document.visibilityState === "hidden");
  if (away && tab) {
    const rows = sets[0]?.total;
    if (status === "success") {
      toast.success(`${tab.name}: query finished`, {
        description: `${rows != null ? `${formatNumber(rows)} rows · ` : ""}${formatDuration(ex.elapsed_ms)}`,
      });
    } else if (status === "error") {
      toast.error(`${tab.name}: query failed`, { description: (ex.error ?? "").slice(0, 200) });
    }
  }
}

function finish(tabId: string, rtId: string, fn: (r: ResultTab) => ResultTab) {
  updateResult(tabId, rtId, fn);
  const result = findResult(tabId, rtId);
  if (result) finishListeners.forEach((l) => l({ tabId, result }));
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export async function cancelRun(tabId: string, rtId: string): Promise<void> {
  const r = findResult(tabId, rtId);
  if (!r || r.status !== "running") return;
  if (!r.execId || !r.sessionId) {
    cancelRequested.add(rtId);
    return;
  }
  try {
    await api.cancelExecution(r.sessionId, r.execId);
  } catch (e) {
    // Already finished between the click and the request — the poll will pick it up.
    if (!/^400\b/.test(String((e as any)?.message))) toast.error("Cancel failed", { description: errText(e) });
  }
}

export function cancelAllRunning(tabId?: string): void {
  for (const t of getIdeState().tabs) {
    if (tabId && t.id !== tabId) continue;
    for (const r of t.results) if (r.status === "running") void cancelRun(t.id, r.id);
  }
}

// ---------------------------------------------------------------------------
// paging
// ---------------------------------------------------------------------------

/** Append the next window of rows for one result set (from server memory, no re-query). */
export async function loadMoreRows(tabId: string, rtId: string, setIdx: number, count = RESULT_PAGE_SIZE): Promise<void> {
  const r = findResult(tabId, rtId);
  const set = r?.sets[setIdx];
  if (!r || !set || !r.sessionId || !r.execId || !set.hasMore) return;
  const win = await api.getExecutionRows(r.sessionId, r.execId, set.rows.length, count, setIdx);
  updateResult(tabId, rtId, (cur) => {
    const s = cur.sets[setIdx];
    if (!s || s.rows.length !== set.rows.length) return cur; // raced with another load
    const sets = cur.sets.slice();
    sets[setIdx] = { ...s, rows: s.rows.concat(win.rows), hasMore: win.has_more, total: win.total_rows };
    return { ...cur, sets };
  });
}

/**
 * Every fetched row of a result set (loads the rest in 5k pages). Returns null
 * when stopped or when rows can no longer be loaded.
 */
export async function allRows(
  tabId: string, rtId: string, setIdx: number,
  opts: { keep?: boolean; shouldStop?: () => boolean; onProgress?: (n: number, total: number) => void } = {},
): Promise<any[][] | null> {
  const r = findResult(tabId, rtId);
  const set = r?.sets[setIdx];
  if (!r || !set) return null;
  const rows = set.rows.slice();
  if (!set.hasMore) return rows;
  if (!r.sessionId || !r.execId) {
    toast.error("The result's session is gone — re-run the query to load every row.");
    return null;
  }
  try {
    let more = true;
    while (more) {
      if (opts.shouldStop?.()) return null;
      const win = await api.getExecutionRows(r.sessionId, r.execId, rows.length, 5000, setIdx);
      if (!win.rows.length) break;
      rows.push(...win.rows);
      more = win.has_more;
      opts.onProgress?.(rows.length, win.total_rows);
    }
  } catch (e) {
    toast.error("Could not load all rows", { description: errText(e) });
    return null;
  }
  if (opts.keep) {
    updateResult(tabId, rtId, (cur) => {
      const sets = cur.sets.slice();
      if (!sets[setIdx]) return cur;
      sets[setIdx] = { ...sets[setIdx], rows, hasMore: false, total: rows.length };
      return { ...cur, sets };
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------------

export async function endTransaction(tabId: string, commit: boolean): Promise<boolean> {
  const tab = getTab(tabId);
  if (!tab) return false;
  if (!tab.sessionId) {
    updateTab(tabId, (t) => ({ ...t, txnPending: false }));
    return true;
  }
  if (tab.results.some((r) => r.status === "running")) {
    toast.error("Wait for the running query to finish (or cancel it) first");
    return false;
  }
  try {
    const res = commit ? await api.commitSession(tab.sessionId) : await api.rollbackSession(tab.sessionId);
    updateTab(tabId, (t) => ({ ...t, txnPending: false }));
    toast.success(commit ? "Transaction committed" : "Transaction rolled back", {
      description: formatDuration(res.elapsed_ms),
    });
    return true;
  } catch (e) {
    if (isNotFound(e)) {
      updateTab(tabId, (t) => ({ ...t, sessionId: null, txnPending: false }));
      toast.warning("Session already ended", { description: "Nothing left to commit — the server rolled it back." });
      return true;
    }
    toast.error(commit ? "Commit failed" : "Rollback failed", { description: errText(e) });
    return false;
  }
}
