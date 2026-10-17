/**
 * Virtualized result grid (DBeaver / DataGrip style).
 *
 * - only visible rows are in the DOM, so 200k-row results scroll smoothly
 * - fixed-width, resizable columns (drag the header edge; double-click to fit)
 * - spreadsheet selection: click / drag / Shift+click a range, click a header
 *   for a column, the row number for a row, Ctrl+A for all; arrow keys,
 *   Shift+arrows, Home/End, PageUp/PageDown, Ctrl+Home/End move the cursor
 * - Ctrl+C copies the selection as TSV; the context menu has every copy format,
 *   value filters and exports
 * - numbers right-aligned in tabular figures; NULL and control characters
 *   shown explicitly
 * - infinite scroll pulls the next page from the server's in-memory result
 */
import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2 } from "lucide-react";
import { copyToClipboard, downloadBlob, nowStamp, toCsv, toInsert, toJson, toMarkdown, toTsv } from "@/lib/export";
import { renderControlChars, escapeControlCharsPlain } from "@/lib/text";
import { cn, formatNumber } from "@/lib/utils";
import { Menu, type MenuAnchor, type MenuEntry } from "./ui";

export interface ValueFilter {
  col: number;
  op: "eq" | "ne" | "null" | "notnull";
  value?: any;
}

export interface GridSelectionInfo {
  cells: number;
  rows: number;
  cols: number;
  numeric: { count: number; sum: number; min: number; max: number } | null;
  distinct?: number;
  active: { row: any[]; rowIndex: number; col: number; column: string; value: any } | null;
}

interface Props {
  columns: string[];
  rows: any[][];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  quickFilter: string;
  valueFilters: ValueFilter[];
  onAddFilter: (f: ValueFilter) => void;
  onSelectionInfo?: (info: GridSelectionInfo | null) => void;
  onOpenRecord?: (rowIndex: number) => void;
  onToggleValuePanel?: () => void;
  /** Table name to use for "Copy as INSERT". */
  tableName?: string;
  rowHeight?: number;
  fontSize?: number;
}

const ROW_NUM_W = 56;
const DEFAULT_COL_W = 160;
const MIN_COL_W = 48;
const NUMERIC_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

type Cell = { r: number; c: number };

// Column widths survive re-runs of the same query shape.
const widthMemo = new Map<string, number[]>();

function isNull(v: any) {
  return v === null || v === undefined;
}

export function cellText(v: any): string {
  if (isNull(v)) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function compareValues(a: any, b: any): number {
  if (isNull(a) && isNull(b)) return 0;
  if (isNull(a)) return -1;
  if (isNull(b)) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = cellText(a);
  const sb = cellText(b);
  if (NUMERIC_TEXT.test(sa) && NUMERIC_TEXT.test(sb)) return Number(sa) - Number(sb);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
}

function sqlLiteral(v: any): string {
  if (isNull(v)) return "NULL";
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${cellText(v).replace(/'/g, "''")}'`;
}

export const ResultGrid = React.memo(function ResultGrid({
  columns, rows, hasMore, loadingMore, onLoadMore, quickFilter, valueFilters, onAddFilter,
  onSelectionInfo, onOpenRecord, onToggleValuePanel, tableName, rowHeight = 26, fontSize = 12,
}: Props) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const colsKey = columns.join("\u0001");

  // ---- column widths ------------------------------------------------------
  const [widths, setWidths] = React.useState<number[]>(() => widthMemo.get(colsKey) ?? autoWidths(columns, rows));
  React.useEffect(() => {
    setWidths(widthMemo.get(colsKey) ?? autoWidths(columns, rows));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey]);
  React.useEffect(() => {
    widthMemo.set(colsKey, widths);
  }, [colsKey, widths]);
  const template = React.useMemo(() => `${ROW_NUM_W}px ${widths.map((w) => `${w}px`).join(" ")}`, [widths]);
  const totalWidth = React.useMemo(() => ROW_NUM_W + widths.reduce((a, b) => a + b, 0), [widths]);

  // ---- numeric columns (right aligned) -------------------------------------
  const numericCols = React.useMemo(() => {
    const out: boolean[] = columns.map(() => false);
    for (let c = 0; c < columns.length; c++) {
      let seen = 0;
      let numeric = 0;
      for (let r = 0; r < rows.length && seen < 60; r++) {
        const v = rows[r]?.[c];
        if (isNull(v)) continue;
        seen++;
        if (typeof v === "number" || (typeof v === "string" && v.length < 40 && NUMERIC_TEXT.test(v))) numeric++;
      }
      out[c] = seen > 0 && numeric === seen;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colsKey, rows.length > 0]);

  // ---- sort + filter -------------------------------------------------------
  const [sort, setSort] = React.useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  React.useEffect(() => setSort(null), [colsKey]);

  /** Indices into `rows`, in display order. */
  const order = React.useMemo(() => {
    let idx: number[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) idx[i] = i;
    const q = quickFilter.trim().toLowerCase();
    if (q) idx = idx.filter((i) => rows[i].some((v) => !isNull(v) && cellText(v).toLowerCase().includes(q)));
    for (const f of valueFilters) {
      idx = idx.filter((i) => {
        const v = rows[i][f.col];
        switch (f.op) {
          case "null":
            return isNull(v);
          case "notnull":
            return !isNull(v);
          case "eq":
            return !isNull(v) && cellText(v) === cellText(f.value);
          case "ne":
            return isNull(v) || cellText(v) !== cellText(f.value);
        }
      });
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      idx.sort((a, b) => compareValues(rows[a][sort.col], rows[b][sort.col]) * dir || a - b);
    }
    return idx;
  }, [rows, quickFilter, valueFilters, sort]);

  const filtered = order.length !== rows.length;

  // ---- selection -----------------------------------------------------------
  const [anchorCell, setAnchorCell] = React.useState<Cell | null>(null);
  const [focus, setFocus] = React.useState<Cell | null>(null);
  const dragging = React.useRef(false);
  React.useEffect(() => {
    setAnchorCell(null);
    setFocus(null);
  }, [colsKey, quickFilter, valueFilters, sort]);

  const rect = React.useMemo(() => {
    if (!anchorCell || !focus) return null;
    return {
      r1: Math.min(anchorCell.r, focus.r),
      r2: Math.max(anchorCell.r, focus.r),
      c1: Math.min(anchorCell.c, focus.c),
      c2: Math.max(anchorCell.c, focus.c),
    };
  }, [anchorCell, focus]);
  const lastRow = Math.max(0, order.length - 1);
  const lastCol = Math.max(0, columns.length - 1);
  const fullColumns = !!rect && rect.r1 === 0 && rect.r2 === lastRow;
  const fullRows = !!rect && rect.c1 === 0 && rect.c2 === lastCol;

  // Selection summary for the status line / value panel (DBeaver "Calc").
  React.useEffect(() => {
    if (!onSelectionInfo) return;
    if (!rect || !focus) {
      onSelectionInfo(null);
      return;
    }
    const cells = (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
    let numeric: GridSelectionInfo["numeric"] = null;
    let distinct: number | undefined;
    if (cells > 1 && cells <= 500_000) {
      let count = 0, sum = 0, min = Infinity, max = -Infinity;
      const seen = new Set<string>();
      for (let r = rect.r1; r <= rect.r2; r++) {
        const row = rows[order[r]];
        for (let c = rect.c1; c <= rect.c2; c++) {
          const v = row?.[c];
          if (seen.size < 100_001) seen.add(isNull(v) ? "\u0000NULL" : cellText(v));
          const n = typeof v === "number" ? v : typeof v === "string" && NUMERIC_TEXT.test(v) ? Number(v) : NaN;
          if (!Number.isNaN(n)) {
            count++;
            sum += n;
            if (n < min) min = n;
            if (n > max) max = n;
          }
        }
      }
      if (count) numeric = { count, sum, min, max };
      distinct = seen.size;
    }
    const ri = order[focus.r];
    const row = rows[ri];
    onSelectionInfo({
      cells,
      rows: rect.r2 - rect.r1 + 1,
      cols: rect.c2 - rect.c1 + 1,
      numeric,
      distinct,
      active: row ? { row, rowIndex: ri, col: focus.c, column: columns[focus.c], value: row[focus.c] } : null,
    });
  }, [rect, focus, rows, order, columns, onSelectionInfo]);

  // ---- virtualizer -----------------------------------------------------------
  const virtualizer = useVirtualizer({
    count: order.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    // one batched React render per frame instead of a synchronous one per scroll event
    useFlushSync: false,
  });
  React.useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowHeight]);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore || loadingMore || filtered) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < rowHeight * 12) onLoadMore();
  }, [hasMore, loadingMore, filtered, onLoadMore, rowHeight]);

  // Short results never scroll - keep paging until the viewport is filled.
  React.useEffect(() => {
    onScroll();
  }, [rows.length, onScroll]);

  const scrollCellIntoView = React.useCallback(
    (cell: Cell) => {
      virtualizer.scrollToIndex(cell.r, { align: "auto" });
      const el = scrollRef.current;
      if (!el) return;
      let left = ROW_NUM_W;
      for (let c = 0; c < cell.c; c++) left += widths[c];
      const right = left + widths[cell.c];
      if (left - ROW_NUM_W < el.scrollLeft) el.scrollLeft = left - ROW_NUM_W;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [virtualizer, widths],
  );

  // ---- copy helpers ----------------------------------------------------------
  const selectionData = React.useCallback(
    (scope: "selection" | "rows" | "columns" = "selection") => {
      if (!rect) return { cols: [] as string[], rows: [] as any[][] };
      const c1 = scope === "rows" ? 0 : rect.c1;
      const c2 = scope === "rows" ? lastCol : rect.c2;
      const r1 = scope === "columns" ? 0 : rect.r1;
      const r2 = scope === "columns" ? lastRow : rect.r2;
      const out: any[][] = [];
      for (let r = r1; r <= r2; r++) out.push(rows[order[r]].slice(c1, c2 + 1));
      return { cols: columns.slice(c1, c2 + 1), rows: out };
    },
    [rect, rows, order, columns, lastCol, lastRow],
  );

  const copy = React.useCallback(async (text: string, what: string) => {
    if (await copyToClipboard(text)) toast.success(what, { duration: 1400 });
    else toast.error("Copy failed");
  }, []);

  const copyValues = React.useCallback(
    (withHeader: boolean) => {
      const d = selectionData();
      if (!d.rows.length) return;
      const tsv = toTsv(d.cols, d.rows);
      const text = withHeader ? tsv : tsv.split("\n").slice(1).join("\n");
      void copy(text, d.rows.length * d.cols.length === 1 ? "Copied value" : `Copied ${formatNumber(d.rows.length)} × ${d.cols.length}`);
    },
    [selectionData, copy],
  );

  // ---- keyboard ---------------------------------------------------------------
  const moveTo = React.useCallback(
    (cell: Cell, extend: boolean) => {
      const next = { r: Math.max(0, Math.min(lastRow, cell.r)), c: Math.max(0, Math.min(lastCol, cell.c)) };
      if (!extend || !anchorCell) setAnchorCell(next);
      setFocus(next);
      scrollCellIntoView(next);
    },
    [anchorCell, lastRow, lastCol, scrollCellIntoView],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const mod = e.ctrlKey || e.metaKey;
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / rowHeight) - 2);
    const cur = focus ?? { r: 0, c: 0 };
    const k = e.key;
    if (mod && (k === "a" || k === "A")) {
      e.preventDefault();
      if (!order.length) return;
      setAnchorCell({ r: 0, c: 0 });
      setFocus({ r: lastRow, c: lastCol });
      return;
    }
    if (mod && (k === "c" || k === "C")) {
      if (!rect) return;
      e.preventDefault();
      copyValues(e.shiftKey);
      return;
    }
    if (k === "Escape") {
      setAnchorCell(null);
      setFocus(null);
      return;
    }
    if (!order.length) return;
    const nav: Record<string, () => Cell> = {
      ArrowDown: () => ({ r: mod ? lastRow : cur.r + 1, c: cur.c }),
      ArrowUp: () => ({ r: mod ? 0 : cur.r - 1, c: cur.c }),
      ArrowRight: () => ({ r: cur.r, c: mod ? lastCol : cur.c + 1 }),
      ArrowLeft: () => ({ r: cur.r, c: mod ? 0 : cur.c - 1 }),
      PageDown: () => ({ r: cur.r + pageRows, c: cur.c }),
      PageUp: () => ({ r: cur.r - pageRows, c: cur.c }),
      Home: () => (mod ? { r: 0, c: 0 } : { r: cur.r, c: 0 }),
      End: () => (mod ? { r: lastRow, c: lastCol } : { r: cur.r, c: lastCol }),
      Tab: () => ({ r: cur.r, c: e.shiftKey ? cur.c - 1 : cur.c + 1 }),
    };
    if (nav[k]) {
      e.preventDefault();
      moveTo(nav[k](), e.shiftKey && k !== "Tab");
      return;
    }
    if (k === "Enter" && focus) {
      e.preventDefault();
      onOpenRecord?.(order[focus.r]);
    }
  };

  // ---- pointer -------------------------------------------------------------------
  const cellFromEvent = (target: EventTarget | null): Cell | null => {
    const el = (target as HTMLElement | null)?.closest?.("[data-r]") as HTMLElement | null;
    if (!el) return null;
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    return Number.isNaN(r) || Number.isNaN(c) ? null : { r, c };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const cell = cellFromEvent(e.target);
    if (!cell) return;
    scrollRef.current?.focus({ preventScroll: true });
    if (e.shiftKey && anchorCell) setFocus(cell);
    else {
      setAnchorCell(cell);
      setFocus(cell);
      dragging.current = true;
    }
  };
  const onMouseOver = (e: React.MouseEvent) => {
    if (!dragging.current) return;
    const cell = cellFromEvent(e.target);
    if (cell) setFocus(cell);
  };
  React.useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const selectColumn = (c: number, extend: boolean) => {
    if (!order.length) return;
    const startC = extend && anchorCell ? anchorCell.c : c;
    setAnchorCell({ r: 0, c: startC });
    setFocus({ r: lastRow, c });
    scrollRef.current?.focus({ preventScroll: true });
  };
  const selectRow = (r: number, extend: boolean) => {
    const startR = extend && anchorCell ? anchorCell.r : r;
    setAnchorCell({ r: startR, c: 0 });
    setFocus({ r, c: lastCol });
    scrollRef.current?.focus({ preventScroll: true });
  };

  // ---- resize ------------------------------------------------------------------
  const resizeRef = React.useRef<{ c: number; x: number; w: number } | null>(null);
  const fitColumn = (c: number) => {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    let max = ctx.measureText(columns[c]).width + 44;
    for (let i = 0; i < Math.min(order.length, 300); i++) {
      const v = rows[order[i]][c];
      max = Math.max(max, ctx.measureText(isNull(v) ? "NULL" : cellText(v).slice(0, 200)).width + 22);
    }
    setWidths((w) => w.map((x, i) => (i === c ? Math.min(800, Math.max(MIN_COL_W, Math.ceil(max))) : x)));
  };

  // ---- context menu ------------------------------------------------------------
  const [menu, setMenu] = React.useState<MenuAnchor | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    const header = (e.target as HTMLElement).closest("[data-hc]") as HTMLElement | null;
    const cell = cellFromEvent(e.target);
    if (cell) {
      const inside = rect && cell.r >= rect.r1 && cell.r <= rect.r2 && cell.c >= rect.c1 && cell.c <= rect.c2;
      if (!inside) {
        setAnchorCell(cell);
        setFocus(cell);
      }
    } else if (header) {
      const c = Number(header.dataset.hc);
      const inside = rect && fullColumns && c >= rect.c1 && c <= rect.c2;
      if (!inside) selectColumn(c, false);
    } else return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const menuEntries = (): MenuEntry[] => {
    if (!rect || !focus) return [];
    const d = selectionData();
    const value = rows[order[focus.r]]?.[focus.c];
    const colName = columns[focus.c];
    const single = d.rows.length * d.cols.length === 1;
    const colVals = () => {
      const vals: any[] = [];
      const seen = new Set<string>();
      for (const r of selectionData("selection").rows) {
        for (const v of r) {
          const k = isNull(v) ? "\u0000" : cellText(v);
          if (!seen.has(k) && !isNull(v)) {
            seen.add(k);
            vals.push(v);
          }
        }
      }
      return vals;
    };
    const entries: MenuEntry[] = [
      { label: single ? "Copy value" : "Copy", shortcut: "Mod-c", onSelect: () => copyValues(false) },
      { label: "Copy with column names", shortcut: "Mod-Shift-c", onSelect: () => copyValues(true) },
      { kind: "heading", label: "Copy as" },
      { label: "CSV", onSelect: () => void copy(toCsv(d.cols, d.rows), "Copied as CSV") },
      { label: "JSON", onSelect: () => void copy(toJson(d.cols, d.rows), "Copied as JSON") },
      { label: "Markdown table", onSelect: () => void copy(toMarkdown(d.cols, d.rows), "Copied as Markdown") },
      {
        label: "SQL INSERT statements",
        onSelect: () => {
          const full = selectionData(fullRows ? "rows" : "selection");
          void copy(toInsert(full.cols, full.rows, tableName || "table_name"), `Copied ${full.rows.length} INSERT statement(s)`);
        },
      },
      {
        label: "SQL IN list",
        title: "('a', 'b', 'c') - distinct selected values",
        onSelect: () => void copy(`(${colVals().map(sqlLiteral).join(", ")})`, "Copied IN list"),
      },
      {
        label: "WHERE condition",
        title: "col = value AND … for the active row's selected columns",
        onSelect: () => {
          const row = rows[order[focus.r]];
          const parts: string[] = [];
          for (let c = rect.c1; c <= rect.c2; c++) {
            const v = row[c];
            parts.push(isNull(v) ? `${columns[c]} IS NULL` : `${columns[c]} = ${sqlLiteral(v)}`);
          }
          void copy(parts.join("\n  AND "), "Copied WHERE condition");
        },
      },
      { kind: "heading", label: "Column names" },
      { label: "Comma separated", onSelect: () => void copy(d.cols.join(", "), "Copied column names") },
      { label: "One per line", onSelect: () => void copy(d.cols.join("\n"), "Copied column names") },
      {
        label: "SELECT list",
        onSelect: () => void copy(`SELECT ${d.cols.join(",\n       ")}\nFROM ${tableName || ""}`, "Copied SELECT list"),
      },
      { kind: "separator" },
      {
        label: isNull(value) ? `Filter: ${colName} IS NULL` : `Filter: ${colName} = ${truncate(cellText(value), 30)}`,
        onSelect: () => onAddFilter(isNull(value) ? { col: focus.c, op: "null" } : { col: focus.c, op: "eq", value }),
      },
      {
        label: isNull(value) ? `Filter: ${colName} IS NOT NULL` : `Filter: ${colName} <> ${truncate(cellText(value), 30)}`,
        onSelect: () => onAddFilter(isNull(value) ? { col: focus.c, op: "notnull" } : { col: focus.c, op: "ne", value }),
      },
      { kind: "separator" },
      { label: "Open in record view", shortcut: "Enter", onSelect: () => onOpenRecord?.(order[focus.r]) },
      { label: "Value panel", shortcut: "F7", onSelect: () => onToggleValuePanel?.() },
      {
        label: "Sort ascending",
        onSelect: () => setSort({ col: focus.c, dir: "asc" }),
      },
      { label: "Sort descending", onSelect: () => setSort({ col: focus.c, dir: "desc" }) },
      ...(sort ? [{ label: "Clear sort", onSelect: () => setSort(null) } as MenuEntry] : []),
      { kind: "separator" },
      {
        label: "Export selection to CSV…",
        onSelect: () => {
          downloadBlob(toCsv(d.cols, d.rows), `selection_${nowStamp()}.csv`, "text/csv");
          toast.success("Selection exported");
        },
      },
      {
        label: "Select all",
        shortcut: "Mod-a",
        onSelect: () => {
          setAnchorCell({ r: 0, c: 0 });
          setFocus({ r: lastRow, c: lastCol });
        },
      },
    ];
    return entries;
  };

  const cycleSort = (c: number) =>
    setSort((s) => (!s || s.col !== c ? { col: c, dir: "asc" } : s.dir === "asc" ? { col: c, dir: "desc" } : null));

  const items = virtualizer.getVirtualItems();
  const cellPad = fontSize >= 14 ? "px-2.5" : "px-2";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="grid"
        aria-rowcount={order.length}
        aria-colcount={columns.length}
        className="min-h-0 flex-1 select-none overflow-auto outline-none scrollbar-thin focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40 focus-visible:ring-offset-0"
        style={{ fontSize }}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
        onMouseOver={onMouseOver}
        onContextMenu={onContextMenu}
        onDoubleClick={(e) => {
          const cell = cellFromEvent(e.target);
          if (!cell) return;
          const v = rows[order[cell.r]]?.[cell.c];
          void copy(isNull(v) ? "NULL" : cellText(v), "Copied value");
        }}
      >
        {/* header */}
        <div
          className="sticky top-0 z-20 grid border-b bg-muted/95 font-medium backdrop-blur supports-[backdrop-filter]:bg-muted/80"
          style={{ gridTemplateColumns: template, width: totalWidth, minWidth: "100%", height: rowHeight + 2 }}
          role="row"
        >
          <div
            className="sticky left-0 z-10 flex cursor-pointer items-center justify-center border-r bg-muted text-[10px] text-muted-foreground hover:text-foreground"
            title="Select all (Ctrl+A)"
            onClick={() => {
              if (!order.length) return;
              setAnchorCell({ r: 0, c: 0 });
              setFocus({ r: lastRow, c: lastCol });
              scrollRef.current?.focus({ preventScroll: true });
            }}
          >
            {filtered ? `${formatNumber(order.length)}` : "#"}
          </div>
          {columns.map((name, c) => {
            const selected = fullColumns && rect && c >= rect.c1 && c <= rect.c2;
            const sorted = sort?.col === c ? sort.dir : null;
            return (
              <div
                key={c}
                data-hc={c}
                role="columnheader"
                aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                className={cn(
                  "group relative flex min-w-0 cursor-pointer select-none items-center gap-1 border-r",
                  cellPad,
                  selected && "bg-primary/15",
                  numericCols[c] && "flex-row-reverse text-right",
                )}
                title={`${name}\nClick: select column · Shift+click: extend · ↕ sorts`}
                onClick={(e) => selectColumn(c, e.shiftKey)}
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`Sort by ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    cycleSort(c);
                  }}
                  className={cn(
                    "shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                    !sorted && "opacity-0 group-hover:opacity-100",
                    sorted && "text-primary",
                  )}
                >
                  {sorted === "asc" ? <ArrowUp className="h-3 w-3" /> : sorted === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3" />}
                </button>
                <div
                  className="dv-resize-handle absolute -right-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    fitColumn(c);
                  }}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    resizeRef.current = { c, x: e.clientX, w: widths[c] };
                  }}
                  onPointerMove={(e) => {
                    const d = resizeRef.current;
                    if (!d) return;
                    const w = Math.max(MIN_COL_W, d.w + e.clientX - d.x);
                    setWidths((ws) => (ws[d.c] === w ? ws : ws.map((x, i) => (i === d.c ? w : x))));
                  }}
                  onPointerUp={() => (resizeRef.current = null)}
                />
              </div>
            );
          })}
        </div>

        {/* body */}
        <div style={{ height: virtualizer.getTotalSize(), width: totalWidth, minWidth: "100%", position: "relative" }}>
          {items.map((vr) => {
            const r = vr.index;
            const ri = order[r];
            const row = rows[ri];
            if (!row) return null;
            const rowSel = !!rect && r >= rect.r1 && r <= rect.r2;
            return (
              <div
                key={vr.key}
                role="row"
                className={cn("absolute left-0 top-0 grid border-b border-border/60", r % 2 === 1 && "bg-muted/25")}
                style={{
                  transform: `translateY(${vr.start}px)`,
                  height: rowHeight,
                  gridTemplateColumns: template,
                  width: totalWidth,
                  minWidth: "100%",
                }}
              >
                <div
                  className={cn(
                    "sticky left-0 z-10 flex cursor-pointer select-none items-center justify-end border-r bg-background pr-2 font-mono text-[11px] tabular-nums text-muted-foreground hover:text-foreground",
                    rowSel && fullRows && "bg-primary/15 text-foreground",
                    rowSel && !fullRows && "text-foreground",
                  )}
                  onClick={(e) => selectRow(r, e.shiftKey)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onOpenRecord?.(ri);
                  }}
                  title="Click: select row · Double-click: record view"
                >
                  {ri + 1}
                </div>
                {row.map((v, c) => {
                  const inSel = rowSel && c >= rect!.c1 && c <= rect!.c2;
                  const isFocus = focus?.r === r && focus?.c === c;
                  const nul = isNull(v);
                  const text = nul ? "" : cellText(v);
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      data-r={r}
                      data-c={c}
                      className={cn(
                        "flex min-w-0 cursor-cell items-center overflow-hidden whitespace-pre border-r border-border/60 font-mono",
                        cellPad,
                        numericCols[c] && "justify-end tabular-nums",
                        nul && "italic text-muted-foreground/70",
                        typeof v === "boolean" && "text-[hsl(var(--primary))]",
                        inSel && "bg-primary/15",
                        isFocus && "dv-grid-cell-active",
                      )}
                      title={nul ? "NULL" : text.length > 60 || text.includes("\n") ? escapeControlCharsPlain(text.slice(0, 2000)) : undefined}
                    >
                      <span className="overflow-hidden text-ellipsis" style={{ whiteSpace: "pre" }}>
                        {nul ? "NULL" : renderControlChars(text.length > 1000 ? text.slice(0, 1000) + "…" : text)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {(hasMore || loadingMore) && !filtered && (
          <div
            className="sticky left-0 flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
            style={{ width: "100%" }}
          >
            {loadingMore ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {loadingMore ? "Loading more rows…" : "Scroll for more rows"}
          </div>
        )}
        {order.length === 0 && rows.length > 0 && (
          <div className="sticky left-0 px-3 py-6 text-center text-xs text-muted-foreground">No loaded rows match the filter.</div>
        )}
      </div>
      {menu && <Menu anchor={menu} entries={menuEntries()} onClose={() => setMenu(null)} minWidth={250} />}
    </div>
  );
});

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function autoWidths(columns: string[], rows: any[][]): number[] {
  // Few columns (query plans, key/value results) may use much more width.
  const cap = columns.length <= 2 ? 960 : columns.length <= 4 ? 520 : 360;
  return columns.map((name, c) => {
    let max = name.length * 7.5 + 40;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const v = rows[i]?.[c];
      const len = isNull(v) ? 4 : Math.min(160, cellText(v).length);
      max = Math.max(max, len * 7.3 + 20);
    }
    return Math.round(Math.min(cap, Math.max(72, max || DEFAULT_COL_W)));
  });
}
