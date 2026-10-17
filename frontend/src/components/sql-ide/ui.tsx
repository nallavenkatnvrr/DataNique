/**
 * Small UI primitives for the SQL IDE chrome: icon buttons, dropdown /
 * context menus, an anchored popover, a searchable picker chip, keycaps and a
 * promise-based confirm dialog. Menus render in a portal so they escape the
 * IDE's overflow-hidden panes, and are fully keyboard-driven.
 */
import * as React from "react";
import ReactDOM from "react-dom";
import { Check, ChevronDown, Loader2, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatKey } from "./ideCommands";

// ---------------------------------------------------------------------------
// IconButton
// ---------------------------------------------------------------------------

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: "sm" | "md";
  tone?: "default" | "danger" | "primary";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, shortcut, active, size = "md", tone = "default", className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-6 w-6" : "h-7 w-7",
        active && "bg-accent text-foreground",
        tone === "danger" && "hover:bg-destructive/10 hover:text-destructive",
        tone === "primary" && "text-primary hover:text-primary",
        className,
      )}
      {...rest}
    >
      <Icon className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />
    </button>
  );
});

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-[20px] items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KeyCombo({ binding }: { binding?: string }) {
  if (!binding) return null;
  return <span className="font-mono text-[11px] text-muted-foreground">{formatKey(binding)}</span>;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export type MenuEntry =
  | {
      kind?: "item";
      label: React.ReactNode;
      icon?: LucideIcon;
      shortcut?: string;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      checked?: boolean;
      title?: string;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: React.ReactNode };

export interface MenuAnchor {
  x: number;
  y: number;
  /** Width of the anchor element, to right-align under it. */
  alignRight?: number;
}

export function Menu({
  anchor, entries, onClose, minWidth = 220, className,
}: {
  anchor: MenuAnchor;
  entries: MenuEntry[];
  onClose: () => void;
  minWidth?: number;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState({ left: anchor.x, top: anchor.y, ready: false });
  const [active, setActive] = React.useState(-1);
  const items = entries.map((e, i) => ({ e, i })).filter(({ e }) => (e.kind ?? "item") === "item" && !(e as any).disabled);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = anchor.alignRight != null ? anchor.x + anchor.alignRight - width : anchor.x;
    let top = anchor.y;
    if (left + width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - width - 4);
    if (top + height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - height - 4);
    setPos({ left: Math.max(4, left), top, ready: true });
    el.focus();
  }, [anchor.x, anchor.y, anchor.alignRight]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      const cur = items.findIndex((x) => x.i === active);
      const next = e.key === "ArrowDown" ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
      setActive(items[next].i);
    } else if (e.key === "Enter" || e.key === " ") {
      const hit = entries[active];
      if (hit && (hit.kind ?? "item") === "item") {
        e.preventDefault();
        onClose();
        (hit as any).onSelect();
      }
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  return ReactDOM.createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "fixed z-[300] max-h-[80vh] overflow-y-auto rounded-lg border bg-popover py-1 text-[13px] text-popover-foreground shadow-xl outline-none scrollbar-thin",
        !pos.ready && "invisible",
        className,
      )}
      style={{ left: pos.left, top: pos.top, minWidth }}
    >
      {entries.map((e, i) => {
        if (e.kind === "separator") return <div key={i} className="my-1 border-t" />;
        if (e.kind === "heading") {
          return (
            <div key={i} className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {e.label}
            </div>
          );
        }
        const Icon = e.icon;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={e.disabled}
            title={e.title}
            onMouseEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              e.onSelect();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:opacity-40",
              active === i && "bg-accent",
              e.danger && "text-destructive",
            )}
          >
            <span className="flex w-4 shrink-0 justify-center">
              {e.checked ? <Check className="h-3.5 w-3.5" /> : Icon ? <Icon className="h-3.5 w-3.5 opacity-80" /> : null}
            </span>
            <span className="flex-1 truncate">{e.label}</span>
            {e.shortcut && <span className="ml-4 font-mono text-[11px] text-muted-foreground">{formatKey(e.shortcut)}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** Render-prop helper: a trigger that opens a Menu under itself. */
export function MenuButton({
  entries, children, align = "left", minWidth,
}: {
  entries: MenuEntry[] | (() => MenuEntry[]);
  children: (props: { open: boolean; onClick: (e: React.MouseEvent<HTMLElement>) => void; ref: React.Ref<any> }) => React.ReactNode;
  align?: "left" | "right";
  minWidth?: number;
}) {
  const [anchor, setAnchor] = React.useState<MenuAnchor | null>(null);
  const ref = React.useRef<HTMLElement>(null);
  const onClick = (e: React.MouseEvent<HTMLElement>) => {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const r = (ref.current ?? e.currentTarget).getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 4, alignRight: align === "right" ? r.width : undefined });
  };
  const list = anchor ? (typeof entries === "function" ? entries() : entries) : [];
  return (
    <>
      {children({ open: !!anchor, onClick, ref })}
      {anchor && <Menu anchor={anchor} entries={list} onClose={() => setAnchor(null)} minWidth={minWidth} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Popover (anchored panel)
// ---------------------------------------------------------------------------

export function Popover({
  anchorEl, onClose, children, className, align = "left", width,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  align?: "left" | "right";
  width?: number;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  React.useLayoutEffect(() => {
    const r = anchorEl.getBoundingClientRect();
    const el = ref.current;
    const w = el?.getBoundingClientRect().width ?? width ?? 280;
    const h = el?.getBoundingClientRect().height ?? 300;
    let left = align === "right" ? r.right - w : r.left;
    left = Math.min(Math.max(4, left), window.innerWidth - w - 4);
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 4);
    setPos({ left, top });
  }, [anchorEl, align, width]);
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorEl.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchorEl, onClose]);
  return ReactDOM.createPortal(
    <div
      ref={ref}
      className={cn(
        "fixed z-[300] rounded-lg border bg-popover text-popover-foreground shadow-xl",
        !pos && "invisible",
        className,
      )}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, width }}
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// PickerChip - toolbar chip that opens a searchable list (connection, database, schema…)
// ---------------------------------------------------------------------------

export interface PickerOption {
  value: string;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  search?: string;
}

export function PickerChip({
  icon: Icon, label, value, placeholder, options, onChange, loading, error, disabled, allowDefault,
  defaultLabel = "Default", footer, title, className, tone,
}: {
  icon?: LucideIcon;
  label: string;
  value: string | null;
  placeholder?: string;
  options: PickerOption[];
  onChange: (v: string | null) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Offer a "Default" entry that clears the choice. */
  allowDefault?: boolean;
  defaultLabel?: string;
  footer?: React.ReactNode;
  title?: string;
  className?: string;
  tone?: "danger";
}) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [hi, setHi] = React.useState(0);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s
      ? options.filter((o) => (o.search ?? o.value).toLowerCase().includes(s))
      : options;
    return list.slice(0, 500);
  }, [options, q]);
  const rows: (PickerOption | null)[] = allowDefault && !q ? [null, ...filtered] : filtered;

  React.useEffect(() => {
    if (open) {
      setQ("");
      const idx = rows.findIndex((r) => (r ? r.value === value : value == null));
      setHi(Math.max(0, idx));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const pick = (o: PickerOption | null) => {
    setOpen(false);
    onChange(o ? o.value : null);
    btnRef.current?.focus();
  };

  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        title={title ?? `${label}: ${value ?? defaultLabel}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "group inline-flex h-7 min-w-[44px] max-w-[240px] shrink items-center gap-1.5 rounded-md border border-transparent px-2 text-xs transition-colors",
          "hover:border-border hover:bg-accent disabled:opacity-50",
          open && "border-border bg-accent",
          tone === "danger" && "text-destructive",
          className,
        )}
      >
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        <span className="sr-only">{label}:</span>
        <span className={cn("truncate", !value && "text-muted-foreground")}>
          {loading && !value ? "Loading…" : current?.label ?? value ?? placeholder ?? defaultLabel}
        </span>
        {loading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-60" /> : <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />}
      </button>
      {open && btnRef.current && (
        <Popover anchorEl={btnRef.current} onClose={() => setOpen(false)} width={300}>
          <div className="flex items-center gap-2 border-b px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              placeholder={`Find ${label.toLowerCase()}…`}
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHi((h) => Math.min(rows.length - 1, h + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => Math.max(0, h - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (rows[hi] !== undefined) pick(rows[hi]);
                }
              }}
              className="h-6 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div ref={listRef} className="max-h-72 overflow-y-auto py-1 scrollbar-thin">
            {error && <div className="px-3 py-2 text-xs text-destructive">{error}</div>}
            {loading && !options.length && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {!loading && !rows.length && !error && <div className="px-3 py-2 text-xs text-muted-foreground">No matches</div>}
            {rows.map((o, i) => {
              const selected = o ? o.value === value : value == null;
              return (
                <button
                  key={o ? o.value : "__default"}
                  data-idx={i}
                  type="button"
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(o)}
                  className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs", hi === i && "bg-accent")}
                >
                  <span className="flex w-3.5 shrink-0 justify-center">{selected && <Check className="h-3.5 w-3.5 text-primary" />}</span>
                  <span className={cn("flex-1 truncate", !o && "italic text-muted-foreground")}>
                    {o ? o.label ?? o.value : defaultLabel}
                  </span>
                  {o?.hint && <span className="shrink-0 text-[10px] text-muted-foreground">{o.hint}</span>}
                </button>
              );
            })}
          </div>
          {footer && <div className="border-t p-1">{footer}</div>}
        </Popover>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog (promise based)
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Optional third choice (e.g. "Roll back and close"). */
  alternateLabel?: string;
  danger?: boolean;
  resolve: (v: boolean | "alternate") => void;
}

let pushConfirm: ((r: ConfirmRequest) => void) | null = null;

export function confirmDialog(opts: Omit<ConfirmRequest, "resolve">): Promise<boolean | "alternate"> {
  return new Promise((resolve) => {
    if (!pushConfirm) {
      resolve(window.confirm(opts.title));
      return;
    }
    pushConfirm({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = React.useState<ConfirmRequest | null>(null);
  const okRef = React.useRef<HTMLButtonElement>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    pushConfirm = (r) => setReq(r);
    return () => {
      pushConfirm = null;
    };
  }, []);
  // Dangerous confirmations start on Cancel so a stray Enter can't approve them.
  React.useEffect(() => {
    if (req) setTimeout(() => (req.danger ? cancelRef.current : okRef.current)?.focus(), 0);
  }, [req]);
  if (!req) return null;
  const done = (v: boolean | "alternate") => {
    req.resolve(v);
    setReq(null);
  };
  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/40 p-4 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) done(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      }}
    >
      <div role="alertdialog" aria-modal className="w-full max-w-md rounded-xl border bg-background p-5 shadow-2xl">
        <h3 className="text-base font-semibold">{req.title}</h3>
        {req.description && <div className="mt-2 text-sm text-muted-foreground">{req.description}</div>}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => done(false)}
            className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent"
          >
            {req.cancelLabel ?? "Cancel"}
          </button>
          {req.alternateLabel && (
            <button
              type="button"
              onClick={() => done("alternate")}
              className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent"
            >
              {req.alternateLabel}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            onClick={() => done(true)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium text-primary-foreground",
              req.danger ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90",
            )}
          >
            {req.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Resize handle
// ---------------------------------------------------------------------------

/** Drag handle that reports the delta from where the drag started. */
export function ResizeHandle({
  direction, onDrag, onEnd, onDoubleClick, className,
}: {
  direction: "horizontal" | "vertical";
  onDrag: (delta: number) => void;
  onEnd?: () => void;
  onDoubleClick?: () => void;
  className?: string;
}) {
  const [dragging, setDragging] = React.useState(false);
  return (
    <div
      role="separator"
      aria-orientation={direction === "horizontal" ? "vertical" : "horizontal"}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        e.preventDefault();
        const start = direction === "horizontal" ? e.clientX : e.clientY;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        setDragging(true);
        document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
        const move = (ev: PointerEvent) => onDrag((direction === "horizontal" ? ev.clientX : ev.clientY) - start);
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          setDragging(false);
          onEnd?.();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      }}
      className={cn(
        "dv-resize-handle relative z-10 shrink-0",
        direction === "horizontal" ? "-mx-[2px] w-[5px] cursor-col-resize" : "-my-[2px] h-[5px] cursor-row-resize",
        dragging && "dv-dragging",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Parameter prompt (":name" / "${name}" in a statement)
// ---------------------------------------------------------------------------

const PARAMS_KEY = "dv-ide-params";

function loadParamValues(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PARAMS_KEY) || "{}") ?? {};
  } catch {
    return {};
  }
}

interface ParamsRequest {
  names: string[];
  resolve: (v: Record<string, string> | null) => void;
}

let pushParams: ((r: ParamsRequest) => void) | null = null;

/** Ask for parameter values; resolves null when cancelled. Values are remembered. */
export function promptParams(names: string[]): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    if (!pushParams) {
      resolve(null);
      return;
    }
    pushParams({ names, resolve });
  });
}

export function ParamsHost() {
  const [req, setReq] = React.useState<ParamsRequest | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    pushParams = (r) => {
      const saved = loadParamValues();
      setValues(Object.fromEntries(r.names.map((n) => [n, saved[n] ?? ""])));
      setReq(r);
    };
    return () => {
      pushParams = null;
    };
  }, []);
  if (!req) return null;
  const finish = (ok: boolean) => {
    if (ok) {
      try {
        localStorage.setItem(PARAMS_KEY, JSON.stringify({ ...loadParamValues(), ...values }));
      } catch {
        /* ignore */
      }
    }
    req.resolve(ok ? values : null);
    setReq(null);
  };
  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/40 p-4 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) finish(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(false);
        }
      }}
    >
      <form
        role="dialog"
        aria-label="Statement parameters"
        className="w-full max-w-lg rounded-xl border bg-background p-5 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          finish(true);
        }}
      >
        <h3 className="text-base font-semibold">Bind parameters</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Values are inserted into the SQL exactly as typed - quote text values, e.g. <code className="font-mono">'ACTIVE'</code>.
        </p>
        <div className="mt-4 max-h-[50vh] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
          {req.names.map((n, i) => (
            <label key={n} className="flex items-center gap-3">
              <span className="w-40 shrink-0 truncate text-right font-mono text-xs text-muted-foreground" title={n}>
                {n}
              </span>
              <input
                autoFocus={i === 0}
                value={values[n] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))}
                className="h-8 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
                placeholder="value"
              />
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => finish(false)} className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-accent">
            Cancel
          </button>
          <button type="submit" className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
            Run
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
