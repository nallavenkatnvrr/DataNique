/**
 * Small shared building blocks for the redesigned app.
 */
import * as React from "react";
import { CheckCircle2, CircleSlash, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";

export function PageHeader({
  title, subtitle, icon, actions, className,
}: { title: React.ReactNode; subtitle?: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)}>
      <div className="flex min-w-0 items-center gap-3">
        {icon && <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">{icon}</div>}
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  value, onChange, options, size = "md", className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode; disabled?: boolean; title?: string }[];
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("inline-flex rounded-lg border bg-muted/50 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          title={o.title}
          aria-selected={value === o.value}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md font-medium transition-all disabled:opacity-40",
            size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
            value === o.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, hint, disabled, className }: {
  checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; hint?: React.ReactNode; disabled?: boolean; className?: string;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-3", disabled && "cursor-not-allowed opacity-60", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span className={cn("absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-sm leading-5">{label}</span>}
          {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
        </span>
      )}
    </label>
  );
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="dv-label">{label}</div>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin", className)} />;
}

export type Verdict = "MATCH" | "MISMATCH" | "ERROR" | "CANCELLED" | string | null | undefined;

export function VerdictBadge({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" | "lg" }) {
  const v = (verdict || "").toUpperCase();
  const cfg =
    v === "MATCH" ? { c: "text-equal bg-equal/10 border-equal/30", i: <CheckCircle2 className="h-3.5 w-3.5" />, t: "Match" }
    : v === "MISMATCH" ? { c: "text-changed bg-changed/10 border-changed/30", i: <TriangleAlert className="h-3.5 w-3.5" />, t: "Mismatch" }
    : v === "ERROR" ? { c: "text-destructive bg-destructive/10 border-destructive/30", i: <XCircle className="h-3.5 w-3.5" />, t: "Error" }
    : v === "CANCELLED" ? { c: "text-muted-foreground bg-muted border-border", i: <CircleSlash className="h-3.5 w-3.5" />, t: "Cancelled" }
    : v === "RUNNING" ? { c: "text-primary bg-primary/10 border-primary/30", i: <Loader2 className="h-3.5 w-3.5 animate-spin" />, t: "Running" }
    : { c: "text-muted-foreground bg-muted border-border", i: null, t: v ? v.toLowerCase() : "-" };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border font-semibold", cfg.c,
      size === "sm" ? "px-1.5 py-0 text-[10.5px]" : size === "lg" ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-xs")}>
      {cfg.i}
      {cfg.t}
    </span>
  );
}

/** Proportional bar: equal / changed / only in source / only in target. */
export function SpectrumBar({ equal = 0, changed = 0, onlySrc = 0, onlyTgt = 0, className, height = 8 }: {
  equal?: number; changed?: number; onlySrc?: number; onlyTgt?: number; className?: string; height?: number;
}) {
  const total = equal + changed + onlySrc + onlyTgt;
  const parts = [
    { n: equal, c: "bg-equal", t: "equal" },
    { n: changed, c: "bg-changed", t: "changed" },
    { n: onlySrc, c: "bg-only-src", t: "only in source" },
    { n: onlyTgt, c: "bg-only-tgt", t: "only in target" },
  ];
  return (
    <div className={cn("flex w-full gap-px overflow-hidden rounded-full bg-muted", className)} style={{ height }}>
      {total > 0 &&
        parts.filter((p) => p.n > 0).map((p) => (
          <div key={p.t} className={cn(p.c, "transition-all")} title={`${formatNumber(p.n)} ${p.t}`}
            style={{ width: `${Math.max((p.n / total) * 100, 0.6)}%` }} />
        ))}
    </div>
  );
}

/** Ring gauge of the equal share. */
export function MatchRing({ equal, total, size = 120, stroke = 10 }: { equal: number; total: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? equal / total : 0;
  const pct = total > 0 ? frac * 100 : 0;
  const label = total === 0 ? "-" : pct >= 99.995 && equal !== total ? "99.99%" : `${pct.toFixed(pct >= 99.9 || pct < 1 ? 2 : 1)}%`;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={frac >= 1 ? "hsl(var(--equal))" : "hsl(var(--primary))"}
          strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} style={{ transition: "stroke-dasharray 600ms ease" }} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-xl font-semibold tabular-nums">{label}</div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">equal</div>
        </div>
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, tone, className, onClick, active }: {
  label: React.ReactNode; value: React.ReactNode; sub?: React.ReactNode; tone?: "equal" | "changed" | "only-src" | "only-tgt" | "primary";
  className?: string; onClick?: () => void; active?: boolean;
}) {
  const dot = tone ? { equal: "bg-equal", changed: "bg-changed", "only-src": "bg-only-src", "only-tgt": "bg-only-tgt", primary: "bg-primary" }[tone] : null;
  const Comp: any = onClick ? "button" : "div";
  return (
    <Comp type={onClick ? "button" : undefined} onClick={onClick}
      className={cn("dv-panel-flat px-4 py-3 text-left transition-colors", onClick && "hover:border-primary/50", active && "border-primary ring-2 ring-primary/20", className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {dot && <span className={cn("h-2 w-2 rounded-full", dot)} />}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </Comp>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="grid h-12 w-12 place-items-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action}
    </div>
  );
}

export function Sparkline({ values, width = 160, height = 36, className }: { values: number[]; width?: number; height?: number; className?: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`).join(" ");
  return (
    <svg width={width} height={height} className={className}>
      <polyline points={`0,${height} ${pts} ${width},${height}`} fill="hsl(var(--primary) / 0.12)" stroke="none" />
      <polyline points={pts} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function KindIcon({ kind, className }: { kind?: string | null; className?: string }) {
  const map: Record<string, string> = { table: "TBL", query: "SQL", file: "FILE", mixed: "MIX" };
  return (
    <span className={cn("inline-grid h-5 min-w-[30px] place-items-center rounded border bg-muted px-1 font-mono text-[9.5px] font-semibold text-muted-foreground", className)}>
      {map[kind || ""] ?? (kind || "-").toUpperCase().slice(0, 4)}
    </span>
  );
}

export function compactNumber(n: number | null | undefined): string {
  if (n == null) return "-";
  if (Math.abs(n) < 100_000_000) return n.toLocaleString();
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  // What this hook last read or wrote, to notice writes by someone else
  // (another tab) and not overwrite them with an older pending value.
  const stored = React.useRef<string | null>(null);
  const [v, setV] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      stored.current = raw;
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  // Persist after typing pauses (and on page hide), not on every keystroke.
  const latest = React.useRef(v);
  const timer = React.useRef<number>();
  const flush = React.useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    try {
      const now = localStorage.getItem(key);
      if (now !== stored.current) {
        stored.current = now; // changed elsewhere: theirs wins
        return;
      }
      const raw = JSON.stringify(latest.current);
      localStorage.setItem(key, raw);
      stored.current = raw;
    } catch {
      /* ignore */
    }
  }, [key]);
  React.useEffect(() => {
    const onHide = () => timer.current !== undefined && flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      if (timer.current !== undefined) flush();
    };
  }, [flush]);
  const set = React.useCallback((next: T | ((p: T) => T)) => {
    setV((prev) => {
      const val = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      latest.current = val;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 400);
      return val;
    });
  }, [flush]);
  return [v, set];
}
