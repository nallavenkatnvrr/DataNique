/**
 * Script tabs (VS Code style): connection colour dot, unsaved dot, running
 * spinner, inline rename (double-click / F2), middle-click close, drag to
 * reorder, and a context menu with the usual close / duplicate / save actions.
 */
import * as React from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { Connection } from "@/api/client";
import { cn } from "@/lib/utils";
import { isDirty, type ScriptTab } from "./ideStore";
import { isProductionConnection, useIdeSettings } from "./ideSettings";
import { IconButton, Menu, type MenuAnchor, type MenuEntry } from "./ui";
import { shortcutLabel } from "./ideCommands";

export function connectionColor(id: number | null | undefined): string {
  if (id == null) return "hsl(var(--muted-foreground))";
  const hues = [212, 152, 28, 270, 340, 188, 48, 100];
  return `hsl(${hues[id % hues.length]} 70% 50%)`;
}

interface Props {
  tabs: ScriptTab[];
  activeTabId: string;
  connections: Connection[];
  renamingId: string | null;
  onRenameDone: (id: string, name: string | null) => void;
  onStartRename: (id: string) => void;
  onActivate: (id: string) => void;
  onClose: (ids: string[]) => void;
  onNew: () => void;
  onDuplicate: (id: string) => void;
  onSave: (id: string) => void;
  onDownload: (id: string) => void;
  onMove: (fromId: string, toId: string) => void;
  onReopenClosed?: () => void;
  canReopen: boolean;
}

export function EditorTabs(props: Props) {
  const { tabs, activeTabId, connections } = props;
  const settings = useIdeSettings();
  const [menu, setMenu] = React.useState<{ anchor: MenuAnchor; id: string } | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropId, setDropId] = React.useState<string | null>(null);
  const stripRef = React.useRef<HTMLDivElement>(null);

  // Keep the active tab in view.
  React.useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>(`[data-tab="${activeTabId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const connName = (id: number | null) => connections.find((c) => c.id === id)?.name ?? "No connection";

  const entries = (id: string): MenuEntry[] => {
    const idx = tabs.findIndex((t) => t.id === id);
    const t = tabs[idx];
    if (!t) return [];
    return [
      { label: "Close", shortcut: "Alt-w", onSelect: () => props.onClose([id]) },
      { label: "Close others", disabled: tabs.length < 2, onSelect: () => props.onClose(tabs.filter((x) => x.id !== id).map((x) => x.id)) },
      { label: "Close tabs to the right", disabled: idx === tabs.length - 1, onSelect: () => props.onClose(tabs.slice(idx + 1).map((x) => x.id)) },
      { label: "Close all", onSelect: () => props.onClose(tabs.map((x) => x.id)) },
      ...(props.canReopen ? [{ label: "Reopen closed script", onSelect: () => props.onReopenClosed?.() } as MenuEntry] : []),
      { kind: "separator" },
      { label: "Rename…", shortcut: "F2", onSelect: () => props.onStartRename(id) },
      { label: "Duplicate", onSelect: () => props.onDuplicate(id) },
      { kind: "separator" },
      { label: t.libraryName ? "Save to library" : "Save to library…", shortcut: "Mod-s", onSelect: () => props.onSave(id) },
      { label: "Download as .sql", onSelect: () => props.onDownload(id) },
    ];
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b bg-muted/40">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Scripts"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-none"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
        }}
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) props.onNew();
        }}
      >
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const running = t.results.some((r) => r.status === "running");
          const dirty = isDirty(t);
          const prod = isProductionConnection(t.connectionId, settings);
          return (
            <div
              key={t.id}
              data-tab={t.id}
              role="tab"
              aria-selected={active}
              draggable={props.renamingId !== t.id}
              onDragStart={(e) => {
                setDragId(t.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("application/x-dv-tab", t.id);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === t.id) return;
                e.preventDefault();
                setDropId(t.id);
              }}
              onDragLeave={() => setDropId((d) => (d === t.id ? null : d))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId && dragId !== t.id) props.onMove(dragId, t.id);
                setDragId(null);
                setDropId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropId(null);
              }}
              onMouseDown={(e) => {
                if (e.button === 0) props.onActivate(t.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  props.onClose([t.id]);
                }
              }}
              onDoubleClick={() => props.onStartRename(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ anchor: { x: e.clientX, y: e.clientY }, id: t.id });
              }}
              title={`${t.name}\n${connName(t.connectionId)}${t.libraryName ? `\nLibrary: ${t.libraryName}` : ""}${dirty ? "\nUnsaved changes" : ""}`}
              className={cn(
                "group relative flex min-w-[110px] max-w-[220px] shrink-0 cursor-pointer select-none items-center gap-1.5 border-r pl-3 pr-1.5 text-[13px]",
                active ? "dv-ide-tab-active bg-background text-foreground" : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                dropId === t.id && "bg-primary/10",
                dragId === t.id && "opacity-50",
              )}
            >
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", prod && "ring-2 ring-destructive/40")}
                style={{ background: prod ? "hsl(var(--destructive))" : connectionColor(t.connectionId) }}
                aria-hidden
              />
              {props.renamingId === t.id ? (
                <RenameInput initial={t.name} onDone={(name) => props.onRenameDone(t.id, name)} />
              ) : (
                <span className={cn("min-w-0 flex-1 truncate", !t.libraryName && !t.sql.trim() && "italic")}>{t.name}</span>
              )}
              {running ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
              ) : t.txnPending ? (
                <span className="shrink-0 rounded bg-warning/20 px-1 text-[9px] font-semibold uppercase text-warning" title="Uncommitted transaction">
                  txn
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`Close ${t.name}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  props.onClose([t.id]);
                }}
                className={cn(
                  "relative flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent",
                  !active && !dirty && "opacity-0 group-hover:opacity-100",
                )}
                title={`Close (${shortcutLabel("script.close")})`}
              >
                {dirty ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-foreground/70 group-hover:hidden" />
                    <X className="hidden h-3.5 w-3.5 group-hover:block" />
                  </>
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          );
        })}
        <div className="flex shrink-0 items-center px-1">
          <IconButton size="sm" icon={Plus} label="New script" shortcut={shortcutLabel("script.new")} onClick={props.onNew} />
        </div>
      </div>
      {menu && <Menu anchor={menu.anchor} entries={entries(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = React.useState(initial);
  const done = React.useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      autoFocus
      value={v}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(v.trim() || null);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(v.trim() || null)}
      className="h-6 min-w-0 flex-1 rounded border border-primary bg-background px-1 text-[13px] text-foreground outline-none"
    />
  );
}

