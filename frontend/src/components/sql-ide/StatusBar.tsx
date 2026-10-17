/**
 * IDE status bar: connection, context and transaction state on the left;
 * cursor position, current statement, run state and editor info on the
 * right. Turns red for connections marked Production.
 */
import * as React from "react";
import { AlertTriangle, CircleDot, Loader2, ShieldAlert, WrapText } from "lucide-react";
import type { Connection } from "@/api/client";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import { useCursorInfo } from "./cursorStore";
import type { ResultTab, ScriptTab } from "./ideStore";
import { isProductionConnection, updateIdeSettings, useIdeSettings } from "./ideSettings";

const DIALECT_LABEL: Record<string, string> = {
  snowflake: "Snowflake",
  oracle: "Oracle",
  sqlserver: "SQL Server",
  postgres: "PostgreSQL",
  mysql: "MySQL",
};

export function StatusBar({
  tab, conn, database, schema, result, onCommand,
}: {
  tab: ScriptTab;
  conn: Connection | undefined;
  database: string | null;
  schema: string | null;
  result: ResultTab | undefined;
  onCommand: (id: "view.settings" | "txn.toggleMode" | "view.palette") => void;
}) {
  const settings = useIdeSettings();
  const cursor = useCursorInfo();
  const prod = isProductionConnection(conn?.id, settings);
  const running = tab.results.find((r) => r.status === "running");
  return (
    <footer
      className={cn(
        "flex h-6 shrink-0 select-none items-center gap-3 border-t px-3 text-[11px]",
        prod ? "dv-statusbar-prod" : "bg-muted/50 text-muted-foreground",
      )}
    >
      {conn ? (
        <>
          <span className="flex items-center gap-1.5 font-medium" title={`${conn.name} — ${conn.host ?? ""}`}>
            {prod ? <ShieldAlert className="h-3 w-3" /> : <CircleDot className="h-3 w-3 text-success" />}
            {conn.name}
            {prod && <span className="rounded bg-white/20 px-1 text-[9px] font-bold uppercase tracking-wider">Production</span>}
          </span>
          {(database || schema) && <span className="truncate">{[database, schema].filter(Boolean).join(" › ")}</span>}
          <button
            type="button"
            onClick={() => onCommand("txn.toggleMode")}
            className={cn("flex items-center gap-1 hover:underline", !tab.autocommit && !prod && "text-warning")}
            title="Switch auto-commit / manual commit"
          >
            {tab.autocommit ? "Auto-commit" : "Manual commit"}
            {tab.txnPending && (
              <span className="flex items-center gap-0.5 font-medium">
                <AlertTriangle className="h-3 w-3" /> uncommitted
              </span>
            )}
          </button>
        </>
      ) : (
        <span className="italic">No connection</span>
      )}

      <span className="flex-1" />

      {running ? (
        <RunningClock rt={running} />
      ) : result && result.status !== "idle" && result.finishedAt ? (
        <span className={cn("tabular-nums", result.status === "error" && !prod && "text-destructive")}>
          {result.status === "error" ? "Failed" : result.status === "cancelled" ? "Cancelled" : "Done"}
          {result.sets[0] ? ` · ${formatNumber(result.sets[0].total)} rows` : result.affectedRows != null ? ` · ${formatNumber(result.affectedRows)} affected` : ""}
          {` · ${formatDuration(result.elapsedMs)}`}
        </span>
      ) : null}

      {cursor && (
        <>
          <span className="tabular-nums">
            Ln {cursor.line}, Col {cursor.col}
            {cursor.selectionChars > 0 && ` (${formatNumber(cursor.selectionChars)} selected${cursor.selectionLines > 1 ? `, ${cursor.selectionLines} lines` : ""})`}
          </span>
          {cursor.statementCount > 0 && (
            <span className="tabular-nums" title="Statement under the cursor / statements in the script">
              Stmt {cursor.statementIndex != null ? cursor.statementIndex + 1 : "–"}/{cursor.statementCount}
            </span>
          )}
        </>
      )}
      <button type="button" className="hover:underline" onClick={() => updateIdeSettings({ wordWrap: !settings.wordWrap })} title="Toggle word wrap (Alt+Z)">
        <WrapText className={cn("h-3 w-3", !settings.wordWrap && "opacity-40")} />
      </button>
      <button type="button" className="hover:underline" onClick={() => onCommand("view.settings")} title="Editor settings">
        Spaces: {settings.tabSize}
      </button>
      <span>{conn ? DIALECT_LABEL[conn.db_type] ?? conn.db_type : "SQL"}</span>
    </footer>
  );
}

function RunningClock({ rt }: { rt: ResultTab }) {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(iv);
  }, []);
  const p = rt.progress;
  return (
    <span className="flex items-center gap-1.5 tabular-nums">
      <Loader2 className="h-3 w-3 animate-spin" />
      Executing{p && p.total > 1 ? ` ${Math.min(p.done + 1, p.total)}/${p.total}` : ""} · {formatDuration(rt.startedAt ? now - rt.startedAt : 0)}
    </span>
  );
}
