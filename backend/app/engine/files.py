"""File sides: storage of uploads, format detection, inspection and loading.

Every reader lands the data in DuckDB:

* CSV / TSV / PSV / TXT / DAT (+ .gz .zst): DuckDB's parallel CSV reader
  with dialect sniffing; other encodings are transcoded first.
* Excel (.xlsx .xlsm .xlsb .xls .ods): python-calamine (Rust).
* Parquet, JSON / NDJSON: DuckDB native readers.
* Avro: fastavro, streamed in batches through Arrow.
* ORC, Arrow IPC / Feather: pyarrow.
* Fixed width: column widths supplied by the user.
* .zip: the first (or chosen) member is extracted and read as above.
"""
from __future__ import annotations

import codecs
import datetime as dt
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import time
import zipfile
from decimal import Decimal
from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.engine.spec import FileOptions, SideSpec

log = logging.getLogger("dv.engine.files")

EXT_FORMATS = {
    ".csv": "csv", ".tsv": "csv", ".psv": "csv", ".txt": "csv", ".dat": "csv", ".tab": "csv",
    ".xlsx": "excel", ".xlsm": "excel", ".xlsb": "excel", ".xls": "excel", ".ods": "excel",
    ".parquet": "parquet", ".pq": "parquet", ".parq": "parquet",
    ".json": "json", ".ndjson": "json", ".jsonl": "json",
    ".avro": "avro",
    ".orc": "orc",
    ".arrow": "arrow", ".feather": "arrow", ".ipc": "arrow",
}
COMPRESSED = {".gz": "gzip", ".zst": "zstd", ".gzip": "gzip"}
TEXT_FORMATS = {"csv", "fixed", "json"}
_DUCKDB_ENCODINGS = {"utf-8", "utf8", "utf-16", "utf16", "latin-1", "latin1", "iso-8859-1"}


def uploads_dir() -> Path:
    p = settings.data_dir / "uploads"
    p.mkdir(parents=True, exist_ok=True)
    return p


def new_file_id() -> str:
    return secrets.token_hex(12)


def safe_name(name: str) -> str:
    base = (name or "file").replace("\\", "/").rsplit("/", 1)[-1]
    base = re.sub(r"[^A-Za-z0-9._ -]+", "_", base).strip(" .") or "file"
    return base[:180]


def upload_path(file_id: str) -> Path:
    d = uploads_dir() / file_id
    if not d.is_dir():
        raise FileNotFoundError("Uploaded file not found (it may have expired); upload it again")
    files = [p for p in d.iterdir() if p.is_file() and not p.name.startswith(".")]
    if not files:
        raise FileNotFoundError("Uploaded file not found; upload it again")
    return files[0]


def purge_uploads(max_age_hours: float = 24.0) -> int:
    """Delete uploads older than ``max_age_hours`` (all when 0)."""
    n = 0
    cutoff = time.time() - max_age_hours * 3600
    root = uploads_dir()
    for d in root.iterdir():
        try:
            if max_age_hours <= 0 or d.stat().st_mtime < cutoff:
                shutil.rmtree(d, ignore_errors=True) if d.is_dir() else d.unlink(missing_ok=True)
                n += 1
        except Exception:
            pass
    return n


def side_path(side: SideSpec) -> Path:
    if side.file_id:
        return upload_path(side.file_id)
    p = Path(os.path.expandvars(os.path.expanduser((side.path or "").strip().strip('"'))))
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    if p.is_dir():
        return p
    return p


def detect_format(path: Path, hint: str | None = None) -> tuple[str, str | None]:
    """Return (format, compression)."""
    if path.is_dir():
        exts = {q.suffix.lower() for q in path.iterdir() if q.is_file()}
        for ext in exts:
            if ext in EXT_FORMATS:
                return hint or EXT_FORMATS[ext], None
        raise ValueError(f"No readable files in folder {path}")
    name = path.name.lower()
    comp = None
    suffixes = [s.lower() for s in path.suffixes]
    if suffixes and suffixes[-1] in COMPRESSED:
        comp = COMPRESSED[suffixes[-1]]
        suffixes = suffixes[:-1]
    if hint:
        return hint, comp
    if suffixes and suffixes[-1] == ".zip" or name.endswith(".zip"):
        return "zip", None
    if suffixes and suffixes[-1] in EXT_FORMATS:
        return EXT_FORMATS[suffixes[-1]], comp
    head = b""
    try:
        with open(path, "rb") as f:
            head = f.read(8)
    except OSError:
        pass
    if head.startswith(b"PAR1"):
        return "parquet", None
    if head.startswith(b"Obj\x01"):
        return "avro", None
    if head.startswith(b"ORC"):
        return "orc", None
    if head.startswith(b"ARROW1"):
        return "arrow", None
    if head.startswith(b"PK"):
        return "excel" if name.endswith((".xlsx", ".xlsm", ".ods")) else "zip", None
    if head.startswith(b"\x1f\x8b"):
        return "csv", "gzip"
    if head[:1] in (b"{", b"["):
        return "json", None
    return "csv", None


def _unzip(path: Path, member: str | None) -> Path:
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX")]
        if not names:
            raise ValueError("The zip file is empty")
        pick = member if member in names else names[0]
        key = hashlib.sha1(f"{path}:{path.stat().st_mtime_ns}:{pick}".encode()).hexdigest()[:16]
        out_dir = uploads_dir() / f"_unzip_{key}"
        out = out_dir / safe_name(pick)
        if not out.exists():
            out_dir.mkdir(parents=True, exist_ok=True)
            with z.open(pick) as src, open(out, "wb") as dst:
                shutil.copyfileobj(src, dst, 4 * 1024 * 1024)
        return out


def zip_members(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return [n for n in z.namelist() if not n.endswith("/") and not n.startswith("__MACOSX")]


def _transcode(path: Path, encoding: str) -> Path:
    """Re-encode a text file to UTF-8 (DuckDB reads UTF-8/16 and Latin-1)."""
    key = hashlib.sha1(f"{path}:{path.stat().st_mtime_ns}:{encoding}".encode()).hexdigest()[:16]
    out = uploads_dir() / f"_utf8_{key}" / (path.stem + ".csv")
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    dec = codecs.getincrementaldecoder(encoding)(errors="replace")
    with open(path, "rb") as src, open(out, "w", encoding="utf-8", newline="") as dst:
        while True:
            chunk = src.read(8 * 1024 * 1024)
            if not chunk:
                dst.write(dec.decode(b"", final=True))
                break
            dst.write(dec.decode(chunk))
    return out


def _sql_str(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _csv_source(path: Path, opts: FileOptions, compression: str | None, sample: bool = False,
                lenient: bool = False) -> str:
    target = path
    enc = (opts.encoding or "").strip().lower()
    if enc and enc not in _DUCKDB_ENCODINGS:
        codecs.lookup(enc)  # raises LookupError for unknown encodings
        target = _transcode(path, enc)
        enc = ""
    p = str(target / "*") if target.is_dir() else str(target)
    args = [_sql_str(p)]
    if opts.delimiter:
        d = opts.delimiter.replace("\\t", "\t")
        args.append(f"delim={_sql_str(d)}")
    if opts.header is not None:
        args.append(f"header={'true' if opts.header else 'false'}")
    if opts.quote is not None:
        args.append(f"quote={_sql_str(opts.quote)}")
    if opts.escape is not None:
        args.append(f"escape={_sql_str(opts.escape)}")
    if enc:
        args.append(f"encoding={_sql_str('latin-1' if enc in ('latin1', 'iso-8859-1') else enc.replace('utf8', 'utf-8').replace('utf16', 'utf-16'))}")
    if opts.skip_rows:
        args.append(f"skip={int(opts.skip_rows)}")
    if opts.null_values:
        args.append("nullstr=[" + ", ".join(_sql_str(v) for v in opts.null_values) + "]")
    if opts.date_format:
        args.append(f"dateformat={_sql_str(opts.date_format)}")
    if opts.timestamp_format:
        args.append(f"timestampformat={_sql_str(opts.timestamp_format)}")
    if opts.decimal_separator:
        args.append(f"decimal_separator={_sql_str(opts.decimal_separator)}")
    if opts.all_varchar:
        args.append("all_varchar=true")
    if compression:
        args.append(f"compression={_sql_str(compression)}")
    args.append("sample_size=" + ("20480" if sample else "-1" if opts.all_varchar else "102400"))
    if lenient:
        # ragged rows / stray quotes: keep reading instead of failing
        args.append("strict_mode=false")
        args.append("null_padding=true")
    return f"read_csv({', '.join(args)})"


def _fixed_source(path: Path, opts: FileOptions, compression: str | None) -> str:
    cols = opts.fixed_columns or []
    if not cols:
        raise ValueError("Fixed-width files need column widths")
    args = [_sql_str(str(path)), "header=false", "auto_detect=false", "columns={'__line': 'VARCHAR'}",
            "delim='\x1e'", "quote=''", "escape=''", "strict_mode=false"]
    if opts.skip_rows:
        args.append(f"skip={int(opts.skip_rows)}")
    if compression:
        args.append(f"compression={_sql_str(compression)}")
    pos = 1
    parts = []
    for c in cols:
        parts.append(f"NULLIF(trim(substr(__line, {pos}, {c.width})), '') AS {_q(c.name)}")
        pos += c.width
    return f"(SELECT {', '.join(parts)} FROM read_csv({', '.join(args)}))"


def _q(ident: str) -> str:
    return '"' + str(ident).replace('"', '""') + '"'


def _json_source(path: Path, opts: FileOptions, compression: str | None) -> str:
    p = str(path / "*") if path.is_dir() else str(path)
    fmt = {"auto": "auto", "array": "array", "newline_delimited": "newline_delimited"}[opts.json_format]
    if fmt == "auto" and str(path).lower().endswith((".ndjson", ".jsonl")):
        fmt = "newline_delimited"
    args = [_sql_str(p), f"format={_sql_str(fmt)}", "maximum_object_size=67108864"]
    if compression:
        args.append(f"compression={_sql_str(compression)}")
    return f"read_json({', '.join(args)})"


def _parquet_source(path: Path) -> str:
    p = str(path / "**" / "*.parquet") if path.is_dir() else str(path)
    return f"read_parquet({_sql_str(p)}, union_by_name=true)"


# ---------------------------------------------------------------------------
# Excel (python-calamine)
# ---------------------------------------------------------------------------
def excel_sheets(path: Path) -> list[str]:
    from python_calamine import CalamineWorkbook  # type: ignore

    wb = CalamineWorkbook.from_path(str(path))
    try:
        return list(wb.sheet_names)
    finally:
        try:
            wb.close()
        except Exception:
            pass


def _excel_rows(path: Path, sheet: str | None, limit: int | None = None) -> tuple[str, list[list[Any]]]:
    from python_calamine import CalamineWorkbook  # type: ignore

    wb = CalamineWorkbook.from_path(str(path))
    try:
        names = list(wb.sheet_names)
        name = sheet if sheet in names else names[0]
        ws = wb.get_sheet_by_name(name)
        if limit is None:
            rows = ws.to_python(skip_empty_area=True)
        else:
            rows = []
            for i, r in enumerate(ws.iter_rows()):
                if i >= limit:
                    break
                rows.append(list(r))
        return name, rows
    finally:
        try:
            wb.close()
        except Exception:
            pass


def _round_ms(v: dt.datetime) -> dt.datetime:
    # Excel stores date-times as fractions of a day; round the float noise
    # away to Excel's own precision (1 ms).
    us = round(v.microsecond / 1000) * 1000
    if us >= 1_000_000:
        return v.replace(microsecond=0) + dt.timedelta(seconds=1)
    return v.replace(microsecond=us)


def _excel_array(col: list, all_varchar: bool):
    import pyarrow as pa
    import pyarrow.compute as pc

    vals = [None if v == "" else v for v in col]
    kinds = set(map(type, vals))
    kinds.discard(type(None))

    def as_text(v):
        if v is None or isinstance(v, str):
            return v
        if isinstance(v, float) and v.is_integer() and abs(v) < 2**63:
            return str(int(v))
        if isinstance(v, dt.datetime):
            return _round_ms(v).isoformat(sep=" ")
        if isinstance(v, (dt.date, dt.time)):
            return v.isoformat()
        return str(v)

    if all_varchar or not kinds:
        return pa.array([as_text(v) for v in vals], type=pa.string())
    try:
        if kinds <= {int, float}:
            arr = pa.array(vals, type=pa.float64())
            nn = pc.drop_null(arr)
            if len(nn) and pc.all(pc.equal(nn, pc.floor(nn))).as_py() and pc.max(pc.abs(nn)).as_py() < 2**53:
                return arr.cast(pa.int64())
            return arr
        if kinds == {bool}:
            return pa.array(vals, type=pa.bool_())
        if kinds == {dt.date}:
            return pa.array(vals, type=pa.date32())
        if kinds <= {dt.date, dt.datetime}:
            return pa.array([None if v is None else _round_ms(v if isinstance(v, dt.datetime) else dt.datetime(v.year, v.month, v.day)) for v in vals], type=pa.timestamp("us"))
        if kinds == {dt.time}:
            return pa.array(vals, type=pa.time64("us"))
        if kinds == {str}:
            return pa.array(vals, type=pa.string())
    except (pa.ArrowInvalid, pa.ArrowTypeError, TypeError, ValueError, OverflowError):
        pass
    return pa.array([as_text(v) for v in vals], type=pa.string())


def excel_to_arrow(path: Path, opts: FileOptions, limit: int | None = None):
    import pyarrow as pa

    sheet, rows = _excel_rows(path, opts.sheet, None if limit is None else limit + opts.skip_rows + 1)
    rows = rows[opts.skip_rows:]
    while rows and all(v in ("", None) for v in rows[-1]):
        rows.pop()
    if not rows:
        return sheet, pa.table({})
    width = max(len(r) for r in rows)
    header = opts.header if opts.header is not None else _looks_like_header(rows)
    if header:
        names = [str(v).strip() if v not in ("", None) else f"column{i + 1}" for i, v in enumerate(rows[0])]
        names += [f"column{i + 1}" for i in range(len(names), width)]
        data = rows[1:]
    else:
        names = [f"column{i + 1}" for i in range(width)]
        data = rows
    names = _dedupe(names)
    if limit is not None:
        data = data[:limit]
    if any(len(r) != width for r in data):
        data = [list(r) + [None] * (width - len(r)) for r in data]
    columns = list(zip(*data)) if data else [() for _ in names]
    arrays = [_excel_array(list(c), opts.all_varchar) for c in columns]
    return sheet, pa.Table.from_arrays(arrays, names=names)


def _looks_like_header(rows: list[list]) -> bool:
    first = rows[0]
    if not first or any(isinstance(v, (int, float, dt.date)) and not isinstance(v, bool) for v in first if v not in ("", None)):
        return False
    if len(rows) == 1:
        return True
    nonempty = [v for v in first if v not in ("", None)]
    return len(nonempty) >= max(1, len(first) // 2) and len(set(map(str, nonempty))) == len(nonempty)


def _dedupe(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for n in names:
        k = n.lower()
        if k in seen:
            seen[k] += 1
            n = f"{n}_{seen[k]}"
        else:
            seen[k] = 0
        out.append(n)
    return out


# ---------------------------------------------------------------------------
# Avro (fastavro)
# ---------------------------------------------------------------------------
def _avro_arrow_type(t):
    import pyarrow as pa

    if isinstance(t, list):
        non_null = [x for x in t if x != "null"]
        return _avro_arrow_type(non_null[0]) if len(non_null) == 1 else pa.string()
    if isinstance(t, dict):
        lt = t.get("logicalType")
        base = t.get("type")
        if lt == "date":
            return pa.date32()
        if lt in ("timestamp-millis", "timestamp-micros", "local-timestamp-millis", "local-timestamp-micros"):
            return pa.timestamp("us", tz="UTC" if not lt.startswith("local") else None)
        if lt == "decimal":
            return pa.decimal128(int(t.get("precision", 38)), int(t.get("scale", 0)))
        if lt in ("time-millis", "time-micros"):
            return pa.time64("us")
        if lt == "uuid":
            return pa.string()
        if base in ("record", "array", "map"):
            return pa.string()
        if base == "enum":
            return pa.string()
        if base == "fixed":
            return pa.binary()
        return _avro_arrow_type(base)
    return {
        "null": pa.null(), "boolean": pa.bool_(), "int": pa.int32(), "long": pa.int64(),
        "float": pa.float32(), "double": pa.float64(), "bytes": pa.binary(), "string": pa.string(),
    }.get(t, pa.string())


def avro_batches(path: Path, batch_rows: int = 100_000, limit: int | None = None):
    import fastavro  # type: ignore
    import pyarrow as pa

    with open(path, "rb") as f:
        reader = fastavro.reader(f)
        schema = reader.writer_schema or {}
        fields = schema.get("fields") or []
        arrow_fields = [(fl["name"], _avro_arrow_type(fl["type"])) for fl in fields]
        names = [n for n, _ in arrow_fields]
        types = [ty for _, ty in arrow_fields]
        stringish = {n for n, ty in arrow_fields if ty == pa.string()}
        buf: list[dict] = []
        n = 0
        for rec in reader:
            if stringish:
                rec = {k: (json.dumps(v, default=str) if k in stringish and isinstance(v, (dict, list)) else (str(v) if k in stringish and v is not None and not isinstance(v, str) else v)) for k, v in rec.items()}
            buf.append(rec)
            n += 1
            if len(buf) >= batch_rows or (limit is not None and n >= limit):
                yield pa.Table.from_pylist(buf, schema=pa.schema(list(zip(names, types))))
                buf = []
                if limit is not None and n >= limit:
                    return
        if buf:
            yield pa.Table.from_pylist(buf, schema=pa.schema(list(zip(names, types))))


# ---------------------------------------------------------------------------
# Inspect / load
# ---------------------------------------------------------------------------
def _relation_sql(con, path: Path, fmt: str, compression: str | None, opts: FileOptions, sample: bool = False,
                  lenient: bool = False) -> str | None:
    """SQL table expression for formats DuckDB reads natively, else None.
    CSV relations are probed and re-tried in lenient mode when the strict
    dialect sniffer rejects the file."""
    if fmt == "csv":
        rel = _csv_source(path, opts, compression, sample=sample, lenient=lenient)
        if con is not None and not lenient:
            try:
                con.execute(f"DESCRIBE SELECT * FROM {rel}")
            except Exception:
                return _csv_source(path, opts, compression, sample=sample, lenient=True)
        return rel
    if fmt == "fixed":
        return _fixed_source(path, opts, compression)
    if fmt == "parquet":
        return _parquet_source(path)
    if fmt == "json":
        return _json_source(path, opts, compression)
    return None


def _arrow_for(path: Path, fmt: str, opts: FileOptions, limit: int | None = None):
    """Arrow table or iterator of tables for non-DuckDB formats."""
    import pyarrow as pa

    if fmt == "excel":
        return excel_to_arrow(path, opts, limit)[1]
    if fmt == "avro":
        return avro_batches(path, limit=limit)
    if fmt == "orc":
        import pyarrow.orc as orc

        f = orc.ORCFile(str(path))

        def gen():
            n = 0
            for i in range(f.nstripes):
                t = f.read_stripe(i)
                t = pa.Table.from_batches([t]) if isinstance(t, pa.RecordBatch) else t
                if limit is not None and n + t.num_rows > limit:
                    yield t.slice(0, limit - n)
                    return
                n += t.num_rows
                yield t
        return gen()
    if fmt == "arrow":
        import pyarrow.ipc as ipc

        src = pa.memory_map(str(path), "r")
        try:
            t = ipc.open_file(src).read_all()
        except Exception:
            src = pa.memory_map(str(path), "r")
            t = ipc.open_stream(src).read_all()
        return t if limit is None else t.slice(0, limit)
    raise ValueError(f"Unsupported file format: {fmt}")


def resolve(side: SideSpec) -> tuple[Path, str, str | None]:
    path = side_path(side)
    fmt, comp = detect_format(path, side.format)
    if fmt == "zip":
        path = _unzip(path, side.options.zip_member)
        fmt, comp = detect_format(path, None if side.format == "zip" else side.format)
    return path, fmt, comp


def load_side(con, table: str, side: SideSpec, max_rows: int = 0,
              on_rows: Callable[[int], None] | None = None,
              cancelled: Callable[[], bool] | None = None) -> dict:
    """Create DuckDB table ``table`` from a file side. Returns reader info."""
    path, fmt, comp = resolve(side)
    opts = side.options
    t0 = time.perf_counter()
    rel = _relation_sql(con, path, fmt, comp, opts)
    limit = f" LIMIT {int(max_rows)}" if max_rows else ""
    if rel is not None:
        con.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM {rel}{limit}")
        reader = {"csv": "duckdb read_csv", "fixed": "duckdb fixed-width", "parquet": "duckdb read_parquet", "json": "duckdb read_json"}[fmt]
    else:
        data = _arrow_for(path, fmt, opts, limit=max_rows or None)
        import pyarrow as pa

        if isinstance(data, pa.Table):
            con.register("__dv_arrow", data)
            con.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM __dv_arrow")
            con.unregister("__dv_arrow")
        else:
            created = False
            n = 0
            for chunk in data:
                if cancelled and cancelled():
                    raise InterruptedError("Cancelled")
                con.register("__dv_arrow", chunk)
                if not created:
                    con.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM __dv_arrow")
                    created = True
                else:
                    con.execute(f"INSERT INTO {table} SELECT * FROM __dv_arrow")
                con.unregister("__dv_arrow")
                n += chunk.num_rows
                if on_rows:
                    on_rows(n)
            if not created:
                raise ValueError("The file has no rows")
        reader = {"excel": "calamine", "avro": "fastavro → arrow", "orc": "pyarrow orc", "arrow": "pyarrow ipc"}[fmt]
    rows = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
    if on_rows:
        on_rows(rows)
    return {
        "reader": reader,
        "format": fmt,
        "path": str(path) if not side.file_id else None,
        "file_name": path.name,
        "size_bytes": _size(path),
        "rows": rows,
        "read_ms": int((time.perf_counter() - t0) * 1000),
        "sheet": opts.sheet if fmt == "excel" else None,
    }


def _size(path: Path) -> int:
    if path.is_dir():
        return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    return path.stat().st_size


def inspect(side: SideSpec, preview_rows: int = 50) -> dict:
    """Detected format, options, columns and a preview for the UI."""
    import duckdb

    path = side_path(side)
    fmt0, _ = detect_format(path, side.format)
    members = zip_members(path) if fmt0 == "zip" else None
    path, fmt, comp = resolve(side)
    opts = side.options
    con = duckdb.connect()
    try:
        out: dict[str, Any] = {
            "format": fmt, "compression": comp, "file_name": path.name, "size_bytes": _size(path),
            "zip_members": members, "sheets": None, "detected": {}, "row_count": None,
        }
        if fmt == "excel":
            out["sheets"] = excel_sheets(path)
            sheet, tbl = excel_to_arrow(path, opts, limit=preview_rows)
            out["detected"]["sheet"] = sheet
            con.register("__p", tbl)
            rel = "__p"
        elif fmt in ("avro", "orc", "arrow"):
            data = _arrow_for(path, fmt, opts, limit=preview_rows)
            import pyarrow as pa
            if not isinstance(data, pa.Table):
                parts = list(data)
                data = pa.concat_tables(parts) if parts else pa.table({})
            con.register("__p", data)
            rel = "__p"
        else:
            rel = _relation_sql(con, path, fmt, comp, opts, sample=True)
            if fmt == "csv" and not path.is_dir():
                try:
                    sn = con.execute(f"SELECT Delimiter, Quote, Escape, HasHeader, NewLineDelimiter, SkipRows FROM sniff_csv({_sql_str(str(path if not (opts.encoding and opts.encoding.lower() not in _DUCKDB_ENCODINGS) else _transcode(path, opts.encoding)))}, sample_size=20480)").fetchone()
                    out["detected"].update({
                        "delimiter": sn[0], "quote": sn[1], "escape": sn[2], "header": sn[3],
                        "line_ending": {"\\n": "LF", "\\r\\n": "CRLF", "\\r": "CR"}.get(sn[4], sn[4]), "skip_rows": sn[5],
                    })
                except Exception:
                    pass
        cols = con.execute(f"DESCRIBE SELECT * FROM {rel}").fetchall()
        out["columns"] = [{"name": c[0], "type": c[1]} for c in cols]
        cur = con.execute(f"SELECT * FROM {rel} LIMIT {int(preview_rows)}")
        out["preview"] = [[display_value(v) for v in row] for row in cur.fetchall()]
        if fmt == "parquet":
            try:
                out["row_count"] = con.execute(f"SELECT sum(num_rows) FROM parquet_file_metadata({_sql_str(str(path / '**' / '*.parquet') if path.is_dir() else str(path))})").fetchone()[0]
            except Exception:
                pass
        elif fmt == "excel":
            out["row_count"] = None
        elif fmt == "csv" and not comp and out["size_bytes"] <= 256 * 1024 * 1024:
            try:
                out["row_count"] = con.execute(f"SELECT count(*) FROM {_relation_sql(con, path, fmt, comp, opts)}").fetchone()[0]
            except Exception:
                pass
        return out
    finally:
        con.close()


def display_value(v):
    if v is None:
        return None
    if isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else str(v)
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        return v.isoformat(sep=" ") if isinstance(v, dt.datetime) else v.isoformat()
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return "0x" + b[:256].hex() + ("…" if len(b) > 256 else "")
    if isinstance(v, (list, dict, tuple)):
        return json.dumps(v, default=str)
    return str(v)


# ---------------------------------------------------------------------------
# Text checks for two text files (format fidelity, e.g. ETL migrations)
# ---------------------------------------------------------------------------
def text_profile(path: Path) -> dict:
    h = hashlib.sha256()
    crlf = lf = cr = 0
    lines = 0
    trailing_ws = 0
    max_len = 0
    min_len = None
    prev_cr = False
    bom = False
    first = True
    carry = b""
    with open(path, "rb") as f:
        while True:
            chunk = f.read(4 * 1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            if first:
                bom = chunk.startswith(b"\xef\xbb\xbf")
                first = False
            n_crlf = chunk.count(b"\r\n")
            if prev_cr and chunk.startswith(b"\n"):
                n_crlf += 1
            crlf += n_crlf
            lf += chunk.count(b"\n")
            cr += chunk.count(b"\r")
            prev_cr = chunk.endswith(b"\r")
            data = carry + chunk
            parts = data.split(b"\n")
            carry = parts.pop()
            for ln in parts:
                ln = ln.rstrip(b"\r")
                lines += 1
                ll = len(ln)
                max_len = max(max_len, ll)
                min_len = ll if min_len is None else min(min_len, ll)
                if ll and ln[-1:] in (b" ", b"\t"):
                    trailing_ws += 1
    if carry:
        ln = carry.rstrip(b"\r")
        lines += 1
        max_len = max(max_len, len(ln))
        min_len = len(ln) if min_len is None else min(min_len, len(ln))
        if ln[-1:] in (b" ", b"\t"):
            trailing_ws += 1
    lf_only = lf - crlf
    cr_only = cr - crlf
    endings = {"CRLF": crlf, "LF": lf_only, "CR": cr_only}
    dominant = max(endings, key=endings.get) if any(endings.values()) else "none"
    mixed = sum(1 for v in endings.values() if v) > 1
    return {
        "size_bytes": path.stat().st_size,
        "sha256": h.hexdigest(),
        "lines": lines,
        "line_ending": dominant + (" (mixed)" if mixed else ""),
        "has_bom": bom,
        "trailing_whitespace_lines": trailing_ws,
        "max_line_length": max_len,
        "min_line_length": min_len or 0,
        "ends_with_newline": carry == b"",
    }


def text_line_diff(a: Path, b: Path, limit: int = 20) -> dict:
    out = []
    differing = 0
    with open(a, "rb") as fa, open(b, "rb") as fb:
        i = 0
        while True:
            la = fa.readline()
            lb = fb.readline()
            if not la and not lb:
                break
            i += 1
            if la == lb:
                continue
            differing += 1
            if len(out) < limit:
                sa, sb = la.rstrip(b"\r\n"), lb.rstrip(b"\r\n")
                reasons = []
                if not la:
                    reasons.append("only in target")
                elif not lb:
                    reasons.append("only in source")
                else:
                    if sa == sb:
                        reasons.append("line ending")
                    elif sa.rstrip(b" \t") == sb.rstrip(b" \t"):
                        reasons.append("trailing whitespace")
                    else:
                        reasons.append("content")
                out.append({
                    "line": i, "reasons": reasons,
                    "source": sa.decode("utf-8", "replace")[:400] if la else None,
                    "target": sb.decode("utf-8", "replace")[:400] if lb else None,
                })
    return {"differing_lines": differing, "samples": out}


def text_checks(a: Path, b: Path) -> dict:
    pa_, pb = text_profile(a), text_profile(b)
    identical = pa_["sha256"] == pb["sha256"]
    out = {"source": pa_, "target": pb, "identical_bytes": identical}
    if not identical:
        out["line_diff"] = text_line_diff(a, b)
    return out
