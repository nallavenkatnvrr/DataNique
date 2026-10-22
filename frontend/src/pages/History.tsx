import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowRight, History as HistoryIcon, Layers, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { runsApi } from "@/api/engine";
import { EmptyState, KindIcon, PageHeader, Segmented, SpectrumBar, Spinner, VerdictBadge, compactNumber, timeAgo } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { cn, formatDuration } from "@/lib/utils";

export function HistoryPage() {
  const [view, setView] = React.useState<"runs" | "batches">("runs");
  return (
    <div className="mx-auto flex h-full max-w-[1500px] flex-col gap-5 p-6">
      <PageHeader icon={<HistoryIcon className="h-5 w-5" />} title="History" subtitle="Every run is stored encrypted; differences can be browsed and exported."
        actions={<Segmented value={view} onChange={setView} options={[{ value: "runs", label: "Runs" }, { value: "batches", label: "Bulk batches", icon: <Layers className="h-3.5 w-3.5" /> }]} />} />
      {view === "runs" ? <Runs /> : <Batches />}
    </div>
  );
}

function Runs() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [verdict, setVerdict] = React.useState("");
  const [kind, setKind] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    const t = setTimeout(() => setQ(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const runs = useQuery({
    queryKey: ["runs", "list", verdict, kind, q],
    queryFn: () => runsApi.list({ limit: 1000, verdict: verdict || undefined, kind: kind || undefined, q: q || undefined }),
    refetchInterval: 15_000,
  });
  const del = useMutation({
    mutationFn: () => runsApi.removeMany([...sel]),
    onSuccess: (r) => { toast.success(`Deleted ${r.deleted} runs`); setSel(new Set()); void qc.invalidateQueries({ queryKey: ["runs"] }); },
  });
  const items = runs.data?.items ?? [];
  const ref = React.useRef<HTMLDivElement>(null);
  // Scrolling renders at most once per frame (no synchronous flush per
  // scroll event); rows are memoized, so only rows entering the view render.
  const virt = useVirtualizer({ count: items.length, getScrollElement: () => ref.current, estimateSize: () => ROW_H, overscan: 6, useFlushSync: false });
  const toggle = React.useCallback((u: string) => setSel((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; }), []);
  const open = React.useCallback((u: string) => navigate(`/runs/${u}`), [navigate]);

  return (
    <div className="dv-panel flex min-h-[420px] flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search source or target…" className="dv-input w-72 pl-8" />
        </div>
        <Segmented size="sm" value={verdict} onChange={setVerdict} options={[{ value: "", label: "All" }, { value: "MATCH", label: "Match" }, { value: "MISMATCH", label: "Mismatch" }, { value: "ERROR", label: "Error" }]} />
        <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: "", label: "Any" }, { value: "table", label: "Tables" }, { value: "query", label: "Queries" }, { value: "file", label: "Files" }, { value: "mixed", label: "Mixed" }]} />
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {runs.isFetching && <Spinner className="h-3.5 w-3.5" />}
          {compactNumber(runs.data?.total ?? 0)} runs
          {sel.size > 0 && <Button variant="destructive" size="sm" loading={del.isPending} onClick={() => window.confirm(`Delete ${sel.size} runs?`) && del.mutate()}><Trash2 className="h-3.5 w-3.5" /> Delete {sel.size}</Button>}
        </div>
      </div>
      <div className="grid items-center gap-3 border-b bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground" style={{ gridTemplateColumns: TPL }}>
        <input type="checkbox" className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" checked={!!items.length && sel.size === items.length} onChange={(e) => setSel(e.target.checked ? new Set(items.map((i) => i.run_uuid)) : new Set())} />
        <span>Verdict</span><span>Source → target</span><span>Result</span><span className="text-right">Rows</span><span className="text-right">Time</span><span className="text-right">When</span>
      </div>
      {runs.isLoading ? <div className="grid flex-1 place-items-center"><Spinner /></div> : !items.length ? (
        <EmptyState icon={<HistoryIcon className="h-5 w-5" />} title="No runs" action={<Button size="sm" onClick={() => navigate("/compare")}>New compare</Button>} />
      ) : (
        <div ref={ref} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div style={{ height: virt.getTotalSize(), position: "relative" }}>
            {virt.getVirtualItems().map((vi) => {
              const r = items[vi.index];
              return (
                <div key={r.run_uuid} className="absolute inset-x-0" style={{ height: ROW_H, transform: `translateY(${vi.start}px)` }}>
                  <RunRow r={r} selected={sel.has(r.run_uuid)} onToggle={toggle} onOpen={open} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const ROW_H = 58;
const TPL = "28px 104px minmax(0,1fr) 200px 120px 90px 100px";

type RunItem = Awaited<ReturnType<typeof runsApi.list>>["items"][number];

const RunRow = React.memo(function RunRow({ r, selected, onToggle, onOpen }: {
  r: RunItem; selected: boolean; onToggle: (u: string) => void; onOpen: (u: string) => void;
}) {
  const s = r.summary ?? {};
  return (
    <div className={cn("grid h-full cursor-pointer items-center gap-3 border-b px-4 hover:bg-accent/40", selected && "bg-primary/5")}
      style={{ gridTemplateColumns: TPL, contain: "layout style paint" }}
      onClick={() => onOpen(r.run_uuid)}>
      <input type="checkbox" className="h-3.5 w-3.5 accent-[hsl(var(--primary))]" checked={selected} onClick={(e) => e.stopPropagation()} onChange={() => onToggle(r.run_uuid)} />
      <VerdictBadge verdict={r.verdict || r.status} size="sm" />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 truncate text-sm">
          <KindIcon kind={s.source_kind} /><span className="truncate">{r.source_label}</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          <KindIcon kind={s.target_kind} /><span className="truncate">{r.target_label}</span>
        </div>
        {r.error && <div className="truncate text-xs text-destructive">{r.error}</div>}
        {r.batch_id && <Link to={`/batches/${r.batch_id}`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-primary hover:underline">bulk batch</Link>}
      </div>
      <div className="space-y-1">
        <SpectrumBar equal={s.matching ?? 0} changed={s.changed ?? 0} onlySrc={s.only_in_source ?? 0} onlyTgt={s.only_in_target ?? 0} height={6} />
        <div className="flex gap-2 text-[10.5px] tabular-nums text-muted-foreground">
          {s.changed ? <span className="text-changed">{compactNumber(s.changed)} chg</span> : null}
          {s.only_in_source ? <span className="text-only-src">{compactNumber(s.only_in_source)} src</span> : null}
          {s.only_in_target ? <span className="text-only-tgt">{compactNumber(s.only_in_target)} tgt</span> : null}
        </div>
      </div>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{compactNumber(s.source_rows)}</span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">{formatDuration(r.elapsed_ms)}</span>
      <span className="text-right text-xs text-muted-foreground">{timeAgo(r.started_at)}</span>
    </div>
  );
});

function Batches() {
  const q = useQuery({ queryKey: ["batches"], queryFn: runsApi.batches, refetchInterval: 10_000 });
  if (q.isLoading) return <div className="grid h-40 place-items-center"><Spinner /></div>;
  if (!q.data?.length) return <div className="dv-panel"><EmptyState icon={<Layers className="h-5 w-5" />} title="No bulk batches yet" action={<Link to="/bulk" className="text-sm text-primary hover:underline">Start a bulk compare</Link>} /></div>;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {q.data.map((b) => {
        const c = b.counts ?? {};
        return (
          <Link key={b.batch_uuid} to={`/batches/${b.batch_uuid}`} className="dv-panel-flat p-4 hover:border-primary/50">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate font-medium">{b.name || "Bulk compare"}</div>
              <VerdictBadge verdict={b.status === "RUNNING" ? "RUNNING" : b.status === "SUCCESS" ? (c.mismatch || c.error ? "MISMATCH" : "MATCH") : b.status} size="sm" />
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{b.total} pairs · {timeAgo(b.started_at)}</div>
            <div className="mt-3 flex h-2 gap-px overflow-hidden rounded-full bg-muted">
              {(["match", "mismatch", "error", "cancelled"] as const).map((k) => c[k] ? <div key={k} className={k === "match" ? "bg-equal" : k === "mismatch" ? "bg-changed" : k === "error" ? "bg-destructive" : "bg-muted-foreground"} style={{ width: `${(c[k] / (b.total || 1)) * 100}%` }} /> : null)}
            </div>
            <div className="mt-2 flex gap-3 text-xs tabular-nums text-muted-foreground">
              {Object.entries(c).map(([k, v]) => <span key={k}>{v} {k}</span>)}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
