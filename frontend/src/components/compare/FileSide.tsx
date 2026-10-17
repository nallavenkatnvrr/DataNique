/**
 * File side: drop / upload a file or point at a path on this computer, then
 * adjust the detected reader options with a live preview.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { FileUp, FolderOpen, HardDrive, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { errorText } from "@/api/client";
import { filesApi, type DescribeResult, type FileFormat, type FileOptions, type SideSpec } from "@/api/engine";
import { Field, Segmented, Spinner, Switch } from "@/components/kit";
import { cn, formatBytes, formatNumber } from "@/lib/utils";
import { FileBrowser } from "./FileBrowser";

const FORMATS: { value: FileFormat | ""; label: string }[] = [
  { value: "", label: "Auto-detect" },
  { value: "csv", label: "CSV / delimited text" },
  { value: "excel", label: "Excel / ODS" },
  { value: "parquet", label: "Parquet" },
  { value: "json", label: "JSON / NDJSON" },
  { value: "avro", label: "Avro" },
  { value: "orc", label: "ORC" },
  { value: "arrow", label: "Arrow / Feather" },
  { value: "fixed", label: "Fixed width" },
];

export function useFileInspect(side: SideSpec, enabled = true) {
  return useQuery<DescribeResult>({
    queryKey: ["inspect", side.file_id, side.path, side.format, JSON.stringify(side.options ?? {})],
    queryFn: () => filesApi.inspect({ file_id: side.file_id, path: side.path, format: side.format, options: side.options }, 30),
    enabled: enabled && !!(side.file_id || side.path) && !(side.format === "fixed" && !(side.options?.fixed_columns?.length)),
    staleTime: 60_000,
    retry: false,
  });
}

export function FileSide({ value, onChange }: { value: SideSpec; onChange: (s: SideSpec) => void }) {
  const [mode, setMode] = React.useState<"upload" | "path">(value.path ? "path" : "upload");
  const [progress, setProgress] = React.useState<number | null>(null);
  const [drag, setDrag] = React.useState(false);
  const [browse, setBrowse] = React.useState(false);
  const [pathDraft, setPathDraft] = React.useState(value.path ?? "");
  const input = React.useRef<HTMLInputElement>(null);
  const has = !!(value.file_id || value.path);
  const info = useFileInspect(value);
  const opts = value.options ?? {};
  const setOpts = (p: Partial<FileOptions>) => onChange({ ...value, options: { ...opts, ...p } });

  const upload = async (file: File) => {
    setProgress(0);
    try {
      const r = await filesApi.upload(file, setProgress);
      onChange({ kind: "file", file_id: r.file_id, label: r.name, options: {} });
      if (r.inspect_error) toast.warning("Uploaded, but couldn't read it yet", { description: r.inspect_error });
    } catch (e) {
      toast.error("Upload failed", { description: errorText(e) });
    } finally {
      setProgress(null);
    }
  };

  const clear = () => {
    if (value.file_id) void filesApi.remove(value.file_id).catch(() => undefined);
    onChange({ kind: "file", options: {} });
    setPathDraft("");
  };

  if (!has) {
    return (
      <div className="space-y-3">
        <Segmented size="sm" value={mode} onChange={setMode} options={[
          { value: "upload", label: "Upload", icon: <FileUp className="h-3.5 w-3.5" /> },
          { value: "path", label: "Path on this computer", icon: <HardDrive className="h-3.5 w-3.5" /> },
        ]} />
        {mode === "upload" ? (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) void upload(f); }}
            onClick={() => progress == null && input.current?.click()}
            className={cn("grid min-h-[190px] cursor-pointer place-items-center rounded-xl border-2 border-dashed p-6 text-center transition-colors",
              drag ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/40")}>
            <input ref={input} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            {progress != null ? (
              <div className="w-full max-w-xs space-y-2">
                <div className="text-sm font-medium">Uploading… {Math.round(progress * 100)}%</div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${progress * 100}%` }} /></div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary"><FileUp className="h-5 w-5" /></div>
                <div className="text-sm font-medium">Drop a file or click to choose</div>
                <div className="text-xs text-muted-foreground">CSV · TSV · TXT · DAT · Excel · Parquet · JSON · Avro · ORC · Arrow · .gz · .zip</div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <input value={pathDraft} onChange={(e) => setPathDraft(e.target.value)} placeholder="C:\data\export\customers.csv or a folder of parquet files"
                className="dv-input font-mono text-xs"
                onKeyDown={(e) => { if (e.key === "Enter" && pathDraft.trim()) onChange({ kind: "file", path: pathDraft.trim(), options: {} }); }} />
              <button type="button" onClick={() => setBrowse(true)} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-accent">
                <FolderOpen className="h-4 w-4" /> Browse
              </button>
            </div>
            <button type="button" disabled={!pathDraft.trim()} onClick={() => onChange({ kind: "file", path: pathDraft.trim(), options: {} })}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" /> Use this path
            </button>
            <p className="text-xs text-muted-foreground">Reading in place skips the upload — best for large files.</p>
          </div>
        )}
        <FileBrowser open={browse} onClose={() => setBrowse(false)} onPick={(p) => { setBrowse(false); setPathDraft(p); onChange({ kind: "file", path: p, options: {} }); }} />
      </div>
    );
  }

  const d = info.data;
  const fmt = (value.format || d?.format || "") as string;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl border bg-muted/30 p-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary/10 font-mono text-[10px] font-bold uppercase text-primary">{fmt.slice(0, 4) || "?"}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium" title={value.path || value.label || ""}>{value.label || value.path}</div>
          <div className="text-xs text-muted-foreground">
            {info.isLoading ? "Reading…" : d ? [
              d.size_bytes != null && formatBytes(d.size_bytes),
              d.row_count != null && `${formatNumber(d.row_count)} rows`,
              `${d.columns.length} columns`,
              d.compression,
            ].filter(Boolean).join(" · ") : info.error ? <span className="text-destructive">{errorText(info.error)}</span> : null}
          </div>
        </div>
        <button type="button" title="Re-read" onClick={() => void info.refetch()} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"><RefreshCw className="h-4 w-4" /></button>
        <button type="button" title="Remove" onClick={clear} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-destructive"><Trash2 className="h-4 w-4" /></button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Format">
          <select className="dv-input" value={value.format ?? ""} onChange={(e) => onChange({ ...value, format: (e.target.value || null) as FileFormat | null })}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </Field>
        {fmt === "excel" && (
          <Field label="Sheet">
            <select className="dv-input" value={opts.sheet ?? d?.detected?.sheet ?? ""} onChange={(e) => setOpts({ sheet: e.target.value })}>
              {(d?.sheets ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}
        {fmt === "csv" && (
          <Field label="Delimiter">
            <select className="dv-input" value={opts.delimiter ?? ""} onChange={(e) => setOpts({ delimiter: e.target.value || null })}>
              <option value="">Auto {d?.detected?.delimiter ? `(${d.detected.delimiter === "\t" ? "tab" : d.detected.delimiter})` : ""}</option>
              <option value=",">Comma ,</option><option value="\t">Tab</option><option value="|">Pipe |</option>
              <option value=";">Semicolon ;</option><option value="~">Tilde ~</option>
            </select>
          </Field>
        )}
        {d?.zip_members && d.zip_members.length > 1 && (
          <Field label="File in zip">
            <select className="dv-input" value={opts.zip_member ?? d.zip_members[0]} onChange={(e) => setOpts({ zip_member: e.target.value })}>
              {d.zip_members.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
        )}
      </div>
      {fmt === "csv" && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Header row">
            <select className="dv-input" value={opts.header == null ? "" : opts.header ? "1" : "0"} onChange={(e) => setOpts({ header: e.target.value === "" ? null : e.target.value === "1" })}>
              <option value="">Auto {d?.detected?.header != null ? `(${d.detected.header ? "yes" : "no"})` : ""}</option>
              <option value="1">Yes</option><option value="0">No</option>
            </select>
          </Field>
          <Field label="Encoding">
            <select className="dv-input" value={opts.encoding ?? ""} onChange={(e) => setOpts({ encoding: e.target.value || null })}>
              <option value="">UTF-8</option><option value="cp1252">Windows-1252</option><option value="latin-1">Latin-1</option>
              <option value="utf-16">UTF-16</option><option value="cp437">CP437</option><option value="shift_jis">Shift-JIS</option>
            </select>
          </Field>
        </div>
      )}
      {(fmt === "csv" || fmt === "excel" || fmt === "fixed") && (
        <div className="grid grid-cols-2 items-end gap-3">
          <Field label="Skip rows">
            <input type="number" min={0} className="dv-input" value={opts.skip_rows ?? 0} onChange={(e) => setOpts({ skip_rows: Math.max(0, Number(e.target.value) || 0) })} />
          </Field>
          <Switch checked={!!opts.all_varchar} onChange={(v) => setOpts({ all_varchar: v })} label="Read all as text" className="pb-2" />
        </div>
      )}
      {fmt === "fixed" && <FixedColumns value={opts.fixed_columns ?? []} onChange={(c) => setOpts({ fixed_columns: c })} />}

      {d && d.columns.length > 0 && <Preview d={d} />}
    </div>
  );
}

function FixedColumns({ value, onChange }: { value: { name: string; width: number }[]; onChange: (v: { name: string; width: number }[]) => void }) {
  const [text, setText] = React.useState(value.map((c) => `${c.name}:${c.width}`).join(", "));
  return (
    <Field label="Columns (name:width, …)" hint="e.g. id:8, code:10, name:30 — fields are trimmed">
      <input className="dv-input font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(text.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
          const [n, w] = p.split(":");
          return { name: (n || "").trim(), width: Math.max(1, Number(w) || 1) };
        }).filter((c) => c.name))} />
    </Field>
  );
}

export function Preview({ d, rows = 6 }: { d: DescribeResult; rows?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="max-h-56 overflow-auto scrollbar-thin">
        <table className="w-full border-collapse font-mono text-[11.5px]">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {d.columns.map((c) => (
                <th key={c.name} className="whitespace-nowrap border-b px-2 py-1.5 text-left font-sans font-medium">
                  {c.name}
                  {c.type && <span className="ml-1 text-[10px] font-normal text-muted-foreground">{c.type.toLowerCase()}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.preview.slice(0, rows).map((r, i) => (
              <tr key={i} className="border-b last:border-0">
                {(r as unknown[]).map((v, j) => (
                  <td key={j} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1">
                    {v == null ? <span className="text-muted-foreground/60">NULL</span> : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FileName({ path }: { path: string }) {
  return <span className="truncate">{path.replace(/\\/g, "/").split("/").pop()}</span>;
}

export { Spinner, X };
