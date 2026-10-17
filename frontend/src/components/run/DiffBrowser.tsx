/**
 * Browse every stored difference of a run: changed rows side by side, rows
 * only in the source or only in the target. Server-paged, virtualized.
 */
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Download, Eye, EyeOff, Search, X } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/api/client";
import { downloadTicket, runsApi, type DiffPage } from "@/api/engine";
import { Spinner } from "@/components/kit";
import { cn, formatNumber } from "@/lib/utils";

export type DiffKind = "changed" | "only_source" | "only_target";
const PAGE = 400;

interface Props {
  runUuid: string;
  counts: Record<DiffKind, number>;
  kind: DiffKind;
  onKind: (k: DiffKind) => void;
  column: string | null;
  onColumn: (c: string | null) => void;
  keyed: boolean;
}

export function DiffBrowser({ runUuid, counts, kind, onKind, column, onColumn, keyed }: Props) {
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [onlyDiffCols, setOnlyDiffCols] = React.useState(true);
  const [data, setData] = React.useState<{ columns: DiffPage["columns"]; rows: unknown[][]; total: number } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const loadingRef = React.useRef(false);
  const genRef = React.useRef(0);

  React.useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = React.useCallback(async (offset: number, reset: boolean) => {
    if (loadingRef.current && !reset) return;
    const gen = reset ? ++genRef.current : genRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const page = await runsApi.diff(runUuid, { kind, offset, limit: PAGE, search: q || undefined, column: kind === "changed" ? column ?? undefined : undefined });
      if (gen !== genRef.current) return;
      setData((prev) => ({ columns: page.columns, total: page.total, rows: reset || !prev ? page.rows : prev.rows.concat(page.rows) }));
      setError(null);
    } catch (e) {
      if (gen === genRef.current) setError(errorText(e));
    } finally {
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [runUuid, kind, q, column]);

  React.useEffect(() => {
    setData(null);
    void load(0, true);
  }, [load]);

  const exportAs = async (format: string) => {
    try {
      const t = await runsApi.export(runUuid, { kind, format, search: q || undefined, column: kind === "changed" ? column ?? undefined : undefined });
      downloadTicket(t);
    } catch (e) {
      toast.error("Export failed", { description: errorText(e) });
    }
  };

  const tabs: { k: DiffKind; label: string; dot: string }[] = [
    ...(keyed ? [{ k: "changed" as const, label: "Changed", dot: "bg-changed" }] : []),
    { k: "only_source", label: "Only in source", dot: "bg-only-src" },
    { k: "only_target", label: "Only in target", dot: "bg-only-tgt" },
  ];

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button key={t.k} type="button" onClick={() => onKind(t.k)}
              className={cn("flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm", kind === t.k ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <span className={cn("h-2 w-2 rounded-full", t.dot)} />
              {t.label}
              <span className="tabular-nums text-xs text-muted-foreground">{formatNumber(counts[t.k] ?? 0)}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {kind === "changed" && column && (
            <button type="button" onClick={() => onColumn(null)} className="dv-chip border-changed/40 bg-changed/10 text-changed">
              column: {column} <X className="h-3 w-3" />
            </button>
          )}
          {kind === "changed" && (
            <button type="button" onClick={() => setOnlyDiffCols((v) => !v)} title="Show only columns that differ"
              className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs", onlyDiffCols && "border-primary/50 text-primary")}>
              {onlyDiffCols ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} Differing columns
            </button>
          )}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search values…" className="dv-input h-8 w-52 pl-8 text-xs" />
          </div>
          <ExportMenu onPick={exportAs} />
        </div>
      </div>
      {error && <div className="p-4 text-sm text-destructive">{error}</div>}
      {!data && !error && <div className="grid h-48 place-items-center"><Spinner /></div>}
      {data && (kind === "changed"
        ? <ChangedGrid data={data} onlyDiffCols={onlyDiffCols} onEnd={() => data.rows.length < data.total && void load(data.rows.length, false)} onColumn={onColumn} />
        : <PlainGrid data={data} onEnd={() => data.rows.length < data.total && void load(data.rows.length, false)} />)}
      <div className="flex items-center justify-between border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>{data ? `${formatNumber(data.rows.length)} of ${formatNumber(data.total)} rows loaded` : ""}</span>
        {loading && <Spinner className="h-3.5 w-3.5" />}
      </div>
    </div>
  );
}

function ExportMenu({ onPick }: { onPick: (f: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs hover:bg-accent">
        <Download className="h-3.5 w-3.5" /> Export
      </button>
      {open && (
        <div className="dv-panel absolute right-0 top-9 z-30 w-40 p-1 scale-in">
          {[["xlsx", "Excel (.xlsx)"], ["csv", "CSV"], ["parquet", "Parquet"], ["json", "JSON"]].map(([f, l]) => (
            <button key={f} type="button" onClick={() => { setOpen(false); onPick(f); }} className="block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent">{l}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function diffList(v: unknown): string[] {
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Cell({ v, className }: { v: unknown; className?: string }) {
  if (v === null || v === undefined) return <span className={cn("italic text-muted-foreground/50", className)}>NULL</span>;
  const s = fmt(v);
  return <span className={cn("truncate", s === "" && "italic text-muted-foreground/50", className)} title={s}>{s === "" ? "(empty)" : s}</span>;
}

function useEndTrigger(virt: { getVirtualItems: () => { index: number }[] }, count: number, onEnd: () => void) {
  const items = virt.getVirtualItems();
  const last = items[items.length - 1]?.index ?? 0;
  React.useEffect(() => {
    if (count && last >= count - 40) onEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, count]);
}

/* Grids: rows AND columns are virtualized (only what is on screen is in the
 * DOM, so a 60-column table scrolls as smoothly as a 5-column one). Cells are
 * absolutely positioned with fixed widths - no per-row CSS grid layout. The
 * row number and key columns stay pinned on the left. */
const ROW_NUM_W = 64;

/* Rows are recycled through a fixed set of DOM slots instead of being
 * inserted and removed while scrolling: key = index mod window size, so the
 * row scrolling in takes over the slot of the row scrolling out. Inserting a
 * row in front of its siblings makes Chrome restyle every row in the grid
 * (Tailwind's space-y/divide-y "~" rules mark parents as sibling-sensitive). */
function bySlot<T extends { index: number }>(items: T[], slot: (i: number) => number): T[] {
  // DOM order = slot order, so React never moves a row node.
  return [...items].sort((a, b) => slot(a.index) - slot(b.index));
}

function useSlots(itemsLength: number) {
  const size = React.useRef(0);
  if (itemsLength > size.current) size.current = itemsLength;
  const n = Math.max(1, size.current);
  return (index: number) => index % n;
}

function useGridVirtual(ref: React.RefObject<HTMLDivElement>, rows: number, rowH: number, colWidths: number[], pinnedW: number) {
  // useFlushSync off: both virtualizers update in one batched React render per
  // frame instead of two synchronous ones that force layout in between.
  const rowsV = useVirtualizer({ count: rows, getScrollElement: () => ref.current, estimateSize: () => rowH, overscan: 6, useFlushSync: false });
  const colsV = useVirtualizer({
    horizontal: true, count: colWidths.length, getScrollElement: () => ref.current,
    estimateSize: (i) => colWidths[i], overscan: 2, paddingStart: pinnedW, useFlushSync: false,
  });
  // column widths change when "differing columns only" is toggled
  React.useEffect(() => { colsV.measure(); }, [colWidths.join(","), pinnedW]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrollW = colWidths.reduce((a, b) => a + b, 0);
  return { rowsV, colsV, totalW: pinnedW + scrollW, scrollW };
}

const gridBox = "h-[560px] overflow-auto font-mono text-[12px] scrollbar-thin";
const gridContain: React.CSSProperties = { contain: "strict" };

function PlainGrid({ data, onEnd }: { data: { columns: DiffPage["columns"]; rows: unknown[][] }; onEnd: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const cols = data.columns;
  const widths = React.useMemo(() => cols.map((c) => Math.min(280, Math.max(120, c.name.length * 8 + 28))), [cols]);
  const { rowsV, colsV, totalW, scrollW } = useGridVirtual(ref, data.rows.length, 30, widths, ROW_NUM_W);
  const slotKey = useSlots(rowsV.getVirtualItems().length);
  useEndTrigger(rowsV, data.rows.length, onEnd);
  const vcols = colsV.getVirtualItems();
  return (
    <div ref={ref} className={gridBox} style={gridContain}>
      <div style={{ width: totalW, height: rowsV.getTotalSize() + 34, position: "relative" }}>
        <div className="sticky top-0 z-20 flex h-[34px] border-b bg-muted" style={{ width: totalW }}>
          <div className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r bg-muted px-2 text-muted-foreground" style={{ width: ROW_NUM_W }}>#</div>
          <div className="relative shrink-0" style={{ width: scrollW }}>
            {vcols.map((vc) => {
              const c = cols[vc.index];
              return <div key={vc.key} className="absolute top-0 flex h-full items-center truncate px-2 font-sans text-xs font-semibold" style={{ left: vc.start - ROW_NUM_W, width: vc.size }} title={`${c.name} ${c.type ?? ""}`}>{c.name}</div>;
            })}
          </div>
        </div>
        {bySlot(rowsV.getVirtualItems(), slotKey).map((vr) => {
          const r = data.rows[vr.index];
          return (
            <div key={slotKey(vr.index)} className="group absolute left-0 flex border-b border-border/60" style={{ top: 34, width: totalW, height: vr.size, transform: `translateY(${vr.start}px)` }}>
              <div className="sticky left-0 z-10 flex shrink-0 items-center justify-end border-r bg-card px-2 text-muted-foreground/60 group-hover:bg-accent" style={{ width: ROW_NUM_W }}>{vr.index + 1}</div>
              <div className="relative shrink-0 group-hover:bg-accent/40" style={{ width: scrollW }}>
                {vcols.map((vc) => (
                  <div key={vc.key} className="absolute top-0 flex h-full min-w-0 items-center px-2" style={{ left: vc.start - ROW_NUM_W, width: vc.size }}><Cell v={r[vc.index]} /></div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChangedGrid({ data, onlyDiffCols, onEnd, onColumn }: {
  data: { columns: DiffPage["columns"]; rows: unknown[][] }; onlyDiffCols: boolean; onEnd: () => void; onColumn: (c: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const { idx, keys, comps } = React.useMemo(() => {
    const names = data.columns.map((c) => c.name);
    return {
      idx: Object.fromEntries(names.map((n, i) => [n, i])) as Record<string, number>,
      keys: names.filter((n) => n.startsWith("k:")).map((n) => n.slice(2)),
      comps: names.filter((n) => n.startsWith("s:")).map((n) => n.slice(2)),
    };
  }, [data.columns]);
  const diffSets = React.useMemo(() => data.rows.map((r) => new Set(diffList(r[idx.__diff]))), [data.rows, idx]);
  const diffCols = React.useMemo(() => {
    const set = new Set<string>();
    for (const d of diffSets) for (const c of d) set.add(c);
    return set;
  }, [diffSets]);
  const shown = React.useMemo(() => {
    const filtered = comps.filter((c) => diffCols.has(c));
    return onlyDiffCols && filtered.length ? filtered : comps;
  }, [comps, diffCols, onlyDiffCols]);
  const KEY_W = 120;
  const pinnedW = ROW_NUM_W + keys.length * KEY_W;
  const widths = React.useMemo(() => shown.map((c) => Math.min(300, Math.max(170, c.length * 8 + 28))), [shown]);
  const { rowsV, colsV, totalW, scrollW } = useGridVirtual(ref, data.rows.length, 46, widths, pinnedW);
  const slotKey = useSlots(rowsV.getVirtualItems().length);
  useEndTrigger(rowsV, data.rows.length, onEnd);
  const vcols = colsV.getVirtualItems();
  return (
    <div ref={ref} className={gridBox} style={gridContain}>
      <div style={{ width: totalW, height: rowsV.getTotalSize() + 34, position: "relative" }}>
        <div className="sticky top-0 z-20 flex h-[34px] border-b bg-muted" style={{ width: totalW }}>
          <div className="sticky left-0 z-10 flex shrink-0 border-r bg-muted" style={{ width: pinnedW }}>
            <div className="flex shrink-0 items-center justify-end px-2 text-muted-foreground" style={{ width: ROW_NUM_W }}>#</div>
            {keys.map((k) => <div key={k} className="flex shrink-0 items-center truncate px-2 font-sans text-xs font-semibold text-changed" style={{ width: KEY_W }} title={k}>⚿ {k}</div>)}
          </div>
          <div className="relative shrink-0" style={{ width: scrollW }}>
            {vcols.map((vc) => {
              const c = shown[vc.index];
              return (
                <button key={vc.key} type="button" onClick={() => onColumn(c)} title="Show only rows where this column differs"
                  className={cn("absolute top-0 h-full truncate px-2 text-left font-sans text-xs font-semibold hover:text-primary", diffCols.has(c) && "text-changed")}
                  style={{ left: vc.start - pinnedW, width: vc.size }}>{c}</button>
              );
            })}
          </div>
        </div>
        {bySlot(rowsV.getVirtualItems(), slotKey).map((vr) => {
          const r = data.rows[vr.index];
          const d = diffSets[vr.index];
          return (
            <div key={slotKey(vr.index)} className="group absolute left-0 flex border-b border-border/60" style={{ top: 34, width: totalW, height: vr.size, transform: `translateY(${vr.start}px)` }}>
              <div className="sticky left-0 z-10 flex shrink-0 border-r bg-card group-hover:bg-accent" style={{ width: pinnedW }}>
                <div className="flex shrink-0 items-center justify-end px-2 text-muted-foreground/60" style={{ width: ROW_NUM_W }}>{vr.index + 1}</div>
                {keys.map((k) => <div key={k} className="flex min-w-0 shrink-0 items-center px-2 font-medium" style={{ width: KEY_W }}><Cell v={r[idx["k:" + k]]} /></div>)}
              </div>
              <div className="relative shrink-0 group-hover:bg-accent/30" style={{ width: scrollW }}>
                {vcols.map((vc) => {
                  const c = shown[vc.index];
                  const pos = { left: vc.start - pinnedW, width: vc.size };
                  const sv = r[idx["s:" + c]];
                  if (!d.has(c)) return <div key={vc.key} className="absolute top-0 flex h-full min-w-0 items-center px-2 text-muted-foreground" style={pos}><Cell v={sv} /></div>;
                  const tv = r[idx["t:" + c]];
                  return (
                    <div key={vc.key} className="absolute top-0 flex h-full min-w-0 flex-col justify-center gap-0.5 bg-changed/10 px-2" style={pos}>
                      <span className="flex min-w-0 items-center gap-1"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-only-src" /><Cell v={sv} className="text-only-src" /></span>
                      <span className="flex min-w-0 items-center gap-1"><span className="h-1.5 w-1.5 shrink-0 rounded-full bg-only-tgt" /><Cell v={tv} className="text-only-tgt" /></span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
