/**
 * SQL IDE page - layout and command wiring.
 *
 *  ┌──┬────────────┬───────────────────────────────────────────────┐
 *  │A │ Side bar   │ Script tabs                                    │
 *  │c │ (Explorer, │ Toolbar: run · connection/db/schema · txn      │
 *  │t │  Scripts,  │ Editor (CodeMirror 6, GitHub theme)            │
 *  │i │  History)  │──────────────────── drag ──────────────────────│
 *  │v │            │ Results: tabs · grid/text/record/messages      │
 *  ├──┴────────────┴───────────────────────────────────────────────┤
 *  │ Status bar                                                     │
 *  └───────────────────────────────────────────────────────────────┘
 *
 * State lives in ideStore (survives route changes), execution in ideRunner,
 * preferences in ideSettings, commands/shortcuts in ideCommands.
 */
import * as React from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Command, Database, FileCode2, History as HistoryIcon, Keyboard, Loader2, Maximize, Minimize, PanelLeftClose,
  Plug, Settings2, X,
} from "lucide-react";
import { api, type Connection, type SqlExecution } from "@/api/client";
import { ConnectionForm } from "@/components/ConnectionForm";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { CodeEditor, type CursorInfo, type SqlEditorHandle } from "@/components/sql-ide/CodeEditor";
import { PlainEditor } from "@/components/sql-ide/PlainEditor";
import { CommandPalette, type PaletteExtra } from "@/components/sql-ide/CommandPalette";
import { EditorTabs } from "@/components/sql-ide/EditorTabs";
import { ExplorerView } from "@/components/sql-ide/ExplorerView";
import { HistoryView } from "@/components/sql-ide/HistoryView";
import { ResultsPanel, StatusIcon } from "@/components/sql-ide/ResultsPanel";
import { ScriptsView } from "@/components/sql-ide/ScriptsView";
import { SettingsDialog } from "@/components/sql-ide/SettingsDialog";
import { StatusBar } from "@/components/sql-ide/StatusBar";
import { Toolbar } from "@/components/sql-ide/Toolbar";
import { VisualDiffPanel, type DiffSource } from "@/components/sql-ide/VisualDiff";
import { setCursorInfo } from "@/components/sql-ide/cursorStore";
import { commandForEvent, shortcutLabel, type IdeCommandId } from "@/components/sql-ide/ideCommands";
import {
  allRows, cancelAllRunning, cancelRun, changeTabConnection, closeSessions, endTransaction, onRunFinished, runStatements,
  stopPolling,
} from "@/components/sql-ide/ideRunner";
import {
  getIdeState, getTab, hashText, newScriptTab, nextScriptName, pageState, setIdeState, updateTab, useIdeState,
  type ResultTab, type ScriptTab,
} from "@/components/sql-ide/ideStore";
import {
  isProductionConnection, loadLayout, saveLayout, updateIdeSettings, useIdeSettings, type IdeLayout,
} from "@/components/sql-ide/ideSettings";
import { useConnectionContext } from "@/components/sql-ide/useConnectionContext";
import { ConfirmHost, IconButton, ParamsHost, ResizeHandle, confirmDialog, promptParams } from "@/components/sql-ide/ui";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { downloadBlob, nowStamp, toCsv } from "@/lib/export";
import { errorRange } from "@/lib/sqlErrors";
import { isModifyingStatement, normalizeDialect, splitSqlStatements, type SqlStatement } from "@/lib/sqlSplit";
import { countStatement, explainStatements, isCountable } from "@/lib/sqlWrap";
import { findParams, paramNames, substituteParams } from "@/lib/sqlParams";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import type { HistoryEntry } from "@/components/sql-ide/queryHistory";

const EMPTY_CONNS: Connection[] = [];
const EMPTY_TABLES: string[] = [];
const MAX_COLUMN_TABLES = 12;

type SaveDialogState = { tabId: string; name: string; saving: boolean } | null;

export function SqlIdePage() {
  const qc = useQueryClient();
  const connsQuery = useQuery({ queryKey: ["connections"], queryFn: api.listConnections, staleTime: 30_000 });
  const connections = connsQuery.data ?? EMPTY_CONNS;
  const state = useIdeState();
  const settings = useIdeSettings();
  const tab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0];
  const conn = connections.find((c) => c.id === tab.connectionId);
  const ctx = useConnectionContext(conn, tab.context);

  const editorRef = React.useRef<SqlEditorHandle>(null);
  const commandsRef = React.useRef<Partial<Record<IdeCommandId, () => void>>>({});
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const activeTabIdRef = React.useRef(tab.id);
  activeTabIdRef.current = tab.id;

  // ---- layout ---------------------------------------------------------------
  const [layout, setLayoutState] = React.useState<IdeLayout>(loadLayout);
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const setLayout = React.useCallback((patch: Partial<IdeLayout>, persist = true) => {
    setLayoutState((l) => {
      const n = { ...l, ...patch };
      if (persist) saveLayout(n);
      return n;
    });
  }, []);
  const dragBase = React.useRef(0);
  const [zen, setZen] = React.useState(false);

  // ---- dialogs ----------------------------------------------------------------
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [newConnOpen, setNewConnOpen] = React.useState(false);
  const [diffOpen, setDiffOpen] = React.useState(false);
  const [diffIds, setDiffIds] = React.useState<[string, string] | null>(null);
  const [trackerOpen, setTrackerOpen] = React.useState(false);
  const [ddlOpen, setDdlOpen] = React.useState(false);
  const [saveDlg, setSaveDlg] = React.useState<SaveDialogState>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const closedTabs = React.useRef<ScriptTab[]>([]);
  const [closedCount, setClosedCount] = React.useState(0);

  // ---- lifecycle ----------------------------------------------------------------
  React.useEffect(() => {
    pageState.mounted = true;
    return () => {
      pageState.mounted = false;
      setCursorInfo(null);
    };
  }, []);

  React.useEffect(() => {
    window.dispatchEvent(new CustomEvent("dv:zen", { detail: zen }));
  }, [zen]);
  React.useEffect(() => () => void window.dispatchEvent(new CustomEvent("dv:zen", { detail: false })), []);

  // ---- completion data -------------------------------------------------------------
  const completionTables = useQuery({
    queryKey: ["completion-tables", conn?.id ?? null, ctx.database, ctx.schema],
    queryFn: async () => (await api.listTables(conn!.id, ctx.database || undefined, ctx.schema || undefined)).tables ?? [],
    enabled: !!conn,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
  });
  const tables = completionTables.data ?? EMPTY_TABLES;

  const referenced = React.useMemo(() => {
    if (!tables.length || !tab.sql) return EMPTY_TABLES;
    const known = new Map(tables.map((t) => [t.toLowerCase(), t]));
    const found = new Set<string>();
    const re = /\b(?:from|join|update|into|table)\s+(?:[\w$"`\[\]]+\.)?["`\[]?([A-Za-z_][\w$#]*)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tab.sql)) && found.size < MAX_COLUMN_TABLES) {
      const hit = known.get(m[1].toLowerCase());
      if (hit) found.add(hit);
    }
    return found.size ? [...found].sort() : EMPTY_TABLES;
  }, [tab.sql, tables]);

  const columnQueries = useQueries({
    queries: referenced.map((t) => ({
      queryKey: ["ide-columns", conn?.id ?? null, ctx.database, ctx.schema, t],
      queryFn: async () => (await api.listColumns(conn!.id, t, ctx.database || undefined, ctx.schema || undefined)).columns ?? [],
      enabled: !!conn,
      staleTime: 10 * 60_000,
      gcTime: 60 * 60_000,
    })),
  });
  const columnsSig = columnQueries.map((q) => (q.data ? q.dataUpdatedAt : 0)).join(",") + "|" + referenced.join(",");
  const editorColumns = React.useMemo(() => {
    const out: Record<string, string[]> = {};
    referenced.forEach((t, i) => {
      const d = columnQueries[i]?.data;
      if (d) out[t] = d.map((c) => c.name);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsSig]);

  // ---- tab helpers -------------------------------------------------------------------
  const activate = React.useCallback((id: string) => {
    setIdeState((s) => (s.activeTabId === id ? s : { ...s, activeTabId: id }));
  }, []);

  const createTab = React.useCallback(
    (init: Partial<ScriptTab> = {}, opts: { activate?: boolean } = {}) => {
      const cur = getTab(getIdeState().activeTabId);
      const connectionId = init.connectionId !== undefined ? init.connectionId : cur?.connectionId ?? null;
      const t = newScriptTab({
        name: nextScriptName(getIdeState().tabs),
        connectionId,
        context: connectionId === cur?.connectionId ? { ...(cur?.context ?? {}) } : {},
        autocommit: settings.defaultAutocommit,
        ...init,
      });
      setIdeState((s) => {
        const idx = s.tabs.findIndex((x) => x.id === s.activeTabId);
        const tabs = s.tabs.slice();
        tabs.splice(idx + 1, 0, t);
        return { tabs, activeTabId: opts.activate === false ? s.activeTabId : t.id };
      });
      return t;
    },
    [settings.defaultAutocommit],
  );

  const closeTabs = React.useCallback(
    async (ids: string[]) => {
      const s = getIdeState();
      const closing = s.tabs.filter((t) => ids.includes(t.id));
      if (!closing.length) return;
      const pending = closing.filter((t) => t.txnPending);
      if (pending.length) {
        const answer = await confirmDialog({
          title: pending.length === 1 ? `“${pending[0].name}” has an uncommitted transaction` : `${pending.length} scripts have uncommitted transactions`,
          description: "Closing rolls the changes back. Commit them first if you want to keep them.",
          confirmLabel: "Roll back and close",
          alternateLabel: "Commit and close",
          danger: true,
        });
        if (answer === false) return;
        if (answer === "alternate") {
          for (const t of pending) if (!(await endTransaction(t.id, true))) return;
        }
      }
      for (const t of closing) {
        stopPolling(t.results.map((r) => r.id));
        for (const r of t.results) if (r.status === "running") void cancelRun(t.id, r.id);
        editorRef.current?.forget(t.id);
      }
      closeSessions(closing.map((t) => t.sessionId));
      const withContent = closing.filter((t) => t.sql.trim());
      closedTabs.current.push(
        ...withContent.map((t) => ({ ...t, sessionId: null, txnPending: false, results: [], activeResultId: null })),
      );
      closedTabs.current = closedTabs.current.slice(-20);
      setClosedCount(closedTabs.current.length);
      setIdeState((st) => {
        const remaining = st.tabs.filter((t) => !ids.includes(t.id));
        if (!remaining.length) {
          const keep = closing.find((t) => t.id === st.activeTabId) ?? closing[0];
          const fresh = newScriptTab({
            name: "Script 1",
            connectionId: keep?.connectionId ?? null,
            context: keep?.context ?? {},
            autocommit: settings.defaultAutocommit,
          });
          return { tabs: [fresh], activeTabId: fresh.id };
        }
        let activeTabId = st.activeTabId;
        if (ids.includes(activeTabId)) {
          const oldIdx = st.tabs.findIndex((t) => t.id === activeTabId);
          const after = st.tabs.slice(oldIdx + 1).find((t) => !ids.includes(t.id));
          const before = st.tabs.slice(0, oldIdx).reverse().find((t) => !ids.includes(t.id));
          activeTabId = (after ?? before ?? remaining[0]).id;
        }
        return { tabs: remaining, activeTabId };
      });
      if (withContent.length === 1) {
        toast(`Closed “${withContent[0].name}”`, {
          action: { label: "Undo", onClick: () => commandsRef.current["script.reopen"]?.() },
          duration: 5000,
        });
      }
    },
    [settings.defaultAutocommit],
  );

  const reopenClosed = React.useCallback(() => {
    const t = closedTabs.current.pop();
    setClosedCount(closedTabs.current.length);
    if (!t) return;
    setIdeState((s) => ({ tabs: [...s.tabs.filter((x) => x.id !== t.id), t], activeTabId: t.id }));
  }, []);

  const workspaceKeyFor = React.useCallback(
    (connId: number) => {
      const c = connections.find((x) => x.id === connId);
      return c ? `${c.name}-${c.id}` : `conn-${connId}`;
    },
    [connections],
  );

  // ---- editor callbacks ------------------------------------------------------------
  const onEditorChange = React.useCallback((id: string, text: string) => {
    updateTab(id, (t) => (t.sql === text ? t : { ...t, sql: text }));
  }, []);
  const onCursor = React.useCallback((info: CursorInfo) => setCursorInfo(info), []);

  const insertText = React.useCallback((text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.insertAtCursor(text, { newLine: true });
  }, []);

  // ---- running ------------------------------------------------------------------------
  const runRef = React.useRef<(mode: "statement" | "script" | "newTab" | "explain" | "count", explicit?: SqlStatement) => void>();
  runRef.current = async (mode, explicit) => {
    const t = getTab(activeTabIdRef.current);
    const ed = editorRef.current;
    if (!t || !ed) return;
    const c = connections.find((x) => x.id === t.connectionId);
    if (!c) {
      toast.error("Choose a connection first", { description: "Use the connection chip in the toolbar." });
      return;
    }
    const sel = ed.getSelection();
    let stmts: SqlStatement[];
    if (explicit) stmts = [explicit];
    else if (sel.text.trim()) {
      stmts = splitSqlStatements(sel.text, c.db_type, { blankLineDelimiter: settings.blankLineDelimiter }).map((s) => ({
        text: s.text,
        from: s.from + sel.from,
        to: s.to + sel.from,
      }));
    } else if (mode === "script") stmts = ed.getStatements();
    else {
      const cur = ed.getCurrentStatement();
      stmts = cur ? [cur] : [];
    }
    if (!stmts.length) {
      toast.info(mode === "script" ? "The script is empty" : "No statement at the cursor", {
        description: mode === "script" ? undefined : "Put the cursor inside a statement, or select the SQL to run.",
      });
      return;
    }
    if ((mode === "explain" || mode === "count") && stmts.length > 1) stmts = [stmts[0]];

    const kind = mode === "explain" ? "explain" : mode === "count" ? "count" : mode === "script" || stmts.length > 1 ? "script" : "statement";
    if (kind === "count" && !isCountable(stmts[0].text)) {
      toast.info("Count rows works on queries (SELECT / WITH)");
      return;
    }
    // Parameters / variables (DBeaver: ":id", "${since}").
    const refs = stmts.map((s) => findParams(s.text, { named: settings.namedParameters }));
    const names = paramNames(refs.flat());
    if (names.length) {
      const values = await promptParams(names);
      if (!values) return;
      stmts = stmts.map((s, i) => (refs[i].length ? { ...s, text: substituteParams(s.text, refs[i], values) } : s));
    }

    if (
      (kind === "statement" || kind === "script") &&
      settings.confirmModifyingOnProduction &&
      isProductionConnection(c.id, settings)
    ) {
      const modifying = stmts.filter((s) => isModifyingStatement(s.text));
      if (modifying.length) {
        const ok = await confirmDialog({
          title: `Run on production “${c.name}”?`,
          description: (
            <div className="space-y-2">
              <p>
                {modifying.length === 1 ? "This statement changes" : `${modifying.length} statements change`} data or schema
                {t.autocommit ? " and will be committed immediately (auto-commit)." : " (manual commit - you can still roll back)."}
              </p>
              <pre className="max-h-40 overflow-auto rounded-md border bg-muted/50 p-2 font-mono text-[11px] text-foreground">
                {modifying[0].text.slice(0, 800)}
              </pre>
            </div>
          ),
          confirmLabel: "Run",
          danger: true,
        });
        if (ok !== true) return;
      }
    }

    ed.setDiagnostics([]);
    ed.flashRange(stmts[0].from, stmts[stmts.length - 1].to);
    if (!layoutRef.current.resultsVisible) setLayout({ resultsVisible: true });
    const docHash = hashText(ed.getText());
    const dialect = normalizeDialect(c.db_type);

    if (kind === "explain") {
      const w = explainStatements(dialect, stmts[0].text);
      void runStatements({
        tabId: t.id, conn: c, kind, newResultTab: true, label: "Plan", docHash, stopOnError: w.stopOnError,
        statements: w.statements.map((text) => ({ text, from: stmts[0].from, to: stmts[0].to })),
      });
    } else if (kind === "count") {
      void runStatements({
        tabId: t.id, conn: c, kind, newResultTab: true, label: "Count", docHash,
        statements: [{ text: countStatement(stmts[0].text), from: stmts[0].from, to: stmts[0].to }],
      });
    } else {
      void runStatements({
        tabId: t.id, conn: c, kind, newResultTab: mode === "newTab", docHash,
        statements: stmts.map((s) => ({ text: s.text, from: s.from, to: s.to })),
      });
    }
  };
  const run = React.useCallback((mode: Parameters<NonNullable<typeof runRef.current>>[0], explicit?: SqlStatement) => {
    void runRef.current?.(mode, explicit);
  }, []);
  const onRunStatementAt = React.useCallback((s: SqlStatement) => run("statement", s), [run]);

  // "Run in new tab" (explorer, history): run once the editor shows the new
  // tab, through the normal path (parameters, production confirmation).
  // Child effects run first, so the editor has already switched documents.
  const pendingRun = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (pendingRun.current && pendingRun.current === tab.id) {
      pendingRun.current = null;
      run("script");
    }
  }, [tab.id, run]);

  // Underline the failing statement / token when a run errors.
  React.useEffect(
    () =>
      onRunFinished(({ tabId, result }) => {
        if (result.status !== "error" || result.errorStatementIndex == null) return;
        if (tabId !== activeTabIdRef.current) return;
        const ed = editorRef.current;
        if (!ed) return;
        const idx = result.kind === "explain" || result.kind === "count" ? 0 : result.errorStatementIndex;
        const st = result.statements[idx];
        if (!st || st.from < 0) return;
        const doc = ed.getText();
        const original = doc.slice(st.from, st.to);
        const sameDoc = hashText(doc) === result.docHash;
        if (!sameDoc && result.kind !== "explain" && result.kind !== "count" && original !== st.text) return;
        const msg = result.messages.find((m) => m.index === result.errorStatementIndex)?.error ?? result.error ?? "Error";
        const range =
          result.kind === "explain" || result.kind === "count"
            ? errorRange("", original, st.from)
            : errorRange(msg, st.text, st.from);
        ed.setDiagnostics([{ ...range, message: msg, severity: "error" }]);
      }),
    [],
  );

  const gotoStatement = React.useCallback((rt: ResultTab, index: number) => {
    const ed = editorRef.current;
    const st = rt.statements[rt.kind === "explain" || rt.kind === "count" ? 0 : index];
    if (!ed || !st || st.from < 0) return;
    const doc = ed.getText();
    if (doc.slice(st.from, st.to) === st.text || rt.kind === "explain" || rt.kind === "count") {
      ed.setSelection(st.from, Math.min(st.to, doc.length));
      return;
    }
    const at = doc.indexOf(st.text);
    if (at >= 0) ed.setSelection(at, at + st.text.length);
    else toast.info("That statement has changed since it ran");
  }, []);

  // ---- library -------------------------------------------------------------------------
  const saveScript = React.useCallback(
    async (tabId: string, name: string) => {
      const t = getTab(tabId);
      if (!t || t.connectionId == null) return false;
      const ws = workspaceKeyFor(t.connectionId);
      const sql = t.id === activeTabIdRef.current && editorRef.current ? editorRef.current.getText() : t.sql;
      try {
        const res = await api.saveScript(ws, name, sql);
        updateTab(tabId, (x) => ({ ...x, name, libraryName: name, savedHash: hashText(sql), sql }));
        void qc.invalidateQueries({ queryKey: ["scripts", ws] });
        toast.success(res.version_count > 1 ? `Saved “${name}” (version ${res.version_count})` : `Saved “${name}”`);
        return true;
      } catch (e: any) {
        toast.error("Could not save the script", { description: e?.message });
        return false;
      }
    },
    [qc, workspaceKeyFor],
  );

  const openSaved = React.useCallback(
    async (connId: number, name: string, version?: string) => {
      const ws = workspaceKeyFor(connId);
      if (!version) {
        const existing = getIdeState().tabs.find((t) => t.connectionId === connId && t.libraryName === name);
        if (existing) {
          activate(existing.id);
          return;
        }
      }
      try {
        const res = version ? await api.loadScriptVersion(ws, name, version) : await api.loadScript(ws, name);
        createTab({
          name: version ? `${name} @${version}` : name,
          connectionId: connId,
          sql: res.content,
          libraryName: version ? null : name,
          savedHash: version ? null : hashText(res.content),
        });
      } catch (e: any) {
        toast.error("Could not open the script", { description: e?.message });
      }
    },
    [activate, createTab, workspaceKeyFor],
  );

  // ---- connection / context -------------------------------------------------------------
  const setConnection = React.useCallback(
    async (id: number | null) => {
      const t = getTab(activeTabIdRef.current);
      if (!t || t.connectionId === id) return;
      if (t.txnPending) {
        const ok = await confirmDialog({
          title: "Switch connection and roll back?",
          description: "This script has an uncommitted transaction on the current connection. Switching rolls it back.",
          confirmLabel: "Roll back and switch",
          danger: true,
        });
        if (ok !== true) return;
      }
      changeTabConnection(t.id, id);
    },
    [],
  );

  const setContext = React.useCallback((patch: Partial<ScriptTab["context"]>) => {
    updateTab(activeTabIdRef.current, (t) => ({ ...t, context: { ...t.context, ...patch } }));
  }, []);

  // ---- commands --------------------------------------------------------------------------
  const activeResult = tab.results.find((r) => r.id === tab.activeResultId);
  const running = tab.results.some((r) => r.status === "running");

  const toggleSidebarView = (view: IdeLayout["sidebarView"]) =>
    setLayout({ sidebarView: layoutRef.current.sidebarView === view ? null : view });

  commandsRef.current = {
    "run.statement": () => run("statement"),
    "run.script": () => run("script"),
    "run.newTab": () => run("newTab"),
    "run.explain": () => run("explain"),
    "run.count": () => run("count"),
    "run.stop": () => cancelAllRunning(activeTabIdRef.current),
    "edit.format": () => void editorRef.current?.format(),
    "edit.comment": () => editorRef.current?.command("comment"),
    "edit.blockComment": () => editorRef.current?.command("blockComment"),
    "edit.upper": () => editorRef.current?.command("upper"),
    "edit.lower": () => editorRef.current?.command("lower"),
    "edit.find": () => editorRef.current?.command("find"),
    "edit.replace": () => editorRef.current?.command("replace"),
    "edit.gotoLine": () => editorRef.current?.command("gotoLine"),
    "edit.nextStatement": () => editorRef.current?.command("nextStatement"),
    "edit.prevStatement": () => editorRef.current?.command("prevStatement"),
    "edit.selectStatement": () => editorRef.current?.command("selectStatement"),
    "edit.complete": () => editorRef.current?.command("complete"),
    "script.new": () => createTab(),
    "script.close": () => void closeTabs([activeTabIdRef.current]),
    "script.rename": () => setRenamingId(activeTabIdRef.current),
    "script.duplicate": () => {
      const t = getTab(activeTabIdRef.current);
      if (t) createTab({ name: `${t.name} (copy)`, connectionId: t.connectionId, context: { ...t.context }, sql: editorRef.current?.getText() ?? t.sql, autocommit: t.autocommit });
    },
    "script.save": () => {
      const t = getTab(activeTabIdRef.current);
      if (!t) return;
      if (t.connectionId == null) {
        toast.error("Choose a connection first", { description: "Scripts are saved per connection." });
        return;
      }
      if (t.libraryName) void saveScript(t.id, t.libraryName);
      else setSaveDlg({ tabId: t.id, name: t.name, saving: false });
    },
    "script.saveAs": () => {
      const t = getTab(activeTabIdRef.current);
      if (!t) return;
      if (t.connectionId == null) {
        toast.error("Choose a connection first", { description: "Scripts are saved per connection." });
        return;
      }
      setSaveDlg({ tabId: t.id, name: t.libraryName ?? t.name, saving: false });
    },
    "script.library": () => setLayout({ sidebarView: "scripts" }),
    "script.import": () => fileInputRef.current?.click(),
    "script.export": () => {
      const t = getTab(activeTabIdRef.current);
      if (!t) return;
      downloadBlob(editorRef.current?.getText() ?? t.sql, `${t.name.replace(/[^\w.-]+/g, "_") || "script"}.sql`, "application/sql");
    },
    "script.reopen": reopenClosed,
    "view.palette": () => setPaletteOpen(true),
    "view.toggleResults": () => setLayout({ resultsVisible: !layoutRef.current.resultsVisible, resultsMaximized: false }),
    "view.maximizeResults": () => setLayout({ resultsMaximized: !layoutRef.current.resultsMaximized, resultsVisible: true }),
    "view.toggleSidebar": () =>
      setLayout({ sidebarView: layoutRef.current.sidebarView ? null : (lastSidebar.current ?? "explorer") }),
    "view.explorer": () => toggleSidebarView("explorer"),
    "view.scripts": () => toggleSidebarView("scripts"),
    "view.history": () => toggleSidebarView("history"),
    "view.wordWrap": () => updateIdeSettings({ wordWrap: !settings.wordWrap }),
    "view.zoomIn": () => updateIdeSettings({ fontSize: Math.min(24, settings.fontSize + 1) }),
    "view.zoomOut": () => updateIdeSettings({ fontSize: Math.max(10, settings.fontSize - 1) }),
    "view.zen": () => setZen((z) => !z),
    "view.settings": () => setSettingsOpen(true),
    "view.shortcuts": () => setShortcutsOpen(true),
    "view.valuePanel": () => setLayout({ valuePanel: !layoutRef.current.valuePanel }),
    "view.focusEditor": () => editorRef.current?.focus(),
    "results.fetchAll": () => {
      const t = getTab(activeTabIdRef.current);
      const r = t?.results.find((x) => x.id === t.activeResultId);
      if (!t || !r || !r.sets[r.activeSet]?.hasMore) return;
      const id = toast.loading("Loading all rows…");
      void allRows(t.id, r.id, r.activeSet, { keep: true }).then((rows) => {
        toast.dismiss(id);
        if (rows) toast.success(`All ${formatNumber(rows.length)} rows loaded`);
      });
    },
    "results.exportCsv": () => {
      const t = getTab(activeTabIdRef.current);
      const r = t?.results.find((x) => x.id === t.activeResultId);
      const set = r?.sets[r.activeSet];
      if (!t || !r || !set) {
        toast.info("No result to export");
        return;
      }
      void allRows(t.id, r.id, r.activeSet).then((rows) => {
        if (rows) downloadBlob(toCsv(set.columns, rows), `${t.name.replace(/[^\w.-]+/g, "_")}_${nowStamp()}.csv`, "text/csv");
      });
    },
    "results.diff": () => setDiffOpen(true),
    "results.closeTab": () => {
      const t = getTab(activeTabIdRef.current);
      if (!t?.activeResultId) return;
      const id = t.activeResultId;
      stopPolling([id]);
      updateTab(t.id, (x) => {
        const results = x.results.filter((r) => r.id !== id);
        return { ...x, results, activeResultId: results[results.length - 1]?.id ?? null };
      });
    },
    "txn.commit": () => void endTransaction(activeTabIdRef.current, true),
    "txn.rollback": () => void endTransaction(activeTabIdRef.current, false),
    "txn.toggleMode": async () => {
      const t = getTab(activeTabIdRef.current);
      if (!t) return;
      if (!t.autocommit && t.txnPending) {
        const answer = await confirmDialog({
          title: "Finish the open transaction first",
          description: "Switching back to auto-commit needs the current transaction to be committed or rolled back.",
          confirmLabel: "Commit and switch",
          alternateLabel: "Roll back and switch",
        });
        if (answer === false) return;
        if (!(await endTransaction(t.id, answer === true))) return;
      }
      updateTab(t.id, (x) => ({ ...x, autocommit: !x.autocommit }));
      toast.info(t.autocommit ? "Manual commit: changes stay pending until you Commit" : "Auto-commit on");
    },
    "conn.new": () => setNewConnOpen(true),
    "conn.refresh": () => {
      void qc.invalidateQueries({ queryKey: ["ide-objects"] });
      void qc.invalidateQueries({ queryKey: ["ide-columns"] });
      void qc.invalidateQueries({ queryKey: ["completion-tables"] });
      void qc.invalidateQueries({ queryKey: ["sql-ide-databases"] });
      void qc.invalidateQueries({ queryKey: ["sql-ide-schemas"] });
      void qc.invalidateQueries({ queryKey: ["sql-ide-sf-context"] });
      toast.success("Metadata refreshed");
    },
    "tools.ddl": () => setDdlOpen(true),
    "tools.queryManager": () => setTrackerOpen(true),
  };
  const lastSidebar = React.useRef<IdeLayout["sidebarView"]>(layout.sidebarView ?? "explorer");
  if (layout.sidebarView) lastSidebar.current = layout.sidebarView;

  const runCommand = React.useCallback((id: IdeCommandId) => {
    commandsRef.current[id]?.();
  }, []);

  // Page-level shortcuts (the editor handles its own keys first).
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".cm-editor")) return; // CodeMirror keymap already ran
      if (target?.closest("[role=dialog],[role=alertdialog],[role=menu]")) return;
      const cmd = commandForEvent(e);
      if (!cmd || cmd.scope === "editor") return;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      // In text fields only accept chords with Ctrl/Alt or function keys.
      if (typing && !(e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key))) return;
      if (typing && target!.closest(".dv-plain-editor")) return; // plain editor handles its keys
      e.preventDefault();
      e.stopPropagation();
      commandsRef.current[cmd.id]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- derived data ------------------------------------------------------------------------
  const diffSources = React.useMemo<DiffSource[]>(() => {
    const out: DiffSource[] = [];
    for (const t of state.tabs) {
      for (const r of t.results) {
        if (r.status !== "success") continue;
        r.sets.forEach((s, i) => {
          if (!s.columns.length) return;
          out.push({
            id: `${r.id}:${i}`,
            tabId: t.id,
            rtId: r.id,
            setIdx: i,
            scriptName: t.name,
            label: r.sets.length > 1 ? `${r.label} · set ${i + 1}` : r.label,
            columns: s.columns,
            rows: s.rows,
            total: s.total,
            truncated: s.truncated,
            hasMore: s.hasMore,
            execId: r.execId,
            sql: r.statements[s.statementIndex ?? 0]?.text ?? r.sql,
            elapsedMs: r.elapsedMs,
          });
        });
      }
    }
    return out;
  }, [state.tabs]);

  const paletteExtras = React.useMemo<PaletteExtra[]>(
    () => [
      ...state.tabs.map((t) => ({
        id: `tab:${t.id}`,
        label: `Go to script: ${t.name}`,
        hint: connections.find((c) => c.id === t.connectionId)?.name,
        group: "Scripts" as const,
        run: () => activate(t.id),
      })),
      ...connections.map((c) => ({
        id: `conn:${c.id}`,
        label: `Use connection: ${c.name}`,
        hint: c.db_type,
        group: "Connections" as const,
        run: () => void setConnection(c.id),
      })),
    ],
    [state.tabs, connections, activate, setConnection],
  );

  const isEnabled = React.useCallback(
    (id: IdeCommandId) => {
      if (id.startsWith("run.") && id !== "run.stop") return !!conn;
      if (id === "run.stop") return running;
      if (id === "txn.commit" || id === "txn.rollback") return !tab.autocommit;
      if (id === "results.diff") return diffSources.length >= 2;
      if (id === "script.reopen") return closedCount > 0;
      return true;
    },
    [conn, running, tab.autocommit, diffSources.length, closedCount],
  );

  // ---- render ------------------------------------------------------------------------------
  const showSidebar = !!layout.sidebarView && !zen;
  const resultsShown = layout.resultsVisible;
  const maximized = resultsShown && layout.resultsMaximized;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
      <input
        ref={fileInputRef}
        type="file"
        accept=".sql,.txt"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          f.text().then((text) => {
            createTab({ name: f.name.replace(/\.(sql|txt)$/i, ""), sql: text });
            toast.success(`Imported ${f.name}`);
          });
        }}
      />

      <div className="flex min-h-0 flex-1">
        {/* activity bar */}
        {!zen && (
          <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r bg-muted/40 py-2" aria-label="IDE views">
            <ActivityButton icon={Database} label="Database explorer" shortcut={shortcutLabel("view.explorer")} active={layout.sidebarView === "explorer"} onClick={() => toggleSidebarView("explorer")} />
            <ActivityButton icon={FileCode2} label="Scripts" active={layout.sidebarView === "scripts"} onClick={() => toggleSidebarView("scripts")} />
            <ActivityButton icon={HistoryIcon} label="Query history" shortcut={shortcutLabel("view.history")} active={layout.sidebarView === "history"} onClick={() => toggleSidebarView("history")} />
            <div className="flex-1" />
            <ActivityButton icon={Command} label="Command palette" shortcut={shortcutLabel("view.palette")} onClick={() => setPaletteOpen(true)} />
            <ActivityButton icon={Keyboard} label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)} />
            <ActivityButton icon={Settings2} label="Editor settings" shortcut={shortcutLabel("view.settings")} onClick={() => setSettingsOpen(true)} />
            <ActivityButton icon={Maximize} label="Focus mode" shortcut={shortcutLabel("view.zen")} onClick={() => setZen(true)} />
          </nav>
        )}

        {/* side bar */}
        {showSidebar && (
          <>
            <aside className="flex min-h-0 shrink-0 flex-col bg-card" style={{ width: layout.sidebarWidth }}>
              <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-1">
                <span className="flex-1 truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {layout.sidebarView === "explorer" ? "Database" : layout.sidebarView === "scripts" ? "Scripts" : "History"}
                </span>
                {layout.sidebarView === "explorer" && (
                  <IconButton size="sm" icon={Plug} label="New connection" onClick={() => setNewConnOpen(true)} />
                )}
                <IconButton size="sm" icon={PanelLeftClose} label="Hide side bar" shortcut={shortcutLabel("view.toggleSidebar")} onClick={() => setLayout({ sidebarView: null })} />
              </div>
              <div className="min-h-0 flex-1">
                {layout.sidebarView === "explorer" && (
                  <ExplorerView
                    conn={conn}
                    database={ctx.database}
                    schema={ctx.schema}
                    onInsert={insertText}
                    onOpenInNewTab={(sql, name, doRun) => {
                      const t = createTab({ name, sql });
                      if (doRun) pendingRun.current = t.id;
                    }}
                  />
                )}
                {layout.sidebarView === "scripts" && (
                  <ScriptsView
                    connections={connections}
                    tabs={state.tabs}
                    activeTabId={tab.id}
                    activeConnectionId={tab.connectionId}
                    workspaceKeyFor={workspaceKeyFor}
                    onActivateTab={activate}
                    onNewScript={(connId) => createTab({ connectionId: connId, context: {} })}
                    onOpenSaved={(connId, name, version) => void openSaved(connId, name, version)}
                    onNewConnection={() => setNewConnOpen(true)}
                  />
                )}
                {layout.sidebarView === "history" && (
                  <HistoryView
                    connectionId={tab.connectionId}
                    onInsert={insertText}
                    onOpenInNewTab={(e: HistoryEntry, doRun) => {
                      const target = connections.find((c) => c.id === e.connectionId) ?? conn;
                      const t = createTab({
                        name: nextScriptName(getIdeState().tabs, "History"),
                        sql: e.sql,
                        connectionId: target?.id ?? null,
                        context: e.connectionId === tab.connectionId ? { ...tab.context } : { database: e.database ?? null, schema_name: e.schema ?? null },
                      });
                      if (doRun) pendingRun.current = t.id;
                    }}
                  />
                )}
              </div>
            </aside>
            <ResizeHandle
              direction="horizontal"
              className="bg-border"
              onDrag={(d) => {
                if (!dragBase.current) dragBase.current = layoutRef.current.sidebarWidth;
                setLayout({ sidebarWidth: Math.min(640, Math.max(200, dragBase.current + d)) }, false);
              }}
              onEnd={() => {
                dragBase.current = 0;
                saveLayout(layoutRef.current);
              }}
              onDoubleClick={() => setLayout({ sidebarWidth: 280 })}
            />
          </>
        )}

        {/* main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <EditorTabs
            tabs={state.tabs}
            activeTabId={tab.id}
            connections={connections}
            renamingId={renamingId}
            onStartRename={setRenamingId}
            onRenameDone={(id, name) => {
              setRenamingId(null);
              if (name) updateTab(id, (t) => ({ ...t, name }));
              setTimeout(() => editorRef.current?.focus(), 0);
            }}
            onActivate={activate}
            onClose={(ids) => void closeTabs(ids)}
            onNew={() => createTab()}
            onDuplicate={(id) => {
              const t = getTab(id);
              if (t) createTab({ name: `${t.name} (copy)`, connectionId: t.connectionId, context: { ...t.context }, sql: t.sql, autocommit: t.autocommit });
            }}
            onSave={(id) => {
              activate(id);
              setTimeout(() => commandsRef.current["script.save"]?.(), 0);
            }}
            onDownload={(id) => {
              const t = getTab(id);
              if (t) downloadBlob(t.sql, `${t.name.replace(/[^\w.-]+/g, "_") || "script"}.sql`, "application/sql");
            }}
            onMove={(from, to) =>
              setIdeState((s) => {
                const tabs = s.tabs.slice();
                const fi = tabs.findIndex((t) => t.id === from);
                const ti = tabs.findIndex((t) => t.id === to);
                if (fi < 0 || ti < 0) return s;
                const [moved] = tabs.splice(fi, 1);
                tabs.splice(ti, 0, moved);
                return { ...s, tabs };
              })
            }
            onReopenClosed={reopenClosed}
            canReopen={closedCount > 0}
          />
          <Toolbar
            tab={tab}
            conn={conn}
            connections={connections}
            ctx={ctx}
            running={running}
            cmd={runCommand}
            onConnection={(id) => void setConnection(id)}
            onContext={setContext}
          />

          <div className="flex min-h-0 flex-1 flex-col">
            {/* editor */}
            <div className={cn("relative min-h-[60px] flex-1", maximized && "hidden")}>
              {!conn && (
                <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs">
                  <Plug className="h-3.5 w-3.5 text-warning" />
                  {connections.length ? "This script isn't connected to a database." : "No database connections yet."}
                  <button type="button" className="font-medium text-primary hover:underline" onClick={() => (connections.length ? setPaletteOpen(true) : setNewConnOpen(true))}>
                    {connections.length ? "Choose a connection" : "Create one"}
                  </button>
                </div>
              )}
              {settings.engine === "plain" ? (
                <PlainEditor
                  key={tab.id}
                  ref={editorRef}
                  tabId={tab.id}
                  initialText={tab.sql}
                  dbType={conn?.db_type}
                  settings={settings}
                  commands={commandsRef}
                  onChange={onEditorChange}
                  onCursor={onCursor}
                  className={!conn ? "pt-8" : undefined}
                />
              ) : (
                <CodeEditor
                  ref={editorRef}
                  tabId={tab.id}
                  initialText={tab.sql}
                  dbType={conn?.db_type}
                  tables={tables}
                  columns={editorColumns}
                  settings={settings}
                  commands={commandsRef}
                  onChange={onEditorChange}
                  onCursor={onCursor}
                  onRunStatementAt={onRunStatementAt}
                  className={!conn ? "pt-8" : undefined}
                />
              )}
            </div>

            {/* results */}
            {resultsShown && (
              <>
                {!maximized && (
                  <ResizeHandle
                    direction="vertical"
                    className="bg-border"
                    onDrag={(d) => {
                      if (!dragBase.current) dragBase.current = layoutRef.current.resultsHeight;
                      setLayout({ resultsHeight: Math.min(window.innerHeight - 180, Math.max(120, dragBase.current - d)) }, false);
                    }}
                    onEnd={() => {
                      dragBase.current = 0;
                      saveLayout(layoutRef.current);
                    }}
                    onDoubleClick={() => setLayout({ resultsMaximized: true })}
                  />
                )}
                <div className={cn("flex min-h-0 flex-col", maximized ? "flex-1" : "shrink-0")} style={maximized ? undefined : { height: layout.resultsHeight }}>
                  <ResultsPanel
                    tab={tab}
                    conn={conn}
                    settings={settings}
                    valuePanel={layout.valuePanel}
                    valuePanelWidth={layout.valuePanelWidth}
                    onToggleValuePanel={() => setLayout({ valuePanel: !layoutRef.current.valuePanel })}
                    onValuePanelWidth={(w) => setLayout({ valuePanelWidth: w })}
                    maximized={maximized}
                    onToggleMaximize={() => setLayout({ resultsMaximized: !layoutRef.current.resultsMaximized })}
                    onHide={() => setLayout({ resultsVisible: false, resultsMaximized: false })}
                    onGotoStatement={gotoStatement}
                    onOpenDiff={() => setDiffOpen(true)}
                    canDiff={diffSources.length >= 2}
                  />
                </div>
              </>
            )}
            {!resultsShown && (
              <button
                type="button"
                onClick={() => setLayout({ resultsVisible: true })}
                className="flex h-7 shrink-0 items-center gap-2 border-t bg-muted/30 px-3 text-xs text-muted-foreground hover:text-foreground"
              >
                {activeResult && <StatusIcon status={activeResult.status} kind={activeResult.kind} />}
                Results
                {activeResult?.status === "success" && activeResult.sets[0] && (
                  <span className="tabular-nums">· {formatNumber(activeResult.sets[0].total)} rows · {formatDuration(activeResult.elapsedMs)}</span>
                )}
                <span className="ml-auto font-mono text-[11px]">{shortcutLabel("view.toggleResults")}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        tab={tab}
        conn={conn}
        database={ctx.database}
        schema={ctx.schema}
        result={activeResult}
        onCommand={(id) => runCommand(id)}
      />

      {zen && (
        <button
          type="button"
          onClick={() => setZen(false)}
          className="fixed right-3 top-2 z-[60] flex items-center gap-1.5 rounded-full border bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
          title={`Leave focus mode (${shortcutLabel("view.zen")})`}
        >
          <Minimize className="h-3.5 w-3.5" /> Exit focus
        </button>
      )}

      {/* overlays */}
      <ConfirmHost />
      <ParamsHost />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} run={runCommand} isEnabled={isEnabled} extras={paletteExtras} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} connections={connections} />
      <KeyboardShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <Dialog open={!!saveDlg} onOpenChange={(o) => !o && setSaveDlg(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save script</DialogTitle>
            <DialogDescription>
              Saved to the script library for{" "}
              <span className="font-medium text-foreground">{connections.find((c) => c.id === getTab(saveDlg?.tabId ?? "")?.connectionId)?.name ?? "-"}</span>.
              Saving again keeps the previous version.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="dv-save-name" className="text-xs">
              Name
            </Label>
            <Input
              id="dv-save-name"
              autoFocus
              value={saveDlg?.name ?? ""}
              onChange={(e) => setSaveDlg((s) => (s ? { ...s, name: e.target.value } : s))}
              onKeyDown={(e) => {
                if (e.key === "Enter") (document.getElementById("dv-save-ok") as HTMLButtonElement | null)?.click();
              }}
              placeholder="daily_reconciliation"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setSaveDlg(null)}>
              Cancel
            </Button>
            <Button
              id="dv-save-ok"
              size="sm"
              loading={saveDlg?.saving}
              disabled={!saveDlg?.name.trim()}
              onClick={async () => {
                if (!saveDlg) return;
                setSaveDlg({ ...saveDlg, saving: true });
                const ok = await saveScript(saveDlg.tabId, saveDlg.name.trim());
                if (ok) setSaveDlg(null);
                else setSaveDlg((s) => (s ? { ...s, saving: false } : s));
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newConnOpen} onOpenChange={setNewConnOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-auto scrollbar-thin">
          <ConnectionForm
            onSaved={(c) => {
              setNewConnOpen(false);
              void qc.invalidateQueries({ queryKey: ["connections"] });
              const t = getTab(activeTabIdRef.current);
              if (t && t.connectionId == null) changeTabConnection(t.id, c.id);
              else createTab({ connectionId: c.id, context: {} });
              toast.success(`Connected to ${c.name}`);
            }}
            onCancel={() => setNewConnOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={diffOpen} onOpenChange={setDiffOpen}>
        <DialogContent className="flex h-[92vh] max-h-[92vh] w-[96vw] max-w-[96vw] flex-col overflow-hidden p-0">
          <VisualDiffPanel sources={diffSources} diffIds={diffIds} onDiffIdsChange={setDiffIds} onClose={() => setDiffOpen(false)} />
        </DialogContent>
      </Dialog>

      {trackerOpen && <QueryManager onClose={() => setTrackerOpen(false)} />}
      {ddlOpen && <GenerateDialog conn={conn} database={ctx.database} schema={ctx.schema} onClose={() => setDdlOpen(false)} onInsert={insertText} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ActivityButton({
  icon: Icon, label, shortcut, active, onClick,
}: {
  icon: typeof Database;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      className={cn(
        "relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground before:absolute before:-left-[5px] before:top-1.5 before:h-6 before:w-[3px] before:rounded-r before:bg-primary",
      )}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

function QueryManager({ onClose }: { onClose: () => void }) {
  const q = useQuery({
    queryKey: ["sql-ide-recent"],
    queryFn: () => api.recentQueries(100),
    refetchInterval: 2000,
  });
  const list: SqlExecution[] = q.data ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] w-[min(1000px,94vw)] max-w-none flex-col p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Query manager</h3>
          <span className="text-xs text-muted-foreground">Running and recent queries from every IDE session on this server</span>
          {q.isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted/90 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">Status</th>
                <th className="px-3 py-1.5 font-medium">Script</th>
                <th className="px-3 py-1.5 font-medium">SQL</th>
                <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                <th className="px-3 py-1.5 text-right font-medium">Time</th>
                <th className="px-3 py-1.5 font-medium">Started</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {list.map((x) => (
                <tr key={x.exec_id} className="border-b border-border/60 hover:bg-accent/30">
                  <td className="px-3 py-1.5">
                    <StatusIcon status={x.status === "queued" ? "running" : x.status} />
                  </td>
                  <td className="max-w-[140px] truncate px-3 py-1.5">{x.session_name || x.session_id.slice(0, 8)}</td>
                  <td className="max-w-[420px] truncate px-3 py-1.5 font-mono" title={x.sql}>
                    {x.sql}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(x.row_count)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatDuration(x.elapsed_ms)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{x.started_at ? new Date(x.started_at).toLocaleTimeString() : ""}</td>
                  <td className="px-3 py-1.5 text-right">
                    {(x.status === "running" || x.status === "queued") && (
                      <button
                        type="button"
                        className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10"
                        onClick={() => api.cancelExecution(x.session_id, x.exec_id).then(() => q.refetch()).catch((e) => toast.error(e.message))}
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!list.length && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                    No queries yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GenerateDialog({
  conn, database, schema, onClose, onInsert,
}: {
  conn: Connection | undefined;
  database: string | null;
  schema: string | null;
  onClose: () => void;
  onInsert: (sql: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const go = async (kind: "ddl" | "insert" | "exec") => {
    if (!conn || !name.trim()) return;
    setBusy(kind);
    try {
      const res =
        kind === "ddl" ? await api.generateDDL(conn.id, name.trim(), database || undefined, schema || undefined)
        : kind === "insert" ? await api.generateInsert(conn.id, name.trim(), database || undefined, schema || undefined)
        : await api.generateExecProc(conn.db_type, name.trim(), database || undefined, schema || undefined);
      if (res.error) throw new Error(res.error);
      if (res.sql) {
        onInsert(res.sql);
        onClose();
      }
    } catch (e: any) {
      toast.error(`Could not generate ${kind.toUpperCase()}`, { description: String(e?.message ?? e).slice(0, 300) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Generate SQL</DialogTitle>
          <DialogDescription>
            DDL or sample INSERTs for a table, or an EXEC / CALL template for a procedure
            {conn ? ` on ${conn.name}` : ""}. The result is inserted at the cursor.
          </DialogDescription>
        </DialogHeader>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Table or procedure name" className="font-mono" />
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={!conn || !name.trim() || !!busy} loading={busy === "exec"} onClick={() => void go("exec")}>
            EXEC / CALL
          </Button>
          <Button variant="outline" size="sm" disabled={!conn || !name.trim() || !!busy} loading={busy === "insert"} onClick={() => void go("insert")}>
            INSERTs
          </Button>
          <Button size="sm" disabled={!conn || !name.trim() || !!busy} loading={busy === "ddl"} onClick={() => void go("ddl")}>
            DDL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
