/**
 * Result of one comparison: verdict, spectrum, sides, timings, columns,
 * statistics, the full difference browser, exports.
 */
import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Clock, Columns3, FileText, FileSpreadsheet, Gauge, Info, Pencil, RotateCw, Rows3, ScrollText, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/api/client";
import { downloadTicket, jobsApi, runsApi, type RunDetail } from "@/api/engine";
import { EmptyState, KindIcon, MatchRing, SpectrumBar, Spinner, Stat, VerdictBadge, compactNumber } from "@/components/kit";
import { DiffBrowser, type DiffKind } from "@/components/run/DiffBrowser";
import { Button } from "@/components/ui/button";
import { LogConsole } from "@/pages/Job";
import { cn, formatBytes, formatDate, formatDuration, formatNumber } from "@/lib/utils";

export function RunPage() {
  const { runUuid } = useParams();
  const q = useQuery({ queryKey: ["run", runUuid], queryFn: () => runsApi.get(runUuid!), enabled: !!runUuid, staleTime: 60_000 });
  if (q.isLoading) return <div className="grid h-64 place-items-center"><Spinner className="h-5 w-5" /></div>;
  if (q.error || !q.data) return <EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Run not found">{q.error ? errorText(q.error) : null}</EmptyState>;
  const r = q.data;
  if (r.result?.schema_version === 2 && r.result.status === "SUCCESS") return <V2 run={r} />;
  return <Basic run={r} />;
}

function Actions({ run }: { run: RunDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const spec = run.options?.spec;
  const rerun = useMutation({
    mutationFn: () => jobsApi.compare(spec),
    onSuccess: (j) => navigate(`/jobs/${j.id}`),
    onError: (e) => toast.error("Couldn't start", { description: errorText(e) }),
  });
  const del = useMutation({
    mutationFn: () => runsApi.remove(run.run_uuid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["runs"] });
      toast.success("Run deleted");
      navigate("/history");
    },
  });
  const report = useMutation({
    mutationFn: () => runsApi.report(run.run_uuid),
    onSuccess: (t) => downloadTicket(t),
    onError: (e) => toast.error("Report failed", { description: errorText(e) }),
  });
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" loading={report.isPending} onClick={() => report.mutate()}><FileSpreadsheet className="h-4 w-4" /> Excel report</Button>
      {spec && <Button variant="outline" size="sm" onClick={() => navigate(`/compare?rerun=${run.run_uuid}`)}><Pencil className="h-4 w-4" /> Edit</Button>}
      {spec && <Button size="sm" loading={rerun.isPending} onClick={() => rerun.mutate()}><RotateCw className="h-4 w-4" /> Run again</Button>}
      <Button variant="ghost" size="sm" onClick={() => window.confirm("Delete this run and its saved differences?") && del.mutate()}><Trash2 className="h-4 w-4" /></Button>
    </div>
  );
}

function Header({ run }: { run: RunDetail }) {
  const res = run.result ?? {};
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Link to="/history" className="hover:text-foreground">History</Link><span>/</span>
          <span>{formatDate(run.started_at)}</span>
          {run.batch_id && <><span>·</span><Link to={`/batches/${run.batch_id}`} className="text-primary hover:underline">batch</Link></>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
          <KindIcon kind={res.source?.kind} /><span className="truncate">{run.source_label}</span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <KindIcon kind={res.target?.kind} /><span className="truncate">{run.target_label}</span>
        </div>
      </div>
      <Actions run={run} />
    </div>
  );
}

function V2({ run }: { run: RunDetail }) {
  const res = run.result;
  const rd = res.row_diff ?? {};
  const keyed = rd.strategy === "keyed";
  const counts: Record<DiffKind, number> = {
    changed: rd.key_match_hash_diff_count ?? 0,
    only_source: rd.only_in_source_count ?? 0,
    only_target: rd.only_in_target_count ?? 0,
  };
  const firstKind: DiffKind = keyed && counts.changed ? "changed" : counts.only_source ? "only_source" : counts.only_target ? "only_target" : keyed ? "changed" : "only_source";
  const [tab, setTab] = React.useState<"diff" | "columns" | "stats" | "files" | "log" | "details">(res.verdict === "MATCH" ? "columns" : "diff");
  const [kind, setKind] = React.useState<DiffKind>(firstKind);
  const [column, setColumn] = React.useState<string | null>(null);
  const total = Math.max(res.source?.row_count ?? 0, res.target?.row_count ?? 0);
  const store = res.diff_store ?? {};
  const pickKind = (k: DiffKind) => { setKind(k); setTab("diff"); if (k !== "changed") setColumn(null); };

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-6">
      <Header run={run} />

      <div className="dv-panel relative overflow-hidden">
        <div className={cn("absolute inset-x-0 top-0 h-1", res.verdict === "MATCH" ? "bg-equal" : "bg-changed")} />
        <div className="grid items-center gap-6 p-6 lg:grid-cols-[auto_1fr]">
          <div className="flex items-center gap-6">
            <MatchRing equal={rd.matching_count ?? 0} total={total} size={128} />
            <div className="space-y-2">
              <VerdictBadge verdict={res.verdict} size="lg" />
              <div className="text-sm text-muted-foreground">
                {formatNumber(rd.matching_count)} of {formatNumber(total)} rows equal
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3.5 w-3.5" /> {formatDuration(res.elapsed_ms)} · <Gauge className="h-3.5 w-3.5" /> {compactNumber(res.rows_per_second)} rows/s
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <SpectrumBar equal={rd.matching_count} changed={counts.changed} onlySrc={counts.only_source} onlyTgt={counts.only_target} height={12} />
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat label="Equal" tone="equal" value={compactNumber(rd.matching_count)} />
              <Stat label="Changed" tone="changed" value={compactNumber(counts.changed)} sub={keyed ? `${(rd.column_mismatches ?? []).length} columns affected` : "needs key columns"}
                onClick={keyed ? () => pickKind("changed") : undefined} active={tab === "diff" && kind === "changed"} />
              <Stat label="Only in source" tone="only-src" value={compactNumber(counts.only_source)} onClick={() => pickKind("only_source")} active={tab === "diff" && kind === "only_source"} />
              <Stat label="Only in target" tone="only-tgt" value={compactNumber(counts.only_target)} onClick={() => pickKind("only_target")} active={tab === "diff" && kind === "only_target"} />
            </div>
          </div>
        </div>
        <SidesStrip res={res} />
      </div>

      {(res.warnings ?? []).length > 0 && (
        <div className="space-y-1.5">
          {res.warnings.map((w: string, i: number) => (
            <div key={i} className="flex items-start gap-2 rounded-lg border border-changed/30 bg-changed/5 px-3 py-2 text-sm"><Info className="mt-0.5 h-4 w-4 shrink-0 text-changed" />{w}</div>
          ))}
        </div>
      )}

      <div className="dv-panel overflow-hidden">
        <div className="flex gap-1 overflow-x-auto border-b px-2">
          {([
            ["diff", "Differences", Rows3],
            ["columns", "Columns", Columns3],
            ...((res.column_stats ?? []).length ? [["stats", "Statistics", Gauge]] : []),
            ...(res.file_checks ? [["files", "File checks", FileText]] : []),
            ["log", "Log", ScrollText],
            ["details", "Details", Info],
          ] as [typeof tab, string, any][]).map(([id, label, Icon]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={cn("relative flex shrink-0 items-center gap-1.5 px-3 py-3 text-sm font-medium", tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {label}
              {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
        {tab === "diff" && (store.available ? (
          <DiffBrowser runUuid={run.run_uuid} counts={counts} kind={kind} onKind={setKind} column={column} onColumn={(c) => { setColumn(c); if (c) setKind("changed"); }} keyed={keyed} />
        ) : <SamplesOnly res={res} />)}
        {tab === "columns" && <ColumnsTab res={res} onColumn={(c) => { setColumn(c); setKind("changed"); setTab("diff"); }} />}
        {tab === "stats" && <StatsTab stats={res.column_stats} />}
        {tab === "files" && <FileChecks fc={res.file_checks} />}
        {tab === "log" && <div className="p-4"><LogConsole events={res.logs ?? []} /></div>}
        {tab === "details" && <pre className="max-h-[560px] overflow-auto p-4 font-mono text-xs scrollbar-thin">{JSON.stringify({ options: res.options, timings: res.timings, key_source: res.key_source, source: res.source, target: res.target }, null, 2)}</pre>}
      </div>
    </div>
  );
}

function SidesStrip({ res }: { res: any }) {
  const t = res.timings ?? {};
  const parts = [
    ["metadata_ms", "Metadata", "bg-muted-foreground/50"], ["read_ms", "Read", "bg-primary"], ["prepare_ms", "Match", "bg-cyan-500"],
    ["diff_ms", "Compare", "bg-changed"], ["stats_ms", "Stats", "bg-violet-500"], ["store_ms", "Save", "bg-equal"], ["file_checks_ms", "File checks", "bg-pink-500"],
  ].filter(([k]) => t[k]);
  const sum = parts.reduce((a, [k]) => a + (t[k] || 0), 0) || 1;
  return (
    <div className="grid gap-px border-t bg-border md:grid-cols-[1fr_1fr_1.2fr]">
      {(["source", "target"] as const).map((s) => {
        const d = res[s] ?? {};
        return (
          <div key={s} className="bg-card px-6 py-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("h-2 w-2 rounded-full", s === "source" ? "bg-only-src" : "bg-only-tgt")} />
              <span className="capitalize">{s}</span> · {d.kind === "file" ? `${(d.format || "").toUpperCase()} ${d.size_bytes ? formatBytes(d.size_bytes) : ""}` : d.db_type}
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{formatNumber(d.row_count)} <span className="text-sm font-normal text-muted-foreground">rows · {d.column_count} cols</span></div>
            <div className="mt-1 text-xs text-muted-foreground">via <span className="font-medium text-foreground">{d.reader}</span> in {formatDuration(d.read_ms)} · {compactNumber(d.rows_per_second)} rows/s</div>
          </div>
        );
      })}
      <div className="bg-card px-6 py-4">
        <div className="text-xs text-muted-foreground">Where the time went</div>
        <div className="mt-2 flex h-2.5 overflow-hidden rounded-full">
          {parts.map(([k, l, c]) => <div key={k} className={c} style={{ width: `${(t[k] / sum) * 100}%` }} title={`${l}: ${formatDuration(t[k])}`} />)}
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {parts.map(([k, l, c]) => <span key={k} className="flex items-center gap-1"><span className={cn("h-1.5 w-1.5 rounded-full", c)} />{l} {formatDuration(t[k])}</span>)}
        </div>
      </div>
    </div>
  );
}

function ColumnsTab({ res, onColumn }: { res: any; onColumn: (c: string) => void }) {
  const sd = res.schema_diff ?? {};
  const mism: Record<string, number> = Object.fromEntries((res.row_diff?.column_mismatches ?? []).map((m: any) => [m.column, m.count]));
  const max = Math.max(1, ...Object.values(mism));
  return (
    <div className="p-4">
      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr><th className="px-3 py-2">Source</th><th className="px-3 py-2">Target</th><th className="px-3 py-2">Types</th><th className="px-3 py-2">Compared as</th><th className="w-[30%] px-3 py-2">Rows that differ</th></tr>
          </thead>
          <tbody>
            {(sd.pairs ?? []).map((p: any) => (
              <tr key={p.source} className={cn("border-t", mism[p.source] && "cursor-pointer hover:bg-accent/40")} onClick={() => mism[p.source] && onColumn(p.source)}>
                <td className="px-3 py-2 font-mono text-xs">{p.role === "key" && <span className="mr-1 text-changed">⚿</span>}{p.source}</td>
                <td className="px-3 py-2 font-mono text-xs">{p.target}</td>
                <td className={cn("px-3 py-2 text-xs", p.source_type !== p.target_type ? "text-changed" : "text-muted-foreground")}>{(p.source_type || "").toLowerCase()}{p.source_type !== p.target_type && ` → ${(p.target_type || "").toLowerCase()}`}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{p.compare_as}</td>
                <td className="px-3 py-2">
                  {p.role === "key" ? <span className="text-xs text-muted-foreground">key</span> : mism[p.source] ? (
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-changed" style={{ width: `${(mism[p.source] / max) * 100}%` }} /></div>
                      <span className="w-16 text-right text-xs font-medium tabular-nums text-changed">{formatNumber(mism[p.source])}</span>
                    </div>
                  ) : <span className="text-xs text-equal">all equal</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(sd.only_in_source?.length > 0 || sd.only_in_target?.length > 0 || sd.excluded?.length > 0) && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[["Only in source", sd.only_in_source, "text-only-src"], ["Only in target", sd.only_in_target, "text-only-tgt"], ["Skipped", sd.excluded, "text-muted-foreground"]].map(([l, cols, c]: any) => cols?.length ? (
            <div key={l} className="rounded-xl border p-3">
              <div className={cn("dv-label mb-2", c)}>{l}</div>
              <div className="flex flex-wrap gap-1">{cols.map((x: string) => <span key={x} className="dv-chip font-mono">{x}</span>)}</div>
            </div>
          ) : null)}
        </div>
      )}
    </div>
  );
}

function StatsTab({ stats }: { stats: any[] }) {
  return (
    <div className="overflow-x-auto p-4">
      <table className="w-full text-xs">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
          <tr><th className="px-2 py-2">Column</th><th className="px-2">Nulls</th><th className="px-2">Min</th><th className="px-2">Max</th><th className="px-2">Average</th><th className="px-2">Distinct</th></tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.name} className={cn("border-t align-top", !s.match && "bg-changed/5")}>
              <td className="px-2 py-2 font-mono">{s.name}{!s.match && <span className="ml-1 text-changed">●</span>}</td>
              {(["null_count", "min_val", "max_val", "avg_val", "distinct_count"] as const).map((k) => {
                const a = s.source?.[k], b = s.target?.[k];
                const same = String(a) === String(b);
                return (
                  <td key={k} className="max-w-[220px] px-2 py-2 font-mono">
                    <div className="truncate text-only-src" title={String(a ?? "")}>{a ?? "—"}</div>
                    {!same && <div className="truncate text-only-tgt" title={String(b ?? "")}>{b ?? "—"}</div>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileChecks({ fc }: { fc: any }) {
  const keys = Object.keys(fc.source ?? {});
  return (
    <div className="space-y-4 p-4">
      <div className={cn("rounded-lg border px-3 py-2 text-sm", fc.identical_bytes ? "border-equal/40 bg-equal/10 text-equal" : "border-changed/40 bg-changed/10")}>
        {fc.identical_bytes ? "The two files are byte-for-byte identical." : `The files differ at byte level${fc.line_diff ? ` (${formatNumber(fc.line_diff.differing_lines)} lines)` : ""}.`}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-[11px] uppercase tracking-wider text-muted-foreground"><tr><th className="py-1.5">Property</th><th>Source</th><th>Target</th></tr></thead>
        <tbody>
          {keys.map((k) => {
            const a = fc.source[k], b = fc.target[k];
            return (
              <tr key={k} className={cn("border-t", String(a) !== String(b) && "text-changed")}>
                <td className="py-1.5 text-muted-foreground">{k.replace(/_/g, " ")}</td>
                <td className="font-mono text-xs">{String(a)}</td><td className="font-mono text-xs">{String(b)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {fc.line_diff?.samples?.length > 0 && (
        <div className="overflow-hidden rounded-xl border font-mono text-xs">
          {fc.line_diff.samples.map((s: any) => (
            <div key={s.line} className="border-b p-2 last:border-0">
              <div className="mb-1 font-sans text-[11px] text-muted-foreground">line {s.line} · {s.reasons.join(", ")}</div>
              {s.source != null && <div className="truncate text-only-src">− {s.source}</div>}
              {s.target != null && <div className="truncate text-only-tgt">+ {s.target}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SamplesOnly({ res }: { res: any }) {
  const s = res.row_diff?.samples ?? {};
  return (
    <div className="space-y-4 p-4 text-sm">
      <div className="text-muted-foreground">Differences were not saved for this run; showing samples.</div>
      {[["Only in source", s.only_in_source], ["Only in target", s.only_in_target]].map(([l, rows]: any) => rows?.length ? (
        <div key={l}><div className="dv-label mb-2">{l}</div><MiniTable rows={rows} /></div>
      ) : null)}
      {s.key_match_column_diffs?.length > 0 && (
        <div>
          <div className="dv-label mb-2">Changed</div>
          {s.key_match_column_diffs.map((d: any, i: number) => (
            <div key={i} className="border-b py-1.5 font-mono text-xs">
              <b>{d.key}</b>: {d.columns.map((c: any) => <span key={c.column} className="ml-2">{c.column} <span className="text-only-src">{String(c.source)}</span> → <span className="text-only-tgt">{String(c.target)}</span></span>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="max-h-80 overflow-auto rounded-lg border scrollbar-thin">
      <table className="w-full font-mono text-xs">
        <thead className="sticky top-0 bg-muted"><tr>{cols.map((c) => <th key={c} className="px-2 py-1.5 text-left font-sans">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t">{cols.map((c) => <td key={c} className="whitespace-nowrap px-2 py-1">{r[c] == null ? "NULL" : String(r[c])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Runs from older versions, errors and cancellations. */
function Basic({ run }: { run: RunDetail }) {
  const res = run.result ?? {};
  const rd = res.row_diff ?? {};
  return (
    <div className="mx-auto max-w-[1300px] space-y-5 p-6">
      <Header run={run} />
      <div className="dv-panel space-y-4 p-6">
        <div className="flex items-center gap-3">
          <VerdictBadge verdict={run.verdict || res.verdict || run.status} size="lg" />
          <span className="text-sm text-muted-foreground">{res.engine ? `engine ${res.engine}` : ""} · {formatDuration(res.elapsed_ms)}</span>
        </div>
        {(run.error || res.error) && <pre className="whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/10 p-3 font-mono text-xs text-destructive">{run.error || res.error}</pre>}
        {rd.matching_count != null && (
          <>
            <SpectrumBar equal={rd.matching_count} changed={rd.key_match_hash_diff_count} onlySrc={rd.only_in_source_count} onlyTgt={rd.only_in_target_count} height={10} />
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Equal" tone="equal" value={compactNumber(rd.matching_count)} />
              <Stat label="Changed" tone="changed" value={compactNumber(rd.key_match_hash_diff_count)} />
              <Stat label="Only in source" tone="only-src" value={compactNumber(rd.only_in_source_count)} />
              <Stat label="Only in target" tone="only-tgt" value={compactNumber(rd.only_in_target_count)} />
            </div>
          </>
        )}
      </div>
      {rd.samples && <div className="dv-panel"><SamplesOnly res={res} /></div>}
      {res.logs?.length > 0 && <LogConsole events={res.logs} />}
    </div>
  );
}
