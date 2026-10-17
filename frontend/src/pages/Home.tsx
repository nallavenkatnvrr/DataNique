import * as React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Database, FileSpreadsheet, GitCompareArrows, Layers, Play, Table2 } from "lucide-react";
import { api } from "@/api/client";
import { EmptyState, KindIcon, Sparkline, SpectrumBar, Stat, VerdictBadge, compactNumber, timeAgo } from "@/components/kit";
import { phaseLabel, useActiveJobs } from "@/lib/jobs";
import { formatDuration } from "@/lib/utils";

export function HomePage() {
  const navigate = useNavigate();
  const metrics = useQuery({ queryKey: ["metrics", "dashboard"], queryFn: () => api.dashboardMetrics(30), staleTime: 15_000 });
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const active = useActiveJobs();
  const m = metrics.data as any;
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const starts = [
    { t: "Table vs table", d: "Two tables, any databases", icon: Table2, to: "/compare" },
    { t: "File vs table", d: "CSV, Excel, Parquet… against a table", icon: FileSpreadsheet, to: "/compare?source_kind=file&target_kind=table" },
    { t: "File vs file", d: "Data and format checks", icon: FileSpreadsheet, to: "/compare?source_kind=file&target_kind=file" },
    { t: "Bulk", d: "Whole schemas or folders, auto-paired", icon: Layers, to: "/bulk" },
  ];

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6">
      <div className="relative overflow-hidden rounded-2xl border bg-card p-7">
        <div className="dv-grid-bg pointer-events-none absolute inset-0 opacity-50 [mask-image:linear-gradient(to_left,black,transparent_70%)]" />
        <div className="pointer-events-none absolute -right-40 -top-40 h-96 w-96 bg-[radial-gradient(closest-side,hsl(var(--primary)/0.22),transparent)]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-sm text-muted-foreground">{greet}</div>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">What do you want to <span className="dv-brand-text">validate</span>?</h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">Compare tables, queries and files across Snowflake, Oracle, SQL Server, PostgreSQL and MySQL. Runs continue in the background.</p>
          </div>
          <button type="button" onClick={() => navigate("/compare")}
            className="dv-glow inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition hover:brightness-110">
            <GitCompareArrows className="h-4 w-4" /> New compare
          </button>
        </div>
        <div className="relative mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {starts.map((s) => (
            <Link key={s.t} to={s.to} className="group flex items-center gap-3 rounded-xl border bg-background/60 p-4 transition-colors hover:border-primary/50 hover:bg-background">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary"><s.icon className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{s.t}</div>
                <div className="truncate text-xs text-muted-foreground">{s.d}</div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
            </Link>
          ))}
        </div>
      </div>

      {(active.data ?? []).length > 0 && (
        <div className="dv-panel p-4">
          <div className="dv-label mb-3">Running now</div>
          <div className="grid gap-2 md:grid-cols-2">
            {(active.data ?? []).map((j) => (
              <Link key={j.id} to={`/jobs/${j.id}`} className="flex items-center gap-3 rounded-lg border p-3 hover:border-primary/50">
                <Play className="h-4 w-4 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{j.kind === "bulk" ? j.name : `${j.source_label} → ${j.target_label}`}</div>
                  <div className="dv-indeterminate mt-1.5 h-1 rounded-full bg-muted" />
                </div>
                <span className="text-xs text-muted-foreground">{phaseLabel(j.phase)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Runs (30 days)" value={compactNumber(m?.total_runs ?? 0)} tone="primary" sub={<Sparkline values={(m?.daily_activity ?? []).map((d: any) => d.count)} width={150} height={26} />} />
        <Stat label="Matched" tone="equal" value={m?.total_runs ? `${Math.round((m.success_rate ?? 0) * 100)}%` : "-"} sub={`${m?.match_count ?? 0} runs`} />
        <Stat label="Mismatched" tone="changed" value={compactNumber(m?.mismatch_count ?? 0)} sub={`${m?.error_count ?? 0} errors`} />
        <Stat label="Rows compared" value={compactNumber(m?.total_rows_compared ?? 0)} sub={`avg ${formatDuration(m?.avg_elapsed_ms ?? 0)} per run`} />
        <Stat label="Connections" value={conns.data?.length ?? "-"} sub={<Link to="/connections" className="text-primary hover:underline">Manage</Link>} />
      </div>

      <div className="dv-panel overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-semibold">Recent runs</div>
          <Link to="/history" className="text-xs text-primary hover:underline">All history</Link>
        </div>
        {!m?.recent_runs?.length ? (
          <EmptyState icon={<Database className="h-5 w-5" />} title="No runs yet">Start with a compare above.</EmptyState>
        ) : (
          <div className="divide-y">
            {m.recent_runs.map((r: any) => {
              const s = r.summary ?? {};
              return (
                <Link key={r.run_uuid} to={`/runs/${r.run_uuid}`} className="grid grid-cols-[auto_minmax(0,1fr)_180px_90px_90px] items-center gap-4 px-4 py-3 hover:bg-accent/40">
                  <VerdictBadge verdict={r.verdict || r.status} size="sm" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-sm"><KindIcon kind={s.source_kind} /> {r.source_label} <ArrowRight className="h-3 w-3 text-muted-foreground" /> <KindIcon kind={s.target_kind} /> {r.target_label}</div>
                  </div>
                  <SpectrumBar equal={s.matching ?? 0} changed={s.changed ?? 0} onlySrc={s.only_in_source ?? 0} onlyTgt={s.only_in_target ?? 0} height={6} />
                  <span className="text-right text-xs tabular-nums text-muted-foreground">{formatDuration(r.elapsed_ms)}</span>
                  <span className="text-right text-xs text-muted-foreground">{timeAgo(r.started_at)}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
