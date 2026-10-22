import * as React from "react";
import { Keyboard, Search, X } from "lucide-react";
import { IDE_COMMANDS, formatKey } from "@/components/sql-ide/ideCommands";

interface Shortcut {
  keys: string[];
  description: string;
  category: string;
}

// Editor keys that come from the editor itself rather than the IDE command list.
const EDITOR_SHORTCUTS: Shortcut[] = [
  { category: "Editor", keys: ["Tab"], description: "Accept completion / next template field / indent" },
  { category: "Editor", keys: ["Shift-Tab"], description: "Outdent" },
  { category: "Editor", keys: ["Mod-z"], description: "Undo" },
  { category: "Editor", keys: ["Mod-Shift-z", "Mod-y"], description: "Redo" },
  { category: "Editor", keys: ["Mod-d"], description: "Select next occurrence" },
  { category: "Editor", keys: ["Alt-Shift-ArrowDown"], description: "Copy line down" },
  { category: "Editor", keys: ["Alt-ArrowUp"], description: "Move line up / down (with ↓)" },
  { category: "Editor", keys: ["Mod-Shift-k"], description: "Delete line" },
  { category: "Editor", keys: ["Mod-Shift-["], description: "Fold block (Mod-Shift-] unfolds)" },
  { category: "Editor", keys: ["Mod-Click"], description: "Add a cursor" },
  { category: "Editor", keys: ["Alt-Drag"], description: "Rectangular (column) selection" },
  { category: "Editor", keys: ["F3"], description: "Find next (Shift+F3: previous)" },
];

const APP_SHORTCUTS: Shortcut[] = [
  { category: "App", keys: ["?"], description: "Show this list" },
  { category: "App", keys: ["Escape"], description: "Close dialog / menu" },
  { category: "App", keys: ["Mod-k"], description: "Search or jump to a page" },
  { category: "App", keys: ["Mod-b"], description: "Collapse or expand the side menu" },
  { category: "App", keys: ["Mod-Shift-l"], description: "Lock Datanique" },
];

const ALL: Shortcut[] = [
  ...IDE_COMMANDS.filter((c) => c.keys?.length).map((c) => ({
    category: `SQL IDE · ${c.category}`,
    keys: c.keys!,
    description: c.title,
  })),
  ...EDITOR_SHORTCUTS.map((s) => ({ ...s, category: "SQL IDE · Editor" })),
  ...APP_SHORTCUTS,
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsDialog({ open, onClose }: Props) {
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (!open) return;
    setQ("");
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const list = q
    ? ALL.filter((s) => `${s.description} ${s.keys.map(formatKey).join(" ")}`.toLowerCase().includes(q.toLowerCase()))
    : ALL;
  const categories = Array.from(new Set(list.map((s) => s.category)));

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4 fade-in" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b px-5 py-3">
          <Keyboard className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <div className="relative ml-auto flex w-64 items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="h-8 w-full rounded-md border bg-background pl-7 pr-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-5 scrollbar-thin">
          <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
            {categories.map((cat) => (
              <div key={cat}>
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{cat}</h3>
                <div className="space-y-0.5">
                  {list
                    .filter((s) => s.category === cat)
                    .map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 rounded px-2 py-1 text-[13px] hover:bg-accent/50">
                        <span className="min-w-0 truncate">{s.description}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {s.keys.map((k, ki) => (
                            <kbd key={ki} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] shadow-sm">
                              {formatKey(k)}
                            </kbd>
                          ))}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
          {!list.length && <div className="py-8 text-center text-sm text-muted-foreground">No shortcuts match.</div>}
        </div>
      </div>
    </div>
  );
}

/** Hook to install the global `?` keyboard listener that opens the shortcuts dialog. */
export function useKeyboardShortcutsDialog() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        target.closest(".cm-editor")
      ) {
        return;
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return { open, setOpen };
}
