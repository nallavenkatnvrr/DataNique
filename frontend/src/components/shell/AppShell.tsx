/**
 * App frame: side menu (expanded with labels, or collapsed to icons with
 * tooltips; the choice is remembered), top bar with the command menu, live
 * job indicator, theme and lock. The menu always takes its own space, so it
 * never covers the page.
 */
import * as React from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, Keyboard, Lock, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun, X } from "lucide-react";
import { jobsApi } from "@/api/engine";
import { Logo } from "@/components/Logo";
import { KeyboardShortcutsDialog, useKeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { compactNumber, useLocalState } from "@/components/kit";
import { lockNow } from "@/components/vault/VaultGate";
import { useTheme } from "@/context/ThemeContext";
import { phaseLabel, useActiveJobs } from "@/lib/jobs";
import { preloadAllRoutes, prefetchRoute } from "@/lib/routePrefetch";
import { cn } from "@/lib/utils";
import { CommandMenu } from "./CommandMenu";
import { NAV } from "./nav";

export function AppShell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { resolved, toggle } = useTheme();
  const [expanded, setExpanded] = useLocalState("dv-rail-expanded", true);
  const [cmd, setCmd] = React.useState(false);
  const shortcuts = useKeyboardShortcutsDialog();
  const [zen, setZen] = React.useState(false);
  const ide = loc.pathname.startsWith("/sql-ide");

  React.useEffect(() => { preloadAllRoutes(); }, []);

  React.useEffect(() => {
    const onZen = (e: Event) => setZen(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("dv:zen", onZen);
    return () => window.removeEventListener("dv:zen", onZen);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && !ide) {
        e.preventDefault();
        setCmd((v) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b" && !ide) {
        e.preventDefault();
        setExpanded((v: boolean) => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        void lockNow();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ide, setExpanded]);

  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname === to || loc.pathname.startsWith(to + "/"));
  const current = NAV.find((n) => isActive(n.to)) ?? (loc.pathname.startsWith("/runs") || loc.pathname.startsWith("/jobs") || loc.pathname.startsWith("/batches") ? NAV.find((n) => n.to === "/history") : undefined);

  const extra = React.useMemo(() => [
    { id: "new-compare", group: "Actions", label: "New compare", hint: "Tables, queries or files", icon: <Plus className="h-4 w-4" />, run: () => navigate("/compare") },
    { id: "theme", group: "Actions", label: `Switch to ${resolved === "dark" ? "light" : "dark"} theme`, icon: resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />, run: toggle },
    { id: "lock", group: "Actions", label: "Lock Datanique", hint: "Ctrl+Shift+L", icon: <Lock className="h-4 w-4" />, run: () => void lockNow() },
  ], [navigate, resolved, toggle]);

  const focus = ide && zen;

  const railItem = (n: (typeof NAV)[number]) => {
    const active = isActive(n.to);
    return (
      <Link key={n.to} to={n.to} title={expanded ? undefined : n.label}
        onMouseEnter={() => prefetchRoute(n.to, qc)} onFocus={() => prefetchRoute(n.to, qc)}
        className={cn(
          "group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] font-medium transition-colors",
          active ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}>
        {active && <span className="absolute -left-2 top-1.5 h-6 w-1 rounded-r-full bg-primary" />}
        <n.icon className="h-[18px] w-[18px] shrink-0" />
        {expanded && <span className="truncate">{n.label}</span>}
      </Link>
    );
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* side menu: takes its own width, never floats over the page */}
      <aside className={cn("flex shrink-0 flex-col overflow-hidden border-r bg-card", expanded ? "w-56" : "w-[60px]", focus && "hidden")}>
        <div className="flex h-14 items-center gap-2.5 px-3.5">
          <Logo className="h-8 w-8 shrink-0" />
          {expanded && <span className="truncate text-[15px] font-semibold tracking-tight">Datanique</span>}
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-2 scrollbar-thin">
          {NAV.filter((n) => n.group === "main").map(railItem)}
          <div className="mx-2 my-2 h-px bg-border" />
          {NAV.filter((n) => n.group === "work").map(railItem)}
        </nav>
        <div className="flex flex-col gap-0.5 border-t px-2 py-2">
          {NAV.filter((n) => n.group === "bottom").map(railItem)}
          <button type="button" onClick={() => setExpanded(!expanded)}
            title={expanded ? "Collapse menu (Ctrl+B)" : "Expand menu (Ctrl+B)"} aria-label={expanded ? "Collapse menu" : "Expand menu"}
            className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            {expanded ? <PanelLeftClose className="h-[18px] w-[18px] shrink-0" /> : <PanelLeftOpen className="h-[18px] w-[18px] shrink-0" />}
            {expanded && <span className="truncate">Collapse</span>}
          </button>
        </div>
      </aside>

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!ide && (
          <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-5">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              {current && <current.icon className="h-4 w-4 text-muted-foreground" />}
              <span className="truncate font-medium">{current?.label ?? "Datanique"}</span>
            </div>
            <button type="button" onClick={() => setCmd(true)}
              className="mx-auto flex h-9 w-full max-w-md items-center gap-2 rounded-lg border bg-muted/40 px-3 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">
              <Search className="h-4 w-4" />
              <span className="flex-1 text-left">Search or jump to…</span>
              <kbd>Ctrl K</kbd>
            </button>
            <div className="flex items-center gap-1">
              <JobsIndicator />
              <IconBtn title="Keyboard shortcuts" onClick={() => shortcuts.setOpen(true)}><Keyboard className="h-4 w-4" /></IconBtn>
              <IconBtn title={`${resolved === "dark" ? "Light" : "Dark"} theme`} onClick={toggle}>
                {resolved === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </IconBtn>
              <IconBtn title="Lock (Ctrl+Shift+L)" onClick={() => void lockNow()}><Lock className="h-4 w-4" /></IconBtn>
            </div>
          </header>
        )}
        <main className={cn("min-h-0 flex-1", ide ? "overflow-hidden" : "overflow-y-auto scrollbar-thin")}>{children}</main>
      </div>
      <CommandMenu open={cmd} onClose={() => setCmd(false)} extra={extra} />
      <KeyboardShortcutsDialog open={shortcuts.open} onClose={() => shortcuts.setOpen(false)} />
    </div>
  );
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick}
      className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      {children}
    </button>
  );
}

function JobsIndicator() {
  const { data } = useActiveJobs();
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const ref = React.useRef<HTMLDivElement>(null);
  const jobs = data ?? [];
  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} title="Running jobs"
        className={cn("flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm transition-colors hover:bg-accent",
          jobs.length ? "text-primary" : "text-muted-foreground")}>
        <span className="relative flex h-4 w-4 items-center justify-center">
          {jobs.length > 0 && <span className="pulse-ring absolute inset-0 rounded-full" />}
          <Activity className="relative h-4 w-4" />
        </span>
        {jobs.length > 0 && <span className="font-semibold tabular-nums">{jobs.length}</span>}
      </button>
      {open && (
        <div className="dv-panel absolute right-0 top-11 z-50 w-96 p-2 scale-in">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="dv-label">Running</span>
            <button type="button" onClick={() => { setOpen(false); navigate("/history"); }} className="text-xs text-primary hover:underline">History</button>
          </div>
          {jobs.length === 0 && <div className="px-2 py-6 text-center text-sm text-muted-foreground">Nothing running</div>}
          {jobs.map((j) => {
            const rows = Object.values(j.rows || {}).reduce((a, b) => a + b, 0);
            return (
              <div key={j.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => { setOpen(false); navigate(`/jobs/${j.id}`); }}>
                  <div className="truncate text-sm font-medium">{j.kind === "bulk" ? j.name : `${j.source_label} → ${j.target_label}`}</div>
                  <div className="text-xs text-muted-foreground">
                    {j.kind === "bulk" ? `${Object.entries(j.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ") || "starting"}` : `${phaseLabel(j.phase)}${rows ? ` · ${compactNumber(rows)} rows` : ""}`}
                  </div>
                  <div className="dv-indeterminate mt-1.5 h-0.5 rounded-full bg-muted" />
                </button>
                <button type="button" title="Cancel" onClick={() => void jobsApi.cancel(j.id)}
                  className="rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100">
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
