"""Request models for the compare engine.

One ``CompareSpec`` describes any comparison: each side is a table, a SQL
query or a file, so table vs table, query vs table, file vs table and file
vs file all go through the same engine. ``BulkSpec`` runs many specs.
"""
from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.security.sql_guard import injection_reason

DEFAULT_EXCLUDED_COLUMNS = {
    "INFA_LAST_REPLICATED", "INFA_OPERATION_SEQUENCE", "INFA_TRANSACTION_ID",
    "INFA_OPERATION_OWNER", "INFA_OPERATION_TIME", "INFA_OPERATION_TYPE",
    "SOURCE_UPDATE_TMSTP", "SOURCE_INSERT_TMSTP", "SOURCE_SYSTEM_CODE",
    "UPDATE_TMSTP", "INSERT_TMSTP",
}

FILE_FORMATS = (
    "csv", "excel", "parquet", "json", "avro", "orc", "arrow", "fixed",
)


class FixedWidthColumn(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    width: int = Field(ge=1, le=100_000)


class FileOptions(BaseModel):
    """Reader options; anything left empty is auto-detected."""
    # csv / text
    delimiter: str | None = Field(default=None, max_length=8)
    header: bool | None = None
    quote: str | None = Field(default=None, max_length=1)
    escape: str | None = Field(default=None, max_length=1)
    encoding: str | None = Field(default=None, max_length=32)
    skip_rows: int = Field(default=0, ge=0, le=1_000_000)
    null_values: list[str] | None = None
    date_format: str | None = Field(default=None, max_length=64)
    timestamp_format: str | None = Field(default=None, max_length=64)
    decimal_separator: str | None = Field(default=None, max_length=1)
    # Read every column as text (no type sniffing).
    all_varchar: bool = False
    # excel
    sheet: str | None = Field(default=None, max_length=256)
    # json
    json_format: Literal["auto", "array", "newline_delimited"] = "auto"
    # fixed width
    fixed_columns: list[FixedWidthColumn] | None = None
    # first member of a .zip, or a specific member
    zip_member: str | None = None


class SideSpec(BaseModel):
    kind: Literal["table", "query", "file"] = "table"
    # database sides
    connection_id: int | None = None
    database: str | None = None
    schema_name: str | None = None
    table: str | None = None
    filter_sql: str | None = None
    sql: str | None = None
    # file sides: an uploaded file id, or a path on the machine running the app
    file_id: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")
    path: str | None = None
    format: str | None = None
    options: FileOptions = Field(default_factory=FileOptions)
    label: str | None = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def _check(self):
        if self.kind in ("table", "query") and not self.connection_id:
            raise ValueError("connection_id is required for table and query sides")
        if self.kind == "table" and not (self.table or "").strip():
            raise ValueError("table is required")
        if self.kind == "query" and not (self.sql or "").strip():
            raise ValueError("sql is required")
        if self.kind == "file" and not (self.file_id or self.path):
            raise ValueError("file_id or path is required for a file side")
        if self.format and self.format not in FILE_FORMATS:
            raise ValueError(f"format must be one of {', '.join(FILE_FORMATS)}")
        reason = injection_reason(self.filter_sql)
        if reason:
            raise ValueError(f"filter_sql rejected: {reason}")
        return self

    def display(self) -> str:
        if self.label:
            return self.label
        if self.kind == "file":
            return (self.path or self.file_id or "file").replace("\\", "/").rsplit("/", 1)[-1]
        if self.kind == "query":
            q = " ".join((self.sql or "").split())
            return q[:80] + ("…" if len(q) > 80 else "")
        parts = [p for p in (self.database, self.schema_name, self.table) if p]
        return ".".join(parts)


class ColumnPair(BaseModel):
    source: str = Field(min_length=1)
    target: str = Field(min_length=1)
    role: Literal["key", "compare", "ignore"] = "compare"


class Normalize(BaseModel):
    """How values are made comparable before diffing.

    Representation rules are on by default: they remove differences that are
    only formatting (12.50 vs 12.5, a DATE vs a midnight TIMESTAMP, 1 vs
    true, '42' vs 42). String rules are off by default because each can hide
    a real difference.
    """
    numbers: bool = True
    timestamps: bool = True
    booleans: bool = True
    rtrim: bool = False
    ltrim: bool = False
    case_insensitive: bool = False
    null_equals_empty: bool = False
    null_equals_blank: bool = False
    # absolute tolerance for floating point / decimal comparisons (0 = exact)
    numeric_tolerance: float = Field(default=0.0, ge=0.0)
    # truncate timestamps before comparing
    timestamp_precision: Literal["us", "ms", "s", "min", "day"] = "us"


class CompareOptions(BaseModel):
    key_columns: list[str] | None = None
    # 0-based positions of key columns on the source side (alternative to names)
    key_positions: list[int] | None = None
    # None = default exclusions (replication audit columns); [] = none
    excluded_columns: list[str] | None = None
    column_map: list[ColumnPair] | None = None
    match_columns: Literal["name", "position"] = "name"
    auto_key: bool = True
    normalize: Normalize = Field(default_factory=Normalize)
    # local = read both sides into the engine; in_database = diff inside the
    # database when both sides are on one connection; auto picks.
    strategy: Literal["auto", "local", "in_database"] = "auto"
    column_stats: bool = True
    # approximate distinct counts in the column statistics (slower)
    distinct_counts: bool = False
    sample_limit: int = Field(default=50, ge=0, le=1000)
    store_diffs: bool = True
    max_stored_rows: int = Field(default=5_000_000, ge=0, le=500_000_000)
    max_rows: int = Field(default=0, ge=0, le=2_000_000_000)
    incremental_column: str | None = None
    since: str | None = None
    # parallel readers per side for databases without a parallel scanner
    parallel_reads: int = Field(default=0, ge=0, le=16)
    # line endings, BOM, trailing spaces and checksums for two text files
    file_checks: bool = True

    @field_validator("incremental_column")
    @classmethod
    def _ident(cls, v):
        if v is not None and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$#. \"]{0,127}", v):
            raise ValueError("incremental_column must be a column name")
        return v


class CompareSpec(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    source: SideSpec
    target: SideSpec
    options: CompareOptions = Field(default_factory=CompareOptions)


class BulkSpec(BaseModel):
    name: str | None = Field(default=None, max_length=256)
    items: list[CompareSpec] = Field(min_length=1, max_length=5000)
    concurrency: int = Field(default=2, ge=1, le=16)
    stop_on_error: bool = False


# ---------------------------------------------------------------------------
# Legacy request shapes (saved templates, scripts calling the old API)
# ---------------------------------------------------------------------------
def from_legacy_compare(payload: dict) -> CompareSpec:
    """Convert an old ``CompareRequest`` dict to a ``CompareSpec``."""
    if "options" in payload and isinstance(payload.get("source"), dict) and "kind" in payload["source"]:
        return CompareSpec.model_validate(payload)

    def side(d: dict) -> SideSpec:
        return SideSpec(
            kind="table",
            connection_id=d.get("connection_id"),
            database=d.get("database"),
            schema_name=d.get("schema_name"),
            table=d.get("table"),
            filter_sql=d.get("filter_sql"),
        )

    norm = Normalize()
    n = payload.get("normalize")
    if isinstance(n, dict) and n.get("enabled"):
        norm = Normalize(**{k: v for k, v in n.items() if k in Normalize.model_fields})
    elif payload.get("canonicalize_hash"):
        norm = Normalize(rtrim=True, ltrim=True)
    cmap = payload.get("column_map")
    opts = CompareOptions(
        key_columns=payload.get("key_columns") or None,
        excluded_columns=payload.get("excluded_columns"),
        column_map=[ColumnPair(**m) for m in cmap] if cmap else None,
        normalize=norm,
        column_stats=payload.get("include_column_stats", True),
        sample_limit=min(int(payload.get("row_diff_sample_limit") or 50), 1000),
        max_rows=int(payload.get("max_rows") or 0),
        incremental_column=payload.get("incremental_column"),
        since=payload.get("since"),
    )
    return CompareSpec(source=side(payload["source"]), target=side(payload["target"]), options=opts)


def from_legacy_query(payload: dict) -> CompareSpec:
    src, tgt = payload["source"], payload["target"]
    return CompareSpec(
        source=SideSpec(kind="query", connection_id=src["connection_id"], sql=src["sql"]),
        target=SideSpec(kind="query", connection_id=tgt["connection_id"], sql=tgt["sql"]),
        options=CompareOptions(
            key_positions=payload.get("key_column_indices") or None,
            sample_limit=min(int(payload.get("sample_limit") or 50), 1000),
            max_rows=int(payload.get("max_rows") or 0),
        ),
    )
