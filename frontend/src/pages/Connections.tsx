import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Database, GitCompareArrows, KeyRound, Pencil, Plug, Plus, Search, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api, errorText, type Connection } from "@/api/client";
import { ConnectionForm } from "@/components/ConnectionForm";
import { EmptyState, PageHeader, Spinner } from "@/components/kit";
import { DB_COLORS } from "@/components/compare/SideEditor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = { snowflake: "Snowflake", oracle: "Oracle", sqlserver: "SQL Server", postgres: "PostgreSQL", mysql: "MySQL" };

export function ConnectionsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const [editing, setEditing] = React.useState<Connection | "new" | null>(null);
  const [q, setQ] = React.useState("");
  const [tests, setTests] = React.useState<Record<number, { ok: boolean; msg: string } | "busy">>({});
  const del = useMutation({
    mutationFn: (id: number) => api.deleteConnection(id),
    onSuccess: () => { toast.success("Connection deleted"); void qc.invalidateQueries({ queryKey: ["connections"] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  const test = async (c: Connection) => {
    setTests((t) => ({ ...t, [c.id]: "busy" }));
    try {
      const r = await api.testConnection(c.id);
      setTests((t) => ({ ...t, [c.id]: { ok: r.ok, msg: r.ok ? `OK${r.ping ? ` · ${r.ping}` : ""}` : r.error || "failed" } }));
    } catch (e) {
      setTests((t) => ({ ...t, [c.id]: { ok: false, msg: errorText(e) } }));
    }
  };
  const items = (data ?? []).filter((c) => !q || `${c.name} ${c.host ?? ""} ${c.db_type} ${c.database ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  if (editing) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <ConnectionForm initial={editing === "new" ? undefined : editing}
          onSaved={() => { setEditing(null); void qc.invalidateQueries({ queryKey: ["connections"] }); }}
          onCancel={() => setEditing(null)} />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      <PageHeader icon={<Database className="h-5 w-5" />} title="Connections" subtitle="Passwords are encrypted with your master password."
        actions={
          <>
            <div className="relative"><Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><input className="dv-input w-64 pl-8" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <Button onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> New connection</Button>
          </>
        } />
      {isLoading ? <div className="grid h-40 place-items-center"><Spinner /></div> : !items.length ? (
        <div className="dv-panel"><EmptyState icon={<Database className="h-5 w-5" />} title="No connections" action={<Button size="sm" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add one</Button>} /></div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((c) => {
            const t = tests[c.id];
            return (
              <div key={c.id} className="dv-panel-flat group relative overflow-hidden p-4">
                <div className="absolute inset-y-0 left-0 w-1" style={{ background: DB_COLORS[c.db_type] }} />
                <div className="flex items-start gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: DB_COLORS[c.db_type] }}>
                    {LABELS[c.db_type]?.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{c.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{LABELS[c.db_type]} · {c.host || (c.extra as any)?.account || "—"}{c.port ? `:${c.port}` : ""}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{[c.database, c.schema_name].filter(Boolean).join(" / ") || "default database"}{c.username ? ` · ${c.username}` : ""}</div>
                  </div>
                  {!c.has_password && <span title="No saved password" className="text-changed"><KeyRound className="h-4 w-4" /></span>}
                </div>
                {t && t !== "busy" && (
                  <div className={cn("mt-3 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-xs", t.ok ? "bg-equal/10 text-equal" : "bg-destructive/10 text-destructive")}>
                    {t.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                    <span className="line-clamp-3">{t.msg}</span>
                  </div>
                )}
                <div className="mt-3 flex items-center gap-1">
                  <Button variant="outline" size="sm" loading={t === "busy"} onClick={() => void test(c)}><Plug className="h-3.5 w-3.5" /> Test</Button>
                  <Button variant="ghost" size="sm" onClick={() => navigate(`/compare?source=${c.id}`)}><GitCompareArrows className="h-3.5 w-3.5" /> Compare</Button>
                  <div className="ml-auto flex">
                    <button type="button" title="Edit" onClick={() => setEditing(c)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><Pencil className="h-4 w-4" /></button>
                    <button type="button" title="Delete" onClick={() => window.confirm(`Delete “${c.name}”?`) && del.mutate(c.id)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
