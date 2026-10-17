/**
 * Database explorer for the active script's connection and context
 * (DBeaver "Database Navigator", scoped to the selected database / schema).
 *
 * Tables and views expand to their columns. Double-click inserts a name at
 * the cursor, drag drops it into the editor, and the context menu has
 * dialect-correct quick queries ("Select top 100" runs in a new tab), DDL and
 * INSERT generators, and copy helpers.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  ChevronDown, ChevronRight, Cog, Columns3, Copy, Eye, FileCode, FunctionSquare, Hash, Loader2,
  MoreHorizontal, Play, RefreshCw, Search, Table2, Type, X,
} from "lucide-react";
import { api, type ColumnInfo, type Connection } from "@/api/client";
import { copyToClipboard } from "@/lib/export";
import { normalizeDialect } from "@/lib/sqlSplit";
import { qualify, quoteIdent, selectTop } from "@/lib/sqlWrap";
import { cn, formatNumber } from "@/lib/utils";
import { Menu, IconButton, type MenuAnchor, type MenuEntry } from "./ui";

type ObjType = "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION";

interface Props {
  conn: Connection | undefined;
  database: string | null;
  schema: string | null;
  onInsert: (text: string) => void;
  onOpenInNewTab: (sql: string, name: string, run: boolean) => void;
}

const GROUPS: { type: ObjType; label: string; icon: typeof Table2; key: "tables" | "views" | "procedures" | "functions" }[] = [
  { type: "TABLE", label: "Tables", icon: Table2, key: "tables" },
  { type: "VIEW", label: "Views", icon: Eye, key: "views" },
  { type: "PROCEDURE", label: "Procedures", icon: Cog, key: "procedures" },
  { type: "FUNCTION", label: "Functions", icon: FunctionSquare, key: "functions" },
];

const ROW_H = 24;

type Row =
  | { kind: "group"; type: ObjType; label: string; count: number; icon: typeof Table2; open: boolean }
  | { kind: "object"; type: ObjType; name: string; icon: typeof Table2; open: boolean }
  | { kind: "column"; table: string; col: ColumnInfo }
  | { kind: "columns-loading"; table: string }
  | { kind: "empty"; label: string };

export function useColumns(connId: number | undefined, database: string | null, schema: string | null, table: string | null) {
  return useQuery({
    queryKey: ["ide-columns", connId ?? null, database, schema, table],
    queryFn: async () => (await api.listColumns(connId!, table!, database || undefined, schema || undefined)).columns ?? [],
    enabled: !!connId && !!table,
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
  });
}

export function ExplorerView({ conn, database, schema, onInsert, onOpenInNewTab }: Props) {
  const qc = useQueryClient();
  const dialect = normalizeDialect(conn?.db_type);
  const objects = useQuery({
    queryKey: ["ide-objects", conn?.id ?? null, database, schema],
    queryFn: () => api.listObjects(conn!.id, database || undefined, schema || undefined),
    enabled: !!conn,
    staleTime: 10 * 60_000,
    gcTime: 60 * 60_000,
  });
  const [filter, setFilter] = React.useState("");
  const [openGroups, setOpenGroups] = React.useState<Set<ObjType>>(() => new Set(["TABLE", "VIEW"]));
  const [openObjects, setOpenObjects] = React.useState<Set<string>>(() => new Set());
  const [menu, setMenu] = React.useState<{ anchor: MenuAnchor; type: ObjType; name: string; col?: string } | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  React.useEffect(() => {
    setOpenObjects(new Set());
    setSelected(null);
  }, [conn?.id, database, schema]);

  // Columns of expanded tables (cached per table by react-query).
  const expanded = React.useMemo(() => [...openObjects], [openObjects]);
  const columnsByTable = useQueries(conn?.id, database, schema, expanded);

  const nameFor = React.useCallback(
    (name: string) => {
      // SQL Server doesn't switch schema per session, so qualify outside dbo.
      if (dialect === "sqlserver" && schema && schema.toLowerCase() !== "dbo") return qualify(name, schema, dialect);
      return name.includes(".") ? name : quoteIdent(name, dialect);
    },
    [dialect, schema],
  );

  const rows = React.useMemo<Row[]>(() => {
    const data = objects.data;
    if (!data) return [];
    const q = filter.trim().toLowerCase();
    const out: Row[] = [];
    for (const g of GROUPS) {
      const items = ((data as any)[g.key] as string[] | undefined) ?? [];
      const list = q ? items.filter((n) => n.toLowerCase().includes(q)) : items;
      const open = openGroups.has(g.type) || (!!q && list.length > 0);
      out.push({ kind: "group", type: g.type, label: g.label, count: list.length, icon: g.icon, open });
      if (!open) continue;
      if (!list.length) out.push({ kind: "empty", label: q ? "No matches" : "None" });
      for (const name of list) {
        const key = `${g.type}:${name}`;
        const isOpen = openObjects.has(key);
        out.push({ kind: "object", type: g.type, name, icon: g.icon, open: isOpen });
        if (isOpen) {
          const cols = columnsByTable[name];
          if (!cols) out.push({ kind: "columns-loading", table: name });
          else if (!cols.length) out.push({ kind: "empty", label: "No columns" });
          else for (const col of cols) out.push({ kind: "column", table: name, col });
        }
      }
    }
    return out;
  }, [objects.data, filter, openGroups, openObjects, columnsByTable]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  const toggleGroup = (t: ObjType) =>
    setOpenGroups((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  const toggleObject = (type: ObjType, name: string) =>
    setOpenObjects((s) => {
      const n = new Set(s);
      const k = `${type}:${name}`;
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const generate = async (kind: "ddl" | "insert" | "exec" | "definition", type: ObjType, name: string) => {
    if (!conn) return;
    try {
      if (kind === "definition") {
        const res = await api.getObjectDefinition(conn.id, name, type, database || undefined, schema || undefined);
        if (res.error) throw new Error(res.error);
        if (!res.definition) {
          toast.warning("No definition returned");
          return;
        }
        onOpenInNewTab(`-- ${type.toLowerCase()} ${name}\n${res.definition}`, name, false);
        return;
      }
      const res =
        kind === "ddl" ? await api.generateDDL(conn.id, name, database || undefined, schema || undefined)
        : kind === "insert" ? await api.generateInsert(conn.id, name, database || undefined, schema || undefined)
        : await api.generateExecProc(conn.db_type, name, database || undefined, schema || undefined);
      if (res.error) throw new Error(res.error);
      if (res.sql) onInsert(res.sql);
    } catch (e: any) {
      toast.error(`Could not generate ${kind.toUpperCase()}`, { description: String(e?.message ?? e).slice(0, 300) });
    }
  };

  const columnList = async (name: string): Promise<string> => {
    if (!conn) return "*";
    try {
      const cols = await qc.fetchQuery({
        queryKey: ["ide-columns", conn.id, database, schema, name],
        queryFn: async () => (await api.listColumns(conn.id, name, database || undefined, schema || undefined)).columns ?? [],
        staleTime: 10 * 60_000,
      });
      return cols.length ? cols.map((c) => quoteIdent(c.name, dialect)).join(",\n       ") : "*";
    } catch {
      return "*";
    }
  };

  const objectMenu = (type: ObjType, name: string): MenuEntry[] => {
    const q = nameFor(name);
    const isRel = type === "TABLE" || type === "VIEW";
    const entries: MenuEntry[] = [];
    if (isRel) {
      entries.push(
        { label: "Read data (top 200) in new tab", icon: Play, onSelect: () => onOpenInNewTab(selectTop(dialect, q, 200), name, true) },
        { label: "Count rows in new tab", onSelect: () => onOpenInNewTab(`SELECT COUNT(*) AS row_count\nFROM ${q}`, name, true) },
        { kind: "separator" },
        { kind: "heading", label: "Insert into editor" },
        { label: "SELECT * (top 100)", onSelect: () => onInsert(selectTop(dialect, q, 100)) },
        {
          label: "SELECT all columns",
          onSelect: () => void columnList(name).then((cols) => onInsert(`SELECT ${cols}\nFROM ${q}`)),
        },
        { label: "SELECT COUNT(*)", onSelect: () => onInsert(`SELECT COUNT(*)\nFROM ${q}`) },
        { label: "Table name", onSelect: () => onInsert(q) },
        { kind: "separator" },
        { label: "Generate DDL", icon: FileCode, onSelect: () => void generate("ddl", type, name) },
        { label: "Generate INSERT statements", onSelect: () => void generate("insert", type, name) },
      );
      if (type === "VIEW") entries.push({ label: "Show view definition", onSelect: () => void generate("definition", type, name) });
    } else {
      entries.push(
        { label: "Show definition in new tab", icon: FileCode, onSelect: () => void generate("definition", type, name) },
        { label: `Generate ${dialect === "sqlserver" ? "EXEC" : "CALL"}`, onSelect: () => void generate("exec", type, name) },
        { label: "Insert name", onSelect: () => onInsert(q) },
      );
    }
    entries.push(
      { kind: "separator" },
      { label: "Copy name", icon: Copy, onSelect: () => void copyToClipboard(name).then((ok) => ok && toast.success("Copied")) },
      ...(schema
        ? [{ label: "Copy qualified name", onSelect: () => void copyToClipboard(qualify(name, schema, dialect)).then((ok) => ok && toast.success("Copied")) } as MenuEntry]
        : []),
    );
    return entries;
  };

  if (!conn) {
    return (
      <div className="p-4 text-xs text-muted-foreground">
        Pick a connection in the toolbar to browse its tables, views and procedures.
      </div>
    );
  }

  const data = objects.data;
  const total = data ? data.tables.length + data.views.length + data.procedures.length + data.functions.length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pb-1.5 pt-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={[conn.name, database, schema].filter(Boolean).join(" › ")}>
          {[database, schema].filter(Boolean).join(" › ") || conn.name}
        </span>
        <IconButton
          size="sm"
          icon={objects.isFetching ? Loader2 : RefreshCw}
          className={objects.isFetching ? "[&>svg]:animate-spin" : undefined}
          label="Refresh"
          onClick={() => {
            void objects.refetch();
            void qc.invalidateQueries({ queryKey: ["ide-columns", conn.id] });
            void qc.invalidateQueries({ queryKey: ["completion-tables", conn.id] });
          }}
        />
      </div>
      <div className="px-2 pb-2">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={total ? `Filter ${formatNumber(total)} objects…` : "Filter objects…"}
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {filter && (
            <button type="button" aria-label="Clear filter" className="absolute right-1.5 text-muted-foreground hover:text-foreground" onClick={() => setFilter("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {objects.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading objects…
        </div>
      ) : objects.isError ? (
        <div className="space-y-2 px-3 py-2 text-xs">
          <div className="text-destructive">Could not load objects.</div>
          <div className="break-words text-muted-foreground">{String((objects.error as any)?.message ?? "").slice(0, 300)}</div>
          <button type="button" className="text-primary hover:underline" onClick={() => void objects.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pb-2 scrollbar-thin" role="tree">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              const style: React.CSSProperties = { position: "absolute", top: 0, left: 0, right: 0, height: ROW_H, transform: `translateY(${vi.start}px)` };
              if (row.kind === "group") {
                const Icon = row.icon;
                return (
                  <button
                    key={vi.key}
                    type="button"
                    role="treeitem"
                    aria-expanded={row.open}
                    style={style}
                    onClick={() => toggleGroup(row.type)}
                    className="flex w-full items-center gap-1.5 px-2 text-left text-xs font-medium hover:bg-accent/60"
                  >
                    {row.open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{row.label}</span>
                    <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{formatNumber(row.count)}</span>
                  </button>
                );
              }
              if (row.kind === "object") {
                const Icon = row.icon;
                const expandable = row.type === "TABLE" || row.type === "VIEW";
                const key = `${row.type}:${row.name}`;
                return (
                  <div
                    key={vi.key}
                    role="treeitem"
                    aria-expanded={expandable ? row.open : undefined}
                    style={style}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", nameFor(row.name));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onClick={() => setSelected(key)}
                    onDoubleClick={() => onInsert(nameFor(row.name))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(key);
                      setMenu({ anchor: { x: e.clientX, y: e.clientY }, type: row.type, name: row.name });
                    }}
                    className={cn(
                      "group flex cursor-default items-center gap-1.5 pl-5 pr-1 text-xs hover:bg-accent/60",
                      selected === key && "bg-accent",
                    )}
                    title={`${row.name}\nDouble-click: insert · Drag into the editor · Right-click: actions`}
                  >
                    {expandable ? (
                      <button
                        type="button"
                        aria-label={row.open ? "Collapse" : "Expand"}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleObject(row.type, row.name);
                        }}
                        className="rounded text-muted-foreground hover:text-foreground"
                      >
                        {row.open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    ) : (
                      <span className="w-3.5" />
                    )}
                    <Icon className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{row.name}</span>
                    <button
                      type="button"
                      aria-label="Actions"
                      onClick={(e) => {
                        e.stopPropagation();
                        const r = e.currentTarget.getBoundingClientRect();
                        setMenu({ anchor: { x: r.right, y: r.bottom }, type: row.type, name: row.name });
                      }}
                      className="rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              }
              if (row.kind === "column") {
                const c = row.col;
                const ColIcon = c.is_numeric ? Hash : c.is_string ? Type : Columns3;
                return (
                  <div
                    key={vi.key}
                    role="treeitem"
                    style={style}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/plain", quoteIdent(c.name, dialect));
                      e.dataTransfer.effectAllowed = "copy";
                    }}
                    onDoubleClick={() => onInsert(quoteIdent(c.name, dialect))}
                    className="flex cursor-default items-center gap-1.5 pl-[52px] pr-2 text-xs hover:bg-accent/60"
                    title={`${c.name} ${c.data_type}${c.nullable ? "" : " NOT NULL"}`}
                  >
                    <ColIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-[45%] flex-1 truncate font-mono text-[12px]">{c.name}</span>
                    <span className="min-w-0 truncate pl-2 text-right font-mono text-[10.5px] lowercase text-muted-foreground">
                      {c.data_type}
                    </span>
                  </div>
                );
              }
              if (row.kind === "columns-loading") {
                return (
                  <div key={vi.key} style={style} className="flex items-center gap-1.5 pl-[52px] text-[11px] text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> columns…
                  </div>
                );
              }
              return (
                <div key={vi.key} style={style} className="flex items-center pl-9 text-[11px] italic text-muted-foreground">
                  {row.label}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {menu && <Menu anchor={menu.anchor} entries={objectMenu(menu.type, menu.name)} onClose={() => setMenu(null)} minWidth={240} />}
    </div>
  );
}

/** Columns for several tables at once (react-query cache shared with completion). */
function useQueries(connId: number | undefined, database: string | null, schema: string | null, keys: string[]) {
  const qc = useQueryClient();
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const tables = React.useMemo(() => keys.map((k) => k.slice(k.indexOf(":") + 1)), [keys]);
  React.useEffect(() => {
    if (!connId) return;
    let alive = true;
    for (const t of tables) {
      const key = ["ide-columns", connId, database, schema, t];
      if (qc.getQueryData(key)) continue;
      qc.fetchQuery({
        queryKey: key,
        queryFn: async () => (await api.listColumns(connId, t, database || undefined, schema || undefined)).columns ?? [],
        staleTime: 10 * 60_000,
      })
        .catch((e) => {
          qc.setQueryData(key, []);
          toast.error(`Could not load columns of ${t}`, { description: String(e?.message ?? e).slice(0, 200) });
        })
        .finally(() => alive && force());
    }
    return () => {
      alive = false;
    };
  }, [qc, connId, database, schema, tables]);
  const out: Record<string, ColumnInfo[] | undefined> = {};
  for (const t of tables) out[t] = qc.getQueryData<ColumnInfo[]>(["ide-columns", connId ?? null, database, schema, t]);
  return out;
}
