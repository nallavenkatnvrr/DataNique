import * as React from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxProps {
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
  allowClear?: boolean;
}

export function Combobox({
  value,
  options,
  onChange,
  placeholder = "— select —",
  disabled,
  loading,
  emptyLabel = "No matches",
  className,
  allowClear = true,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // close on outside click
  React.useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "flex h-9 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          !value && "text-muted-foreground",
        )}
      >
        <span className="truncate text-left">
          {loading ? "loading..." : value || placeholder}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {allowClear && value && !disabled ? (
            <X
              className="h-3.5 w-3.5 opacity-60 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
            />
          ) : null}
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" />
        </span>
      </button>

      {open && (
        // Phase 4.41: dropdown is wider than the trigger so long table /
        // schema names (e.g. ``sales_order_line_item_history``) are
        // readable. ``w-max`` sizes to the widest item, ``min-w-full``
        // ensures it never gets NARROWER than the trigger, ``max-w-[640px]``
        // caps it so a 200-char name doesn't blow out the layout.
        <div className="absolute z-50 mt-1 min-w-full w-max max-w-[640px] rounded-md border bg-background text-foreground shadow-lg">
          <div className="flex items-center gap-2 border-b px-2 py-1.5">
            <Search className="h-3.5 w-3.5 opacity-60" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, filtered.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered[highlight]) pick(filtered[highlight]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              placeholder="Search..."
              className="h-7 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="text-xs text-muted-foreground shrink-0">
              {filtered.length}/{options.length}
            </span>
          </div>
          <div className="max-h-64 overflow-auto scrollbar-thin py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
            ) : (
              filtered.map((opt, i) => (
                <div
                  key={opt}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(opt)}
                  // Phase 4.41: `title={opt}` shows full name on hover —
                  // belt-and-suspenders with the wider dropdown so
                  // truncated entries are still inspectable.
                  title={opt}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm",
                    i === highlight ? "bg-accent text-accent-foreground" : "",
                  )}
                >
                  <span className="truncate font-mono">{opt}</span>
                  {value === opt ? <Check className="h-3.5 w-3.5 text-primary shrink-0" /> : null}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
