"""Excel report generator for a Data Validator run.

Produces a multi-sheet ``.xlsx`` workbook summarising a comparison:

    * Summary           - verdict, source/target identity, timings, options
    * Schema Diff       - common columns / only-in-X / type mismatches
    * Fingerprint       - row counts, min/max hash, bucket histogram diff
    * Column Stats      - per-column source-vs-target side-by-side
    * Row Diff Summary  - strategy, counts
    * Only in Source    - sample of rows present only on the source side
    * Only in Target    - sample of rows present only on the target side
    * Hash Diff (S/T)   - sample rows where the key matched but the hash didn't
    * Logs              - timestamped backend log lines

The workbook is built with ``xlsxwriter`` in ``in_memory`` mode so the entire
report streams from RAM with no temp files - friendly for both the streaming
HTTP response and very large tables.
"""
from __future__ import annotations

import io
from typing import Any, Iterable

import xlsxwriter  # type: ignore


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def build_excel_report(result: dict) -> bytes:
    """Render a CompareResult dict into an in-memory ``.xlsx`` byte string."""
    buf = io.BytesIO()
    # nan_inf_to_errors: write NaN / Inf as #NUM! cells instead of crashing.
    # DuckDB / Pandas / Spark engines can produce NaN avg_val for columns
    # that are all-null or all-non-numeric; without this option, write_number
    # raises and the whole Excel build fails.
    wb = xlsxwriter.Workbook(buf, {
        "in_memory": True,
        "constant_memory": False,
        "nan_inf_to_errors": True,
        "strings_to_formulas": False,
        "strings_to_urls": False,
    })
    f = _Formats(wb)

    _write_summary(wb, f, result)
    _write_schema(wb, f, result)
    _write_fingerprint(wb, f, result)
    _write_column_stats(wb, f, result)
    _write_row_diff(wb, f, result)
    _write_logs(wb, f, result)

    wb.close()
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------

class _Formats:
    def __init__(self, wb: xlsxwriter.Workbook):
        self.title       = wb.add_format({"bold": True, "font_size": 16, "font_color": "#111827"})
        self.subtitle    = wb.add_format({"italic": True, "font_color": "#6b7280"})
        self.section     = wb.add_format({"bold": True, "font_size": 12, "font_color": "#111827",
                                          "bottom": 2, "border_color": "#1f2937"})
        self.header      = wb.add_format({"bold": True, "bg_color": "#1f2937", "font_color": "white",
                                          "border": 1, "border_color": "#374151", "align": "center"})
        self.label       = wb.add_format({"bold": True, "bg_color": "#f3f4f6", "border": 1,
                                          "border_color": "#e5e7eb"})
        self.cell        = wb.add_format({"border": 1, "border_color": "#e5e7eb",
                                          "text_wrap": True, "valign": "top"})
        self.cell_mono   = wb.add_format({"border": 1, "border_color": "#e5e7eb",
                                          "font_name": "Consolas", "text_wrap": True, "valign": "top"})
        self.num         = wb.add_format({"border": 1, "border_color": "#e5e7eb",
                                          "num_format": "#,##0"})
        self.match_ok    = wb.add_format({"bold": True, "bg_color": "#dcfce7",
                                          "font_color": "#166534", "align": "center", "border": 1})
        self.match_bad   = wb.add_format({"bold": True, "bg_color": "#fee2e2",
                                          "font_color": "#991b1b", "align": "center", "border": 1})
        self.match_warn  = wb.add_format({"bold": True, "bg_color": "#fef3c7",
                                          "font_color": "#92400e", "align": "center", "border": 1})
        # Neutral grey "informational" - used for diagnostic-only fields
        # that aren't part of the match verdict (e.g. Min/Max hash, which
        # converge to deterministic extremes on large tables regardless
        # of content).
        self.match_info  = wb.add_format({"italic": True, "bg_color": "#f3f4f6",
                                          "font_color": "#6b7280", "align": "center", "border": 1})


# ---------------------------------------------------------------------------
# Sheets
# ---------------------------------------------------------------------------

def _write_summary(wb, f: _Formats, r: dict) -> None:
    ws = wb.add_worksheet("Summary")
    ws.set_column(0, 0, 28)
    ws.set_column(1, 1, 90)

    ws.write(0, 0, "Data Validator - Comparison Report", f.title)
    ws.write(1, 0, "Generated from a run captured by Data Validator", f.subtitle)

    verdict = r.get("verdict") or r.get("status") or "?"
    status  = r.get("status") or "?"
    verdict_fmt = f.match_ok if verdict == "MATCH" else f.match_bad if verdict == "MISMATCH" \
        else f.match_warn

    engine_name = r.get("engine") or (r.get("row_diff") or {}).get("strategy", "").split("_")[0] or "standard"

    rows: list[tuple[str, Any, Any]] = [
        ("Verdict",        verdict, verdict_fmt),
        ("Status",         status,  f.cell),
        ("Engine",         engine_name, f.cell_mono),
        ("Run UUID",       r.get("run_uuid"),       f.cell_mono),
        ("Started",        r.get("started_at"),     f.cell_mono),
        ("Finished",       r.get("finished_at"),    f.cell_mono),
        ("Elapsed (ms)",   r.get("elapsed_ms") or 0, f.num),
        ("",               "",                      f.cell),
        ("Source label",   _g(r, "source", "label"),   f.cell_mono),
        ("Source DB type", _g(r, "source", "db_type"), f.cell),
        ("Source rows",    _g(r, "source", "row_count") or 0, f.num),
        ("Target label",   _g(r, "target", "label"),   f.cell_mono),
        ("Target DB type", _g(r, "target", "db_type"), f.cell),
        ("Target rows",    _g(r, "target", "row_count") or 0, f.num),
    ]
    if r.get("error"):
        rows.append(("Error", str(r["error"])[:1000], f.cell))

    row = 3
    ws.write(row, 0, "Run", f.section)
    ws.write(row, 1, "", f.section)
    row += 1
    for label, value, fmt in rows:
        ws.write(row, 0, label, f.label)
        ws.write(row, 1, "" if value is None else value, fmt)
        row += 1

    # Highlight notable modes (incremental / bucket sampling / manual mapping)
    # up-front so whoever opens the report sees them without scrolling.
    opts = r.get("options") or {}
    notable: list[tuple[str, Any]] = []
    if opts.get("column_mapping_mode") == "manual":
        cm = opts.get("column_map") or []
        n_keys = sum(1 for p in cm if (p.get("role") or "").lower() == "key")
        notable.append((
            "Column mapping",
            f"Manual ({len(cm)} pair{'s' if len(cm)!=1 else ''}, {n_keys} key)",
        ))
    if opts.get("incremental_column"):
        notable.append((
            "Mode",
            f"Incremental on {opts['incremental_column']} since {opts.get('since')!r}",
        ))
    if opts.get("row_diff_buckets"):
        buckets = opts["row_diff_buckets"]
        pct = int(len(buckets) / 16 * 100) if isinstance(buckets, list) else "?"
        notable.append((
            "Row-diff buckets",
            f"{buckets}  ({pct}% of row space)",
        ))
    if notable:
        row += 1
        ws.write(row, 0, "Notable options", f.section)
        ws.write(row, 1, "", f.section)
        row += 1
        for label, value in notable:
            ws.write(row, 0, label, f.label)
            ws.write(row, 1, value, f.match_warn)
            row += 1

    row += 1
    ws.write(row, 0, "Options", f.section); ws.write(row, 1, "", f.section); row += 1
    for k, v in (r.get("options") or {}).items():
        ws.write(row, 0, k, f.label)
        ws.write(row, 1, _scalar(v), f.cell)
        row += 1

    ws.freeze_panes(3, 0)


def _write_schema(wb, f: _Formats, r: dict) -> None:
    sd = r.get("schema_diff") or {}
    ws = wb.add_worksheet("Schema Diff")
    ws.set_column(0, 0, 36)
    ws.set_column(1, 3, 24)

    row = 0
    ws.write(row, 0, "Schema Diff", f.title); row += 2

    is_match = bool(sd.get("is_match"))
    ws.write(row, 0, "Schema match", f.label)
    ws.write(row, 1, "YES" if is_match else "NO", f.match_ok if is_match else f.match_bad)
    row += 2

    # Common columns (expanded with length, precision, nullable for both sides)
    common = sd.get("common_columns") or []
    ws.write(row, 0, f"Common columns ({len(common)})", f.section); row += 1
    if common:
        headers = ["Column", "Src Type", "Tgt Type", "Src Nullable", "Tgt Nullable",
                   "Src Length", "Tgt Length", "Src Precision", "Tgt Precision",
                   "Src Scale", "Tgt Scale", "Group"]
        ws.write_row(row, 0, headers, f.header); row += 1
        for ci, c in enumerate(headers):
            ws.set_column(ci, ci, 16 if ci > 0 else 28)
        for c in common:
            tg = "numeric" if c.get("is_numeric") else "temporal" if c.get("is_temporal") \
                else "string" if c.get("is_string") else "other"
            s_type = c.get("data_type") or ""
            t_type = c.get("target_data_type") or s_type
            s_null = c.get("nullable")
            t_null = c.get("target_nullable", s_null)
            type_ok = s_type == t_type or (s_type.upper().split("(")[0] == t_type.upper().split("(")[0])
            null_ok = s_null == t_null or s_null is None or t_null is None
            ws.write(row, 0, c.get("name"), f.cell_mono)
            ws.write(row, 1, s_type, f.cell)
            ws.write(row, 2, t_type, f.cell if type_ok else f.match_bad)
            ws.write(row, 3, "YES" if s_null else "NO", f.cell)
            ws.write(row, 4, "YES" if t_null else "NO", f.cell if null_ok else f.match_bad)
            ws.write(row, 5, _scalar(c.get("char_max_length")), f.num if c.get("char_max_length") else f.cell)
            ws.write(row, 6, _scalar(c.get("target_char_max_length")),
                     f.num if c.get("target_char_max_length") else f.cell)
            ws.write(row, 7, _scalar(c.get("numeric_precision")), f.num if c.get("numeric_precision") else f.cell)
            ws.write(row, 8, _scalar(c.get("target_numeric_precision")),
                     f.num if c.get("target_numeric_precision") else f.cell)
            ws.write(row, 9, _scalar(c.get("numeric_scale")), f.num if c.get("numeric_scale") else f.cell)
            ws.write(row, 10, _scalar(c.get("target_numeric_scale")),
                     f.num if c.get("target_numeric_scale") else f.cell)
            ws.write(row, 11, tg, f.cell)
            row += 1
    row += 1

    # Only in source / target
    for title, key in (("Only in source", "only_in_source"), ("Only in target", "only_in_target")):
        items = sd.get(key) or []
        ws.write(row, 0, f"{title} ({len(items)})", f.section); row += 1
        if items:
            ws.write_row(row, 0, ["Column"], f.header); row += 1
            for c in items:
                ws.write(row, 0, c, f.cell_mono); row += 1
        row += 1

    # Type mismatches
    tm = sd.get("type_mismatches") or []
    ws.write(row, 0, f"Type mismatches ({len(tm)})", f.section); row += 1
    if tm:
        ws.write_row(row, 0, ["Column", "Source type", "Target type"], f.header); row += 1
        for m in tm:
            ws.write(row, 0, m.get("column"),     f.cell_mono)
            ws.write(row, 1, m.get("source_type"), f.cell)
            ws.write(row, 2, m.get("target_type"), f.cell)
            row += 1
    row += 1

    # Nullable mismatches
    nm = sd.get("nullable_mismatches") or []
    ws.write(row, 0, f"Nullable mismatches ({len(nm)})", f.section); row += 1
    if nm:
        ws.write_row(row, 0, ["Column", "Source nullable", "Target nullable"], f.header); row += 1
        for m in nm:
            ws.write(row, 0, m.get("column"),          f.cell_mono)
            ws.write(row, 1, "YES" if m.get("source_nullable") else "NO", f.cell)
            ws.write(row, 2, "YES" if m.get("target_nullable") else "NO", f.match_bad)
            row += 1
    row += 1

    # Length / precision / scale mismatches
    lm = sd.get("length_mismatches") or []
    ws.write(row, 0, f"Length/precision mismatches ({len(lm)})", f.section); row += 1
    if lm:
        ws.write_row(row, 0, ["Column", "Property", "Source", "Target"], f.header); row += 1
        for m in lm:
            col = m.get("column", "")
            for prop in ("char_max_length", "numeric_precision", "numeric_scale"):
                if prop in m:
                    ws.write(row, 0, col, f.cell_mono)
                    ws.write(row, 1, prop.replace("_", " "), f.cell)
                    ws.write(row, 2, m[prop].get("source"), f.num)
                    ws.write(row, 3, m[prop].get("target"), f.match_bad)
                    row += 1

    ws.freeze_panes(1, 0)


def _write_fingerprint(wb, f: _Formats, r: dict) -> None:
    fp_diff = r.get("fingerprint_diff") or {}
    src_fp = _g(r, "source", "fingerprint") or {}
    tgt_fp = _g(r, "target", "fingerprint") or {}

    ws = wb.add_worksheet("Fingerprint")
    ws.set_column(0, 0, 22)
    ws.set_column(1, 4, 18)

    row = 0
    ws.write(row, 0, "Fingerprint", f.title); row += 2

    is_match = bool(fp_diff.get("is_match"))
    ws.write(row, 0, "Overall fingerprint", f.label)
    ws.write(row, 1, "MATCH" if is_match else "MISMATCH", f.match_ok if is_match else f.match_bad)
    row += 2

    ws.write_row(row, 0, ["Metric", "Source", "Target", "Match"], f.header); row += 1
    # Row count is part of the match decision. Min/Max hash are NOT
    # (they converge to 0x00.../0xff... on large tables regardless of
    # content) - render them as INFO with a grey italic indicator so
    # the report no longer implies they vote on MATCH/MISMATCH.
    METRICS = [
        ("Row count", "row_count", False),    # informational=False -> green/red
        ("Min hash",  "min_hash",  True),     # informational=True  -> grey info
        ("Max hash",  "max_hash",  True),
    ]
    for label, key, informational in METRICS:
        s = src_fp.get(key)
        t = tgt_fp.get(key)
        is_num = isinstance(s, (int, float)) and isinstance(t, (int, float))
        cell_fmt = f.num if is_num else f.cell_mono
        ws.write(row, 0, label + ("  (info)" if informational else ""), f.label)
        ws.write(row, 1, _scalar(s), cell_fmt)
        ws.write(row, 2, _scalar(t), cell_fmt)
        if informational:
            # No verdict; just mark as informational regardless of whether
            # the values happen to match.
            ws.write(row, 3, "INFO", f.match_info)
        else:
            ws.write(row, 3, "YES" if s == t else "NO",
                     f.match_ok if s == t else f.match_bad)
        row += 1
    # Brief note explaining the INFO rows
    ws.write(row, 0,
             "Min/Max hash are diagnostic only - for large tables they always "
             "converge to 00.../ff... and are NOT used to determine MATCH.",
             f.subtitle)
    row += 2

    # Bucket histogram diff
    ws.write(row, 0, "16-bucket histogram (first hex of row hash)", f.section); row += 1
    ws.write_row(row, 0, ["Bucket", "Source", "Target", "Delta", "Match"], f.header); row += 1
    s_buckets = src_fp.get("buckets") or {}
    t_buckets = tgt_fp.get("buckets") or {}
    for c in "0123456789abcdef":
        k = f"b_{c}"
        s = int(s_buckets.get(k) or 0)
        t = int(t_buckets.get(k) or 0)
        ws.write(row, 0, k, f.cell_mono)
        ws.write(row, 1, s, f.num)
        ws.write(row, 2, t, f.num)
        ws.write(row, 3, t - s, f.num)
        ws.write(row, 4, "YES" if s == t else "NO", f.match_ok if s == t else f.match_bad)
        row += 1

    ws.freeze_panes(1, 0)


def _write_column_stats(wb, f: _Formats, r: dict) -> None:
    stats = r.get("column_stats")
    ws = wb.add_worksheet("Column Stats")
    if not stats:
        ws.write(0, 0, "Column statistics were not computed for this run.", f.subtitle)
        return

    headers = [
        "Column", "Data type", "Match",
        "Src non-null", "Tgt non-null",
        "Src nulls",    "Tgt nulls",
        "Src distinct", "Tgt distinct",
        "Src min",      "Tgt min",
        "Src max",      "Tgt max",
        "Src avg",      "Tgt avg",
    ]
    widths  = [28, 18, 8, 14, 14, 12, 12, 14, 14, 18, 18, 18, 18, 14, 14]
    for i, w in enumerate(widths):
        ws.set_column(i, i, w)

    ws.write_row(0, 0, headers, f.header)
    row = 1
    for s in stats:
        src = s.get("source") or {}
        tgt = s.get("target") or {}
        match = bool(s.get("match"))
        ws.write(row, 0, s.get("name"),       f.cell_mono)
        ws.write(row, 1, s.get("data_type") or "", f.cell)
        ws.write(row, 2, "YES" if match else "NO", f.match_ok if match else f.match_bad)
        ws.write(row, 3, src.get("non_null_count") or 0, f.num)
        ws.write(row, 4, tgt.get("non_null_count") or 0, f.num)
        ws.write(row, 5, src.get("null_count") or 0,     f.num)
        ws.write(row, 6, tgt.get("null_count") or 0,     f.num)
        ws.write(row, 7, src.get("distinct_count") or 0, f.num)
        ws.write(row, 8, tgt.get("distinct_count") or 0, f.num)
        ws.write(row, 9,  _scalar(src.get("min_val")), f.cell_mono)
        ws.write(row, 10, _scalar(tgt.get("min_val")), f.cell_mono)
        ws.write(row, 11, _scalar(src.get("max_val")), f.cell_mono)
        ws.write(row, 12, _scalar(tgt.get("max_val")), f.cell_mono)
        ws.write(row, 13, _scalar(src.get("avg_val")), f.cell)
        ws.write(row, 14, _scalar(tgt.get("avg_val")), f.cell)
        row += 1

    ws.freeze_panes(1, 1)
    ws.autofilter(0, 0, row - 1, len(headers) - 1)


def _write_row_diff(wb, f: _Formats, r: dict) -> None:
    rd = r.get("row_diff") or {}

    # Summary sheet
    ws = wb.add_worksheet("Row Diff Summary")
    ws.set_column(0, 0, 32); ws.set_column(1, 1, 32)
    ws.write(0, 0, "Row Diff Summary", f.title)
    row = 2
    if not rd or rd.get("strategy") == "skipped":
        ws.write(row, 0, "Row diff was skipped for this run.", f.subtitle)
        reason = rd.get("reason") if rd else None
        if reason:
            ws.write(row + 1, 0, f"Reason: {reason}", f.subtitle)
        return

    pairs = [
        ("Strategy",                rd.get("strategy")),
        ("Skipped",                 rd.get("skipped")),
        ("Skip reason",             rd.get("reason")),
        ("Fallback reason",         rd.get("fallback_reason")),
        ("Key columns",             ", ".join(rd.get("key_columns") or [])),
        ("Compared columns",        ", ".join(rd.get("compared_columns") or [])),
        ("Only in source (count)",  rd.get("only_in_source_count")),
        ("Only in target (count)",  rd.get("only_in_target_count")),
        ("Key match, hash diff",    rd.get("key_match_hash_diff_count")),
        ("Matching rows",           rd.get("matching_count")),
    ]
    for k, v in pairs:
        if v in (None, ""):
            continue
        ws.write(row, 0, k, f.label)
        ws.write(row, 1, _scalar(v), f.num if isinstance(v, (int, float)) else f.cell)
        row += 1

    if "source_sql" in rd or "diff_sql" in rd:
        row += 1
        ws.write(row, 0, "SQL", f.section); ws.write(row, 1, "", f.section); row += 1
        for k in ("source_sql", "target_sql", "diff_sql"):
            v = rd.get(k)
            if v:
                ws.write(row, 0, k, f.label)
                ws.write(row, 1, v, f.cell_mono)
                row += 1

    # Sample sheets
    samples = rd.get("samples") or {}
    sheet_specs = [
        ("Only in Source",      "only_in_source"),
        ("Only in Target",      "only_in_target"),
        ("Hash Diff (Source)",  "key_match_hash_diff_source"),
        ("Hash Diff (Target)",  "key_match_hash_diff_target"),
    ]
    for sheet_name, key in sheet_specs:
        rows = samples.get(key) or []
        _write_rows_sheet(wb, f, sheet_name, rows)


def _write_rows_sheet(wb, f: _Formats, name: str, rows: list[dict]) -> None:
    ws = wb.add_worksheet(name[:31])  # Excel limit
    if not rows:
        ws.write(0, 0, f"No {name.lower()} rows.", f.subtitle)
        return

    # Build header from union of dict keys (stable order: first row's keys, then any extras)
    headers: list[str] = []
    seen = set()
    for r0 in rows:
        for k in r0.keys():
            if k not in seen:
                seen.add(k); headers.append(k)
    ws.write_row(0, 0, headers, f.header)
    for col in range(len(headers)):
        ws.set_column(col, col, 22)

    for i, r0 in enumerate(rows, start=1):
        for j, h in enumerate(headers):
            v = r0.get(h)
            ws.write(i, j, _scalar(v), f.cell_mono if h in ("_error",) else f.cell)

    ws.freeze_panes(1, 0)
    if rows:
        ws.autofilter(0, 0, len(rows), len(headers) - 1)


def _write_logs(wb, f: _Formats, r: dict) -> None:
    ws = wb.add_worksheet("Logs")
    ws.set_column(0, 0, 26); ws.set_column(1, 1, 10); ws.set_column(2, 2, 140)
    ws.write_row(0, 0, ["Timestamp", "Level", "Message"], f.header)
    logs: Iterable[dict] = r.get("logs") or []
    for i, line in enumerate(logs, start=1):
        ws.write(i, 0, line.get("ts"),  f.cell_mono)
        ws.write(i, 1, line.get("level"), f.cell)
        ws.write(i, 2, line.get("msg"),   f.cell)
    ws.freeze_panes(1, 0)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _g(d: dict, *path: str) -> Any:
    cur: Any = d
    for p in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _scalar(v: Any) -> Any:
    if v is None:
        return ""
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (list, tuple)):
        return ", ".join(str(x) for x in v)
    return str(v)
