/**
 * One side of a comparison: a table, a SQL query or a file.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Code2, Database, FileSpreadsheet, Filter, Table2 } from "lucide-react";
import { api, type Connection } from "@/api/client";
import type { SideKind, SideSpec } from "@/api/engine";
import { Field, Segmented } from "@/components/kit";
import { Combobox } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";
import { FileSide } from "./FileSide";

export const DB_COLORS: Record<string, string> = {
  snowflake: "#29B5E8",
  oracle: "#F80000",
  sqlserver: "#CC2927",
  postgres: "#336791",
  mysql: "#00758F",
};

export function emptySide(kind: SideKind = "table", connection_id?: number | null): SideSpec {
  return { kind, connection_id: connection_id ?? null, options: {} };
}

export function sideComplete(s: SideSpec): boolean {
  if (s.kind === "file") return !!(s.file_id || s.path);
  if (!s.connection_id) return false;
  return s.kind === "table" ? !!s.table : !!(s.sql && s.sql.trim());
}

export function ConnectionSelect({ connections, value, onChange }: { connections: Connection[]; value: number | null | undefined; onChange: (id: number) => void }) {
  return (
    <div className="relative">
      <select value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))} className="dv-input appearance-none pl-8">
        <option value="" disabled>Choose a connection…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>{c.name} · {c.db_type}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute left-3 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full"
        style={{ background: DB_COLORS[connections.find((c) => c.id === value)?.db_type ?? ""] ?? "hsl(var(--muted-foreground))" }} />
    </div>
  );
}

export function SideEditor({ role, value, onChange, connections }: {
  role: "source" | "target"; value: SideSpec; onChange: (s: SideSpec) => void; connections: Connection[];
}) {
  const set = (patch: Partial<SideSpec>) => onChange({ ...value, ...patch });
  const accent = role === "source" ? "bg-only-src" : "bg-only-tgt";
  return (
    <div className="dv-panel flex min-w-0 flex-col" data-side={role}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn("h-2.5 w-2.5 rounded-full", accent)} />
          <span className="text-sm font-semibold capitalize">{role}</span>
        </div>
        <Segmented<SideKind>
          size="sm"
          value={value.kind}
          onChange={(k) => onChange({ ...emptySide(k, value.connection_id), connection_id: k === "file" ? null : value.connection_id ?? connections[0]?.id ?? null })}
          options={[
            { value: "table", label: "Table", icon: <Table2 className="h-3.5 w-3.5" /> },
            { value: "query", label: "Query", icon: <Code2 className="h-3.5 w-3.5" /> },
            { value: "file", label: "File", icon: <FileSpreadsheet className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="flex-1 space-y-3 p-4">
        {value.kind === "table" && <TableSide value={value} set={set} connections={connections} />}
        {value.kind === "query" && (
          <>
            <Field label="Connection"><ConnectionSelect connections={connections} value={value.connection_id} onChange={(id) => set({ connection_id: id })} /></Field>
            <Field label="SQL" hint="Any SELECT. It runs on the database as written.">
              <textarea value={value.sql ?? ""} onChange={(e) => set({ sql: e.target.value })} rows={9} spellCheck={false}
                placeholder="SELECT * FROM schema.table WHERE …"
                className="dv-input h-auto min-h-[180px] resize-y py-2 font-mono text-[12.5px] leading-relaxed" />
            </Field>
          </>
        )}
        {value.kind === "file" && <FileSide value={value} onChange={onChange} />}
      </div>
    </div>
  );
}

function TableSide({ value, set, connections }: { value: SideSpec; set: (p: Partial<SideSpec>) => void; connections: Connection[] }) {
  const cid = value.connection_id ?? null;
  const conn = connections.find((c) => c.id === cid);
  const [showFilter, setShowFilter] = React.useState(!!value.filter_sql);
  const dbs = useQuery({ queryKey: ["databases", cid], queryFn: () => api.listDatabases(cid!), enabled: !!cid, staleTime: 300_000 });
  const db = value.database ?? null;
  const schemas = useQuery({ queryKey: ["schemas", cid, db], queryFn: () => api.listSchemas(cid!, db ?? undefined), enabled: !!cid, staleTime: 300_000 });
  const schema = value.schema_name ?? null;
  const tables = useQuery({
    queryKey: ["tables", cid, db, schema],
    queryFn: () => api.listTables(cid!, db ?? undefined, schema ?? undefined),
    enabled: !!cid, staleTime: 120_000,
  });
  const showDb = conn && ["snowflake", "sqlserver", "mysql"].includes(conn.db_type);
  return (
    <>
      <Field label="Connection">
        <ConnectionSelect connections={connections} value={cid} onChange={(id) => set({ connection_id: id, database: null, schema_name: null, table: null })} />
      </Field>
      <div className={cn("grid gap-3", showDb ? "grid-cols-2" : "grid-cols-1")}>
        {showDb && (
          <Field label="Database">
            <Combobox value={db} options={dbs.data?.databases ?? []} loading={dbs.isLoading} placeholder={conn?.database || "default"}
              onChange={(v) => set({ database: v, schema_name: null, table: null })} />
          </Field>
        )}
        <Field label="Schema">
          <Combobox value={schema} options={schemas.data?.schemas ?? []} loading={schemas.isLoading} placeholder={conn?.schema_name || "default"}
            onChange={(v) => set({ schema_name: v, table: null })} />
        </Field>
      </div>
      <Field label="Table">
        <Combobox value={value.table ?? null} options={tables.data?.tables ?? []} loading={tables.isLoading} placeholder="Search tables…"
          emptyLabel={tables.data?.error ? tables.data.error : "No tables"} onChange={(v) => set({ table: v })} />
      </Field>
      {showFilter ? (
        <Field label="Filter (WHERE)" hint="A boolean condition in the database's own SQL.">
          <textarea value={value.filter_sql ?? ""} onChange={(e) => set({ filter_sql: e.target.value || null })} rows={2} spellCheck={false}
            placeholder="status = 'A' AND updated_at >= '2026-01-01'" className="dv-input h-auto py-2 font-mono text-[12.5px]" />
        </Field>
      ) : (
        <button type="button" onClick={() => setShowFilter(true)} className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
          <Filter className="h-3.5 w-3.5" /> Add a row filter
        </button>
      )}
      {!connections.length && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <Database className="h-4 w-4" /> Add a connection first (Connections page).
        </div>
      )}
    </>
  );
}
