/**
 * Visual Diff (Quick Diff): compare two result sets cell by cell, row by
 * row, side by side; export the on-screen comparison to Excel.
 */
import * as React from "react";
import ReactDOM from "react-dom";
import { toast } from "sonner";
import { ArrowLeftRight, Columns, Download, Loader2, X } from "lucide-react";
import { apiAuthHeaders, apiUrl } from "@/api/client";
import { RowDetailDialog, type RowDetailData } from "@/components/RowDetailDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { escapeControlCharsPlain, renderControlChars } from "@/lib/text";
import { cn, formatNumber } from "@/lib/utils";
import { allRows } from "./ideRunner";

export interface DiffSource {
  /** `${resultTabId}:${setIndex}` */
  id: string;
  tabId: string;
  rtId: string;
  setIdx: number;
  scriptName: string;
  label: string;
  columns: string[];
  rows: any[][];
  total: number;
  truncated: boolean;
  hasMore: boolean;
  execId: string | null;
  sql: string;
  elapsedMs: number;
}

function ColumnsPopover({
  anchor, diffData, hiddenCols, setHiddenCols, onClose,
}: {
  anchor: HTMLElement;
  diffData: { cols: string[]; rows: { cells: { match: boolean }[] }[] };
  hiddenCols: Set<string>;
  setHiddenCols: React.Dispatch<React.SetStateAction<Set<string>>>;
  onClose: () => void;
}) {
  const [pos, setPos] = React.useState({ top: 0, left: 0 });
  React.useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 300) });
  }, [anchor]);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchor, onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[9999] max-h-[240px] w-[300px] overflow-y-auto rounded border bg-popover text-xs shadow-lg"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="sticky top-0 flex items-center justify-between gap-2 border-b bg-popover px-2 py-1.5">
        <span className="font-medium">Columns</span>
        <div className="flex gap-2 text-[10px]">
          <button className="text-primary hover:underline" onClick={() => setHiddenCols(new Set())}>
            Show all
          </button>
          <button
            className="text-primary hover:underline"
            onClick={() => {
              const hasDiff = new Set<string>();
              diffData.rows.forEach((r) => r.cells.forEach((c, ci) => !c.match && hasDiff.add(diffData.cols[ci])));
              setHiddenCols(new Set(diffData.cols.filter((c) => !hasDiff.has(c))));
            }}
            title="Keep only columns that have at least one mismatch"
          >
            Diffs only
          </button>
          <button className="text-muted-foreground hover:underline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {diffData.cols.map((col, ci) => {
        const diffCount = diffData.rows.reduce((acc, r) => acc + (!r.cells[ci]?.match ? 1 : 0), 0);
        const isHidden = hiddenCols.has(col);
        return (
          <label key={col} className="flex cursor-pointer items-center gap-2 border-b border-border/40 px-2 py-1 last:border-b-0 hover:bg-accent">
            <input
              type="checkbox"
              checked={!isHidden}
              onChange={(e) =>
                setHiddenCols((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.delete(col);
                  else next.add(col);
                  return next;
                })
              }
              className="h-3 w-3 shrink-0"
            />
            <span className={cn("flex-1 truncate font-mono", isHidden && "text-muted-foreground")}>{col}</span>
            {diffCount > 0 && <span className="shrink-0 text-[9px] font-semibold text-red-600">{diffCount} diff{diffCount === 1 ? "" : "s"}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function VisualDiffPanel({
  sources, diffIds, onDiffIdsChange, onClose,
}: {
  sources: DiffSource[];
  diffIds: [string, string] | null;
  onDiffIdsChange: (ids: [string, string] | null) => void;
  onClose: () => void;
}) {
  const leftId = diffIds?.[0] || "";
  const rightId = diffIds?.[1] || "";
  const left = sources.find((t) => t.id === leftId);
  const right = sources.find((t) => t.id === rightId);
  const [allRowsById, setAllRowsById] = React.useState<Record<string, { execId: string | null; rows: any[][] }>>({});
  const [loadingAllRows, setLoadingAllRows] = React.useState(false);
  const [compareLimit, setCompareLimit] = React.useState<number | "all">(200);
  React.useEffect(() => setCompareLimit(200), [leftId, rightId]);

  async function handleCompareLimitChange(limit: number | "all") {
    if (limit !== "all") {
      setCompareLimit(limit);
      return;
    }
    if (!left || !right) {
      setCompareLimit(limit);
      return;
    }
    setLoadingAllRows(true);
    try {
      const loadAll = async (src: DiffSource): Promise<any[][]> => {
        const cached = allRowsById[src.id];
        if (cached?.execId === src.execId) return cached.rows;
        if (!src.hasMore) return src.rows;
        const rows = await allRows(src.tabId, src.rtId, src.setIdx);
        if (!rows) throw new Error(`Could not load every fetched row for ${src.label}.`);
        return rows;
      };
      const [l, r] = await Promise.all([loadAll(left), loadAll(right)]);
      setAllRowsById((prev) => ({ ...prev, [left.id]: { execId: left.execId, rows: l }, [right.id]: { execId: right.execId, rows: r } }));
      setCompareLimit("all");
    } catch (err: any) {
      toast.error("Could not compare all rows", { description: String(err?.message ?? err) });
    } finally {
      setLoadingAllRows(false);
    }
  }

  const diffData = React.useMemo(() => {
    if (!left || !right) return null;
    const cl = allRowsById[left.id];
    const cr = allRowsById[right.id];
    const leftRows = cl?.execId === left.execId ? cl.rows : left.rows;
    const rightRows = cr?.execId === right.execId ? cr.rows : right.rows;
    const cols = left.columns.length >= right.columns.length ? left.columns : right.columns;
    const rawMax = Math.max(leftRows.length, rightRows.length);
    const maxRows = compareLimit === "all" ? rawMax : Math.min(rawMax, compareLimit);
    let totalDiffs = 0;
    const rows: { rowIdx: number; hasDiff: boolean; cells: { left: any; right: any; match: boolean }[] }[] = [];
    for (let r = 0; r < maxRows; r++) {
      const cells: { left: any; right: any; match: boolean }[] = [];
      let hasDiff = false;
      for (let c = 0; c < cols.length; c++) {
        const lv = r < leftRows.length && c < leftRows[r].length ? leftRows[r][c] : undefined;
        const rv = r < rightRows.length && c < rightRows[r].length ? rightRows[r][c] : undefined;
        // NULL, '' and a missing row are three different things.
        const match =
          lv === undefined || rv === undefined ? lv === rv
          : lv === null || rv === null ? lv === rv
          : String(lv) === String(rv);
        if (!match) {
          totalDiffs++;
          hasDiff = true;
        }
        cells.push({ left: lv, right: rv, match });
      }
      rows.push({ rowIdx: r, hasDiff, cells });
    }
    const identicalRows = rows.filter((r) => !r.hasDiff).length;
    const totalCells = rows.length * cols.length;
    return {
      cols, rows, totalDiffs,
      onlyInLeft: Math.max(0, leftRows.length - rightRows.length),
      onlyInRight: Math.max(0, rightRows.length - leftRows.length),
      leftCount: leftRows.length,
      rightCount: rightRows.length,
      identicalRows,
      diffRows: rows.length - identicalRows,
      totalCells,
      matchPct: totalCells > 0 ? ((totalCells - totalDiffs) / totalCells) * 100 : 100,
      rowsCompared: maxRows,
      totalAvailable: Math.max(left.total, right.total),
      serverCapped: left.truncated || right.truncated,
    };
  }, [left, right, compareLimit, allRowsById]);

  const [showOnlyDiffs, setShowOnlyDiffs] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const DIFF_PAGE_SIZE = 500;
  const [diffVisibleLimit, setDiffVisibleLimit] = React.useState(DIFF_PAGE_SIZE);
  React.useEffect(() => setDiffVisibleLimit(DIFF_PAGE_SIZE), [leftId, rightId]);
  const [hiddenCols, setHiddenCols] = React.useState<Set<string>>(() => new Set());
  React.useEffect(() => setHiddenCols(new Set()), [leftId, rightId]);
  const [colsPanelOpen, setColsPanelOpen] = React.useState(false);
  const colsBtnRef = React.useRef<HTMLButtonElement>(null);
  const [rowDetail, setRowDetail] = React.useState<RowDetailData | null>(null);

  const visibleDiff = React.useMemo(() => {
    if (!diffData) return null;
    if (hiddenCols.size === 0) return diffData;
    const keepIdx: number[] = [];
    const keepCols: string[] = [];
    diffData.cols.forEach((c, i) => {
      if (!hiddenCols.has(c)) {
        keepIdx.push(i);
        keepCols.push(c);
      }
    });
    let totalDiffs = 0;
    const rows = diffData.rows.map((r) => {
      const cells = keepIdx.map((i) => r.cells[i]);
      const hasDiff = cells.some((c) => !c.match);
      if (hasDiff) totalDiffs += cells.filter((c) => !c.match).length;
      return { rowIdx: r.rowIdx, hasDiff, cells };
    });
    return { ...diffData, cols: keepCols, rows, totalDiffs };
  }, [diffData, hiddenCols]);
  const diffIsComplete =
    !!visibleDiff && visibleDiff.rowsCompared >= visibleDiff.totalAvailable && !visibleDiff.serverCapped && hiddenCols.size === 0;

  async function handleExportExcel() {
    if (!visibleDiff || !left || !right) return;
    setExporting(true);
    try {
      const leftLabel = `${left.scriptName} / ${left.label}`;
      const rightLabel = `${right.scriptName} / ${right.label}`;
      const exportRows = showOnlyDiffs ? visibleDiff.rows.filter((r) => r.hasDiff) : visibleDiff.rows;
      const payload = {
        left_label: leftLabel,
        right_label: rightLabel,
        left_source: leftLabel,
        right_source: rightLabel,
        columns: visibleDiff.cols,
        rows: exportRows.map((r) => ({
          row_idx: r.rowIdx,
          has_diff: r.hasDiff,
          cells: r.cells.map((c) => ({
            left: c.left == null ? null : String(c.left),
            right: c.right == null ? null : String(c.right),
            match: c.match,
          })),
        })),
        total_diffs: visibleDiff.totalDiffs,
        left_row_count: visibleDiff.leftCount,
        right_row_count: visibleDiff.rightCount,
        only_in_left: visibleDiff.onlyInLeft,
        only_in_right: visibleDiff.onlyInRight,
        show_only_diffs: showOnlyDiffs,
        left_sql: left.sql || "",
        right_sql: right.sql || "",
        all_columns: diffData?.cols ?? visibleDiff.cols,
        hidden_columns: [...hiddenCols],
        compare_limit: compareLimit === "all" ? -1 : compareLimit,
        rows_compared: visibleDiff.rowsCompared,
        total_available: visibleDiff.totalAvailable,
        identical_rows: visibleDiff.identicalRows,
        diff_rows: visibleDiff.diffRows,
        total_cells: visibleDiff.totalCells,
        match_pct: visibleDiff.matchPct,
        left_elapsed_ms: left.elapsedMs || 0,
        right_elapsed_ms: right.elapsedMs || 0,
      };
      const res = await fetch(apiUrl("/api/sql-ide/diff/export-excel?save_to_disk=true"), {
        method: "POST",
        headers: apiAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
      const partial = `${visibleDiff.rowsCompared} of ${visibleDiff.totalAvailable} available rows${visibleDiff.serverCapped ? "; server-capped" : ""}${hiddenCols.size ? "; some columns hidden" : ""}`;
      if ((res.headers.get("Content-Type") || "").includes("application/json")) {
        const data = await res.json();
        const savedPath: string = data?.saved_path || data?.path || "";
        if (diffIsComplete) toast.success("Visual Diff saved", { description: savedPath || "Saved to exports folder" });
        else toast.warning("Visual Diff saved with a partial result", { description: partial });
      } else {
        const blob = await res.blob();
        const m = (res.headers.get("Content-Disposition") || "").match(/filename="?([^"]+)"?/);
        const filename = m?.[1] ?? `visual_diff_${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}.xlsx`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (diffIsComplete) toast.success("Visual Diff exported", { description: filename });
        else toast.warning("Visual Diff exported with a partial result", { description: partial });
      }
    } catch (err: any) {
      toast.error("Export failed", { description: String(err?.message ?? err) });
    } finally {
      setExporting(false);
    }
  }

  const optionLabel = (t: DiffSource) => `${t.scriptName} / ${t.label} (${formatNumber(t.total)} rows)`;
  const filteredRows = visibleDiff ? (showOnlyDiffs ? visibleDiff.rows.filter((r) => r.hasDiff) : visibleDiff.rows) : [];

  return (
    <div className="flex h-full min-h-0 flex-col space-y-2 p-4">
      <div className="flex shrink-0 items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          <ArrowLeftRight className="h-4 w-4" /> Visual Diff
        </span>
        <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex shrink-0 items-end gap-2">
        {(["Left", "Right"] as const).map((side) => (
          <div key={side} className="flex-1">
            <Label className="text-[11px]">{side} result</Label>
            <select
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              value={side === "Left" ? leftId : rightId}
              disabled={loadingAllRows}
              onChange={(e) =>
                onDiffIdsChange(side === "Left" ? [e.target.value, rightId] : [leftId, e.target.value])
              }
            >
              <option value="">— select —</option>
              {sources.map((t) => (
                <option key={t.id} value={t.id}>
                  {optionLabel(t)}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div>
          <Label className="text-[11px]">Compare rows</Label>
          <select
            className="h-8 w-24 rounded-md border bg-background px-2 text-xs"
            value={compareLimit === "all" ? "all" : String(compareLimit)}
            onChange={(e) => void handleCompareLimitChange(e.target.value === "all" ? "all" : Number(e.target.value))}
            disabled={loadingAllRows}
          >
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="1000">1,000</option>
            <option value="5000">5,000</option>
            <option value="all">All</option>
          </select>
        </div>
        {loadingAllRows && <Loader2 className="mb-2 h-4 w-4 animate-spin text-primary" />}
      </div>

      {!visibleDiff && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Pick a left and a right result to compare.
        </div>
      )}

      {visibleDiff && (
        <div className="flex min-h-0 flex-1 flex-col space-y-1.5">
          <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
            <Badge variant={visibleDiff.totalDiffs > 0 ? "destructive" : diffIsComplete ? "success" : "warning"}>
              {visibleDiff.totalDiffs > 0
                ? `${formatNumber(visibleDiff.totalDiffs)} cell differences`
                : diffIsComplete ? "Identical" : "No differences in preview"}
            </Badge>
            <span className="text-muted-foreground">
              Compared {formatNumber(visibleDiff.rowsCompared)} of {formatNumber(visibleDiff.totalAvailable)} rows
            </span>
            {visibleDiff.rowsCompared < visibleDiff.totalAvailable && <Badge variant="warning" className="text-[10px]">partial preview</Badge>}
            {visibleDiff.serverCapped && <Badge variant="warning" className="text-[10px]">server-capped</Badge>}
            <span className="text-muted-foreground">· {visibleDiff.matchPct.toFixed(1)}% match</span>
            <span className="text-muted-foreground">
              · {formatNumber(visibleDiff.identicalRows)} identical, {formatNumber(visibleDiff.diffRows)} differ
            </span>
            {visibleDiff.onlyInLeft > 0 && <span className="text-red-600">+{visibleDiff.onlyInLeft} only in left</span>}
            {visibleDiff.onlyInRight > 0 && <span className="text-green-600">+{visibleDiff.onlyInRight} only in right</span>}
            {hiddenCols.size > 0 && <span className="text-amber-600">({hiddenCols.size} column{hiddenCols.size === 1 ? "" : "s"} hidden)</span>}
            <div className="ml-auto flex items-center gap-3">
              <Button
                ref={colsBtnRef}
                variant="outline"
                size="sm"
                onClick={() => setColsPanelOpen((v) => !v)}
                className="h-7 gap-1 px-2 text-xs"
              >
                <Columns className="h-3 w-3" /> Columns ({diffData ? diffData.cols.length - hiddenCols.size : 0}/{diffData?.cols.length ?? 0})
              </Button>
              {colsPanelOpen && diffData && colsBtnRef.current &&
                ReactDOM.createPortal(
                  <ColumnsPopover
                    anchor={colsBtnRef.current}
                    diffData={diffData}
                    hiddenCols={hiddenCols}
                    setHiddenCols={setHiddenCols}
                    onClose={() => setColsPanelOpen(false)}
                  />,
                  document.body,
                )}
              <Button variant="outline" size="sm" onClick={handleExportExcel} disabled={exporting} className="h-7 gap-1 px-2 text-xs">
                {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Export Excel
              </Button>
              <label className="flex cursor-pointer select-none items-center gap-1">
                <input type="checkbox" checked={showOnlyDiffs} onChange={(e) => setShowOnlyDiffs(e.target.checked)} className="h-3 w-3" />
                Only rows with differences
              </label>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-md border scrollbar-thin">
            <table className="w-full border-collapse text-[11px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-muted">
                  <th className="w-8 border-b border-r px-1.5 py-1 text-left font-medium text-muted-foreground">#</th>
                  <th className="w-6 border-b border-r px-1.5 py-1 text-center font-medium text-muted-foreground">L/R</th>
                  {visibleDiff.cols.map((col, ci) => (
                    <th key={ci} className="whitespace-nowrap border-b border-r px-1.5 py-1 text-left font-medium">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.slice(0, diffVisibleLimit).map((row) => (
                  <React.Fragment key={row.rowIdx}>
                    <tr className={row.hasDiff ? "bg-red-500/5" : ""}>
                      <td
                        rowSpan={2}
                        className="cursor-pointer border-b border-r px-1.5 py-0.5 text-center align-middle font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() =>
                          setRowDetail({
                            rowNumber: row.rowIdx + 1,
                            columns: visibleDiff.cols,
                            leftValues: row.cells.map((c) => c.left as any),
                            rightValues: row.cells.map((c) => c.right as any),
                            matches: row.cells.map((c) => c.match),
                            title: `Row ${row.rowIdx + 1} — full L/R values`,
                          })
                        }
                        title="View full L/R values for this row"
                      >
                        {row.rowIdx + 1}
                      </td>
                      <td className="border-r px-1.5 py-0.5 text-center text-[10px] font-bold text-red-600">L</td>
                      {row.cells.map((cell, ci) => (
                        <td
                          key={ci}
                          className={cn(
                            "max-w-[180px] truncate border-r px-1.5 py-0.5 font-mono",
                            !cell.match && "bg-red-500/15 font-semibold text-red-700 dark:text-red-300",
                          )}
                          title={cell.left != null ? escapeControlCharsPlain(String(cell.left)) : ""}
                        >
                          {cell.left == null ? <span className="italic text-muted-foreground">NULL</span> : renderControlChars(String(cell.left))}
                        </td>
                      ))}
                    </tr>
                    <tr className={cn(row.hasDiff ? "bg-green-500/5" : "", "border-b")}>
                      <td className="border-r px-1.5 py-0.5 text-center text-[10px] font-bold text-green-600">R</td>
                      {row.cells.map((cell, ci) => (
                        <td
                          key={ci}
                          className={cn(
                            "max-w-[180px] truncate border-r px-1.5 py-0.5 font-mono",
                            !cell.match && "bg-green-500/15 font-semibold text-green-700 dark:text-green-300",
                          )}
                          title={cell.right != null ? escapeControlCharsPlain(String(cell.right)) : ""}
                        >
                          {cell.right == null ? <span className="italic text-muted-foreground">NULL</span> : renderControlChars(String(cell.right))}
                        </td>
                      ))}
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
            {filteredRows.length > diffVisibleLimit && (
              <div className="flex items-center gap-2 border-t p-1.5 text-[11px] text-muted-foreground">
                <span>
                  Showing {formatNumber(diffVisibleLimit)} of {formatNumber(filteredRows.length)} rows.
                </span>
                <button onClick={() => setDiffVisibleLimit((v) => v + DIFF_PAGE_SIZE)} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20">
                  Show more
                </button>
                {filteredRows.length <= 5000 && (
                  <button onClick={() => setDiffVisibleLimit(filteredRows.length)} className="rounded bg-primary/10 px-1.5 py-0.5 text-primary hover:bg-primary/20">
                    Show all ({formatNumber(filteredRows.length)})
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <RowDetailDialog data={rowDetail} onClose={() => setRowDetail(null)} />
    </div>
  );
}
