import * as React from "react";
import { Copy, Check } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { renderControlChars, escapeControlCharsPlain } from "@/lib/text";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// RowDetailDialog (phase 4.38)
//
// Two use cases share one component:
//
// 1. Result grid row click → ``rowDetail({ columns, values })``. The
//    dialog shows column-name / value pairs, full text, scrollable,
//    with per-cell copy buttons. Solves "I can't see the full value of
//    a truncated cell".
//
// 2. Visual Diff row click → ``rowDetail({ columns, leftValues,
//    rightValues })``. The dialog shows three columns per row — name /
//    L / R — with mismatches highlighted. Lets the user inspect WHY
//    a row was flagged without squinting at truncated cells.
//
// In both modes, control characters are rendered visibly (NUL, TAB,
// etc.) using the helpers from `@/lib/text`.
// ---------------------------------------------------------------------------

export interface RowDetailData {
  rowNumber: number;
  columns: string[];
  values?: (string | number | null)[];        // single-side (result grid)
  leftValues?: (string | number | null)[];    // L row (diff)
  rightValues?: (string | number | null)[];   // R row (diff)
  matches?: boolean[];                        // diff-only: per-cell match flags
  title?: string;                             // override dialog title
}

interface RowDetailDialogProps {
  data: RowDetailData | null;
  onClose: () => void;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      onClick={async () => {
        const ok = await navigator.clipboard?.writeText(value).then(() => true).catch(() => false);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
          toast.success("Copied", { duration: 1200 });
        } else {
          toast.error("Copy failed");
        }
      }}
      className="opacity-40 hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-accent shrink-0"
      title="Copy this value to clipboard"
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function CellContent({ value }: { value: string | number | null | undefined }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground italic text-xs">NULL</span>;
  }
  const s = String(value);
  if (s === "") return <span className="text-muted-foreground italic text-xs">(empty string)</span>;
  return (
    // pre-wrap preserves the user's whitespace + newlines so they can
    // see exactly what's in the cell. break-all so a 200-char URL
    // doesn't blow out the dialog width.
    <span className="font-mono text-xs whitespace-pre-wrap break-all">
      {renderControlChars(s)}
    </span>
  );
}

export function RowDetailDialog({ data, onClose }: RowDetailDialogProps) {
  const isDiff = data?.leftValues !== undefined || data?.rightValues !== undefined;
  const open = data !== null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-hidden flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {data?.title || `Row ${data?.rowNumber ?? ""} detail`}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto scrollbar-thin">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                <th className="px-2 py-1 text-left border-b font-medium text-muted-foreground w-44 whitespace-nowrap">
                  Column
                </th>
                {isDiff ? (
                  <>
                    <th className="px-2 py-1 text-left border-b font-medium text-red-700">
                      L
                    </th>
                    <th className="px-2 py-1 text-left border-b font-medium text-green-700">
                      R
                    </th>
                  </>
                ) : (
                  <th className="px-2 py-1 text-left border-b font-medium">Value</th>
                )}
              </tr>
            </thead>
            <tbody>
              {data?.columns.map((col, i) => {
                const isDiffRow = isDiff && data.matches && data.matches[i] === false;
                if (isDiff) {
                  const lv = data.leftValues?.[i];
                  const rv = data.rightValues?.[i];
                  const lStr = lv == null ? "" : String(lv);
                  const rStr = rv == null ? "" : String(rv);
                  return (
                    <tr key={i} className={cn("border-b align-top", isDiffRow && "bg-yellow-50")}>
                      <td className="px-2 py-1 border-r font-medium text-muted-foreground whitespace-nowrap">
                        {col}
                        {isDiffRow && <span className="ml-1 text-amber-600">●</span>}
                      </td>
                      <td className={cn("px-2 py-1 border-r", isDiffRow && "bg-red-50")}>
                        <div className="flex items-start gap-1">
                          <div className="flex-1 min-w-0"><CellContent value={lv} /></div>
                          {lv != null && lStr !== "" && <CopyButton value={lStr} />}
                        </div>
                      </td>
                      <td className={cn("px-2 py-1", isDiffRow && "bg-green-50")}>
                        <div className="flex items-start gap-1">
                          <div className="flex-1 min-w-0"><CellContent value={rv} /></div>
                          {rv != null && rStr !== "" && <CopyButton value={rStr} />}
                        </div>
                      </td>
                    </tr>
                  );
                }
                // Single-side mode
                const v = data.values?.[i];
                const vStr = v == null ? "" : String(v);
                return (
                  <tr key={i} className="border-b align-top">
                    <td className="px-2 py-1 border-r font-medium text-muted-foreground whitespace-nowrap">
                      {col}
                    </td>
                    <td className="px-2 py-1">
                      <div className="flex items-start gap-1">
                        <div className="flex-1 min-w-0"><CellContent value={v} /></div>
                        {v != null && vStr !== "" && <CopyButton value={vStr} />}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2 border-t pt-2">
          {data && !isDiff && (
            <>
              <button
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border hover:bg-accent transition-colors"
                onClick={() => {
                  const vals = data.columns.map((_, i) => {
                    const v = data.values?.[i];
                    return v === null || v === undefined ? "" : String(v);
                  });
                  navigator.clipboard?.writeText(vals.map((v) => String(v ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).then(() =>
                    toast.success(`Row copied (${data.columns.length} columns, tab-separated)`, { duration: 1500 }),
                  );
                }}
                title="Copy all column values as tab-separated text (paste into Excel/Sheets)"
              >
                <Copy className="h-3 w-3" /> Copy Row (TSV)
              </button>
              <button
                className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded border hover:bg-accent transition-colors"
                onClick={() => {
                  const obj: Record<string, any> = {};
                  data.columns.forEach((col, i) => { obj[col] = data.values?.[i] ?? null; });
                  navigator.clipboard?.writeText(JSON.stringify(obj, null, 2)).then(() =>
                    toast.success("Row copied as JSON", { duration: 1500 }),
                  );
                }}
                title="Copy all column values as a JSON object"
              >
                <Copy className="h-3 w-3" /> Copy Row (JSON)
              </button>
            </>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {isDiff && data?.matches && (
              <>
                {data.matches.filter((m) => !m).length} cell difference
                {data.matches.filter((m) => !m).length === 1 ? "" : "s"} in this row.
              </>
            )}
            {!isDiff && data && <>{data.columns.length} columns</>}
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
