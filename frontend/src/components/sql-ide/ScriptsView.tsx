/**
 * Scripts side bar: open script tabs, and every connection's saved scripts
 * in the versioned script library (DBeaver "Scripts" / project explorer).
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Database, FileCode2, History, Loader2, Plus, Plug, Search, X } from "lucide-react";
import { api, type Connection } from "@/api/client";
import { cn, formatNumber } from "@/lib/utils";
import { isDirty, type ScriptTab } from "./ideStore";
import { IconButton, Menu, type MenuAnchor } from "./ui";

interface Props {
  connections: Connection[];
  tabs: ScriptTab[];
  activeTabId: string;
  activeConnectionId: number | null;
  workspaceKeyFor: (connId: number) => string;
  onActivateTab: (id: string) => void;
  onNewScript: (connId: number | null) => void;
  onOpenSaved: (connId: number, name: string, version?: string) => void;
  onNewConnection: () => void;
}

export function ScriptsView(props: Props) {
  const { connections, tabs, activeTabId, onActivateTab } = props;
  const [q, setQ] = React.useState("");
  const connName = (id: number | null) => connections.find((c) => c.id === id)?.name ?? "No connection";
  const filteredTabs = q ? tabs.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())) : tabs;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pb-2 pt-1">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter scripts…"
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {q && (
            <button type="button" aria-label="Clear" className="absolute right-1.5 text-muted-foreground hover:text-foreground" onClick={() => setQ("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-3 scrollbar-thin">
        <Section title="Open editors" count={tabs.length}>
          {filteredTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onActivateTab(t.id)}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pl-6 pr-2 text-left text-xs hover:bg-accent/60",
                t.id === activeTabId && "bg-accent",
              )}
              title={`${t.name} — ${connName(t.connectionId)}`}
            >
              <FileCode2 className="h-3.5 w-3.5 shrink-0 text-primary/80" />
              <span className="min-w-0 flex-1 truncate">{t.name}</span>
              {isDirty(t) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/60" title="Unsaved changes" />}
              <span className="max-w-[90px] shrink-0 truncate text-[10px] text-muted-foreground">{connName(t.connectionId)}</span>
            </button>
          ))}
        </Section>

        <Section
          title="Script library"
          action={<IconButton size="sm" icon={Plug} label="New connection" onClick={props.onNewConnection} />}
        >
          {connections.length === 0 ? (
            <div className="px-6 py-2 text-xs text-muted-foreground">
              No connections yet.{" "}
              <button type="button" className="text-primary hover:underline" onClick={props.onNewConnection}>
                Create one
              </button>
            </div>
          ) : (
            connections.map((c) => (
              <ConnectionScripts
                key={c.id}
                conn={c}
                filter={q}
                defaultOpen={c.id === props.activeConnectionId}
                workspace={props.workspaceKeyFor(c.id)}
                onNewScript={() => props.onNewScript(c.id)}
                onOpen={(name, version) => props.onOpenSaved(c.id, name, version)}
              />
            ))
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(true);
  return (
    <div className="mb-1">
      <div className="flex h-7 items-center gap-1 px-2">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="truncate">{title}</span>
          {count != null && <span className="font-normal tabular-nums">({count})</span>}
        </button>
        {action}
      </div>
      {open && children}
    </div>
  );
}

function ConnectionScripts({
  conn, workspace, filter, defaultOpen, onNewScript, onOpen,
}: {
  conn: Connection;
  workspace: string;
  filter: string;
  defaultOpen: boolean;
  onNewScript: () => void;
  onOpen: (name: string, version?: string) => void;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  React.useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const scripts = useQuery({
    queryKey: ["scripts", workspace],
    queryFn: () => api.listScripts(workspace),
    enabled: (open || !!filter) && !!workspace,
    staleTime: 30_000,
  });
  const [versionsFor, setVersionsFor] = React.useState<{ name: string; anchor: MenuAnchor } | null>(null);
  const versions = useQuery({
    queryKey: ["script-versions", workspace, versionsFor?.name],
    queryFn: () => api.listScriptVersions(workspace, versionsFor!.name),
    enabled: !!versionsFor,
  });
  const list = (scripts.data ?? []).filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()));
  if (filter && !list.length) return null;
  return (
    <div>
      <div className="group flex h-7 items-center gap-1 pl-3 pr-2 text-xs hover:bg-accent/60">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open || filter ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <Database className="h-3.5 w-3.5 shrink-0 text-primary/80" />
          <span className="truncate">{conn.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{conn.db_type}</span>
        </button>
        <IconButton size="sm" icon={Plus} label={`New script for ${conn.name}`} className="opacity-0 group-hover:opacity-100" onClick={onNewScript} />
      </div>
      {(open || filter) && (
        <div>
          {scripts.isLoading ? (
            <div className="flex items-center gap-1.5 py-1 pl-10 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </div>
          ) : !list.length ? (
            <div className="py-1 pl-10 text-[11px] italic text-muted-foreground">No saved scripts</div>
          ) : (
            list.map((s) => (
              <div
                key={s.name}
                className="group flex h-6 cursor-pointer items-center gap-1.5 pl-10 pr-2 text-xs hover:bg-accent/60"
                onClick={() => onOpen(s.name)}
                title={`${s.name}\n${new Date(s.modified).toLocaleString()} · ${formatNumber(s.size)} bytes · ${s.version_count} version(s)`}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.version_count > 1 && (
                  <button
                    type="button"
                    className="flex items-center gap-0.5 rounded px-1 text-[10px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Version history"
                    onClick={(e) => {
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      setVersionsFor({ name: s.name, anchor: { x: r.left, y: r.bottom + 2 } });
                    }}
                  >
                    <History className="h-3 w-3" /> {s.version_count}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
      {versionsFor && (
        <Menu
          anchor={versionsFor.anchor}
          onClose={() => setVersionsFor(null)}
          minWidth={280}
          entries={
            versions.isLoading
              ? [{ kind: "heading", label: "Loading versions…" }]
              : [
                  { kind: "heading", label: `${versionsFor.name} — versions` },
                  { label: "Current version", onSelect: () => onOpen(versionsFor.name) },
                  ...(versions.data ?? []).map((v) => ({
                    label: (
                      <span className="flex gap-2">
                        <span className="font-mono">{v.version}</span>
                        <span className="text-muted-foreground">{new Date(v.modified).toLocaleString()}</span>
                      </span>
                    ),
                    onSelect: () => onOpen(versionsFor.name, v.version),
                  })),
                ]
          }
        />
      )}
    </div>
  );
}
