/**
 * Query history side bar (DBeaver "Query Manager" / SqlDbx "SQL History"):
 * every statement run from the IDE, newest first, searchable, persisted.
 */
import * as React from "react";
import { toast } from "sonner";
import { Ban, CheckCircle2, Copy, FilePlus2, Play, Search, Trash2, X, XCircle } from "lucide-react";
import { copyToClipboard } from "@/lib/export";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import { clearHistory, removeHistory, useQueryHistory, type HistoryEntry } from "./queryHistory";
import { IconButton, Menu, confirmDialog, type MenuAnchor } from "./ui";

interface Props {
  connectionId: number | null;
  onInsert: (sql: string) => void;
  onOpenInNewTab: (entry: HistoryEntry, run: boolean) => void;
}

export function HistoryView({ connectionId, onInsert, onOpenInNewTab }: Props) {
  const all = useQueryHistory();
  const [q, setQ] = React.useState("");
  const [onlyConn, setOnlyConn] = React.useState(true);
  const [failedOnly, setFailedOnly] = React.useState(false);
  const [menu, setMenu] = React.useState<{ anchor: MenuAnchor; e: HistoryEntry } | null>(null);

  const list = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(
      (e) =>
        (!onlyConn || connectionId == null || e.connectionId === connectionId) &&
        (!failedOnly || e.status === "error") &&
        (!s || e.sql.toLowerCase().includes(s) || (e.error ?? "").toLowerCase().includes(s)),
    );
  }, [all, q, onlyConn, failedOnly, connectionId]);

  const groups = React.useMemo(() => {
    const out: { day: string; items: HistoryEntry[] }[] = [];
    for (const e of list.slice(0, 1000)) {
      const d = new Date(e.at);
      const day = dayLabel(d);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [list]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1.5 px-2 pb-2 pt-1">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search history…"
            className="h-7 w-full rounded-md border bg-background pl-7 pr-6 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
          />
          {q && (
            <button type="button" aria-label="Clear" className="absolute right-1.5 text-muted-foreground hover:text-foreground" onClick={() => setQ("")}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <Toggle on={onlyConn} onClick={() => setOnlyConn((v) => !v)}>
            This connection
          </Toggle>
          <Toggle on={failedOnly} onClick={() => setFailedOnly((v) => !v)}>
            Failed
          </Toggle>
          <span className="flex-1" />
          <IconButton
            size="sm"
            icon={Trash2}
            label="Clear history"
            tone="danger"
            disabled={!all.length}
            onClick={async () => {
              const scoped = onlyConn && connectionId != null;
              const ok = await confirmDialog({
                title: scoped ? "Clear this connection's history?" : "Clear all query history?",
                description: "History is stored in this browser only and can't be recovered.",
                confirmLabel: "Clear",
                danger: true,
              });
              if (ok === true) clearHistory(scoped ? connectionId : undefined);
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto pb-3 scrollbar-thin">
        {!list.length && (
          <div className="px-4 py-6 text-center text-xs text-muted-foreground">
            {all.length ? "Nothing matches." : "Statements you run appear here."}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="sticky top-0 z-10 bg-card/95 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
              {g.day}
            </div>
            {g.items.map((e) => (
              <div
                key={e.id}
                className="group cursor-pointer border-b border-border/40 px-3 py-1.5 hover:bg-accent/50"
                onClick={() => onInsert(e.sql)}
                onDoubleClick={() => onOpenInNewTab(e, false)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setMenu({ anchor: { x: ev.clientX, y: ev.clientY }, e });
                }}
                title={`${e.sql.slice(0, 1500)}\n\nClick: insert at cursor · Double-click: open in new tab · Right-click: more`}
              >
                <div className="flex items-start gap-1.5">
                  {e.status === "success" ? (
                    <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-success" />
                  ) : e.status === "error" ? (
                    <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                  ) : (
                    <Ban className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <div className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11.5px] leading-4">{compact(e.sql)}</div>
                </div>
                <div className="mt-0.5 flex items-center gap-2 pl-[18px] text-[10.5px] tabular-nums text-muted-foreground">
                  <span>{new Date(e.at).toLocaleTimeString()}</span>
                  {e.elapsedMs != null && <span>{formatDuration(e.elapsedMs)}</span>}
                  {e.affectedRows != null ? (
                    <span>{formatNumber(e.affectedRows)} affected</span>
                  ) : e.rows ? (
                    <span>
                      {formatNumber(e.rows)} {e.rows === 1 ? "row" : "rows"}
                    </span>
                  ) : null}
                  {(!onlyConn || connectionId == null) && <span className="truncate">{e.connectionName}</span>}
                </div>
                {e.error && <div className="mt-0.5 line-clamp-1 pl-[18px] text-[10.5px] text-destructive">{e.error}</div>}
              </div>
            ))}
          </div>
        ))}
      </div>
      {menu && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          entries={[
            { label: "Insert at cursor", onSelect: () => onInsert(menu.e.sql) },
            { label: "Open in new tab", icon: FilePlus2, onSelect: () => onOpenInNewTab(menu.e, false) },
            { label: "Run in new tab", icon: Play, onSelect: () => onOpenInNewTab(menu.e, true) },
            { kind: "separator" },
            { label: "Copy SQL", icon: Copy, onSelect: () => void copyToClipboard(menu.e.sql).then((ok) => ok && toast.success("Copied")) },
            ...(menu.e.error
              ? [{ label: "Copy error", onSelect: () => void copyToClipboard(menu.e.error ?? "").then((ok) => ok && toast.success("Copied")) }]
              : []),
            { kind: "separator" },
            { label: "Remove from history", danger: true, onSelect: () => removeHistory(menu.e.id) },
          ]}
        />
      )}
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2 transition-colors",
        on ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function compact(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, 4)
    .join("\n");
}

function dayLabel(d: Date): string {
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
