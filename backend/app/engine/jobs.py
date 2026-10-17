"""Background compare jobs.

Jobs run on a small thread pool and live on the server, so a run keeps going
when the user switches pages, and the UI polls ``/api/jobs/{id}`` for
progress and log lines. Every finished compare is saved (encrypted) to the
history; bulk jobs run their items with bounded concurrency.
"""
from __future__ import annotations

import logging
import threading
import time
import traceback
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.engine.spec import BulkSpec, CompareSpec
from app.util_time import now_iso, utcnow_naive

log = logging.getLogger("dv.jobs")

_MAX_EVENTS = 2000
_KEEP_FINISHED = 300


class Job:
    def __init__(self, kind: str, spec: Any, parent: "Job | None" = None, name: str | None = None):
        self.id = uuid.uuid4().hex
        self.kind = kind  # compare | bulk
        self.spec = spec
        self.parent = parent
        self.name = name
        self.status = "queued"  # queued | running | done | error | cancelled
        self.phase = "queued"
        self.message = ""
        self.rows: dict[str, int] = {}
        self.pct: dict[str, float] = {}
        self.created_at = time.time()
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self.events: deque = deque(maxlen=_MAX_EVENTS)
        self.seq = 0
        self.run_uuid: str | None = None
        self.result_summary: dict | None = None
        self.error: str | None = None
        self.children: list[Job] = []
        self.batch_uuid: str | None = None
        self._cancel = threading.Event()
        self.cancel_hooks: list = []
        self.duck: list = []
        self._lock = threading.Lock()
        self.result: dict | None = None  # full result, kept briefly for the legacy stream API
        self._labels: tuple[str, str] | None = None

    # -- events
    def emit(self, level: str, msg: str) -> None:
        with self._lock:
            self.seq += 1
            self.events.append({"seq": self.seq, "ts": now_iso(), "level": level, "msg": msg})

    def set_progress(self, phase: str | None = None, message: str | None = None, rows: dict | None = None,
                     pct: dict | None = None, **_):
        if pct:
            self.pct.update(pct)
        if phase:
            self.phase = phase
        if message is not None:
            self.message = message
        if rows:
            self.rows.update(rows)

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set() or (self.parent is not None and self.parent._cancel.is_set())

    def cancel(self) -> None:
        self._cancel.set()
        for hook in list(self.cancel_hooks):
            try:
                hook()
            except Exception:
                pass
        for con in list(self.duck):
            try:
                con.interrupt()
            except Exception:
                pass
        for c in self.children:
            c.cancel()

    def snapshot(self, since: int = 0, with_children: bool = True) -> dict:
        with self._lock:
            events = [e for e in self.events if e["seq"] > since]
        d = {
            "id": self.id,
            "kind": self.kind,
            "name": self.name,
            "status": self.status,
            "phase": self.phase,
            "message": self.message,
            "rows": dict(self.rows),
            "pct": dict(self.pct),
            "created_at": _iso(self.created_at),
            "started_at": _iso(self.started_at),
            "finished_at": _iso(self.finished_at),
            "elapsed_ms": int(((self.finished_at or time.time()) - (self.started_at or time.time())) * 1000) if self.started_at else 0,
            "run_uuid": self.run_uuid,
            "batch_uuid": self.batch_uuid,
            "summary": self.result_summary,
            "error": self.error,
            "events": events,
            "seq": self.seq,
            "parent_id": self.parent.id if self.parent else None,
        }
        if self.kind == "compare" and isinstance(self.spec, CompareSpec):
            if self._labels is None:
                self._labels = (_label(self.spec.source), _label(self.spec.target))
            d["source_label"], d["target_label"] = self._labels
        if with_children and self.children:
            d["children"] = [c.snapshot(since=10**12, with_children=False) for c in self.children]
            counts: dict[str, int] = {}
            for c in self.children:
                k = c.status if c.status != "done" else ((c.result_summary or {}).get("verdict") or "done").lower()
                counts[k] = counts.get(k, 0) + 1
            d["counts"] = counts
            d["total"] = len(self.children)
        return d


def _label(side) -> str:
    try:
        if side.kind == "file" or side.label:
            return side.display()
        from app.engine.core import _load_record
        return f"{_load_record(side.connection_id).name} · {side.display()}"
    except Exception:
        return side.display()


def _iso(t: float | None) -> str | None:
    return _utc(t).isoformat(timespec="milliseconds") + "Z" if t else None


def _utc(t: float) -> datetime:
    return datetime.fromtimestamp(t, timezone.utc).replace(tzinfo=None)


class JobManager:
    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._order: deque = deque()
        self._lock = threading.Lock()
        workers = max(1, int(getattr(settings, "max_parallel_compares", 3) or 3))
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="dv-job")
        self._bulk_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dv-bulk")

    def _register(self, job: Job) -> None:
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            finished = [jid for jid in self._order if self._jobs[jid].status in ("done", "error", "cancelled")]
            while len(finished) > _KEEP_FINISHED:
                old = finished.pop(0)
                self._order.remove(old)
                self._jobs.pop(old, None)

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def list(self, active_only: bool = False) -> list[Job]:
        with self._lock:
            jobs = [self._jobs[j] for j in self._order if j in self._jobs]
        jobs = [j for j in jobs if j.parent is None]
        if active_only:
            jobs = [j for j in jobs if j.status in ("queued", "running")]
        return list(reversed(jobs))

    # -- compare
    def submit_compare(self, spec: CompareSpec, parent: Job | None = None, batch_uuid: str | None = None,
                       inline: bool = False) -> Job:
        job = Job("compare", spec, parent=parent, name=spec.name)
        job.batch_uuid = batch_uuid
        self._register(job)
        job.emit("info", "Queued")
        if inline:
            self._run_compare(job)
        elif parent is None:
            self._pool.submit(self._run_compare, job)
        return job

    def _run_compare(self, job: Job) -> None:
        from app.engine.core import RunContext, run_compare

        if job.cancelled:
            job.status = "cancelled"
            job.finished_at = time.time()
            return
        job.status = "running"
        job.started_at = time.time()
        job.run_uuid = uuid.uuid4().hex
        rc = RunContext(
            run_uuid=job.run_uuid,
            log=job.emit,
            progress=job.set_progress,
            cancelled=lambda: job.cancelled,
            cancel_hooks=job.cancel_hooks,
            duck=job.duck,
        )
        spec: CompareSpec = job.spec
        job._labels = job._labels or (_label(spec.source), _label(spec.target))
        job.emit("info", f"Comparing {job._labels[0]} → {job._labels[1]}")
        result: dict
        try:
            result = run_compare(spec, rc)
            job.status = "done"
            job.emit("info", f"Verdict: {result.get('verdict')} in {result.get('elapsed_ms', 0) / 1000:.2f}s")
        except InterruptedError:
            job.status = "cancelled"
            job.emit("warn", "Cancelled")
            result = _error_result(job, spec, "Cancelled", status="CANCELLED")
        except Exception as exc:
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"[:2000]
            log.exception("compare job %s failed", job.id)
            job.emit("error", job.error)
            result = _error_result(job, spec, job.error, tb=traceback.format_exc())
        finally:
            job.finished_at = time.time()
            job.phase = "finished"
        result["logs"] = [{"level": e["level"], "ts": e["ts"], "msg": e["msg"]} for e in job.events]
        job.result = result
        job.result_summary = _summary(result)
        try:
            persist_run(result, spec, job.batch_uuid)
        except Exception as exc:
            log.exception("could not save run")
            job.emit("warn", f"The run finished but could not be saved to history: {exc}")
        if job.status != "done":
            _drop_store(job.run_uuid)

    # -- bulk
    def submit_bulk(self, spec: BulkSpec) -> Job:
        parent = Job("bulk", spec, name=spec.name or f"Bulk compare ({len(spec.items)} pairs)")
        parent.batch_uuid = uuid.uuid4().hex
        for item in spec.items:
            child = Job("compare", item, parent=parent, name=item.name)
            child.batch_uuid = parent.batch_uuid
            parent.children.append(child)
        self._register(parent)
        for c in parent.children:
            self._register(c)
        parent.emit("info", f"Queued {len(parent.children)} comparisons, {spec.concurrency} at a time")
        self._bulk_pool.submit(self._run_bulk, parent)
        return parent

    def _run_bulk(self, parent: Job) -> None:
        spec: BulkSpec = parent.spec
        parent.status = "running"
        parent.started_at = time.time()
        _save_batch(parent, "RUNNING")
        sem = threading.Semaphore(spec.concurrency)
        threads = []
        stop = threading.Event()

        def run_child(child: Job):
            try:
                if stop.is_set() or parent.cancelled:
                    child.status = "cancelled"
                    child.finished_at = time.time()
                    return
                self._run_compare(child)
                if child.status == "error" and spec.stop_on_error:
                    stop.set()
                    parent.emit("warn", "Stopping: an item failed and 'stop on error' is on")
                v = (child.result_summary or {}).get("verdict") or child.status
                parent.emit("info" if child.status == "done" else "warn", f"{child.name or _label(child.spec.source)}: {v}")
            finally:
                sem.release()

        for child in parent.children:
            sem.acquire()
            if parent.cancelled or stop.is_set():
                sem.release()
                child.status = "cancelled"
                child.finished_at = time.time()
                continue
            t = threading.Thread(target=run_child, args=(child,), name="dv-bulk-item", daemon=True)
            t.start()
            threads.append(t)
            parent.set_progress(phase="running", message=f"{sum(1 for c in parent.children if c.status in ('done', 'error', 'cancelled'))}/{len(parent.children)} finished")
        for t in threads:
            t.join()
        parent.finished_at = time.time()
        parent.status = "cancelled" if parent.cancelled else "done"
        parent.phase = "finished"
        counts = parent.snapshot(with_children=True).get("counts", {})
        parent.result_summary = {"counts": counts, "total": len(parent.children)}
        parent.emit("info", "Finished: " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
        _save_batch(parent, "CANCELLED" if parent.cancelled else "SUCCESS")


def _error_result(job: Job, spec: CompareSpec, error: str, status: str = "ERROR", tb: str | None = None) -> dict:
    return {
        "schema_version": 2,
        "run_uuid": job.run_uuid,
        "engine": "v2",
        "status": status,
        "verdict": "ERROR" if status == "ERROR" else "CANCELLED",
        "error": error,
        "traceback": (tb or "")[-4000:] or None,
        "started_at": _iso(job.started_at),
        "finished_at": now_iso(),
        "elapsed_ms": int((time.time() - (job.started_at or time.time())) * 1000),
        "source": {"label": _label(spec.source), "kind": spec.source.kind},
        "target": {"label": _label(spec.target), "kind": spec.target.kind},
        "options": spec.options.model_dump(),
    }


def _summary(result: dict) -> dict:
    from app.security.vault_migrate import run_summary
    return run_summary(result)


def _kind(spec: CompareSpec) -> str:
    kinds = {spec.source.kind, spec.target.kind}
    return kinds.pop() if len(kinds) == 1 else "mixed"


def persist_run(result: dict, spec: CompareSpec, batch_uuid: str | None) -> None:
    from app.db.store import CompareRun, get_session, init_db

    init_db()
    s = get_session()
    try:
        started = result.get("started_at")
        finished = result.get("finished_at")
        cr = CompareRun(
            run_uuid=result["run_uuid"],
            status=result.get("status", "UNKNOWN"),
            verdict=result.get("verdict"),
            kind=_kind(spec),
            batch_id=batch_uuid,
            source_connection_id=spec.source.connection_id or 0,
            target_connection_id=spec.target.connection_id or 0,
            source_label=(result.get("source") or {}).get("label") or _label(spec.source),
            target_label=(result.get("target") or {}).get("label") or _label(spec.target),
            options={"spec": spec.model_dump(), **spec.options.model_dump()},
            summary=_summary(result),
            result=result,
            error=result.get("error"),
            started_at=datetime.fromisoformat(started.replace("Z", "")) if started else utcnow_naive(),
            finished_at=datetime.fromisoformat(finished.replace("Z", "")) if finished else utcnow_naive(),
        )
        s.add(cr)
        s.commit()
    finally:
        s.close()


def _save_batch(parent: Job, status: str) -> None:
    from app.db.store import CompareBatch, get_session, init_db

    try:
        init_db()
        s = get_session()
        try:
            b = s.query(CompareBatch).filter(CompareBatch.batch_uuid == parent.batch_uuid).first()
            if b is None:
                b = CompareBatch(batch_uuid=parent.batch_uuid, name=parent.name,
                                 started_at=_utc(parent.started_at or time.time()))
                s.add(b)
            b.status = status
            b.summary = {
                "total": len(parent.children),
                "counts": parent.snapshot(with_children=True).get("counts", {}),
                "spec": parent.spec.model_dump(),
                "runs": [c.run_uuid for c in parent.children],
            }
            if status != "RUNNING":
                b.finished_at = utcnow_naive()
            s.commit()
        finally:
            s.close()
    except Exception:
        log.exception("could not save batch")


def _drop_store(run_uuid: str | None) -> None:
    from app.engine.core import drop_store
    drop_store(run_uuid)


manager = JobManager()
