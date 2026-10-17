import * as React from "react";
import { ChevronDown } from "lucide-react";
import { DEFAULT_NORMALIZE, type CompareOptions, type Normalize } from "@/api/engine";
import { Field, Segmented, Switch } from "@/components/kit";
import { cn } from "@/lib/utils";

export const DEFAULT_OPTIONS: CompareOptions = {
  normalize: DEFAULT_NORMALIZE,
  strategy: "auto",
  column_stats: true,
  distinct_counts: false,
  sample_limit: 50,
  store_diffs: true,
  max_stored_rows: 5_000_000,
  max_rows: 0,
  file_checks: true,
  auto_key: true,
};

export function OptionsEditor({ value, onChange, sameConnection }: { value: CompareOptions; onChange: (o: CompareOptions) => void; sameConnection: boolean }) {
  const n: Normalize = { ...DEFAULT_NORMALIZE, ...(value.normalize ?? {}) };
  const setN = (p: Partial<Normalize>) => onChange({ ...value, normalize: { ...n, ...p } });
  const set = (p: Partial<CompareOptions>) => onChange({ ...value, ...p });
  const [adv, setAdv] = React.useState(false);
  return (
    <div className="space-y-5">
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        <div className="space-y-3">
          <div className="dv-label">Ignore formatting differences</div>
          <Switch checked={n.numbers} onChange={(v) => setN({ numbers: v })} label="Numbers" hint="12.50 = 12.5, '007' = 7, doubles to 15 digits" />
          <Switch checked={n.timestamps} onChange={(v) => setN({ timestamps: v })} label="Dates and times" hint="DATE = midnight TIMESTAMP, time zones to UTC" />
          <Switch checked={n.booleans} onChange={(v) => setN({ booleans: v })} label="Booleans" hint="true = 1 = Y = yes" />
        </div>
        <div className="space-y-3">
          <div className="dv-label">Text rules (can hide real differences)</div>
          <Switch checked={n.rtrim && n.ltrim} onChange={(v) => setN({ rtrim: v, ltrim: v })} label="Trim spaces" />
          <Switch checked={n.case_insensitive} onChange={(v) => setN({ case_insensitive: v })} label="Ignore case" />
          <Switch checked={n.null_equals_empty || n.null_equals_blank} onChange={(v) => setN({ null_equals_empty: v, null_equals_blank: v })} label="Empty text = NULL" />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Numeric tolerance" hint="Absolute; 0 = exact">
          <input type="number" min={0} step="any" className="dv-input" value={n.numeric_tolerance}
            onChange={(e) => setN({ numeric_tolerance: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Timestamp precision">
          <select className="dv-input" value={n.timestamp_precision} onChange={(e) => setN({ timestamp_precision: e.target.value as Normalize["timestamp_precision"] })}>
            <option value="us">Microseconds (exact)</option><option value="ms">Milliseconds</option>
            <option value="s">Seconds</option><option value="min">Minutes</option><option value="day">Date only</option>
          </select>
        </Field>
        <Field label="Where to compare" hint={sameConnection ? "Auto uses the database for very large tables" : "Both sides on one connection enable in-database"}>
          <Segmented size="sm" value={value.strategy ?? "auto"} onChange={(v) => set({ strategy: v })} options={[
            { value: "auto", label: "Auto" }, { value: "local", label: "Local engine" },
            { value: "in_database", label: "In database", disabled: !sameConnection },
          ]} />
        </Field>
      </div>
      <button type="button" onClick={() => setAdv((v) => !v)} className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", adv && "rotate-180")} /> Advanced
      </button>
      {adv && (
        <div className="grid gap-4 md:grid-cols-3 fade-in">
          <Field label="Row limit per side" hint="0 = all rows (sampling for a quick check)">
            <input type="number" min={0} className="dv-input" value={value.max_rows ?? 0} onChange={(e) => set({ max_rows: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label="Keep up to (rows per kind)" hint="Differences saved for browsing and export">
            <input type="number" min={0} className="dv-input" value={value.max_stored_rows ?? 5_000_000} onChange={(e) => set({ max_stored_rows: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Field label="Samples in the summary">
            <input type="number" min={0} max={1000} className="dv-input" value={value.sample_limit ?? 50} onChange={(e) => set({ sample_limit: Math.min(1000, Math.max(0, Number(e.target.value) || 0)) })} />
          </Field>
          <Field label="Incremental column" hint="Compare only rows with this column ≥ since">
            <input className="dv-input font-mono text-xs" value={value.incremental_column ?? ""} placeholder="updated_at" onChange={(e) => set({ incremental_column: e.target.value || null })} />
          </Field>
          <Field label="Since">
            <input className="dv-input font-mono text-xs" value={value.since ?? ""} placeholder="2026-10-01 00:00:00" onChange={(e) => set({ since: e.target.value || null })} />
          </Field>
          <Field label="Skip columns" hint="Comma list; empty = default audit columns">
            <input className="dv-input font-mono text-xs" value={(value.excluded_columns ?? []).join(", ")} placeholder="INSERT_TMSTP, UPDATE_TMSTP…"
              onChange={(e) => set({ excluded_columns: e.target.value.trim() ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : null })} />
          </Field>
          <div className="space-y-3 md:col-span-3 md:grid md:grid-cols-3 md:gap-4 md:space-y-0">
            <Switch checked={value.store_diffs !== false} onChange={(v) => set({ store_diffs: v })} label="Save all differences" hint="Encrypted, for browsing and export" />
            <Switch checked={value.column_stats !== false} onChange={(v) => set({ column_stats: v })} label="Column statistics" hint="Nulls, min, max, average" />
            <Switch checked={!!value.distinct_counts} onChange={(v) => set({ distinct_counts: v })} label="Distinct counts" hint="Approximate; slower" />
            <Switch checked={value.file_checks !== false} onChange={(v) => set({ file_checks: v })} label="File format checks" hint="Line endings, BOM, checksums (two text files)" />
          </div>
        </div>
      )}
    </div>
  );
}
