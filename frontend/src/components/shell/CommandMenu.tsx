/**
 * Ctrl+K: jump to any page, connection, recent run or action.
 */
import * as React from "react";
import ReactDOM from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Database, History, Search } from "lucide-react";
import { api } from "@/api/client";
import { runsApi } from "@/api/engine";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandMenu({ open, onClose, extra }: { open: boolean; onClose: () => void; extra: Item[] }) {
  const navigate = useNavigate();
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState(0);
  const conns = useQuery({ queryKey: ["connections"], queryFn: api.listConnections, enabled: open, staleTime: 30_000 });
  const runs = useQuery({ queryKey: ["runs", "palette"], queryFn: () => runsApi.list({ limit: 15 }), enabled: open, staleTime: 10_000 });

  React.useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);

  const items = React.useMemo<Item[]>(() => {
    const go = (to: string) => () => { navigate(to); onClose(); };
    const out: Item[] = [];
    NAV.forEach((n) => out.push({ id: "nav" + n.to, group: "Go to", label: n.label, hint: n.hint, icon: <n.icon className="h-4 w-4" />, run: go(n.to) }));
    extra.forEach((e) => out.push({ ...e, run: () => { e.run(); onClose(); } }));
    (conns.data ?? []).forEach((c) => out.push({
      id: "c" + c.id, group: "Connections", label: c.name, hint: c.db_type, icon: <Database className="h-4 w-4" />,
      run: go(`/compare?source=${c.id}`),
    }));
    (runs.data?.items ?? []).forEach((r) => out.push({
      id: "r" + r.run_uuid, group: "Recent runs", label: `${r.source_label} → ${r.target_label}`,
      hint: (r.verdict || r.status || "").toLowerCase(), icon: <History className="h-4 w-4" />, run: go(`/runs/${r.run_uuid}`),
    }));
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    const terms = needle.split(/\s+/);
    return out.filter((i) => terms.every((t) => `${i.label} ${i.hint ?? ""} ${i.group}`.toLowerCase().includes(t)));
  }, [conns.data, runs.data, q, extra, navigate, onClose]);

  React.useEffect(() => setSel(0), [q]);
  const listRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  let lastGroup = "";
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[600] flex items-start justify-center bg-black/40 p-4 pt-[12vh] fade-in" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Command menu" className="dv-panel w-full max-w-xl overflow-hidden scale-in">
        <div className="flex items-center gap-2 border-b px-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages, connections, runs…"
            className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
              else if (e.key === "Escape") onClose();
            }} />
          <kbd>Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-1.5 scrollbar-thin">
          {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-muted-foreground">No results</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <React.Fragment key={it.id}>
                {header && <div className="px-3 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{header}</div>}
                <button type="button" data-idx={i} onMouseMove={() => setSel(i)} onClick={() => it.run()}
                  className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm", i === sel ? "bg-primary/10 text-foreground" : "text-foreground/90")}>
                  <span className={cn("text-muted-foreground", i === sel && "text-primary")}>{it.icon}</span>
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="truncate text-xs text-muted-foreground">{it.hint}</span>}
                  {i === sel && <ArrowRight className="h-3.5 w-3.5 text-primary" />}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
