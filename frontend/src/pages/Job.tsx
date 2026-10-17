/**
 * Live view of a running job. A compare job turns into its result page when
 * it finishes; a bulk job shows a board of its items.
 */
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CheckCircle2, CircleDashed, Layers, Loader2, Square, TriangleAlert } from "lucide-react";
import { jobsApi, type Job, type JobEvent, type RunSummary } from "@/api/engine";
import { EmptyState, PageHeader, SpectrumBar, Spinner, VerdictBadge, compactNumber } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { isFinished, phaseLabel, useJob } from "@/lib/jobs";
import { cn, formatDuration } from "@/lib/utils";

const PHASES = ["connect", "read", "prepare", "diff", "stats", "store"] as const;

export function JobPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const { job, events, error } = useJob(jobId);

  React.useEffect(() => {
    if (job?.kind === "compare" && job.status === "done" && job.run_uuid) {
      const t = setTimeout(() => navigate(`/runs/${job.run_uuid}`, { replace: true }), 450);
      return () => clearTimeout(t);
    }
  }, [job?.status, job?.run_uuid, job?.kind, navigate]);

  if (error && !job) return <EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Job not found">The app may have restarted. Finished runs are in History.</EmptyState>;
  if (!job) return <div className="grid h-64 place-items-center"><Spinner className="h-5 w-5" /></div>;
  return job.kind === "bulk" ? <BulkBoard job={job} events={events} /> : <CompareLive job={job} events={events} />;
}

function useRates(rows: Record<string, number>) {
  const prev = React.useRef<{ t: number; rows: Record<string, number> } | null>(null);
  const [rates, setRates] = React.useState<Record<string, number>>({});
  React.useEffect(() => {
    const now = performance.now();
    if (prev.current) {
      const dt = (now - prev.current.t) / 1000;
      if (dt > 0.2) {
        const r: Record<string, number> = {};
        for (const k of Object.keys(rows)) r[k] = Math.max(0, (rows[k] - (prev.current.rows[k] ?? 0)) / dt);
        setRates(r);
        prev.current = { t: now, rows: { ...rows } };
      }
    } else prev.current = { t: now, rows: { ...rows } };
  }, [rows]);
  return rates;
}

/** Ticks once a second on its own, so the rest of the page doesn't re-render. */
function Elapsed({ startedAt, finished, elapsedMs }: { startedAt?: string | null; finished: boolean; elapsedMs?: number | null }) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (finished || !startedAt) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [finished, startedAt]);
  const ms = startedAt ? (finished ? elapsedMs ?? 0 : Date.now() - new Date(startedAt).getTime()) : 0;
  return <>{formatDuration(Math.max(0, ms))}</>;
}

function CompareLive({ job, events }: { job: Job; events: JobEvent[] }) {
  const navigate = useNavigate();
  const rates = useRates(job.rows);
  const finished = isFinished(job);
  const phaseIdx = PHASES.indexOf(job.phase as (typeof PHASES)[number]);
  return (
    <div className="mx-auto max-w-[1200px] space-y-5 p-6">
      <PageHeader
        icon={job.status === "running" || job.status === "queued" ? <Loader2 className="h-5 w-5 animate-spin" /> : job.status === "done" ? <CheckCircle2 className="h-5 w-5" /> : <TriangleAlert className="h-5 w-5" />}
        title={job.status === "error" ? "Compare failed" : job.status === "cancelled" ? "Compare cancelled" : job.status === "done" ? "Done" : "Comparing…"}
        subtitle={<span className="font-mono text-xs">{job.source_label} → {job.target_label}</span>}
        actions={
          <>
            {!finished && <Button variant="outline" size="sm" onClick={() => void jobsApi.cancel(job.id)}><Square className="h-3.5 w-3.5" /> Cancel</Button>}
            {finished && job.run_uuid && <Button size="sm" onClick={() => navigate(`/runs/${job.run_uuid}`)}>Open result</Button>}
            {finished && job.run_uuid && <Button variant="outline" size="sm" onClick={() => navigate(`/compare?rerun=${job.run_uuid}`)}>Edit & re-run</Button>}
          </>
        }
      />

      <div className="dv-panel overflow-hidden">
        <div className={cn("h-1", finished ? (job.status === "done" ? "bg-equal" : "bg-destructive") : "dv-indeterminate bg-muted")} />
        <div className="grid gap-6 p-6 md:grid-cols-[1fr_1fr_auto]">
          {(["source", "target"] as const).map((side) => {
            const n = job.rows[side] ?? 0;
            return (
              <div key={side} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn("h-2 w-2 rounded-full", side === "source" ? "bg-only-src" : "bg-only-tgt")} />
                  {side === "source" ? "Source rows" : "Target rows"}
                </div>
                <div className="text-4xl font-semibold tabular-nums tracking-tight">{!n && !finished && job.pct?.[side] != null ? `${Math.round(job.pct[side])}%` : n.toLocaleString()}</div>
                <div className="text-xs tabular-nums text-muted-foreground">{rates[side] && !finished ? `${compactNumber(Math.round(rates[side]))} rows/s` : " "}</div>
                {!finished && job.pct?.[side] != null && job.phase === "read" && (
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full transition-all duration-500", side === "source" ? "bg-only-src" : "bg-only-tgt")} style={{ width: `${job.pct[side]}%` }} />
                    </div>
                    <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{Math.round(job.pct[side])}%</span>
                  </div>
                )}
              </div>
            );
          })}
          <div className="space-y-1 text-right">
            <div className="text-xs text-muted-foreground">Elapsed</div>
            <div className="text-4xl font-semibold tabular-nums tracking-tight"><Elapsed startedAt={job.started_at} finished={finished} elapsedMs={job.elapsed_ms} /></div>
            <div className="text-xs text-muted-foreground">{job.rows.differences != null ? `${job.rows.differences.toLocaleString()} differences returned` : phaseLabel(job.phase)}</div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t px-6 py-4">
          {PHASES.map((p, i) => {
            const state = finished && job.status === "done" ? "done" : i < phaseIdx ? "done" : i === phaseIdx ? "active" : "todo";
            return (
              <div key={p} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                state === "done" && "border-equal/30 bg-equal/10 text-equal", state === "active" && "border-primary/40 bg-primary/10 text-primary", state === "todo" && "text-muted-foreground")}>
                {state === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : state === "active" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleDashed className="h-3.5 w-3.5" />}
                {phaseLabel(p)}
              </div>
            );
          })}
        </div>
      </div>

      {job.error && <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 font-mono text-xs text-destructive">{job.error}</div>}
      <LogConsole events={events} />
    </div>
  );
}

export const LogConsole = React.memo(function LogConsole({ events, className }: { events: { ts: string; level: string; msg: string }[]; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <div className={cn("dv-panel-flat overflow-hidden", className)}>
      <div className="border-b px-4 py-2 dv-label">Log</div>
      <div ref={ref} className="max-h-80 overflow-y-auto bg-surface p-3 font-mono text-[12px] leading-relaxed scrollbar-thin">
        {events.slice(-500).map((e, i) => (
          <div key={i} className="flex gap-3">
            <span className="shrink-0 text-muted-foreground/70">{(e.ts || "").slice(11, 19)}</span>
            <span className={cn("shrink-0 w-10 uppercase", e.level === "error" ? "text-destructive" : e.level === "warn" ? "text-changed" : e.level === "debug" ? "text-muted-foreground/60" : "text-primary")}>{e.level}</span>
            <span className="whitespace-pre-wrap break-words">{e.msg}</span>
          </div>
        ))}
        {!events.length && <div className="text-muted-foreground">Waiting…</div>}
      </div>
    </div>
  );
});

function BulkBoard({ job, events }: { job: Job; events: JobEvent[] }) {
  const navigate = useNavigate();
  const finished = isFinished(job);
  const kids = job.children ?? [];
  const counts = job.counts ?? {};
  const done = kids.filter((k) => isFinished(k)).length;
  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-6">
      <PageHeader icon={<Layers className="h-5 w-5" />} title={job.name || "Bulk compare"}
        subtitle={`${done} of ${kids.length} finished${finished ? ` in ${formatDuration(job.elapsed_ms)}` : ""}`}
        actions={
          <>
            {!finished && <Button variant="outline" size="sm" onClick={() => void jobsApi.cancel(job.id)}><Square className="h-3.5 w-3.5" /> Cancel all</Button>}
            {job.batch_uuid && finished && <Button size="sm" onClick={() => navigate(`/batches/${job.batch_uuid}`)}>Batch report</Button>}
          </>
        } />
      <div className="dv-panel p-4">
        <div className="mb-3 flex flex-wrap gap-4 text-sm">
          {(["match", "mismatch", "error", "cancelled", "running", "queued"] as const).map((k) => counts[k] ? (
            <span key={k} className="flex items-center gap-1.5"><VerdictBadge verdict={k.toUpperCase()} size="sm" /><b className="tabular-nums">{counts[k]}</b></span>
          ) : null)}
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${kids.length ? (done / kids.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {kids.map((k) => {
          const s = (k.summary ?? {}) as RunSummary;
          const verdict = k.status === "done" ? s.verdict : k.status === "running" ? "RUNNING" : k.status === "error" ? "ERROR" : k.status === "cancelled" ? "CANCELLED" : "queued";
          const body = (
            <div className={cn("dv-panel-flat h-full p-4 transition-colors", k.run_uuid && "hover:border-primary/50")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{k.name || k.source_label}</div>
                  <div className="truncate text-xs text-muted-foreground">→ {k.target_label}</div>
                </div>
                <VerdictBadge verdict={verdict} size="sm" />
              </div>
              <div className="mt-3">
                {k.status === "running" ? <div className="dv-indeterminate h-2 rounded-full bg-muted" /> :
                  <SpectrumBar equal={s.matching ?? 0} changed={s.changed ?? 0} onlySrc={s.only_in_source ?? 0} onlyTgt={s.only_in_target ?? 0} />}
              </div>
              <div className="mt-2 flex justify-between text-xs tabular-nums text-muted-foreground">
                <span>{k.status === "running" ? `${phaseLabel(k.phase)} · ${compactNumber((k.rows.source ?? 0) + (k.rows.target ?? 0))} rows` : `${compactNumber(s.source_rows)} / ${compactNumber(s.target_rows)} rows`}</span>
                <span>{k.elapsed_ms ? formatDuration(k.elapsed_ms) : ""}</span>
              </div>
              {k.error && <div className="mt-2 line-clamp-2 text-xs text-destructive">{k.error}</div>}
            </div>
          );
          return k.run_uuid && isFinished(k) ? <Link key={k.id} to={`/runs/${k.run_uuid}`}>{body}</Link> : <div key={k.id}>{body}</div>;
        })}
      </div>
      <LogConsole events={events} />
    </div>
  );
}
