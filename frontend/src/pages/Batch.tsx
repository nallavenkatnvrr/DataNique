import * as React from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Layers, RotateCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/api/client";
import { jobsApi, runsApi } from "@/api/engine";
import { EmptyState, PageHeader, SpectrumBar, Spinner, Stat, VerdictBadge, compactNumber } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { formatDate, formatDuration } from "@/lib/utils";

export function BatchPage() {
  const { batchUuid } = useParams();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["batch", batchUuid], queryFn: () => runsApi.batch(batchUuid!), refetchInterval: (s) => (s.state.data?.status === "RUNNING" ? 2000 : false) });
  const again = useMutation({
    mutationFn: () => jobsApi.bulk({ ...(q.data!.summary.spec), name: `${q.data!.name ?? "Bulk"} (re-run)` }),
    onSuccess: (j) => navigate(`/jobs/${j.id}`),
    onError: (e) => toast.error(errorText(e)),
  });
  if (q.isLoading) return <div className="grid h-64 place-items-center"><Spinner /></div>;
  if (!q.data) return <EmptyState icon={<TriangleAlert className="h-5 w-5" />} title="Batch not found" />;
  const b = q.data;
  const c = b.summary?.counts ?? {};
  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      <PageHeader icon={<Layers className="h-5 w-5" />} title={b.name || "Bulk compare"} subtitle={`${formatDate(b.started_at)} · ${b.runs.length} runs`}
        actions={b.summary?.spec && <Button size="sm" loading={again.isPending} onClick={() => again.mutate()}><RotateCw className="h-4 w-4" /> Run again</Button>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Match" tone="equal" value={c.match ?? 0} />
        <Stat label="Mismatch" tone="changed" value={c.mismatch ?? 0} />
        <Stat label="Errors" value={c.error ?? 0} />
        <Stat label="Pairs" value={b.summary?.total ?? b.runs.length} />
      </div>
      <div className="dv-panel divide-y overflow-hidden">
        {b.runs.map((r) => {
          const s = r.summary ?? {};
          return (
            <Link key={r.run_uuid} to={`/runs/${r.run_uuid}`} className="grid grid-cols-[100px_minmax(0,1fr)_200px_90px_80px] items-center gap-4 px-4 py-3 hover:bg-accent/40">
              <VerdictBadge verdict={r.verdict || r.status} size="sm" />
              <div className="flex min-w-0 items-center gap-1.5 text-sm"><span className="truncate">{r.source_label}</span><ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{r.target_label}</span></div>
              <SpectrumBar equal={s.matching ?? 0} changed={s.changed ?? 0} onlySrc={s.only_in_source ?? 0} onlyTgt={s.only_in_target ?? 0} height={6} />
              <span className="text-right text-xs tabular-nums text-muted-foreground">{compactNumber(s.source_rows)}</span>
              <span className="text-right text-xs tabular-nums text-muted-foreground">{formatDuration(r.elapsed_ms)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
