/**
 * Bulk compare: pair a schema or folder with another (auto-paired by name),
 * review the pairs, set shared options, run with bounded concurrency.
 */
import * as React from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useQuery as useQ } from "@tanstack/react-query";
import { ArrowRight, FolderOpen, Layers, Play, Plus, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorText, type Connection } from "@/api/client";
import { jobsApi, type BulkItem, type CompareOptions, type PairContainer, type SideSpec } from "@/api/engine";
import { Field, PageHeader, Segmented, Spinner, useLocalState } from "@/components/kit";
import { FileBrowser } from "@/components/compare/FileBrowser";
import { DEFAULT_OPTIONS, OptionsEditor } from "@/components/compare/OptionsEditor";
import { ConnectionSelect } from "@/components/compare/SideEditor";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Row extends BulkItem { on: boolean; keys: string }

function label(s: SideSpec): string {
  if (s.kind === "file") return (s.path || s.label || "file").replace(/\\/g, "/").split("/").pop() || "file";
  return [s.schema_name, s.table].filter(Boolean).join(".");
}

export function BulkPage() {
  const navigate = useNavigate();
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const connections = conns.data ?? [];
  const [src, setSrc] = useLocalState<PairContainer>("dv-bulk-src", { kind: "schema" });
  const [tgt, setTgt] = useLocalState<PairContainer>("dv-bulk-tgt", { kind: "schema" });
  const [prefix, setPrefix] = useLocalState("dv-bulk-prefix", "");
  const [rows, setRows] = React.useState<Row[]>([]);
  const [unmatched, setUnmatched] = React.useState<{ s: string[]; t: string[] }>({ s: [], t: [] });
  const [options, setOptions] = useLocalState<CompareOptions>("dv-bulk-options", DEFAULT_OPTIONS);
  const [concurrency, setConcurrency] = useLocalState("dv-bulk-conc", 3);
  const [name, setName] = React.useState("");
  const [stopOnError, setStopOnError] = React.useState(false);

  const pair = useMutation({
    mutationFn: () => jobsApi.pair({ source: src, target: tgt, strip_prefix: prefix || undefined }),
    onSuccess: (r) => {
      setRows(r.pairs.map((p) => ({ name: p.source.name, source: p.source.side, target: p.target.side, options: {}, on: true, keys: "" })));
      setUnmatched({ s: r.unmatched_source.map((x) => x.name), t: r.unmatched_target.map((x) => x.name) });
      toast.success(`${r.pairs.length} pairs found`);
    },
    onError: (e) => toast.error("Couldn't list objects", { description: errorText(e) }),
  });

  const run = useMutation({
    mutationFn: () => jobsApi.bulk({
      name: name || null, concurrency, stop_on_error: stopOnError,
      items: rows.filter((r) => r.on).map((r) => ({
        name: r.name, source: r.source, target: r.target,
        options: { ...options, key_columns: r.keys.trim() ? r.keys.split(",").map((k) => k.trim()).filter(Boolean) : options.key_columns ?? null },
      })),
    }),
    onSuccess: (j) => navigate(`/jobs/${j.id}`),
    onError: (e) => toast.error("Couldn't start", { description: errorText(e) }),
  });

  const sameConn = src.kind === "schema" && tgt.kind === "schema" && !!src.connection_id && src.connection_id === tgt.connection_id;
  const selected = rows.filter((r) => r.on).length;

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-6">
      <PageHeader icon={<Layers className="h-5 w-5" />} title="Bulk compare" subtitle="Whole schemas or folders, paired by name. Runs a few at a time in the background."
        actions={<Button disabled={!selected} loading={run.isPending} onClick={() => run.mutate()} className="dv-glow"><Play className="h-4 w-4" /> Run {selected} compares</Button>} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <ContainerEditor role="source" value={src} onChange={setSrc} connections={connections} />
        <div className="hidden items-center lg:flex"><ArrowRight className="h-5 w-5 text-muted-foreground" /></div>
        <ContainerEditor role="target" value={tgt} onChange={setTgt} connections={connections} />
      </div>

      <div className="dv-panel flex flex-wrap items-end gap-4 p-4">
        <Field label="Ignore name prefixes" hint="Comma list, e.g. stg_, tmp_" className="w-64">
          <input className="dv-input font-mono text-xs" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="stg_, src_" />
        </Field>
        <Button variant="outline" loading={pair.isPending} onClick={() => pair.mutate()}><Wand2 className="h-4 w-4" /> Find pairs</Button>
        <div className="ml-auto flex items-end gap-4">
          <Field label="Name"><input className="dv-input w-56" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nightly validation" /></Field>
          <Field label="At a time"><input type="number" min={1} max={16} className="dv-input w-20" value={concurrency} onChange={(e) => setConcurrency(Math.min(16, Math.max(1, Number(e.target.value) || 1)))} /></Field>
          <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" className="accent-[hsl(var(--primary))]" checked={stopOnError} onChange={(e) => setStopOnError(e.target.checked)} /> Stop on first error</label>
        </div>
      </div>

      <div className="dv-panel overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="text-sm font-semibold">Pairs <span className="font-normal text-muted-foreground">({selected} of {rows.length} selected)</span></div>
          <button type="button" onClick={() => setRows((r) => [...r, { name: "", source: { kind: "table", connection_id: src.connection_id, schema_name: src.schema_name }, target: { kind: "table", connection_id: tgt.connection_id, schema_name: tgt.schema_name }, options: {}, on: true, keys: "" }])}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Plus className="h-3.5 w-3.5" /> Add manually</button>
        </div>
        {!rows.length ? (
          <div className="p-10 text-center text-sm text-muted-foreground">Choose a source and target, then <b>Find pairs</b>.</div>
        ) : (
          <div className="max-h-[520px] overflow-y-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/90 text-left text-[11px] uppercase tracking-wider text-muted-foreground backdrop-blur">
                <tr>
                  <th className="w-10 px-4 py-2"><input type="checkbox" className="accent-[hsl(var(--primary))]" checked={selected === rows.length} onChange={(e) => setRows((r) => r.map((x) => ({ ...x, on: e.target.checked })))} /></th>
                  <th className="px-2">Source</th><th className="w-6" /><th className="px-2">Target</th><th className="w-56 px-2">Keys (optional)</th><th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={cn("border-t", !r.on && "opacity-50")}>
                    <td className="px-4 py-2"><input type="checkbox" className="accent-[hsl(var(--primary))]" checked={r.on} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} /></td>
                    <td className="px-2 font-mono text-xs">{r.source.kind === "table" && !r.source.table
                      ? <input className="dv-input h-8 text-xs" placeholder="table" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, source: { ...x.source, table: e.target.value }, name: e.target.value } : x)))} />
                      : label(r.source)}</td>
                    <td><ArrowRight className="h-3.5 w-3.5 text-muted-foreground" /></td>
                    <td className="px-2 font-mono text-xs">{r.target.kind === "table" && !r.target.table
                      ? <input className="dv-input h-8 text-xs" placeholder="table" onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, target: { ...x.target, table: e.target.value } } : x)))} />
                      : label(r.target)}</td>
                    <td className="px-2"><input className="dv-input h-8 font-mono text-xs" placeholder="primary key / whole row" value={r.keys} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, keys: e.target.value } : x)))} /></td>
                    <td><button type="button" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="rounded p-1 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(unmatched.s.length > 0 || unmatched.t.length > 0) && (
          <div className="grid gap-3 border-t p-4 text-xs md:grid-cols-2">
            <div><div className="dv-label mb-1.5 text-only-src">No partner in target ({unmatched.s.length})</div><div className="flex flex-wrap gap-1">{unmatched.s.slice(0, 60).map((n) => <span key={n} className="dv-chip font-mono">{n}</span>)}</div></div>
            <div><div className="dv-label mb-1.5 text-only-tgt">No partner in source ({unmatched.t.length})</div><div className="flex flex-wrap gap-1">{unmatched.t.slice(0, 60).map((n) => <span key={n} className="dv-chip font-mono">{n}</span>)}</div></div>
          </div>
        )}
      </div>

      <div className="dv-panel p-4">
        <div className="mb-3 text-sm font-semibold">Options for every pair</div>
        <OptionsEditor value={options} onChange={setOptions} sameConnection={sameConn} />
      </div>
    </div>
  );
}

function ContainerEditor({ role, value, onChange, connections }: { role: string; value: PairContainer; onChange: (v: PairContainer) => void; connections: Connection[] }) {
  const [browse, setBrowse] = React.useState(false);
  const cid = value.connection_id ?? null;
  const conn = connections.find((c) => c.id === cid);
  const dbs = useQ({ queryKey: ["databases", cid], queryFn: () => api.listDatabases(cid!), enabled: !!cid && value.kind === "schema", staleTime: 300_000 });
  const schemas = useQ({ queryKey: ["schemas", cid, value.database ?? null], queryFn: () => api.listSchemas(cid!, value.database ?? undefined), enabled: !!cid && value.kind === "schema", staleTime: 300_000 });
  React.useEffect(() => {
    if (value.kind === "schema" && !cid && connections[0]) onChange({ ...value, connection_id: connections[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length]);
  return (
    <div className="dv-panel space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold capitalize"><span className={cn("h-2.5 w-2.5 rounded-full", role === "source" ? "bg-only-src" : "bg-only-tgt")} />{role}</div>
        <Segmented size="sm" value={value.kind === "files" ? "folder" : value.kind} onChange={(k) => onChange({ kind: k as PairContainer["kind"], connection_id: k === "schema" ? cid ?? connections[0]?.id : null })}
          options={[{ value: "schema", label: "Schema" }, { value: "folder", label: "Folder" }]} />
      </div>
      {value.kind === "schema" ? (
        <>
          <Field label="Connection"><ConnectionSelect connections={connections} value={cid} onChange={(id) => onChange({ ...value, connection_id: id, database: null, schema_name: null })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            {conn && ["snowflake", "sqlserver", "mysql"].includes(conn.db_type) && (
              <Field label="Database"><Combobox value={value.database ?? null} options={dbs.data?.databases ?? []} loading={dbs.isLoading} onChange={(v) => onChange({ ...value, database: v, schema_name: null })} /></Field>
            )}
            <Field label="Schema"><Combobox value={value.schema_name ?? null} options={schemas.data?.schemas ?? []} loading={schemas.isLoading} onChange={(v) => onChange({ ...value, schema_name: v })} /></Field>
          </div>
        </>
      ) : (
        <Field label="Folder on this computer">
          <div className="flex gap-2">
            <input className="dv-input font-mono text-xs" value={value.path ?? ""} onChange={(e) => onChange({ ...value, kind: "folder", path: e.target.value })} placeholder="D:\exports\2026-10-15" />
            <button type="button" onClick={() => setBrowse(true)} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-accent"><FolderOpen className="h-4 w-4" /></button>
          </div>
          <FileBrowser open={browse} folders onClose={() => setBrowse(false)} onPick={(p) => { setBrowse(false); onChange({ kind: "folder", path: p }); }} />
        </Field>
      )}
      {false && <Spinner />}
    </div>
  );
}
