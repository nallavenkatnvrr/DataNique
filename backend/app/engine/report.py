"""Excel workbook for a v2 run: summary, columns, statistics and every
stored difference (each sheet up to Excel's 1,048,575 data rows)."""
from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from pathlib import Path

import xlsxwriter  # type: ignore

XL_MAX = 1_048_575

_WB_OPTS = {
    "constant_memory": True,
    "strings_to_formulas": False,
    "strings_to_urls": False,
    "strings_to_numbers": False,
    "nan_inf_to_errors": True,
    "default_date_format": "yyyy-mm-dd hh:mm:ss",
}


def _cell(v):
    if v is None:
        return None
    if isinstance(v, (bool, int, float, str)):
        if isinstance(v, int) and abs(v) > 2**53:
            return str(v)
        if isinstance(v, str) and len(v) > 32000:
            return v[:32000] + "…"
        return v
    if isinstance(v, Decimal):
        return float(v) if abs(v) < Decimal(2**53) and v == v.normalize() else str(v)
    if isinstance(v, dt.datetime):
        return v.replace(tzinfo=None) if v.tzinfo else v
    if isinstance(v, dt.date):
        return dt.datetime(v.year, v.month, v.day)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return "0x" + bytes(v)[:2000].hex()
    if isinstance(v, (list, dict, tuple)):
        return json.dumps(v, default=str)[:32000]
    return str(v)


class _F:
    def __init__(self, wb):
        self.h = wb.add_format({"bold": True, "bg_color": "#1F2937", "font_color": "#FFFFFF", "border": 1, "border_color": "#374151"})
        self.title = wb.add_format({"bold": True, "font_size": 16})
        self.bold = wb.add_format({"bold": True})
        self.diff = wb.add_format({"bg_color": "#FEE2E2", "font_color": "#991B1B"})
        self.key = wb.add_format({"bg_color": "#EEF2FF", "bold": True})
        self.ok = wb.add_format({"bold": True, "font_color": "#15803D"})
        self.bad = wb.add_format({"bold": True, "font_color": "#B91C1C"})
        self.num = wb.add_format({"num_format": "#,##0"})
        self.dt = wb.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"})


def _write(ws, r, c, v, fmt=None):
    v = _cell(v)
    if v is None:
        ws.write_blank(r, c, None, fmt)
    elif isinstance(v, dt.datetime):
        ws.write_datetime(r, c, v, fmt)
    elif isinstance(v, bool):
        ws.write_boolean(r, c, v, fmt)
    elif isinstance(v, (int, float)):
        ws.write_number(r, c, v, fmt)
    else:
        ws.write_string(r, c, v, fmt)


def _rows_sheet(wb, f: _F, name: str, cur, changed: bool = False) -> int:
    ws = wb.add_worksheet(name[:31])
    names = [d[0] for d in cur.description]
    if changed:
        # layout: keys | col (source) | col (target) ... ; diff cells highlighted
        keys = [n for n in names if n.startswith("k:")]
        comps = [n[2:] for n in names if n.startswith("s:")]
        header = [k[2:] for k in keys] + [x for c in comps for x in (f"{c} (source)", f"{c} (target)")]
        for i, h in enumerate(header):
            ws.write_string(0, i, h, f.h)
        idx = {n: i for i, n in enumerate(names)}
        r = 0
        while r < XL_MAX:
            batch = cur.fetchmany(10_000)
            if not batch:
                break
            for row in batch:
                if r >= XL_MAX:
                    break
                r += 1
                diffs = set(row[idx["__diff"]] or [])
                c = 0
                for k in keys:
                    _write(ws, r, c, row[idx[k]], f.key)
                    c += 1
                for col in comps:
                    fmt = f.diff if col in diffs else None
                    _write(ws, r, c, row[idx["s:" + col]], fmt)
                    _write(ws, r, c + 1, row[idx["t:" + col]], fmt)
                    c += 2
        ws.freeze_panes(1, len(keys))
        ws.autofilter(0, 0, max(r, 1), max(len(header) - 1, 0))
        return r
    for i, h in enumerate(names):
        ws.write_string(0, i, h, f.h)
    r = 0
    while r < XL_MAX:
        batch = cur.fetchmany(10_000)
        if not batch:
            break
        for row in batch:
            if r >= XL_MAX:
                break
            r += 1
            for c, v in enumerate(row):
                _write(ws, r, c, v)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, max(r, 1), max(len(names) - 1, 0))
    return r


def write_rows_xlsx(out: Path, kind: str, cur) -> None:
    wb = xlsxwriter.Workbook(str(out), _WB_OPTS)
    try:
        f = _F(wb)
        title = {"only_source": "Only in source", "only_target": "Only in target", "changed": "Changed rows"}[kind]
        _rows_sheet(wb, f, title, cur, changed=(kind == "changed"))
    finally:
        wb.close()


def build_run_report(out: Path, result: dict, run_uuid: str) -> None:
    from app.engine import diffstore

    wb = xlsxwriter.Workbook(str(out), _WB_OPTS)
    try:
        f = _F(wb)
        rd = result.get("row_diff") or {}
        src, tgt = result.get("source") or {}, result.get("target") or {}
        ws = wb.add_worksheet("Summary")
        ws.set_column(0, 0, 28)
        ws.set_column(1, 2, 60)
        ws.write_string(0, 0, "Datanique comparison", f.title)
        verdict = result.get("verdict") or result.get("status")
        rows = [
            ("Verdict", verdict),
            ("Run", result.get("run_uuid")),
            ("Started", result.get("started_at")),
            ("Duration (s)", round((result.get("elapsed_ms") or 0) / 1000, 3)),
            ("Strategy", f"{result.get('strategy')} / {rd.get('strategy')}"),
            ("Key columns", ", ".join(result.get("key_columns") or []) or "- (whole-row compare)"),
            ("", ""),
            ("", "Source", "Target"),
            ("Object", src.get("label"), tgt.get("label")),
            ("Rows", src.get("row_count"), tgt.get("row_count")),
            ("Columns", src.get("column_count"), tgt.get("column_count")),
            ("Reader", src.get("reader"), tgt.get("reader")),
            ("Read time (s)", (src.get("read_ms") or 0) / 1000, (tgt.get("read_ms") or 0) / 1000),
            ("", ""),
            ("Equal rows", rd.get("matching_count")),
            ("Changed rows", rd.get("key_match_hash_diff_count")),
            ("Only in source", rd.get("only_in_source_count")),
            ("Only in target", rd.get("only_in_target_count")),
        ]
        for i, row in enumerate(rows, start=2):
            for j, v in enumerate(row):
                fmt = f.bold if j == 0 or (i == 9) else None
                if row[0] == "Verdict" and j == 1:
                    fmt = f.ok if verdict == "MATCH" else f.bad
                _write(ws, i, j, v, fmt)
        r = len(rows) + 3
        for w in result.get("warnings") or []:
            ws.write_string(r, 0, "Note")
            ws.write_string(r, 1, str(w))
            r += 1

        sd = result.get("schema_diff") or {}
        if sd.get("pairs"):
            ws = wb.add_worksheet("Columns")
            mism = {m["column"]: m["count"] for m in rd.get("column_mismatches") or []}
            head = ["Source column", "Target column", "Role", "Source type", "Target type", "Compared as", "Rows that differ"]
            for i, h in enumerate(head):
                ws.write_string(0, i, h, f.h)
            for i, p in enumerate(sd["pairs"], start=1):
                vals = [p["source"], p["target"], p["role"], p["source_type"], p["target_type"], p["compare_as"], mism.get(p["source"], 0)]
                for j, v in enumerate(vals):
                    _write(ws, i, j, v, f.diff if j == 6 and v else None)
            i = len(sd["pairs"]) + 2
            for c in sd.get("only_in_source") or []:
                ws.write_string(i, 0, c)
                ws.write_string(i, 2, "only in source")
                i += 1
            for c in sd.get("only_in_target") or []:
                ws.write_string(i, 1, c)
                ws.write_string(i, 2, "only in target")
                i += 1
            ws.set_column(0, 6, 22)

        stats = result.get("column_stats") or []
        if stats:
            ws = wb.add_worksheet("Column stats")
            head = ["Column", "Match", "Nulls (S)", "Nulls (T)", "Distinct (S)", "Distinct (T)", "Min (S)", "Min (T)", "Max (S)", "Max (T)", "Avg (S)", "Avg (T)"]
            for i, h in enumerate(head):
                ws.write_string(0, i, h, f.h)
            for i, s in enumerate(stats, start=1):
                a, b = s["source"], s["target"]
                vals = [s["name"], "yes" if s["match"] else "no", a["null_count"], b["null_count"], a["distinct_count"], b["distinct_count"],
                        a["min_val"], b["min_val"], a["max_val"], b["max_val"], a.get("avg_val"), b.get("avg_val")]
                for j, v in enumerate(vals):
                    _write(ws, i, j, v, f.diff if j == 1 and not s["match"] else None)
            ws.set_column(0, 11, 16)

        try:
            con = diffstore._open(run_uuid)
        except FileNotFoundError:
            con = None
        if con is not None:
            try:
                tables = {r[0] for r in con.execute("SELECT table_name FROM duckdb_tables() WHERE database_name='rs'").fetchall()}
                if "changed" in tables:
                    _rows_sheet(wb, f, "Changed rows", con.execute("SELECT * FROM rs.changed"), changed=True)
                for t, title in (("only_source", "Only in source"), ("only_target", "Only in target")):
                    if t in tables:
                        _rows_sheet(wb, f, title, con.execute(f"SELECT * FROM rs.{t}"))
            finally:
                con.close()

        fc = result.get("file_checks")
        if fc:
            ws = wb.add_worksheet("File checks")
            keys = list((fc.get("source") or {}).keys())
            ws.write_string(0, 0, "Property", f.h)
            ws.write_string(0, 1, "Source", f.h)
            ws.write_string(0, 2, "Target", f.h)
            for i, k in enumerate(keys, start=1):
                ws.write_string(i, 0, k)
                _write(ws, i, 1, fc["source"].get(k))
                _write(ws, i, 2, fc["target"].get(k))
            ld = (fc.get("line_diff") or {}).get("samples") or []
            r = len(keys) + 3
            for s in ld:
                ws.write_number(r, 0, s["line"])
                ws.write_string(r, 1, s.get("source") or "")
                ws.write_string(r, 2, s.get("target") or "")
                ws.write_string(r, 3, ", ".join(s.get("reasons") or []))
                r += 1
            ws.set_column(0, 3, 30)

        logs = result.get("logs") or []
        if logs:
            ws = wb.add_worksheet("Log")
            for i, h in enumerate(["Time", "Level", "Message"]):
                ws.write_string(0, i, h, f.h)
            for i, e in enumerate(logs[:20000], start=1):
                ws.write_string(i, 0, str(e.get("ts") or ""))
                ws.write_string(i, 1, str(e.get("level") or ""))
                ws.write_string(i, 2, str(e.get("msg") or ""))
            ws.set_column(2, 2, 120)
    finally:
        wb.close()
