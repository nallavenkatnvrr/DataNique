import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookMarked, Pencil, Play, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorText } from "@/api/client";
import { jobsApi, type CompareSpec } from "@/api/engine";
import { EmptyState, KindIcon, PageHeader, Spinner, timeAgo } from "@/components/kit";
import { Button } from "@/components/ui/button";

function sideText(s: any): string {
  if (!s) return "?";
  if (s.kind === "file") return (s.label || s.path || "file").replace(/\\/g, "/").split("/").pop();
  if (s.kind === "query") return "SQL query";
  return [s.schema_name, s.table].filter(Boolean).join(".");
}

function toSpec(p: any): CompareSpec {
  if (p?.source?.kind) return p as CompareSpec;
  return {
    name: p.name ?? null,
    source: { kind: "table", ...p.source },
    target: { kind: "table", ...p.target },
    options: { key_columns: p.key_columns ?? null, excluded_columns: p.excluded_columns ?? null, column_map: p.column_map ?? null },
  };
}

export function TemplatesPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const list = useQuery({ queryKey: ["templates"], queryFn: api.listTemplates });
  const runOne = useMutation({
    mutationFn: (p: any) => jobsApi.compare(toSpec(p)),
    onSuccess: (j) => navigate(`/jobs/${j.id}`),
    onError: (e) => toast.error("Couldn't start", { description: errorText(e) }),
  });
  const runMany = useMutation({
    mutationFn: (items: any[]) => jobsApi.bulk({ name: `Templates (${items.length})`, concurrency: 3, items: items.map((t) => ({ name: t.name, ...toSpec(t.payload) })) }),
    onSuccess: (j) => navigate(`/jobs/${j.id}`),
    onError: (e) => toast.error("Couldn't start", { description: errorText(e) }),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteTemplate(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["templates"] }); toast.success("Template deleted"); },
  });
  const items = (list.data ?? []).filter((t) => !q || `${t.name} ${t.description ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      <PageHeader icon={<BookMarked className="h-5 w-5" />} title="Templates" subtitle="Saved compares. Run one, or run them all as a bulk batch."
        actions={
          <>
            <div className="relative"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className="dv-input w-64 pl-8" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Button variant="outline" size="sm" disabled={!items.length} loading={runMany.isPending} onClick={() => runMany.mutate(items)}><Play className="h-4 w-4" /> Run all ({items.length})</Button>
          </>
        } />
      {list.isLoading ? <div className="grid h-40 place-items-center"><Spinner /></div> : !items.length ? (
        <div className="dv-panel"><EmptyState icon={<BookMarked className="h-5 w-5" />} title="No templates">Use “Save as template” on the Compare page.</EmptyState></div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((t) => {
            const p: any = t.payload ?? {};
            const s = toSpec(p);
            return (
              <div key={t.id} className="dv-panel-flat group flex flex-col p-4 transition hover:border-primary/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">updated {timeAgo(t.updated_at)}</div>
                  </div>
                  <div className="flex opacity-60 transition group-hover:opacity-100">
                    <button type="button" title="Edit in composer" onClick={() => navigate(`/compare?template=${t.id}`)} className="rounded p-1.5 hover:bg-accent"><Pencil className="h-3.5 w-3.5" /></button>
                    <button type="button" title="Delete" onClick={() => window.confirm(`Delete “${t.name}”?`) && del.mutate(t.id)} className="rounded p-1.5 hover:bg-accent hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div className="mt-3 flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  <KindIcon kind={s.source.kind} /><span className="truncate">{sideText(s.source)}</span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <KindIcon kind={s.target.kind} /><span className="truncate">{sideText(s.target)}</span>
                </div>
                {t.description && <div className="mt-2 line-clamp-2 text-xs text-muted-foreground">{t.description}</div>}
                <div className="mt-auto pt-4">
                  <Button size="sm" className="w-full" loading={runOne.isPending && runOne.variables === p} onClick={() => runOne.mutate(p)}><Play className="h-3.5 w-3.5" /> Run</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
