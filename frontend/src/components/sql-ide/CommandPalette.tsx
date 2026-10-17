/**
 * Command palette (Ctrl+Shift+P / F1) - every IDE command with its shortcut,
 * plus "go to script" and "switch connection" entries. Fuzzy matched.
 */
import * as React from "react";
import ReactDOM from "react-dom";
import { Command, Database, FileCode2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { IDE_COMMANDS, formatKey, type IdeCommandId } from "./ideCommands";

export interface PaletteExtra {
  id: string;
  label: string;
  hint?: string;
  group: "Scripts" | "Connections";
  run: () => void;
}

interface Item {
  key: string;
  label: string;
  group: string;
  shortcut?: string;
  hint?: string;
  icon: typeof Command;
  disabled?: boolean;
  run: () => void;
}

function score(text: string, q: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  const idx = t.indexOf(s);
  if (idx >= 0) return 1000 - idx * 2 - t.length * 0.01 + (idx === 0 || t[idx - 1] === " " ? 200 : 0);
  // subsequence match
  let ti = 0;
  let gaps = 0;
  for (const ch of s) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    gaps += found - ti;
    ti = found + 1;
  }
  return 500 - gaps;
}

export function CommandPalette({
  open, onClose, run, isEnabled, extras,
}: {
  open: boolean;
  onClose: () => void;
  run: (id: IdeCommandId) => void;
  isEnabled: (id: IdeCommandId) => boolean;
  extras: PaletteExtra[];
}) {
  const [q, setQ] = React.useState("");
  const [hi, setHi] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);
  const restoreFocus = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      setQ("");
      setHi(0);
    }
  }, [open]);

  const items = React.useMemo<Item[]>(() => {
    const cmds: Item[] = IDE_COMMANDS.filter((c) => c.id !== "view.palette").map((c) => ({
      key: c.id,
      label: c.title,
      group: c.category,
      shortcut: c.keys?.[0],
      icon: Command,
      disabled: !isEnabled(c.id),
      run: () => run(c.id),
    }));
    const ex: Item[] = extras.map((e) => ({
      key: e.id,
      label: e.label,
      group: e.group,
      hint: e.hint,
      icon: e.group === "Scripts" ? FileCode2 : Database,
      run: e.run,
    }));
    const all = [...cmds, ...ex];
    const s = q.trim();
    if (!s) return all;
    return all
      .map((it) => ({ it, sc: Math.max(score(it.label, s), score(`${it.group} ${it.label}`, s) - 50) }))
      .filter((x) => x.sc >= 0)
      .sort((a, b) => b.sc - a.sc)
      .map((x) => x.it);
  }, [q, extras, run, isEnabled]);

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  if (!open) return null;

  const close = () => {
    onClose();
    setTimeout(() => restoreFocus.current?.focus?.(), 0);
  };
  const choose = (it: Item | undefined) => {
    if (!it || it.disabled) return;
    onClose();
    setTimeout(() => it.run(), 0);
  };

  let lastGroup = "";
  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[350] flex justify-center bg-black/30 pt-[12vh] fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex h-fit max-h-[70vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHi(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(items.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                choose(items[hi]);
              }
            }}
            placeholder="Type a command, script or connection…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1 scrollbar-thin">
          {!items.length && <div className="px-4 py-6 text-center text-sm text-muted-foreground">No matching commands</div>}
          {items.map((it, i) => {
            const header = !q && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <React.Fragment key={it.key}>
                {header && (
                  <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{header}</div>
                )}
                <button
                  type="button"
                  data-i={i}
                  disabled={it.disabled}
                  onMouseMove={() => setHi(i)}
                  onClick={() => choose(it)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-1.5 text-left text-[13px] disabled:opacity-40",
                    hi === i && "bg-accent",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">
                    {q && <span className="text-muted-foreground">{it.group}: </span>}
                    {it.label}
                  </span>
                  {it.hint && <span className="truncate text-xs text-muted-foreground">{it.hint}</span>}
                  {it.shortcut && <span className="font-mono text-[11px] text-muted-foreground">{formatKey(it.shortcut)}</span>}
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
