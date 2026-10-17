/**
 * Editor toolbar: run controls, active connection / database / schema
 * (and Snowflake role / warehouse) chips, transaction mode, and the overflow
 * menu. One compact row, DBeaver's main toolbar reduced to what's used daily.
 */
import {
  AlignLeft, Boxes, Check, ChevronDown, CircleSlash, CircleStop, Database, FastForward, FileDown, FileUp, Gauge, History,
  Keyboard, Layers, ListTree, MoreHorizontal, Play, Plug, RotateCcw, Save, Settings2, ShieldAlert, UserRound,
  Wand2,
} from "lucide-react";
import * as React from "react";
import type { Connection } from "@/api/client";
import { cn, formatNumber } from "@/lib/utils";
import { contextFields } from "./ideRunner";
import type { ScriptTab } from "./ideStore";
import { isProductionConnection, MAX_ROWS_CHOICES, updateIdeSettings, useIdeSettings } from "./ideSettings";
import { shortcutLabel, type IdeCommandId } from "./ideCommands";
import { useCursorInfo } from "./cursorStore";
import type { ConnectionContextInfo } from "./useConnectionContext";
import { IconButton, MenuButton, PickerChip, type MenuEntry } from "./ui";
import { connectionColor } from "./EditorTabs";

interface Props {
  tab: ScriptTab;
  conn: Connection | undefined;
  connections: Connection[];
  ctx: ConnectionContextInfo;
  running: boolean;
  cmd: (id: IdeCommandId) => void;
  onConnection: (id: number | null) => void;
  onContext: (patch: Partial<ScriptTab["context"]>) => void;
}

export function Toolbar({ tab, conn, connections, ctx, running, cmd, onConnection, onContext }: Props) {
  const settings = useIdeSettings();
  const cursor = useCursorInfo();
  const hasSelection = (cursor?.selectionChars ?? 0) > 0;
  const fields = contextFields(conn?.db_type);
  const prod = isProductionConnection(conn?.id, settings);
  const sf = ctx.snowflake.data;
  // The toolbar sheds secondary controls as the editor column narrows (the
  // overflow menu and the command palette still reach all of them).
  const [width, rootRef] = useWidth<HTMLDivElement>();
  const compact = width > 0 && width < 860;
  const tiny = width > 0 && width < 660;

  return (
    <div ref={rootRef} className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2">
      {/* run */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => cmd("run.statement")}
          disabled={!conn}
          title={`${hasSelection ? "Execute selection" : "Execute statement at cursor"} (${shortcutLabel("run.statement")})`}
          className="flex h-7 items-center gap-1.5 rounded-l-md bg-primary pl-2.5 pr-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5 fill-current" />
          {hasSelection ? "Run selection" : "Run"}
        </button>
        <MenuButton
          entries={[
            { label: hasSelection ? "Execute selection" : "Execute statement", icon: Play, shortcut: "Mod-Enter", onSelect: () => cmd("run.statement") },
            { label: "Execute in new result tab", shortcut: "Mod-\\", onSelect: () => cmd("run.newTab") },
            { label: "Execute script", icon: FastForward, shortcut: "Alt-x", onSelect: () => cmd("run.script") },
            { kind: "separator" },
            { label: "Explain execution plan", icon: ListTree, shortcut: "Mod-Shift-e", onSelect: () => cmd("run.explain") },
            { label: "Count rows", icon: Layers, shortcut: "Mod-Alt-Shift-c", onSelect: () => cmd("run.count") },
          ]}
          minWidth={260}
        >
          {({ onClick, ref }) => (
            <button
              ref={ref}
              type="button"
              onClick={onClick}
              disabled={!conn}
              aria-label="More run options"
              className="flex h-7 items-center rounded-r-md border-l border-primary-foreground/20 bg-primary px-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </MenuButton>
      </div>
      {!tiny && (
        <IconButton
          icon={FastForward}
          label="Execute script"
          shortcut={shortcutLabel("run.script")}
          disabled={!conn}
          onClick={() => cmd("run.script")}
        />
      )}
      <IconButton
        icon={CircleStop}
        label="Cancel query"
        shortcut={shortcutLabel("run.stop")}
        disabled={!running}
        tone="danger"
        className={running ? "text-destructive" : undefined}
        onClick={() => cmd("run.stop")}
      />
      {!compact && (
        <>
          <IconButton icon={ListTree} label="Explain plan" shortcut={shortcutLabel("run.explain")} disabled={!conn} onClick={() => cmd("run.explain")} />
          <Divider />
          <IconButton icon={AlignLeft} label="Format SQL" shortcut={shortcutLabel("edit.format")} onClick={() => cmd("edit.format")} />
          <IconButton icon={Save} label="Save to library" shortcut={shortcutLabel("script.save")} disabled={!conn} onClick={() => cmd("script.save")} />
        </>
      )}
      <Divider />

      {/* context */}
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
        <PickerChip
          icon={prod ? ShieldAlert : Plug}
          tone={prod ? "danger" : undefined}
          label="Connection"
          value={conn ? String(conn.id) : null}
          placeholder="Choose connection"
          options={connections.map((c) => ({
            value: String(c.id),
            label: (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: isProductionConnection(c.id, settings) ? "hsl(var(--destructive))" : connectionColor(c.id) }} />
                <span className="truncate">{c.name}</span>
              </span>
            ),
            hint: c.db_type,
            search: `${c.name} ${c.db_type} ${c.host ?? ""}`,
          }))}
          onChange={(v) => onConnection(v ? Number(v) : null)}
          footer={
            <button type="button" onClick={() => cmd("conn.new")} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent">
              <Plug className="h-3.5 w-3.5" /> New connection…
            </button>
          }
          className="font-medium"
          title={conn ? `${conn.name} (${conn.db_type})${prod ? " - PRODUCTION" : ""}` : "Choose a connection"}
        />
        {conn && fields.database && (
          <PickerChip
            icon={Database}
            label="Database"
            value={tab.context.database ?? null}
            defaultLabel={ctx.database ? `${ctx.database}` : "Default database"}
            allowDefault
            loading={ctx.databases.isFetching}
            error={ctx.databases.data?.error ?? (ctx.databases.isError ? "Could not list databases" : null)}
            options={(ctx.databases.data?.databases ?? []).map((d) => ({ value: d }))}
            onChange={(v) => onContext({ database: v, schema_name: null })}
          />
        )}
        {conn && fields.schema && (
          <PickerChip
            icon={Boxes}
            label="Schema"
            value={tab.context.schema_name ?? null}
            defaultLabel={ctx.schema ? `${ctx.schema}` : "Default schema"}
            allowDefault
            loading={ctx.schemas.isFetching}
            error={ctx.schemas.data?.error ?? (ctx.schemas.isError ? "Could not list schemas" : null)}
            options={(ctx.schemas.data?.schemas ?? []).map((d) => ({ value: d }))}
            onChange={(v) => onContext({ schema_name: v })}
          />
        )}
        {conn && fields.roleWarehouse && (
          <>
            <PickerChip
              icon={UserRound}
              label="Role"
              value={tab.context.role ?? null}
              defaultLabel={sf?.current.role ?? "Default role"}
              allowDefault
              loading={ctx.snowflake.isFetching}
              error={sf?.diagnostics?.roles?.error ?? null}
              options={(sf?.roles ?? []).map((d) => ({ value: d }))}
              onChange={(v) => onContext({ role: v })}
            />
            <PickerChip
              icon={Gauge}
              label="Warehouse"
              value={tab.context.warehouse ?? null}
              defaultLabel={sf?.current.warehouse ?? "Default warehouse"}
              allowDefault
              loading={ctx.snowflake.isFetching}
              error={sf?.diagnostics?.warehouses?.error ?? null}
              options={(sf?.warehouses ?? []).map((d) => ({ value: d }))}
              onChange={(v) => onContext({ warehouse: v })}
            />
          </>
        )}
      </div>

      {/* transaction mode */}
      {conn && (
        <div className="flex items-center gap-0.5">
          <MenuButton
            align="right"
            entries={[
              {
                label: "Auto-commit",
                checked: tab.autocommit,
                title: "Every statement is committed as soon as it runs",
                onSelect: () => !tab.autocommit && cmd("txn.toggleMode"),
              },
              {
                label: "Manual commit",
                checked: !tab.autocommit,
                title: "Changes stay in an open transaction until you Commit or Roll back",
                onSelect: () => tab.autocommit && cmd("txn.toggleMode"),
              },
            ]}
          >
            {({ onClick, ref, open }) => (
              <button
                ref={ref}
                type="button"
                onClick={onClick}
                title="Transaction mode"
                aria-label={`Transaction mode: ${tab.autocommit ? "auto-commit" : "manual commit"}`}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md border px-2 text-xs",
                  open && "bg-accent",
                  tab.autocommit ? "text-muted-foreground hover:text-foreground" : "border-warning/50 bg-warning/10 text-warning",
                )}
              >
                {tab.autocommit ? <Check className="h-3.5 w-3.5" /> : <CircleSlash className="h-3.5 w-3.5" />}
                {!tiny && (tab.autocommit ? "Auto" : "Manual")}
                {tab.txnPending && <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Uncommitted changes" />}
              </button>
            )}
          </MenuButton>
          {!tab.autocommit && (
            <>
              <button
                type="button"
                onClick={() => cmd("txn.commit")}
                disabled={running}
                title={`Commit (${shortcutLabel("txn.commit")})`}
                className={cn(
                  "flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium disabled:opacity-40",
                  tab.txnPending ? "bg-success text-success-foreground hover:bg-success/90" : "text-muted-foreground hover:bg-accent",
                )}
              >
                <Check className="h-3.5 w-3.5" /> {!tiny && "Commit"}
              </button>
              <button
                type="button"
                onClick={() => cmd("txn.rollback")}
                disabled={running}
                title={`Roll back (${shortcutLabel("txn.rollback")})`}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
              >
                <RotateCcw className="h-3.5 w-3.5" /> {!tiny && "Rollback"}
              </button>
            </>
          )}
        </div>
      )}

      {!compact && (
      <MenuButton
        align="right"
        entries={[
          { kind: "heading", label: "Max rows per result" },
          ...MAX_ROWS_CHOICES.map((n) => ({
            label: formatNumber(n),
            checked: settings.maxRows === n,
            onSelect: () => updateIdeSettings({ maxRows: n }),
          })),
        ]}
      >
        {({ onClick, ref }) => (
          <button
            ref={ref}
            type="button"
            onClick={onClick}
            title="Rows fetched per result set"
            className="flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {compactNumber(settings.maxRows)} rows
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        )}
      </MenuButton>
      )}

      <MenuButton align="right" entries={moreMenu(cmd)} minWidth={270}>
        {({ onClick, ref, open }) => <IconButton ref={ref} icon={MoreHorizontal} label="More" active={open} onClick={onClick} />}
      </MenuButton>
    </div>
  );
}

function moreMenu(cmd: (id: IdeCommandId) => void): MenuEntry[] {
  return [
    { label: "Command palette…", shortcut: "Mod-Shift-p", onSelect: () => cmd("view.palette") },
    { kind: "separator" },
    { label: "Explain execution plan", icon: ListTree, shortcut: "Mod-Shift-e", onSelect: () => cmd("run.explain") },
    { label: "Format SQL", icon: AlignLeft, shortcut: "Mod-Shift-f", onSelect: () => cmd("edit.format") },
    { label: "Save to library", shortcut: "Mod-s", onSelect: () => cmd("script.save") },
    { label: "Save as…", icon: Save, shortcut: "Mod-Shift-s", onSelect: () => cmd("script.saveAs") },
    { label: "Open from library", shortcut: "Mod-o", onSelect: () => cmd("script.library") },
    { label: "Import .sql file…", icon: FileUp, onSelect: () => cmd("script.import") },
    { label: "Download script as .sql", icon: FileDown, onSelect: () => cmd("script.export") },
    { kind: "separator" },
    { label: "Generate DDL / INSERT / EXEC…", icon: Wand2, onSelect: () => cmd("tools.ddl") },
    { label: "Visual Diff of two results…", onSelect: () => cmd("results.diff") },
    { label: "Query history", icon: History, shortcut: "Mod-Shift-h", onSelect: () => cmd("view.history") },
    { label: "Query manager (running & recent)", onSelect: () => cmd("tools.queryManager") },
    { kind: "separator" },
    { label: "New connection…", icon: Plug, onSelect: () => cmd("conn.new") },
    { label: "Refresh database metadata", onSelect: () => cmd("conn.refresh") },
    { kind: "separator" },
    { label: "Focus mode", shortcut: "Mod-Alt-z", onSelect: () => cmd("view.zen") },
    { label: "Keyboard shortcuts", icon: Keyboard, onSelect: () => cmd("view.shortcuts") },
    { label: "Editor settings…", icon: Settings2, shortcut: "Mod-,", onSelect: () => cmd("view.settings") },
  ];
}

function useWidth<T extends HTMLElement>(): [number, React.RefObject<T>] {
  const ref = React.useRef<T>(null);
  const [w, setW] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [w, ref];
}

function compactNumber(n: number) {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${n / 1000}k` : String(n);
}

function Divider() {
  return <div className="mx-1 h-5 w-px shrink-0 bg-border" />;
}
