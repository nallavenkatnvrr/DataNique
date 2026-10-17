"""Request models of the previous compare API (kept for compatibility:
``app.routers.compare`` converts them to ``app.engine.spec.CompareSpec``)."""
from __future__ import annotations

import json
import re

from fastapi import HTTPException
from pydantic import BaseModel, Field, StrictInt, field_validator

from app.db.store import Connection as ConnectionRecord, get_session
from app.security.sql_guard import injection_reason
from app.util_time import now_iso


# --------------------------------------------------------------------------
# Logging helper
# --------------------------------------------------------------------------

def log_line(level: str, msg: str) -> str:
    """Build an NDJSON log line that always includes a timestamp.

    The frontend's LogConsole assumes every log entry has ``ts`` (it
    formats with ``l.ts.slice(11,23)``). Engines set ts via their own
    log() helper, but the router's "engine X not installed / crashed"
    branches emit logs directly — those must go through here so they
    never crash LogConsole with a missing ts.
    """
    return json.dumps({
        "type": "log",
        "level": level,
        "ts": now_iso(),
        "msg": msg,
    }) + "\n"


def _finite_safe(obj):
    """Recursively replace non-finite floats (NaN/Inf/-Inf) with None.

    Python's ``json.dumps`` emits bare ``NaN`` / ``Infinity`` tokens for
    these — which are INVALID JSON. The browser's ``JSON.parse`` throws on
    them, so a single non-finite value (e.g. an ``AVG()`` column stat over
    all-null or overflowing data) silently drops the whole ``result`` line
    and the frontend Result tab never renders. Sanitize before dumping.
    """
    import math

    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _finite_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite_safe(v) for v in obj]
    return obj


def dumps_stream(item) -> str:
    """Serialize a stream item to a valid-JSON NDJSON line.

    Uses ``default=str`` for unknown types (parity with the previous inline
    calls) and guarantees finite floats so the line always parses in the
    browser. Always ends with a newline.
    """
    return json.dumps(_finite_safe(item), default=str) + "\n"


# --------------------------------------------------------------------------
# Request / response models
# --------------------------------------------------------------------------

class TableRef(BaseModel):
    connection_id: int
    database: str | None = None
    schema_name: str | None = None
    table: str = Field(min_length=1)
    # Free-form WHERE predicate interpolated into generated SQL. Treated as
    # TRUSTED input (see app.security.sql_guard) but screened for stacked
    # statements / comment-outs as defense-in-depth for shared deployments.
    filter_sql: str | None = None


class ColumnMapping(BaseModel):
    """One pair in an IDMC-style column map.

    * ``source`` - column name as it appears on the source table
    * ``target`` - column name as it appears on the target table
    * ``role``   - ``"key"`` (joins rows across sides) or ``"compare"``
      (included in the row hash but not in the join key)
    """
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    role: str = "compare"


class NormalizeOptions(BaseModel):
    """Granular value-normalization toggles applied before hashing.

    Representation toggles (``numbers`` / ``timestamps`` / ``booleans``)
    default ON — they remove pure cross-DB rendering artifacts that are
    never themselves a data issue. String-handling toggles default OFF
    because each can hide a REAL difference (trailing space, NULL vs '',
    case). See ``app.services.normalize.NormalizeOptions`` for semantics.
    """
    enabled: bool = False
    # representation (default ON when enabled)
    numbers: bool = True
    timestamps: bool = True
    booleans: bool = True
    # string handling (default OFF — opt-in; each can mask a real diff)
    rtrim: bool = False
    ltrim: bool = False
    case_insensitive: bool = False
    null_equals_empty: bool = False
    null_equals_blank: bool = False


class CompareRequest(BaseModel):
    source: TableRef
    target: TableRef
    key_columns: list[str] | None = None
    excluded_columns: list[str] | None = None
    include_column_stats: bool = True
    include_row_diff: bool = True
    force_row_diff: bool = False
    row_diff_sample_limit: int | None = Field(default=None, ge=0, le=10_000)
    row_diff_max_pairs: int | None = Field(default=None, ge=1, le=50_000_000)
    # --- incremental + bucket sampling ---
    incremental_column: str | None = None
    since: str | None = None
    row_diff_buckets: list[str] | None = Field(default=None, max_length=16)
    # --- explicit IDMC-style column mapping ---
    # When provided, this REPLACES the auto-by-name schema diff and the
    # key_columns/excluded_columns fields are ignored.
    column_map: list[ColumnMapping] | None = None
    # --- engine selection ---
    engine: str | None = None  # auto|standard|spark|pandas|polars|duckdb|checksum
    # Named "spark_partitions" for backward-compat; ALL parallel-capable
    # engines (spark, pandas, duckdb, polars) read this field.
    spark_partitions: int = Field(default=4, ge=1, le=128)
    # Max rows to fetch from each side. 0 = use the engine's own default.
    max_rows: int = Field(default=0, ge=0, le=100_000_000)
    # Normalize each column to a canonical string before hashing — kills
    # false hash_diff from cross-DB type-cast artifacts. Cross-DB compares.
    # LEGACY single-boolean; superseded by `normalize`. Kept for back-compat
    # with saved templates / API callers (maps to representation+trim ON).
    canonicalize_hash: bool = False
    # Granular normalization toggles. When present, REPLACES canonicalize_hash.
    normalize: NormalizeOptions | None = None
    # When False, engines skip the expensive key-match-hash-diff step.
    compute_hash_diff: bool = True
    # --- checksum-engine algorithm toggles (data-diff-style speedups) ---
    # bisection_factor > 1 enables recursive key-range (Merkle) bisection;
    # needs a single numeric key. 0/1 = flat 16-bucket pruning.
    bisection_factor: int = Field(default=0, ge=0, le=128)
    bisection_threshold: int = Field(default=50_000, ge=1, le=10_000_000)
    early_exit: bool = False           # stop at first difference (yes/no verdict)
    dual_signature: bool = False       # 2nd independent SUM signature (collision-proof)
    hll_estimate: bool = False         # HyperLogLog quick distinct-count estimate
    # Same-engine fast hashing for the in-memory engines (xxHash instead of MD5).
    # Cross-DB stays MD5 automatically. Maps to DV_HASH_ALGO at runtime.
    fast_hash: bool = False
    # When True, in-memory engines (pandas/polars) fetch source + target
    # concurrently in two threads. Helps for GIL-releasing fast paths
    # (Oracle Arrow / ConnectorX / Snowflake) but HURTS for the generic
    # pure-Python fetchmany path (GIL contention) and same-server compares.
    # Default False — fetch sequentially.
    parallel_fetch: bool = False

    @field_validator("row_diff_buckets")
    @classmethod
    def validate_row_diff_buckets(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        if any(not re.fullmatch(r"[0-9a-fA-F]", bucket) for bucket in value):
            raise ValueError("row_diff_buckets must contain hexadecimal bucket characters 0–9 and a–f")
        return [bucket.lower() for bucket in value]


class StopRequest(BaseModel):
    """Body for /stop. Both optional — a no-op if neither is given."""
    source_connection_id: int | None = None
    target_connection_id: int | None = None


class QueryRef(BaseModel):
    connection_id: int
    sql: str = Field(min_length=1)


class QueryCompareRequest(BaseModel):
    source: QueryRef
    target: QueryRef
    key_column_indices: list[StrictInt] | None = None
    max_rows: int = Field(default=1_000_000, ge=0, le=100_000_000)
    sample_limit: int = Field(default=200, ge=0, le=10_000)
    engine: str | None = None  # "auto" | "standard" | "duckdb" | "pandas" | "polars"
    canonicalize_hash: bool = False
    normalize: NormalizeOptions | None = None
    spark_partitions: int = Field(default=4, ge=1, le=128)
    compute_hash_diff: bool = True

    @field_validator("key_column_indices")
    @classmethod
    def validate_key_column_indices(cls, value: list[int] | None) -> list[int] | None:
        if value is None:
            return None
        if any(index < 0 for index in value):
            raise ValueError("key_column_indices must be nonnegative")
        if len(set(value)) != len(value):
            raise ValueError("key_column_indices must not contain duplicates")
        return value


# --------------------------------------------------------------------------
# Shared helpers
# --------------------------------------------------------------------------

def load_connection(conn_id: int) -> ConnectionRecord:
    session = get_session()
    try:
        rec = session.get(ConnectionRecord, conn_id)
        if not rec:
            raise HTTPException(404, f"Connection {conn_id} not found")
        return rec
    finally:
        session.close()


def _validate_filter(side: str, filter_sql: str | None) -> None:
    reason = injection_reason(filter_sql)
    if reason:
        raise HTTPException(
            400,
            f"Rejected {side} filter_sql: {reason}. Filters must be a single "
            f"boolean predicate (e.g. \"status = 'A' AND amount > 0\").",
        )


def validate_filters(req: CompareRequest) -> None:
    _validate_filter("source", req.source.filter_sql)
    _validate_filter("target", req.target.filter_sql)
