/**
 * Editor settings (Ctrl+,): appearance, editing behaviour, execution and
 * safety. Changes apply live and are stored per browser profile.
 */
import * as React from "react";
import ReactDOM from "react-dom";
import { RotateCcw, ShieldAlert, X } from "lucide-react";
import type { Connection } from "@/api/client";
import { cn, formatNumber } from "@/lib/utils";
import {
  FONT_CHOICES, MAX_ROWS_CHOICES, resetIdeSettings, updateIdeSettings, useIdeSettings, type IdeSettings,
} from "./ideSettings";

export function SettingsDialog({ open, onClose, connections }: { open: boolean; onClose: () => void; connections: Connection[] }) {
  const s = useIdeSettings();
  const [section, setSection] = React.useState<"editor" | "execution" | "safety">("editor");
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  const set = (patch: Partial<IdeSettings>) => updateIdeSettings(patch);

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[350] flex items-center justify-center bg-black/40 p-4 fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-label="Editor settings" className="flex h-[min(640px,90vh)] w-[760px] max-w-[96vw] overflow-hidden rounded-xl border bg-background shadow-2xl">
        <nav className="w-44 shrink-0 border-r bg-muted/30 p-2">
          <div className="px-2 pb-3 pt-1 text-sm font-semibold">Settings</div>
          {([
            ["editor", "Editor"],
            ["execution", "Execution"],
            ["safety", "Safety"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={cn(
                "mb-0.5 w-full rounded-md px-2 py-1.5 text-left text-sm",
                section === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={resetIdeSettings}
            className="mt-6 flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset to defaults
          </button>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b px-5">
            <h2 className="text-sm font-semibold capitalize">{section}</h2>
            <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-5 py-3 scrollbar-thin">
            {section === "editor" && (
              <>
                <Row label="Theme" hint="Match the app, or always use GitHub Light / Dark for the editor.">
                  <Seg
                    value={s.editorTheme}
                    onChange={(v) => set({ editorTheme: v as IdeSettings["editorTheme"] })}
                    options={[
                      ["app", "Match app"],
                      ["github-light", "GitHub Light"],
                      ["github-dark", "GitHub Dark"],
                    ]}
                  />
                </Row>
                <Row label="Font">
                  <select
                    value={s.fontFamily}
                    onChange={(e) => set({ fontFamily: e.target.value })}
                    className="h-8 w-64 rounded-md border bg-background px-2 text-xs"
                  >
                    {FONT_CHOICES.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Font size">
                  <Stepper value={s.fontSize} min={10} max={24} onChange={(v) => set({ fontSize: v })} suffix="px" />
                </Row>
                <Row label="Line height">
                  <Seg
                    value={String(s.lineHeight)}
                    onChange={(v) => set({ lineHeight: Number(v) })}
                    options={[
                      ["1.4", "Compact"],
                      ["1.6", "Normal"],
                      ["1.8", "Relaxed"],
                    ]}
                  />
                </Row>
                <Row label="Tab size">
                  <Seg value={String(s.tabSize)} onChange={(v) => set({ tabSize: Number(v) as 2 | 4 })} options={[["2", "2 spaces"], ["4", "4 spaces"]]} />
                </Row>
                <Check label="Line numbers" checked={s.lineNumbers} onChange={(v) => set({ lineNumbers: v })} />
                <Check label="Word wrap" hint="Alt+Z toggles it from the editor." checked={s.wordWrap} onChange={(v) => set({ wordWrap: v })} />
                <Check label="Highlight the statement under the cursor" checked={s.highlightStatement} onChange={(v) => set({ highlightStatement: v })} />
                <Check label="Run markers (▶) in the gutter" hint="Click a marker to run that statement." checked={s.statementRunMarkers} onChange={(v) => set({ statementRunMarkers: v })} />
                <Check label="Auto-close brackets and quotes" checked={s.autoCloseBrackets} onChange={(v) => set({ autoCloseBrackets: v })} />
                <Check label="Upper-case keywords in completion and formatting" checked={s.uppercaseKeywords} onChange={(v) => set({ uppercaseKeywords: v })} />
                <Check
                  label="Grammar-aware completion (PostgreSQL / MySQL)"
                  hint="Suggests keywords valid at the cursor. Loads the SQL parser on first use."
                  checked={s.contextCompletion}
                  onChange={(v) => set({ contextCompletion: v })}
                />
                <Row label="Engine" hint="Plain is a basic text box for machines where the rich editor misbehaves.">
                  <Seg value={s.engine} onChange={(v) => set({ engine: v as IdeSettings["engine"] })} options={[["codemirror", "Code editor"], ["plain", "Plain"]]} />
                </Row>
              </>
            )}
            {section === "execution" && (
              <>
                <Check
                  label="A blank line ends a statement"
                  hint="For Ctrl+Enter: statements separated by an empty line run separately even without a semicolon (DBeaver “smart” mode). Script runs always use delimiters."
                  checked={s.blankLineDelimiter}
                  onChange={(v) => set({ blankLineDelimiter: v })}
                />
                <Check
                  label="Stop a script at the first error"
                  hint="Off: keep running the remaining statements and report every failure."
                  checked={s.stopOnError}
                  onChange={(v) => set({ stopOnError: v })}
                />
                <Check
                  label="Prompt for :name parameters"
                  hint="${name} variables are always prompted. Turn this off if your SQL uses :name syntax of its own."
                  checked={s.namedParameters}
                  onChange={(v) => set({ namedParameters: v })}
                />
                <Check
                  label="New scripts start in auto-commit mode"
                  hint="Off: new script tabs start in manual-commit mode (Commit / Rollback buttons)."
                  checked={s.defaultAutocommit}
                  onChange={(v) => set({ defaultAutocommit: v })}
                />
                <Row label="Max rows per result" hint="Rows the server keeps per result set; the grid pages through them.">
                  <select
                    value={s.maxRows}
                    onChange={(e) => set({ maxRows: Number(e.target.value) })}
                    className="h-8 w-36 rounded-md border bg-background px-2 text-xs"
                  >
                    {MAX_ROWS_CHOICES.map((n) => (
                      <option key={n} value={n}>
                        {formatNumber(n)}
                      </option>
                    ))}
                  </select>
                </Row>
                <Row label="Text view rows">
                  <select
                    value={s.textViewRows}
                    onChange={(e) => set({ textViewRows: Number(e.target.value) })}
                    className="h-8 w-36 rounded-md border bg-background px-2 text-xs"
                  >
                    {[500, 2000, 10000].map((n) => (
                      <option key={n} value={n}>
                        {formatNumber(n)}
                      </option>
                    ))}
                  </select>
                </Row>
              </>
            )}
            {section === "safety" && (
              <>
                <Check
                  label="Confirm data-changing statements on production connections"
                  hint="INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DROP, ALTER, CREATE, GRANT… ask before running."
                  checked={s.confirmModifyingOnProduction}
                  onChange={(v) => set({ confirmModifyingOnProduction: v })}
                />
                <div className="pt-3">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <ShieldAlert className="h-4 w-4 text-destructive" /> Production connections
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Marked connections get a red status bar and the confirmation above.
                  </p>
                  <div className="mt-2 divide-y rounded-lg border">
                    {connections.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No connections.</div>}
                    {connections.map((c) => {
                      const on = s.productionConnections.includes(c.id);
                      return (
                        <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/40">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) =>
                              set({
                                productionConnections: e.target.checked
                                  ? [...s.productionConnections, c.id]
                                  : s.productionConnections.filter((x) => x !== c.id),
                              })
                            }
                            className="h-4 w-4 accent-[hsl(var(--destructive))]"
                          />
                          <span className="flex-1 truncate">{c.name}</span>
                          <span className="text-xs text-muted-foreground">{c.db_type}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function Seg({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-md border bg-muted/40 p-0.5">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            "h-7 rounded px-2.5 text-xs transition-colors",
            value === v ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Stepper({ value, min, max, onChange, suffix }: { value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <div className="flex items-center rounded-md border">
      <button type="button" className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={value <= min} onClick={() => onChange(value - 1)}>
        −
      </button>
      <span className="w-14 text-center text-xs tabular-nums">
        {value}
        {suffix}
      </span>
      <button type="button" className="h-8 w-8 text-muted-foreground hover:text-foreground disabled:opacity-40" disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </div>
  );
}
