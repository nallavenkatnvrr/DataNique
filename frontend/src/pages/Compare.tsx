/**
 * Compare composer: source and target lanes (table / query / file), column
 * pairing, options, then run as a background job.
 */
import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, BookmarkPlus, Columns3, GitCompareArrows, Play, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { api, errorText } from "@/api/client";
import { jobsApi, runsApi, type CompareOptions, type CompareSpec, type DescribeResult, type SideSpec } from "@/api/engine";
import { PageHeader, useLocalState } from "@/components/kit";
import { MappingEditor, type MappingState } from "@/components/compare/MappingEditor";
import { DEFAULT_OPTIONS, OptionsEditor } from "@/components/compare/OptionsEditor";
import { SideEditor, emptySide, sideComplete } from "@/components/compare/SideEditor";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Draft {
  name: string;
  source: SideSpec;
  target: SideSpec;
  options: CompareOptions;
  mapping: MappingState | null;
}

const blank = (): Draft => ({ name: "", source: emptySide("table"), target: emptySide("table"), options: DEFAULT_OPTIONS, mapping: null });

/** Spec → draft (templates, re-runs). */
export function draftFromSpec(spec: CompareSpec): Draft {
  const o = spec.options ?? {};
  let mapping: MappingState | null = null;
  if (o.column_map?.length) mapping = { pairs: o.column_map, byPosition: o.match_columns === "position", customised: true };
  return { name: spec.name ?? "", source: spec.source, target: spec.target, options: { ...DEFAULT_OPTIONS, ...o }, mapping };
}

/** Draft → spec actually sent. */
export function specFromDraft(d: Draft): CompareSpec {
  const o: CompareOptions = { ...d.options };
  const m = d.mapping;
  if (m) {
    o.match_columns = m.byPosition ? "position" : "name";
    if (m.customised) {
      o.column_map = m.pairs;
      o.key_columns = null;
    } else {
      o.column_map = null;
      const keys = m.pairs.filter((p) => p.role === "key").map((p) => p.source);
      o.key_columns = keys.length ? keys : null;
      o.auto_key = keys.length ? false : o.auto_key;
    }
  }
  const clean = (s: SideSpec): SideSpec => {
    if (s.kind === "file") return { kind: "file", file_id: s.file_id, path: s.path, format: s.format || null, options: s.options ?? {}, label: s.label };
    if (s.kind === "query") return { kind: "query", connection_id: s.connection_id, sql: s.sql };
    return { kind: "table", connection_id: s.connection_id, database: s.database || null, schema_name: s.schema_name || null, table: s.table, filter_sql: s.filter_sql || null };
  };
  return { name: d.name || null, source: clean(d.source), target: clean(d.target), options: o };
}

function useDescribe(side: SideSpec) {
  const complete = sideComplete(side);
  const key = JSON.stringify([side.kind, side.connection_id, side.database, side.schema_name, side.table, side.sql, side.file_id, side.path, side.format, side.options]);
  const [debounced, setDebounced] = React.useState(key);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(key), side.kind === "query" ? 700 : 150);
    return () => clearTimeout(t);
  }, [key, side.kind]);
  return useQuery<DescribeResult>({
    queryKey: ["describe", debounced],
    queryFn: () => jobsApi.describe(side, 5),
    enabled: complete && debounced === key,
    staleTime: 60_000,
    retry: false,
  });
}

export function ComparePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useLocalState<Draft>("dv-compare-draft-v2", blank());
  const [tab, setTab] = React.useState<"columns" | "options">("columns");
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections });
  const connections = conns.data ?? [];

  // deep links: ?source=<connId>, ?template=<id>, ?rerun=<runUuid>, ?source_kind=file
  React.useEffect(() => {
    const tpl = params.get("template");
    const rerun = params.get("rerun");
    const src = params.get("source");
    const sk = params.get("source_kind") as SideSpec["kind"] | null;
    const tk = params.get("target_kind") as SideSpec["kind"] | null;
    if (!tpl && !rerun && !src && !sk) return;
    (async () => {
      try {
        if (tpl) {
          const t = await api.getTemplate(Number(tpl));
          const { payload } = t as any;
          setDraft(draftFromSpec(payload.source?.kind ? payload : await legacyToSpec(payload)));
          toast.success(`Loaded template “${t.name}”`);
        } else if (rerun) {
          const r = await runsApi.get(rerun);
          if (r.options?.spec) setDraft(draftFromSpec(r.options.spec));
        } else if (src) {
          setDraft({ ...blank(), source: emptySide("table", Number(src)), target: emptySide("table", Number(src)) });
        } else if (sk) {
          setDraft({ ...blank(), source: emptySide(sk), target: emptySide(tk || sk) });
        }
      } catch (e) {
        toast.error(errorText(e));
      }
      setParams({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // first visit: default both sides to the first connection
  React.useEffect(() => {
    if (!connections.length) return;
    setDraft((d) => ({
      ...d,
      source: d.source.kind !== "file" && !d.source.connection_id ? { ...d.source, connection_id: connections[0].id } : d.source,
      target: d.target.kind !== "file" && !d.target.connection_id ? { ...d.target, connection_id: connections[0].id } : d.target,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length]);

  const sDesc = useDescribe(draft.source);
  const tDesc = useDescribe(draft.target);
  const ready = sideComplete(draft.source) && sideComplete(draft.target);
  const sameConn = draft.source.kind === "table" && draft.target.kind === "table" && !!draft.source.connection_id && draft.source.connection_id === draft.target.connection_id;

  const run = useMutation({
    mutationFn: () => jobsApi.compare(specFromDraft(draft)),
    onSuccess: (job) => {
      void qc.invalidateQueries({ queryKey: ["jobs", "active"] });
      navigate(`/jobs/${job.id}`);
    },
    onError: (e) => toast.error("Couldn't start", { description: errorText(e) }),
  });

  const save = useMutation({
    mutationFn: async () => {
      const name = window.prompt("Template name", draft.name || defaultName(draft));
      if (!name) return null;
      return api.createTemplate({ name, description: null, payload: { ...specFromDraft(draft), name } } as any);
    },
    onSuccess: (t) => {
      if (!t) return;
      toast.success("Template saved");
      void qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => toast.error("Couldn't save", { description: errorText(e) }),
  });

  React.useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && ready && !run.isPending) {
        e.preventDefault();
        run.mutate();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ready, run]);

  const swap = () => setDraft((d) => ({
    ...d, source: d.target, target: d.source,
    mapping: d.mapping ? { ...d.mapping, pairs: d.mapping.pairs.map((p) => ({ ...p, source: p.target, target: p.source })) } : null,
  }));

  return (
    <div className="mx-auto max-w-[1500px] space-y-5 p-6">
      <PageHeader
        icon={<GitCompareArrows className="h-5 w-5" />}
        title={<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="New comparison"
          className="w-full min-w-[260px] bg-transparent outline-none placeholder:text-foreground" />}
        subtitle="Tables, queries and files in any combination. Runs in the background; you can leave this page."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDraft(blank())}>Clear</Button>
            <Button variant="outline" size="sm" disabled={!ready} onClick={() => save.mutate()}><BookmarkPlus className="h-4 w-4" /> Save as template</Button>
            <Button size="md" disabled={!ready} loading={run.isPending} onClick={() => run.mutate()} className="dv-glow px-5" data-testid="run-compare">
              <Play className="h-4 w-4" /> Run compare <kbd className="ml-1 border-white/20 bg-white/15 text-primary-foreground">Ctrl ↵</kbd>
            </Button>
          </>
        }
      />

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)]">
        <SideEditor role="source" value={draft.source} onChange={(s) => setDraft({ ...draft, source: s })} connections={connections} />
        <div className="flex items-center justify-center">
          <button type="button" onClick={swap} title="Swap source and target"
            className="grid h-10 w-10 place-items-center rounded-full border bg-card text-muted-foreground shadow-sm transition hover:rotate-180 hover:text-primary">
            <ArrowLeftRight className="h-4 w-4" />
          </button>
        </div>
        <SideEditor role="target" value={draft.target} onChange={(s) => setDraft({ ...draft, target: s })} connections={connections} />
      </div>

      <div className="dv-panel">
        <div className="flex items-center gap-1 border-b px-2">
          {([["columns", "Columns & keys", Columns3], ["options", "Options", SlidersHorizontal]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" onClick={() => setTab(id)}
              className={cn("relative flex items-center gap-1.5 px-3 py-3 text-sm font-medium", tab === id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="h-4 w-4" /> {label}
              {tab === id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
        <div className="p-4">
          {tab === "columns" ? (
            <MappingEditor src={sDesc.data} tgt={tDesc.data} loading={ready && (sDesc.isFetching || tDesc.isFetching) && !(sDesc.data && tDesc.data)}
              error={sDesc.error ? `Source: ${errorText(sDesc.error)}` : tDesc.error ? `Target: ${errorText(tDesc.error)}` : null}
              state={draft.mapping} onChange={(m) => setDraft((d) => ({ ...d, mapping: m }))} />
          ) : (
            <OptionsEditor value={draft.options} onChange={(o) => setDraft({ ...draft, options: o })} sameConnection={sameConn} />
          )}
        </div>
      </div>
    </div>
  );
}

function defaultName(d: Draft): string {
  const n = (s: SideSpec) => s.kind === "file" ? (s.label || s.path || "file").replace(/\\/g, "/").split("/").pop() : s.kind === "query" ? "query" : s.table;
  return `${n(d.source)} vs ${n(d.target)}`;
}

/** Old template payloads (CompareRequest shape). */
async function legacyToSpec(p: any): Promise<CompareSpec> {
  return {
    name: p.name ?? null,
    source: { kind: "table", connection_id: p.source?.connection_id, database: p.source?.database, schema_name: p.source?.schema_name, table: p.source?.table, filter_sql: p.source?.filter_sql },
    target: { kind: "table", connection_id: p.target?.connection_id, database: p.target?.database, schema_name: p.target?.schema_name, table: p.target?.table, filter_sql: p.target?.filter_sql },
    options: {
      ...DEFAULT_OPTIONS,
      key_columns: p.key_columns ?? null,
      excluded_columns: p.excluded_columns ?? null,
      column_map: p.column_map ?? null,
      incremental_column: p.incremental_column ?? null,
      since: p.since ?? null,
    },
  };
}
