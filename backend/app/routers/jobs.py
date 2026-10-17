"""Compare jobs API (single, bulk), side description and bulk auto-pairing."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.engine.jobs import manager
from app.engine.spec import BulkSpec, CompareSpec, SideSpec

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.post("/compare")
def start_compare(spec: CompareSpec) -> dict:
    job = manager.submit_compare(spec)
    return job.snapshot()


@router.post("/bulk")
def start_bulk(spec: BulkSpec) -> dict:
    job = manager.submit_bulk(spec)
    return job.snapshot()


@router.get("")
def list_jobs(active: bool = False) -> list[dict]:
    return [j.snapshot(since=10**12) for j in manager.list(active_only=active)][:100]


@router.get("/{job_id}")
def get_job(job_id: str, since: int = Query(0, ge=0)) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (the app may have restarted)")
    return job.snapshot(since=since)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    job.cancel()
    return job.snapshot(since=10**12)


# ---------------------------------------------------------------------------
# Describe a side (columns + preview) for mapping and key suggestions
# ---------------------------------------------------------------------------
@router.post("/describe")
def describe_side(side: SideSpec, preview: int = Query(20, ge=0, le=200)) -> dict:
    from app.engine import files, readers
    from app.engine.core import _load_record

    if side.kind == "file":
        try:
            return files.inspect(side, preview_rows=preview)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc))
        except Exception as exc:
            raise HTTPException(400, f"Could not read the file: {exc}")
    rec = _load_record(side.connection_id)
    out: dict = {"columns": [], "preview": [], "primary_key": [], "row_estimate": None}
    try:
        if side.kind == "table":
            cols = readers.table_columns(rec, side)
            out["columns"] = [{"name": c["name"], "type": c.get("data_type")} for c in cols]
            out["primary_key"] = readers.primary_key(rec, side)
            out["row_estimate"] = readers.estimated_rows(rec, side)
            if preview:
                sql, _ = readers.native_select(rec, side, None, None, preview)
                out["preview"] = _preview(rec, sql, preview)[1]
        else:
            sql, _ = readers.native_select(rec, side, None, None, max(preview, 1))
            names, rows = _preview(rec, sql, max(preview, 1))
            out["columns"] = [{"name": n, "type": None} for n in names]
            out["preview"] = rows[:preview]
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, f"{type(exc).__name__}: {str(exc)[:500]}")
    return out


def _preview(rec, sql: str, n: int):
    from app.connectors.factory import get_compare_connector
    from app.engine.files import display_value

    c = get_compare_connector(rec, role="meta")
    with c.cursor() as cur:
        cur.execute(sql)
        names = [d[0] for d in cur.description or []]
        rows = cur.fetchmany(n)
    return names, [[display_value(v) for v in r] for r in rows]


# ---------------------------------------------------------------------------
# Bulk auto-pairing
# ---------------------------------------------------------------------------
class Container(BaseModel):
    kind: str = Field(pattern="^(schema|folder|files)$")
    connection_id: int | None = None
    database: str | None = None
    schema_name: str | None = None
    path: str | None = None
    file_ids: list[str] | None = None
    names: list[str] | None = None  # display names for file_ids


class PairRequest(BaseModel):
    source: Container
    target: Container
    strip_prefix: str | None = None
    strip_suffix: str | None = None


def _norm(name: str, prefix: str | None, suffix: str | None) -> str:
    n = name.rsplit("/", 1)[-1]
    n = re.sub(r"(\.(csv|tsv|psv|txt|dat|xlsx|xlsm|xls|xlsb|ods|parquet|json|ndjson|jsonl|avro|orc|arrow|feather))+(\.(gz|zst|zip))?$", "", n, flags=re.I)
    low = n.lower()
    for p in [x.strip().lower() for x in (prefix or "").split(",") if x.strip()]:
        if low.startswith(p):
            low = low[len(p):]
    for s in [x.strip().lower() for x in (suffix or "").split(",") if x.strip()]:
        if low.endswith(s):
            low = low[: -len(s)]
    return re.sub(r"[^a-z0-9]", "", low)


def _items(c: Container) -> list[dict]:
    if c.kind == "schema":
        from app.connectors.factory import get_connector
        from app.engine.core import _load_record

        rec = _load_record(c.connection_id)
        names = get_connector(rec, purpose="metadata").list_tables(c.database or None, c.schema_name or None)
        return [{"name": n, "side": {"kind": "table", "connection_id": rec.id, "database": c.database,
                                      "schema_name": c.schema_name, "table": n}} for n in names]
    if c.kind == "folder":
        from app.engine.files import EXT_FORMATS

        p = Path((c.path or "").strip().strip('"')).expanduser()
        if not p.is_dir():
            raise HTTPException(400, f"Not a folder: {p}")
        out = []
        for f in sorted(p.iterdir()):
            sfx = [s.lower() for s in f.suffixes]
            if f.is_file() and (any(s in EXT_FORMATS for s in sfx) or (sfx and sfx[-1] in (".gz", ".zst", ".zip"))):
                out.append({"name": f.name, "side": {"kind": "file", "path": str(f)}})
        return out
    names = c.names or []
    return [{"name": names[i] if i < len(names) else fid, "side": {"kind": "file", "file_id": fid}}
            for i, fid in enumerate(c.file_ids or [])]


@router.post("/pair")
def auto_pair(req: PairRequest) -> dict:
    src = _items(req.source)
    tgt = _items(req.target)
    tmap: dict[str, list[dict]] = {}
    for t in tgt:
        tmap.setdefault(_norm(t["name"], req.strip_prefix, req.strip_suffix), []).append(t)
    pairs, unmatched_s = [], []
    used = set()
    for s in src:
        k = _norm(s["name"], req.strip_prefix, req.strip_suffix)
        cands = [t for t in tmap.get(k, []) if id(t) not in used]
        if cands:
            used.add(id(cands[0]))
            pairs.append({"source": s, "target": cands[0]})
        else:
            unmatched_s.append(s)
    unmatched_t = [t for t in tgt if id(t) not in used]
    return {"pairs": pairs, "unmatched_source": unmatched_s, "unmatched_target": unmatched_t}
