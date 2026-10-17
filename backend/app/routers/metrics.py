"""Dashboard metrics: aggregate stats over compare runs.

Read-only aggregates for a dashboard view - totals, verdict breakdown,
recent activity, and per-engine usage. All derived from the ``compare_runs``
table; nothing here mutates state.
"""
from __future__ import annotations

from collections import Counter
from datetime import timedelta

from fastapi import APIRouter

from sqlalchemy.orm import defer

from app.db.store import CompareRun, CompareTemplate, get_session
from app.util_time import utcnow_naive


router = APIRouter(prefix="/api/metrics", tags=["metrics"])


@router.get("/dashboard")
def dashboard(days: int = 30) -> dict:
    """Aggregate compare-run metrics for the last ``days`` days.

    Returns totals, verdict/status breakdowns, per-engine usage, average
    duration, a daily activity sparkline, and the most-recent runs.
    """
    if days <= 0:
        days = 30
    cutoff = utcnow_naive() - timedelta(days=days)

    session = get_session()
    try:
        rows = (
            session.query(CompareRun)
            .options(defer(CompareRun.result), defer(CompareRun.options))
            .filter(CompareRun.started_at >= cutoff)
            .order_by(CompareRun.started_at.desc())
            .all()
        )
        template_count = session.query(CompareTemplate).count()
    finally:
        session.close()

    total = len(rows)
    verdicts: Counter = Counter()
    statuses: Counter = Counter()
    engines: Counter = Counter()
    elapsed_values: list[int] = []
    daily: Counter = Counter()
    rows_compared = 0

    summaries = {}
    for r in rows:
        res = r.summary or {}
        summaries[r.run_uuid] = res
        statuses[(r.status or "UNKNOWN").upper()] += 1
        verdict = (r.verdict or res.get("verdict") or r.status or "UNKNOWN")
        verdicts[str(verdict).upper()] += 1
        engine = res.get("engine") or "legacy"
        engines[str(engine).lower()] += 1
        ev = res.get("elapsed_ms")
        if isinstance(ev, (int, float)) and ev >= 0:
            elapsed_values.append(int(ev))
        day_key = r.started_at.strftime("%Y-%m-%d")
        daily[day_key] += 1
        for k in ("source_rows", "target_rows"):
            rc = res.get(k)
            if isinstance(rc, (int, float)):
                rows_compared += int(rc)

    match_count = verdicts.get("MATCH", 0) + verdicts.get("IDENTICAL", 0) + verdicts.get("SUCCESS", 0)
    mismatch_count = verdicts.get("MISMATCH", 0) + verdicts.get("DIFF", 0) + verdicts.get("DIFFERENT", 0)
    error_count = statuses.get("ERROR", 0)

    avg_elapsed_ms = int(sum(elapsed_values) / len(elapsed_values)) if elapsed_values else 0

    # Build a dense daily series across the window (fill gaps with 0).
    series: list[dict] = []
    for i in range(days - 1, -1, -1):
        d = (utcnow_naive() - timedelta(days=i)).strftime("%Y-%m-%d")
        series.append({"date": d, "count": daily.get(d, 0)})

    recent = [
        {
            "run_uuid": r.run_uuid,
            "status": r.status,
            "verdict": r.verdict or summaries[r.run_uuid].get("verdict"),
            "engine": summaries[r.run_uuid].get("engine"),
            "kind": r.kind,
            "source_label": r.source_label,
            "target_label": r.target_label,
            "started_at": r.started_at.isoformat() + "Z",
            "elapsed_ms": summaries[r.run_uuid].get("elapsed_ms"),
            "summary": summaries[r.run_uuid],
        }
        for r in rows[:12]
    ]

    return {
        "window_days": days,
        "total_runs": total,
        "match_count": match_count,
        "mismatch_count": mismatch_count,
        "error_count": error_count,
        "success_rate": round(match_count / total, 4) if total else 0.0,
        "avg_elapsed_ms": avg_elapsed_ms,
        "total_rows_compared": rows_compared,
        "template_count": template_count,
        "verdict_breakdown": dict(verdicts),
        "status_breakdown": dict(statuses),
        "engine_usage": dict(engines),
        "daily_activity": series,
        "recent_runs": recent,
    }
