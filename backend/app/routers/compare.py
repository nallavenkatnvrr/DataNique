"""Compatibility endpoints for the previous compare API.

``/api/compare/run`` and ``/api/compare/run/stream`` (and the query
variant) now run on the v2 engine through the job manager; new clients use
``/api/jobs``. ``engine`` in old requests is ignored (one engine now).
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app.engine.jobs import manager
from app.engine.spec import CompareSpec, from_legacy_compare, from_legacy_query
from app.routers._compare_shared import (
    CompareRequest, QueryCompareRequest, StopRequest, dumps_stream, validate_filters,
)

router = APIRouter(prefix="/api/compare", tags=["compare"])


def _spec(req: CompareRequest) -> CompareSpec:
    validate_filters(req)
    try:
        return from_legacy_compare(req.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _check_connections(spec: CompareSpec) -> None:
    from app.engine.core import CompareError, _load_record

    for side in (spec.source, spec.target):
        if side.kind != "file":
            try:
                _load_record(side.connection_id)
            except CompareError as exc:
                raise HTTPException(404, str(exc))


@router.post("/run")
def run(req: CompareRequest) -> dict:
    spec = _spec(req)
    _check_connections(spec)
    job = manager.submit_compare(spec, inline=True)
    return job.result or {"status": "ERROR", "error": job.error}


@router.post("/stop")
def stop_compare(req: StopRequest) -> dict:
    """Cancel running compares that use these connections."""
    from app.connectors.factory import evict_compare_connectors

    ids = {i for i in (req.source_connection_id, req.target_connection_id) if i is not None}
    cancelled = []
    for job in manager.list(active_only=True):
        spec = job.spec
        sides = [spec.source, spec.target] if isinstance(spec, CompareSpec) else []
        if any(getattr(s, "connection_id", None) in ids for s in sides):
            job.cancel()
            cancelled.append(job.id)
    evicted = []
    for label, conn_id in (("source", req.source_connection_id), ("target", req.target_connection_id)):
        if conn_id is None:
            continue
        try:
            evicted.append({"role": label, "connection_id": conn_id, "ok": True,
                            "purposes": evict_compare_connectors(conn_id, force=True)})
        except Exception as exc:
            evicted.append({"role": label, "connection_id": conn_id, "ok": False, "error": f"{type(exc).__name__}: {exc!s:.200}"})
    return {"ok": True, "cancelled_jobs": cancelled, "evicted": evicted}


async def _stream_job(job):
    sent = 0
    try:
        while True:
            snap = job.snapshot(since=sent, with_children=False)
            for e in snap["events"]:
                sent = e["seq"]
                yield dumps_stream({"type": "log", "level": e["level"], "ts": e["ts"], "msg": e["msg"]})
            if job.status in ("done", "error", "cancelled") and job.result is not None:
                yield dumps_stream({"type": "result", "data": job.result})
                return
            await asyncio.sleep(0.2)
    finally:
        if job.status in ("queued", "running"):
            job.cancel()


def _streaming(job) -> StreamingResponse:
    return StreamingResponse(
        _stream_job(job), media_type="application/x-ndjson",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.post("/run/stream")
async def run_stream(req: CompareRequest):
    spec = _spec(req)
    _check_connections(spec)
    return _streaming(manager.submit_compare(spec))


@router.post("/query/run/stream")
async def run_query_stream(req: QueryCompareRequest):
    try:
        spec = from_legacy_query(req.model_dump())
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _check_connections(spec)
    return _streaming(manager.submit_compare(spec))

