/**
 * Results panel: result tabs, the grid / text / record / messages views,
 * quick filter, value panel, selection statistics, paging and export.
 */
import * as React from "react";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowLeftRight, Ban, CheckCircle2, ChevronLeft, ChevronRight, CircleDashed, Clock, Code2, Copy,
  Download, FileJson, Filter, Loader2, Maximize2, Minimize2, PanelRight, Pin, PinOff, Rows3, Search,
  Square, Table2, TerminalSquare, Text as TextIcon, X, XCircle,
} from "lucide-react";
import type { Connection } from "@/api/client";
import { copyToClipboard, downloadBlob, nowStamp, toCsv, toInsert, toJson, toMarkdown, toTsv } from "@/lib/export";
import { renderControlChars } from "@/lib/text";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import { type IdeSettings } from "./ideSettings";
import { type ResultTab, type ResultView, type ScriptTab, type StatementMessage, updateResult, updateTab } from "./ideStore";
import { allRows, cancelRun, loadMoreRows, stopPolling } from "./ideRunner";
import { ResultGrid, cellText, type GridSelectionInfo, type ValueFilter } from "./ResultGrid";
import { IconButton, Menu, MenuButton, Popover, ResizeHandle, type MenuAnchor, type MenuEntry } from "./ui";
import { shortcutLabel } from "./ideCommands";

interface Props {
  tab: ScriptTab;
  conn?: Connection;
  settings: IdeSettings;
  valuePanel: boolean;
  valuePanelWidth: number;
  onToggleValuePanel: () => void;
  onValuePanelWidth: (w: number) => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  onHide: () => void;
  onGotoStatement: (rt: ResultTab, index: number) => void;
  onOpenDiff: () => void;
  canDiff: boolean;
}

export function ResultsPanel(props: Props) {
  const { tab, maximized, onToggleMaximize, onHide } = props;
  const rt = tab.results.find((r) => r.id === tab.activeResultId) ?? tab.results[tab.results.length - 1];
  const [tabMenu, setTabMenu] = React.useState<{ anchor: MenuAnchor; id: string } | null>(null);

  const closeResults = (ids: string[]) => {
    stopPolling(ids);
    for (const id of ids) {
      const r = tab.results.find((x) => x.id === id);
      if (r?.status === "running") void cancelRun(tab.id, id);
    }
    updateTab(tab.id, (t) => {
      const results = t.results.filter((r) => !ids.includes(r.id));
      const activeResultId = results.some((r) => r.id === t.activeResultId)
        ? t.activeResultId
        : results[results.length - 1]?.id ?? null;
      return { ...t, results, activeResultId };
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* result tabs */}
      <div className="flex h-8 shrink-0 items-stretch border-b bg-muted/30">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none" role="tablist">
          {tab.results.length === 0 && (
            <div className="flex items-center px-3 text-xs text-muted-foreground">Results</div>
          )}
          {tab.results.map((r) => {
            const active = r.id === rt?.id;
            const total = r.sets[r.activeSet]?.total ?? r.sets[0]?.total;
            return (
              <div
                key={r.id}
                role="tab"
                aria-selected={active}
                title={r.sql ? r.sql.slice(0, 600) : r.label}
                onClick={() => updateTab(tab.id, (t) => ({ ...t, activeResultId: r.id }))}
                onAuxClick={(e) => {
                  if (e.button === 1) closeResults([r.id]);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({ anchor: { x: e.clientX, y: e.clientY }, id: r.id });
                }}
                className={cn(
                  "group flex shrink-0 cursor-pointer select-none items-center gap-1.5 border-r px-3 text-xs",
                  active ? "dv-ide-tab-active bg-background text-foreground" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <StatusIcon status={r.status} kind={r.kind} />
                <span className="max-w-[160px] truncate">{r.label}</span>
                {r.status === "success" && total != null && r.sets.length > 0 && (
                  <span className="tabular-nums text-muted-foreground">{formatNumber(total)}</span>
                )}
                {r.pinned && <Pin className="h-3 w-3 text-primary" />}
                <button
                  type="button"
                  aria-label="Close result"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeResults([r.id]);
                  }}
                  className={cn("rounded p-0.5 hover:bg-accent", active ? "opacity-70" : "opacity-0 group-hover:opacity-70")}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center gap-0.5 px-1">
          {props.canDiff && (
            <IconButton size="sm" icon={ArrowLeftRight} label="Compare two results (Visual Diff)" onClick={props.onOpenDiff} />
          )}
          <IconButton
            size="sm"
            icon={maximized ? Minimize2 : Maximize2}
            label={maximized ? "Restore panel" : "Maximize panel"}
            shortcut={shortcutLabel("view.maximizeResults")}
            onClick={onToggleMaximize}
          />
          <IconButton size="sm" icon={X} label="Hide panel" shortcut={shortcutLabel("view.toggleResults")} onClick={onHide} />
        </div>
      </div>

      {rt ? (
        <ResultBody key={rt.id} {...props} rt={rt} />
      ) : (
        <EmptyResults />
      )}

      {tabMenu && (
        <Menu
          anchor={tabMenu.anchor}
          onClose={() => setTabMenu(null)}
          entries={(() => {
            const r = tab.results.find((x) => x.id === tabMenu.id);
            if (!r) return [];
            return [
              {
                label: r.pinned ? "Unpin result" : "Pin result",
                icon: r.pinned ? PinOff : Pin,
                title: "A pinned result is never replaced by the next run",
                onSelect: () => updateResult(tab.id, r.id, (x) => ({ ...x, pinned: !x.pinned })),
              },
              { kind: "separator" },
              { label: "Close", onSelect: () => closeResults([r.id]) },
              { label: "Close others", onSelect: () => closeResults(tab.results.filter((x) => x.id !== r.id && !x.pinned).map((x) => x.id)) },
              { label: "Close all", onSelect: () => closeResults(tab.results.filter((x) => !x.pinned).map((x) => x.id)) },
            ] as MenuEntry[];
          })()}
        />
      )}
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
      <Table2 className="h-8 w-8 opacity-30" />
      <div>
        <div className="font-medium text-foreground/80">No results yet</div>
        <div className="mt-1 text-xs">
          <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">{shortcutLabel("run.statement")}</kbd> runs the statement at the cursor ·{" "}
          <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">{shortcutLabel("run.script")}</kbd> runs the script
        </div>
      </div>
    </div>
  );
}

export function StatusIcon({ status, kind, className }: { status: ResultTab["status"]; kind?: ResultTab["kind"]; className?: string }) {
  const c = cn("h-3.5 w-3.5 shrink-0", className);
  if (status === "running") return <Loader2 className={cn(c, "animate-spin text-primary")} />;
  if (status === "error") return <XCircle className={cn(c, "text-destructive")} />;
  if (status === "cancelled") return <Ban className={cn(c, "text-muted-foreground")} />;
  if (kind === "explain") return <Rows3 className={cn(c, "text-primary")} />;
  if (status === "success") return <Table2 className={cn(c, "text-success")} />;
  return <CircleDashed className={cn(c, "text-muted-foreground")} />;
}

// ---------------------------------------------------------------------------

function ResultBody({
  tab, rt, settings, valuePanel, valuePanelWidth, onToggleValuePanel, onValuePanelWidth, onGotoStatement,
}: Props & { rt: ResultTab }) {
  const set = rt.sets[rt.activeSet] ?? rt.sets[0];
  const [quick, setQuick] = React.useState("");
  const [filters, setFilters] = React.useState<ValueFilter[]>([]);
  const [selInfo, setSelInfo] = React.useState<GridSelectionInfo | null>(null);
  const [recordIdx, setRecordIdx] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [fetchingAll, setFetchingAll] = React.useState<{ n: number; total: number } | null>(null);
  const stopFetchRef = React.useRef(false);
  const [sqlAnchor, setSqlAnchor] = React.useState<HTMLElement | null>(null);

  // A new run or another result set resets filters and selection.
  React.useEffect(() => {
    setQuick("");
    setFilters([]);
    setSelInfo(null);
    setRecordIdx(0);
  }, [rt.execId, rt.activeSet]);

  const setView = (view: ResultView) => updateResult(tab.id, rt.id, (r) => ({ ...r, view }));
  const view: ResultView = rt.status === "running" ? rt.view : set ? rt.view : "messages";

  const loadMore = React.useCallback(async () => {
    if (loadingMore || !set?.hasMore) return;
    setLoadingMore(true);
    try {
      await loadMoreRows(tab.id, rt.id, rt.activeSet);
    } catch (e: any) {
      toast.error("Could not load more rows", { description: e?.message });
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, set?.hasMore, tab.id, rt.id, rt.activeSet]);

  const fetchAll = async () => {
    if (!set?.hasMore) return;
    stopFetchRef.current = false;
    setFetchingAll({ n: set.rows.length, total: set.total });
    const rows = await allRows(tab.id, rt.id, rt.activeSet, {
      keep: true,
      shouldStop: () => stopFetchRef.current,
      onProgress: (n, total) => setFetchingAll({ n, total }),
    });
    setFetchingAll(null);
    if (rows && !stopFetchRef.current) toast.success(`All ${formatNumber(rows.length)} rows loaded`);
  };

  const exportAs = async (fmt: "csv" | "json" | "md" | "insert" | "tsv", filteredOnly = false) => {
    if (!set) return;
    let rows: any[][] | null;
    if (filteredOnly) {
      rows = filterRows(set.rows, quick, filters);
    } else {
      const t = set.hasMore ? toast.loading(`Loading ${formatNumber(set.total)} rows…`) : null;
      rows = await allRows(tab.id, rt.id, rt.activeSet);
      if (t != null) toast.dismiss(t);
    }
    if (!rows) return;
    const base = `${(tab.name || "result").replace(/[^\w.-]+/g, "_")}_${nowStamp()}`;
    const table = guessTable(set.title ?? rt.sql) ?? "table_name";
    switch (fmt) {
      case "csv":
        downloadBlob(toCsv(set.columns, rows), `${base}.csv`, "text/csv");
        break;
      case "json":
        downloadBlob(toJson(set.columns, rows), `${base}.json`, "application/json");
        break;
      case "md":
        downloadBlob(toMarkdown(set.columns, rows), `${base}.md`, "text/markdown");
        break;
      case "insert":
        downloadBlob(toInsert(set.columns, rows, table), `${base}.sql`, "application/sql");
        break;
      case "tsv":
        if (await copyToClipboard(toTsv(set.columns, rows))) toast.success(`Copied ${formatNumber(rows.length)} rows (paste into Excel)`);
        else toast.error("Copy failed");
        return;
    }
    toast.success(`Exported ${formatNumber(rows.length)} rows`, {
      description: set.truncated ? `Result was capped at the ${formatNumber(settings.maxRows)}-row fetch limit` : undefined,
    });
  };

  const filteredCount = React.useMemo(
    () => (set && (quick || filters.length) ? filterRows(set.rows, quick, filters).length : null),
    [set, quick, filters],
  );

  const msgCounts = React.useMemo(() => {
    const c = { success: 0, error: 0, skipped: 0, cancelled: 0 };
    for (const m of rt.messages) if (m.status in c) c[m.status as keyof typeof c]++;
    return c;
  }, [rt.messages]);

  if (rt.status === "idle") return <EmptyResults />;

  const showValuePanel = valuePanel && set && (view === "grid" || view === "record");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b px-2 text-xs">
        <div className="flex items-center rounded-md border bg-muted/40 p-0.5" role="tablist" aria-label="Result view">
          {([
            ["grid", Table2, "Grid"],
            ["text", TextIcon, "Text"],
            ["record", Rows3, "Record"],
            ["messages", TerminalSquare, "Messages"],
          ] as const).map(([v, Icon, label]) => {
            const disabled = v !== "messages" && !set;
            return (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                disabled={disabled}
                onClick={() => setView(v)}
                title={label}
                className={cn(
                  "flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:opacity-40",
                  view === v ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden xl:inline">{label}</span>
                {v === "messages" && msgCounts.error > 0 && (
                  <span className="rounded-full bg-destructive px-1 text-[10px] leading-4 text-destructive-foreground">{msgCounts.error}</span>
                )}
              </button>
            );
          })}
        </div>

        {rt.sets.length > 1 && (
          <MenuButton
            entries={rt.sets.map((s, i) => ({
              label: (
                <span className="flex items-center gap-2">
                  <span className="w-5 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="truncate font-mono text-[11px]">{s.title || `Result set ${i + 1}`}</span>
                  <span className="ml-auto pl-3 tabular-nums text-muted-foreground">{formatNumber(s.total)}</span>
                </span>
              ),
              checked: i === rt.activeSet,
              onSelect: () => updateResult(tab.id, rt.id, (r) => ({ ...r, activeSet: i, view: r.view === "messages" ? "grid" : r.view })),
            }))}
            minWidth={360}
          >
            {({ onClick, ref }) => (
              <button
                ref={ref}
                type="button"
                onClick={onClick}
                className="flex h-7 max-w-[260px] items-center gap-1 rounded-md border px-2 hover:bg-accent"
                title="Result sets produced by this run"
              >
                <span className="text-muted-foreground">Set</span>
                <span className="font-medium tabular-nums">
                  {rt.activeSet + 1}/{rt.sets.length}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">{set?.title}</span>
                <ChevronRight className="h-3 w-3 rotate-90 opacity-60" />
              </button>
            )}
          </MenuButton>
        )}

        {set && (view === "grid" || view === "text") && (
          <div className="relative flex min-w-[140px] max-w-[280px] flex-1 items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              placeholder="Filter loaded rows…"
              className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
              aria-label="Filter rows"
            />
            {quick && (
              <button type="button" className="absolute right-1.5 text-muted-foreground hover:text-foreground" onClick={() => setQuick("")} aria-label="Clear filter">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        )}
        {filters.map((f, i) => (
          <span key={i} className="flex h-6 max-w-[220px] items-center gap-1 rounded-full border bg-primary/10 pl-2 pr-1 text-[11px] text-primary">
            <Filter className="h-3 w-3 shrink-0" />
            <span className="truncate">{describeFilter(f, set?.columns ?? [])}</span>
            <button type="button" aria-label="Remove filter" onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))} className="rounded-full p-0.5 hover:bg-primary/20">
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}

        <div className="flex-1" />

        {/* counts */}
        {rt.status === "running" ? (
          <RunningLabel rt={rt} />
        ) : set ? (
          <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
            {filteredCount != null && <span className="tabular-nums text-foreground">{formatNumber(filteredCount)} of</span>}
            <span className="tabular-nums">
              {set.hasMore ? `${formatNumber(set.rows.length)} of ${formatNumber(set.total)}` : formatNumber(set.total)} rows
            </span>
            {set.truncated && (
              <span
                className="flex items-center gap-0.5 rounded bg-warning/15 px-1 text-[10px] font-medium text-warning"
                title={`The server stopped fetching at the ${formatNumber(settings.maxRows)}-row limit (Editor settings → Max rows).`}
              >
                <AlertTriangle className="h-3 w-3" /> capped
              </span>
            )}
            <span>·</span>
            <span className="tabular-nums">{formatDuration(rt.elapsedMs)}</span>
          </span>
        ) : (
          <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(rt.elapsedMs)}</span>
        )}

        {set?.hasMore && rt.status !== "running" && (
          fetchingAll ? (
            <button
              type="button"
              onClick={() => (stopFetchRef.current = true)}
              className="flex h-7 items-center gap-1 rounded-md border border-destructive/40 px-2 text-destructive hover:bg-destructive/10"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {Math.round((fetchingAll.n / Math.max(1, fetchingAll.total)) * 100)}% · Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={fetchAll}
              title={`Load all ${formatNumber(set.total)} fetched rows into the grid (${shortcutLabel("results.fetchAll")})`}
              className="h-7 whitespace-nowrap rounded-md border px-2 hover:bg-accent"
            >
              Fetch all
            </button>
          )
        )}

        {rt.sql && (
          <IconButton
            size="sm"
            icon={Code2}
            label="Executed SQL"
            active={!!sqlAnchor}
            onClick={(e) => setSqlAnchor(sqlAnchor ? null : e.currentTarget)}
          />
        )}
        {set && (
          <>
            <IconButton
              size="sm"
              icon={PanelRight}
              label="Value panel"
              shortcut={shortcutLabel("view.valuePanel")}
              active={valuePanel}
              onClick={onToggleValuePanel}
            />
            <MenuButton
              align="right"
              entries={() => [
                { kind: "heading", label: `Export ${set.hasMore ? `all ${formatNumber(set.total)}` : formatNumber(set.total)} rows` },
                { label: "CSV file", icon: Download, onSelect: () => void exportAs("csv") },
                { label: "JSON file", icon: FileJson, onSelect: () => void exportAs("json") },
                { label: "Markdown file", onSelect: () => void exportAs("md") },
                { label: "SQL INSERT script", onSelect: () => void exportAs("insert") },
                { label: "Copy to clipboard (TSV)", icon: Copy, onSelect: () => void exportAs("tsv") },
                ...(filteredCount != null
                  ? ([
                      { kind: "separator" },
                      { label: `Filtered rows only (${formatNumber(filteredCount)}) → CSV`, onSelect: () => void exportAs("csv", true) },
                    ] as MenuEntry[])
                  : []),
                { kind: "separator" },
                {
                  label: "Copy column names",
                  onSelect: () => void copyToClipboard(set.columns.join(", ")).then((ok) => ok && toast.success("Copied column names")),
                },
              ]}
            >
              {({ onClick, ref, open }) => (
                <IconButton ref={ref} size="sm" icon={Download} label="Export" active={open} onClick={onClick} />
              )}
            </MenuButton>
          </>
        )}
      </div>

      {sqlAnchor && (
        <Popover anchorEl={sqlAnchor} onClose={() => setSqlAnchor(null)} align="right" width={520}>
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs font-medium">
            Executed SQL
            <button
              type="button"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void copyToClipboard(rt.sql).then((ok) => ok && toast.success("SQL copied"))}
            >
              <Copy className="h-3 w-3" /> Copy
            </button>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] scrollbar-thin">{rt.sql}</pre>
        </Popover>
      )}

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {rt.status === "running" && !set ? (
            <RunningView tab={tab} rt={rt} />
          ) : view === "messages" || !set ? (
            <MessagesView rt={rt} counts={msgCounts} onGoto={(i) => onGotoStatement(rt, i)} />
          ) : view === "text" ? (
            <TextView columns={set.columns} rows={filterRows(set.rows, quick, filters)} limit={settings.textViewRows} />
          ) : view === "record" ? (
            <RecordView
              columns={set.columns}
              rows={set.rows}
              index={Math.min(recordIdx, Math.max(0, set.rows.length - 1))}
              onIndex={setRecordIdx}
              hasMore={set.hasMore}
              onLoadMore={loadMore}
            />
          ) : (
            <ResultGrid
              columns={set.columns}
              rows={set.rows}
              hasMore={set.hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
              quickFilter={quick}
              valueFilters={filters}
              onAddFilter={(f) => setFilters((fs) => [...fs, f])}
              onSelectionInfo={setSelInfo}
              onOpenRecord={(i) => {
                setRecordIdx(i);
                setView("record");
              }}
              onToggleValuePanel={onToggleValuePanel}
              tableName={guessTable(set.title ?? rt.sql) ?? undefined}
              fontSize={Math.max(11, settings.fontSize - 1)}
              rowHeight={Math.round(Math.max(11, settings.fontSize - 1) * 2)}
            />
          )}
          {view === "grid" && set && <SelectionBar info={selInfo} />}
        </div>
        {showValuePanel && (
          <>
            <ResizeHandle
              direction="horizontal"
              onDrag={(d) => onValuePanelWidth(Math.min(900, Math.max(220, valuePanelWidth - d)))}
            />
            <ValuePanel
              width={valuePanelWidth}
              info={view === "record" ? recordInfo(set.columns, set.rows, recordIdx) : selInfo?.active ?? null}
              onClose={onToggleValuePanel}
            />
          </>
        )}
      </div>
    </div>
  );
}

function recordInfo(columns: string[], rows: any[][], idx: number): GridSelectionInfo["active"] {
  const row = rows[idx];
  if (!row) return null;
  return { row, rowIndex: idx, col: 0, column: columns[0], value: row[0] };
}

function filterRows(rows: any[][], quick: string, filters: ValueFilter[]): any[][] {
  let out = rows;
  const q = quick.trim().toLowerCase();
  if (q) out = out.filter((r) => r.some((v) => v != null && cellText(v).toLowerCase().includes(q)));
  for (const f of filters) {
    out = out.filter((r) => {
      const v = r[f.col];
      if (f.op === "null") return v == null;
      if (f.op === "notnull") return v != null;
      if (f.op === "eq") return v != null && cellText(v) === cellText(f.value);
      return v == null || cellText(v) !== cellText(f.value);
    });
  }
  return out;
}

function describeFilter(f: ValueFilter, columns: string[]): string {
  const c = columns[f.col] ?? `#${f.col + 1}`;
  if (f.op === "null") return `${c} IS NULL`;
  if (f.op === "notnull") return `${c} IS NOT NULL`;
  const v = cellText(f.value);
  return `${c} ${f.op === "eq" ? "=" : "≠"} ${v.length > 24 ? v.slice(0, 23) + "…" : v}`;
}

/** Best-effort table name from "SELECT … FROM x" for INSERT export. */
function guessTable(sql: string | undefined): string | null {
  if (!sql) return null;
  const m = /\bfrom\s+([\w$#."`\[\]]+)/i.exec(sql);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

function useElapsed(rt: ResultTab): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    if (rt.status !== "running") return;
    const iv = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(iv);
  }, [rt.status]);
  return rt.status === "running" && rt.startedAt ? now - rt.startedAt : rt.elapsedMs;
}

function RunningLabel({ rt }: { rt: ResultTab }) {
  const ms = useElapsed(rt);
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-primary">
      <Loader2 className="h-3 w-3 animate-spin" />
      {rt.progress && rt.progress.total > 1 && (
        <span className="tabular-nums">
          {Math.min(rt.progress.done + 1, rt.progress.total)}/{rt.progress.total}
        </span>
      )}
      <span className="tabular-nums">{formatDuration(ms)}</span>
    </span>
  );
}

function RunningView({ tab, rt }: { tab: ScriptTab; rt: ResultTab }) {
  const ms = useElapsed(rt);
  const p = rt.progress;
  const pct = p && p.total > 1 ? (p.done / p.total) * 100 : null;
  const current = p ? rt.statements[Math.min(p.done, rt.statements.length - 1)]?.text : rt.sql;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <div className="flex items-center gap-3">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <div className="text-sm">
          {p && p.total > 1 ? (
            <>
              Running statement <span className="font-semibold tabular-nums">{Math.min(p.done + 1, p.total)}</span> of{" "}
              <span className="tabular-nums">{p.total}</span>
            </>
          ) : (
            "Executing query"
          )}
          <span className="ml-2 tabular-nums text-muted-foreground">{formatDuration(ms)}</span>
        </div>
      </div>
      {pct != null && (
        <div className="h-1 w-72 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {current && (
        <pre className="max-h-24 w-full max-w-2xl overflow-hidden whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {current.slice(0, 600)}
        </pre>
      )}
      <button
        type="button"
        onClick={() => void cancelRun(tab.id, rt.id)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
      >
        <Square className="h-3 w-3 fill-current" /> Cancel <span className="font-mono opacity-70">{shortcutLabel("run.stop")}</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

function MessagesView({
  rt, counts, onGoto,
}: {
  rt: ResultTab;
  counts: { success: number; error: number; skipped: number; cancelled: number };
  onGoto: (i: number) => void;
}) {
  const failed = rt.messages.find((m) => m.status === "error");
  const topError = failed?.error ?? rt.error;
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <StatusIcon status={rt.status} />
            {rt.status === "success" ? "Completed" : rt.status === "error" ? "Failed" : rt.status === "cancelled" ? "Cancelled" : "Running"}
          </span>
          {rt.messages.length > 0 && (
            <span className="text-muted-foreground">
              {rt.messages.length} statement{rt.messages.length === 1 ? "" : "s"} · {counts.success} succeeded
              {counts.error ? ` · ${counts.error} failed` : ""}
              {counts.skipped ? ` · ${counts.skipped} skipped` : ""}
              {counts.cancelled ? ` · ${counts.cancelled} cancelled` : ""}
            </span>
          )}
          {rt.affectedRows != null && (
            <span className="text-muted-foreground">
              {formatNumber(rt.affectedRows)} {rt.affectedRows === 1 ? "row" : "rows"} affected
            </span>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock className="h-3 w-3" /> {formatDuration(rt.elapsedMs)}
          </span>
          {rt.finishedAt && <span className="text-muted-foreground">{new Date(rt.finishedAt).toLocaleTimeString()}</span>}
        </div>

        {topError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5">
            <div className="flex items-center gap-2 border-b border-destructive/20 px-3 py-1.5 text-xs font-medium text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {failed ? `Statement ${failed.index + 1} failed` : "Execution failed"}
              <span className="flex-1" />
              {failed && (
                <button type="button" onClick={() => onGoto(failed.index)} className="rounded px-1.5 py-0.5 hover:bg-destructive/10">
                  Go to statement
                </button>
              )}
              <button
                type="button"
                onClick={() => void copyToClipboard(topError).then((ok) => ok && toast.success("Error copied"))}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-destructive/10"
              >
                <Copy className="h-3 w-3" /> Copy
              </button>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[12px] text-foreground scrollbar-thin">{topError}</pre>
          </div>
        )}

        {rt.messages.length > 0 && (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="w-10 py-1 pr-2 text-right font-medium">#</th>
                <th className="w-6 py-1" />
                <th className="py-1 pr-2 font-medium">Statement</th>
                <th className="w-28 py-1 pr-2 text-right font-medium">Rows</th>
                <th className="w-20 py-1 text-right font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {rt.messages.map((m) => (
                <MessageRow key={m.index} m={m} onGoto={() => onGoto(m.index)} />
              ))}
            </tbody>
          </table>
        )}
        {!rt.messages.length && !topError && rt.status === "success" && (
          <div className="text-xs text-muted-foreground">Statement executed successfully. No rows returned.</div>
        )}
      </div>
    </div>
  );
}

function MessageRow({ m, onGoto }: { m: StatementMessage; onGoto: () => void }) {
  const first = m.sql.split("\n").find((l) => l.trim() && !l.trim().startsWith("--"))?.trim() ?? m.sql.trim();
  return (
    <tr className="group cursor-pointer border-b border-border/50 align-top hover:bg-accent/40" onClick={onGoto} title="Go to statement">
      <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{m.index + 1}</td>
      <td className="py-1">
        {m.status === "success" ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" />
        ) : m.status === "error" ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : m.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : (
          <Ban className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </td>
      <td className="max-w-0 py-1 pr-2">
        <div className="truncate font-mono text-[11.5px]">{first}</div>
        {m.error && <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] text-destructive">{m.error}</div>}
        {m.note && <div className="mt-0.5 text-[11px] text-warning">{m.note}</div>}
        {m.status === "skipped" && <div className="text-[11px] text-muted-foreground">skipped after an earlier error</div>}
      </td>
      <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
        {m.affected_rows != null ? `${formatNumber(m.affected_rows)} affected` : m.result_sets.length ? `${formatNumber(m.rows)} rows` : "-"}
      </td>
      <td className="py-1 text-right tabular-nums text-muted-foreground">{m.status === "skipped" ? "" : formatDuration(m.elapsed_ms)}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

function TextView({ columns, rows, limit }: { columns: string[]; rows: any[][]; limit: number }) {
  const text = React.useMemo(() => {
    const shown = rows.slice(0, limit);
    const cell = (v: any) => (v == null ? "NULL" : cellText(v).replace(/\r?\n/g, "↵").replace(/\t/g, "→"));
    const widths = columns.map((c, i) => {
      let w = c.length;
      for (const r of shown) w = Math.max(w, Math.min(60, cell(r[i]).length));
      return w;
    });
    const fit = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
    const line = widths.map((w) => "-".repeat(w)).join("-+-");
    const out = [columns.map((c, i) => fit(c, widths[i])).join(" | "), line];
    for (const r of shown) out.push(columns.map((_, i) => fit(cell(r[i]), widths[i])).join(" | "));
    if (rows.length > shown.length) out.push(`… ${formatNumber(rows.length - shown.length)} more loaded rows (Text view shows ${formatNumber(limit)})`);
    return out.join("\n");
  }, [columns, rows, limit]);
  return (
    <div className="relative min-h-0 flex-1">
      <button
        type="button"
        onClick={() => void copyToClipboard(text).then((ok) => ok && toast.success("Copied text table"))}
        className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
      >
        <Copy className="h-3 w-3" /> Copy
      </button>
      <pre className="h-full overflow-auto p-3 font-mono text-[12px] leading-5 scrollbar-thin">{text}</pre>
    </div>
  );
}

function RecordView({
  columns, rows, index, onIndex, hasMore, onLoadMore,
}: {
  columns: string[];
  rows: any[][];
  index: number;
  onIndex: (i: number) => void;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const row = rows[index];
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (hasMore && index >= rows.length - 2) onLoadMore();
  }, [hasMore, index, rows.length, onLoadMore]);
  if (!row) return <div className="p-4 text-xs text-muted-foreground">No rows.</div>;
  const list = columns.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <IconButton size="sm" icon={ChevronLeft} label="Previous row" disabled={index === 0} onClick={() => onIndex(index - 1)} />
        <span className="tabular-nums">
          Row <span className="font-medium">{formatNumber(index + 1)}</span> of {formatNumber(rows.length)}
          {hasMore ? "+" : ""}
        </span>
        <IconButton size="sm" icon={ChevronRight} label="Next row" disabled={index >= rows.length - 1} onClick={() => onIndex(index + 1)} />
        <div className="relative ml-2 flex w-56 items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find column…"
            className="h-7 w-full rounded-md border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {list.map(({ c, i }) => {
              const v = row[i];
              return (
                <tr key={i} className="group border-b border-border/60 align-top hover:bg-accent/30">
                  <td className="w-[30%] max-w-[320px] truncate px-3 py-1.5 font-medium text-muted-foreground" title={c}>
                    {c}
                  </td>
                  <td className={cn("px-3 py-1.5 font-mono", v == null && "italic text-muted-foreground/70")}>
                    <div className="whitespace-pre-wrap break-all">{v == null ? "NULL" : renderControlChars(cellText(v))}</div>
                  </td>
                  <td className="w-8 px-1 py-1">
                    <IconButton
                      size="sm"
                      icon={Copy}
                      label="Copy value"
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => void copyToClipboard(v == null ? "NULL" : cellText(v)).then((ok) => ok && toast.success("Copied value", { duration: 1200 }))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ValuePanel({ width, info, onClose }: { width: number; info: GridSelectionInfo["active"]; onClose: () => void }) {
  const [pretty, setPretty] = React.useState(true);
  const v = info?.value;
  const text = v == null ? "" : cellText(v);
  const json = React.useMemo(() => {
    if (!text || !/^\s*[[{]/.test(text)) return null;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return null;
    }
  }, [text]);
  const kind =
    v == null ? "null" : typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : json ? "json" : "text";
  return (
    <aside className="flex min-h-0 shrink-0 flex-col border-l bg-muted/10" style={{ width }}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium" title={info?.column}>
          {info ? info.column : "Value"}
        </span>
        {info && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{kind}</span>}
        {json && (
          <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setPretty((p) => !p)}>
            {pretty ? "Raw" : "Pretty"}
          </button>
        )}
        <IconButton
          size="sm"
          icon={Copy}
          label="Copy value"
          disabled={!info}
          onClick={() => void copyToClipboard(v == null ? "NULL" : json && pretty ? json : text).then((ok) => ok && toast.success("Copied value"))}
        />
        <IconButton size="sm" icon={X} label="Close value panel" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
        {!info ? (
          <div className="text-xs text-muted-foreground">Select a cell to see its full value.</div>
        ) : v == null ? (
          <div className="font-mono text-xs italic text-muted-foreground">NULL</div>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-5">
            {json && pretty ? json : renderControlChars(text)}
          </pre>
        )}
      </div>
      {info && v != null && (
        <div className="shrink-0 border-t px-3 py-1 text-[11px] tabular-nums text-muted-foreground">
          {formatNumber(text.length)} chars · row {formatNumber(info.rowIndex + 1)}
        </div>
      )}
    </aside>
  );
}

function SelectionBar({ info }: { info: GridSelectionInfo | null }) {
  if (!info || info.cells < 2) return null;
  const n = info.numeric;
  const fmt = (x: number) => (Number.isInteger(x) ? formatNumber(x) : x.toLocaleString(undefined, { maximumFractionDigits: 6 }));
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t bg-muted/30 px-3 text-[11px] tabular-nums text-muted-foreground">
      <span>
        {formatNumber(info.rows)} × {formatNumber(info.cols)} selected
      </span>
      {info.distinct != null && <span>Distinct {formatNumber(info.distinct)}</span>}
      {n && (
        <>
          <span>Count {formatNumber(n.count)}</span>
          <span>Sum {fmt(n.sum)}</span>
          <span>Avg {fmt(n.sum / n.count)}</span>
          <span>Min {fmt(n.min)}</span>
          <span>Max {fmt(n.max)}</span>
        </>
      )}
      <span className="ml-auto">Ctrl+C copies · right-click for more</span>
    </div>
  );
}
