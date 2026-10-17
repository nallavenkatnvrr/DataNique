/**
 * Column pairing and key selection, from the described columns of both sides.
 */
import * as React from "react";
import { ArrowRight, KeyRound, Link2, Plus, RotateCcw, Sparkles, Unlink } from "lucide-react";
import type { ColumnPair, DescribeResult } from "@/api/engine";
import { Segmented, Spinner } from "@/components/kit";
import { autoPair } from "@/lib/pairing";
import { cn } from "@/lib/utils";

export interface MappingState {
  /** pairs the user sees; sent as column_map only when customised */
  pairs: ColumnPair[];
  byPosition: boolean;
  customised: boolean;
}

export function MappingEditor({ src, tgt, loading, error, state, onChange }: {
  src?: DescribeResult; tgt?: DescribeResult; loading: boolean; error?: string | null;
  state: MappingState | null; onChange: (s: MappingState) => void;
}) {
  const sCols = React.useMemo(() => src?.columns.map((c) => c.name) ?? [], [src]);
  const tCols = React.useMemo(() => tgt?.columns.map((c) => c.name) ?? [], [tgt]);
  const sType = React.useMemo(() => Object.fromEntries((src?.columns ?? []).map((c) => [c.name, c.type])), [src]);
  const tType = React.useMemo(() => Object.fromEntries((tgt?.columns ?? []).map((c) => [c.name, c.type])), [tgt]);
  const pk = src?.primary_key?.length ? src.primary_key : tgt?.primary_key ?? [];

  const rebuild = React.useCallback((byPosition: boolean) => {
    const a = autoPair(sCols, tCols, byPosition);
    const pkLower = pk.map((k) => k.toLowerCase());
    const pairs = a.pairs.map((p) => (pkLower.includes(p.source.toLowerCase()) || pkLower.includes(p.target.toLowerCase()) ? { ...p, role: "key" as const } : p));
    onChange({ pairs, byPosition, customised: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sCols.join("\u0001"), tCols.join("\u0001"), pk.join(",")]);

  React.useEffect(() => {
    if (!sCols.length || !tCols.length) return;
    const known = state?.pairs.every((p) => sCols.includes(p.source) && tCols.includes(p.target));
    if (!state || !known || !state.pairs.length) rebuild(state?.byPosition ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sCols.join("\u0001"), tCols.join("\u0001")]);

  if (loading) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Spinner /> Reading columns of both sides…</div>;
  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!src || !tgt) return <div className="p-6 text-sm text-muted-foreground">Pick both sides to see their columns.</div>;
  if (!state) return null;

  const usedS = new Set(state.pairs.map((p) => p.source));
  const usedT = new Set(state.pairs.map((p) => p.target));
  const onlyS = sCols.filter((c) => !usedS.has(c));
  const onlyT = tCols.filter((c) => !usedT.has(c));
  const keys = state.pairs.filter((p) => p.role === "key");
  const setRole = (i: number, role: ColumnPair["role"]) => {
    const pairs = state.pairs.map((p, j) => (j === i ? { ...p, role } : p));
    onChange({ ...state, pairs, customised: state.customised || role === "ignore" || state.pairs[i].role === "ignore" });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented size="sm" value={state.byPosition ? "position" : "name"} onChange={(v) => rebuild(v === "position")}
          options={[{ value: "name", label: "Match by name" }, { value: "position", label: "By position" }]} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <KeyRound className="h-3.5 w-3.5 text-changed" />
          {keys.length ? keys.map((k) => <span key={k.source} className="dv-chip border-changed/40 bg-changed/10 text-changed">{k.source}</span>)
            : <span className="text-muted-foreground">No key — rows compared as whole rows{pk.length ? "" : " (or the table's primary key, if it has one)"}</span>}
          {pk.length > 0 && <span className="text-muted-foreground">· primary key: {pk.join(", ")}</span>}
        </div>
        <button type="button" onClick={() => rebuild(state.byPosition)} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <RotateCcw className="h-3.5 w-3.5" /> Reset
        </button>
      </div>
      <div className="overflow-hidden rounded-xl border">
        <div className="grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_auto] items-center gap-x-2 border-b bg-muted/50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Source column</span><span /><span>Target column</span><span className="w-[214px] text-right">Role</span>
        </div>
        <div className="max-h-[380px] overflow-y-auto scrollbar-thin">
          {state.pairs.map((p, i) => (
            <div key={`${p.source}→${p.target}`} className={cn("grid grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_auto] items-center gap-x-2 border-b px-3 py-1.5 last:border-0", p.role === "ignore" && "opacity-50")}>
              <ColName name={p.source} type={sType[p.source]} />
              <ArrowRight className={cn("h-3.5 w-3.5", p.role === "key" ? "text-changed" : "text-muted-foreground")} />
              <ColName name={p.target} type={tType[p.target]} mismatch={!!sType[p.source] && !!tType[p.target] && norm(sType[p.source]) !== norm(tType[p.target])} />
              <div className="flex items-center gap-1">
                <Segmented size="sm" value={p.role} onChange={(r) => setRole(i, r)} options={[
                  { value: "key", label: "Key" }, { value: "compare", label: "Compare" }, { value: "ignore", label: "Skip" },
                ]} />
                <button type="button" title="Unpair" onClick={() => onChange({ ...state, pairs: state.pairs.filter((_, j) => j !== i), customised: true })}
                  className="rounded p-1 text-muted-foreground hover:text-destructive"><Unlink className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          ))}
          {!state.pairs.length && <div className="p-5 text-center text-sm text-muted-foreground">No columns paired. Match by position or pair them below.</div>}
        </div>
      </div>
      {(onlyS.length > 0 || onlyT.length > 0) && <ManualPair onlyS={onlyS} onlyT={onlyT} onAdd={(s, t) => onChange({ ...state, pairs: [...state.pairs, { source: s, target: t, role: "compare" }], customised: true })} />}
      {state.customised && (
        <div className="flex items-center gap-1.5 text-xs text-primary"><Sparkles className="h-3.5 w-3.5" /> Custom mapping — exactly these pairs are compared.</div>
      )}
    </div>
  );
}

const norm = (t: string | null) => (t || "").toLowerCase().replace(/\(.*\)/, "").replace(/character varying|varchar2?|nvarchar|text|string/, "text");

function ColName({ name, type, mismatch }: { name: string; type?: string | null; mismatch?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="truncate font-mono text-[12.5px]" title={name}>{name}</div>
      {type && <div className={cn("truncate text-[10.5px]", mismatch ? "text-changed" : "text-muted-foreground")}>{type.toLowerCase()}</div>}
    </div>
  );
}

function ManualPair({ onlyS, onlyT, onAdd }: { onlyS: string[]; onlyT: string[]; onAdd: (s: string, t: string) => void }) {
  const [s, setS] = React.useState("");
  const [t, setT] = React.useState("");
  return (
    <div className="rounded-xl border border-dashed p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Link2 className="h-3.5 w-3.5" />
        {onlyS.length} source and {onlyT.length} target columns have no partner (not compared).
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="dv-input h-8 w-auto min-w-[160px] text-xs" value={s} onChange={(e) => setS(e.target.value)}>
          <option value="">Source column…</option>
          {onlyS.map((c) => <option key={c}>{c}</option>)}
        </select>
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        <select className="dv-input h-8 w-auto min-w-[160px] text-xs" value={t} onChange={(e) => setT(e.target.value)}>
          <option value="">Target column…</option>
          {onlyT.map((c) => <option key={c}>{c}</option>)}
        </select>
        <button type="button" disabled={!s || !t} onClick={() => { onAdd(s, t); setS(""); setT(""); }}
          className="inline-flex h-8 items-center gap-1 rounded-lg border px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" /> Pair
        </button>
      </div>
    </div>
  );
}
