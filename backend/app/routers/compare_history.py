"""Compare history: runs, batches, diff browsing, exports and the Excel report."""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import defer
from starlette.background import BackgroundTask

from app.db.store import CompareBatch, CompareRun, get_session
from app.engine import diffstore
from app.engine.core import drop_store, store_exists

router = APIRouter(prefix="/api/compare", tags=["compare-history"])
downloads = APIRouter(prefix="/api/downloads", tags=["downloads"])


def _row(r: CompareRun) -> dict[str, Any]:
    s = r.summary or {}
    return {
        "id": r.id,
        "run_uuid": r.run_uuid,
        "status": r.status,
        "verdict": r.verdict or s.get("verdict"),
        "kind": r.kind,
        "batch_id": r.batch_id,
        "source_label": r.source_label,
        "target_label": r.target_label,
        "started_at": r.started_at.isoformat() + "Z",
        "finished_at": (r.finished_at.isoformat() + "Z") if r.finished_at else None,
        "elapsed_ms": s.get("elapsed_ms"),
        "engine": s.get("engine"),
        "summary": s,
        "error": (r.error or "")[:500] or None,
    }


@router.get("/runs")
def list_runs(
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    verdict: str | None = None,
    kind: str | None = None,
    batch: str | None = None,
    q: str | None = None,
) -> dict:
    session = get_session()
    try:
        query = session.query(CompareRun).options(defer(CompareRun.result), defer(CompareRun.options))
        if verdict:
            query = query.filter(CompareRun.verdict == verdict.upper())
        if kind:
            query = query.filter(CompareRun.kind == kind)
        if batch:
            query = query.filter(CompareRun.batch_id == batch)
        query = query.order_by(CompareRun.started_at.desc())
        if q:
            # labels are encrypted, so text search happens after decryption
            needle = q.lower()
            rows = [r for r in query.limit(5000).all()
                    if needle in (r.source_label or "").lower() or needle in (r.target_label or "").lower()]
            total = len(rows)
            items = rows[offset: offset + limit]
        else:
            total = query.count()
            items = query.offset(offset).limit(limit).all()
        return {"items": [_row(r) for r in items], "total": total, "limit": limit, "offset": offset}
    finally:
        session.close()


def _get(session, run_uuid: str) -> CompareRun:
    r = session.query(CompareRun).filter(CompareRun.run_uuid == run_uuid).first()
    if not r:
        raise HTTPException(404, "Run not found")
    return r


@router.get("/runs/{run_uuid}")
def get_run(run_uuid: str) -> dict:
    session = get_session()
    try:
        r = _get(session, run_uuid)
        d = _row(r)
        d.update({"options": r.options, "result": r.result, "error": r.error})
        d["has_diff_store"] = _store_exists(run_uuid)
        return d
    finally:
        session.close()


def _store_exists(run_uuid: str) -> bool:
    return store_exists(run_uuid)


def _drop_store(run_uuid: str) -> None:
    drop_store(run_uuid)


@router.delete("/runs/{run_uuid}")
def delete_run(run_uuid: str) -> Response:
    session = get_session()
    try:
        r = _get(session, run_uuid)
        session.delete(r)
        session.commit()
    finally:
        session.close()
    _drop_store(run_uuid)
    return Response(status_code=204)


class BulkDelete(BaseModel):
    run_uuids: list[str]


@router.post("/runs/delete")
def delete_runs(body: BulkDelete) -> dict:
    session = get_session()
    n = 0
    try:
        for r in session.query(CompareRun).filter(CompareRun.run_uuid.in_(body.run_uuids)).all():
            session.delete(r)
            n += 1
        session.commit()
    finally:
        session.close()
    for u in body.run_uuids:
        _drop_store(u)
    return {"deleted": n}


@router.get("/runs/{run_uuid}/diff")
def browse_diff(
    run_uuid: str,
    kind: str = Query("changed", pattern="^(changed|only_source|only_target)$"),
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=5000),
    search: str | None = Query(None, max_length=200),
    column: str | None = Query(None, max_length=512),
) -> dict:
    try:
        return diffstore.browse(run_uuid, kind, offset, limit, search or None, column or None)
    except diffstore.StoreMissing as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.get("/runs/{run_uuid}/diff/meta")
def diff_meta(run_uuid: str) -> dict:
    try:
        return diffstore.meta(run_uuid)
    except diffstore.StoreMissing as exc:
        raise HTTPException(404, str(exc))


class ExportIn(BaseModel):
    kind: str = "changed"
    format: str = "csv"
    search: str | None = None
    column: str | None = None


@router.post("/runs/{run_uuid}/export")
def export_diff(run_uuid: str, body: ExportIn) -> dict:
    try:
        path, name = diffstore.export(run_uuid, body.kind, body.format, body.search, body.column)
    except diffstore.StoreMissing as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    fname = f"datanique_{run_uuid[:8]}_{name}"
    tok = diffstore.tickets.issue(path, fname, diffstore.MEDIA[body.format])
    return {"url": f"/api/downloads/{tok}", "filename": fname, "size_bytes": path.stat().st_size}


def _report_file(run_uuid: str):
    session = get_session()
    try:
        r = _get(session, run_uuid)
        result = r.result or {}
    finally:
        session.close()
    if not result:
        raise HTTPException(400, "Run has no captured result to export")
    verdict = (result.get("verdict") or result.get("status") or "report").lower()
    fname = f"datanique_{verdict}_{run_uuid[:8]}.xlsx"
    out = diffstore.exports_tmp() / f"{os.urandom(8).hex()}.xlsx"
    if result.get("schema_version") == 2:
        from app.engine.report import build_run_report
        build_run_report(out, result, run_uuid)
    else:
        from app.reports import build_excel_report
        out.write_bytes(build_excel_report(result))
    return out, fname


@router.post("/runs/{run_uuid}/report")
def report_ticket(run_uuid: str) -> dict:
    try:
        out, fname = _report_file(run_uuid)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to build the Excel report: {exc!s:.300}")
    tok = diffstore.tickets.issue(out, fname, diffstore.MEDIA["xlsx"])
    return {"url": f"/api/downloads/{tok}", "filename": fname, "size_bytes": out.stat().st_size}


@router.get("/runs/{run_uuid}/excel")
def download_run_excel(run_uuid: str):
    try:
        out, fname = _report_file(run_uuid)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Failed to build the Excel report: {exc!s:.300}")
    return FileResponse(out, media_type=diffstore.MEDIA["xlsx"], filename=fname,
                        headers={"Cache-Control": "no-store"},
                        background=BackgroundTask(lambda: out.unlink(missing_ok=True)))


@downloads.get("/{ticket}")
def take_download(ticket: str):
    t = diffstore.tickets.take(ticket)
    if not t:
        raise HTTPException(404, "This download link has expired; export again")
    path, fname, media, _exp, delete_after = t
    bg = BackgroundTask(lambda: path.unlink(missing_ok=True)) if delete_after else None
    return FileResponse(path, media_type=media, filename=fname, headers={"Cache-Control": "no-store"}, background=bg)


# --------------------------------------------------------------------------
# Batches
# --------------------------------------------------------------------------
@router.get("/batches")
def list_batches(limit: int = Query(50, ge=1, le=500)) -> list[dict]:
    session = get_session()
    try:
        rows = session.query(CompareBatch).order_by(CompareBatch.started_at.desc()).limit(limit).all()
        return [{
            "batch_uuid": b.batch_uuid, "name": b.name, "status": b.status,
            "started_at": b.started_at.isoformat() + "Z",
            "finished_at": (b.finished_at.isoformat() + "Z") if b.finished_at else None,
            "total": (b.summary or {}).get("total"), "counts": (b.summary or {}).get("counts"),
        } for b in rows]
    finally:
        session.close()


@router.get("/batches/{batch_uuid}")
def get_batch(batch_uuid: str) -> dict:
    session = get_session()
    try:
        b = session.query(CompareBatch).filter(CompareBatch.batch_uuid == batch_uuid).first()
        if not b:
            raise HTTPException(404, "Batch not found")
        runs = (session.query(CompareRun).options(defer(CompareRun.result), defer(CompareRun.options))
                .filter(CompareRun.batch_id == batch_uuid).order_by(CompareRun.started_at).all())
        return {
            "batch_uuid": b.batch_uuid, "name": b.name, "status": b.status,
            "started_at": b.started_at.isoformat() + "Z",
            "finished_at": (b.finished_at.isoformat() + "Z") if b.finished_at else None,
            "summary": b.summary, "runs": [_row(r) for r in runs],
        }
    finally:
        session.close()


# --------------------------------------------------------------------------
# Watermark for incremental runs
# --------------------------------------------------------------------------
@router.get("/watermark")
def get_watermark(
    source_label: str = Query(..., min_length=1),
    target_label: str = Query(..., min_length=1),
    incremental_column: str = Query(..., min_length=1),
    source_connection_id: int | None = Query(None, ge=1),
    target_connection_id: int | None = Query(None, ge=1),
) -> dict:
    """Start time of the latest matching run with the same incremental column
    between the same objects (labels are encrypted, so compared after
    decryption)."""
    session = get_session()
    try:
        query = session.query(CompareRun).options(defer(CompareRun.result)).filter(
            CompareRun.status == "SUCCESS", CompareRun.verdict == "MATCH")
        if source_connection_id is not None and target_connection_id is not None:
            query = query.filter(
                CompareRun.source_connection_id == source_connection_id,
                CompareRun.target_connection_id == target_connection_id,
            )
        for r in query.order_by(CompareRun.finished_at.desc()).limit(200).all():
            if r.source_label != source_label or r.target_label != target_label:
                continue
            opts = r.options or {}
            if (opts.get("incremental_column") or "").upper() == incremental_column.upper():
                return {
                    "last_compared_at": (r.started_at.isoformat() + "Z") if r.started_at else None,
                    "run_uuid": r.run_uuid,
                    "previous_since": opts.get("since"),
                }
        return {"last_compared_at": None, "run_uuid": None, "previous_since": None}
    finally:
        session.close()
