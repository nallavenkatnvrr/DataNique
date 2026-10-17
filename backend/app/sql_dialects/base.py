from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable


HEX_CHARS = "0123456789abcdef"


def _normalize_buckets(buckets: Iterable[str] | None) -> list[str]:
    """Filter to the 16 valid hex chars; lowercased; de-duplicated; sorted.

    Inputs that aren't already exactly one hex char are rejected (so e.g.
    ``"bogus"`` is dropped rather than silently truncated to ``"b"``).
    """
    if not buckets:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for b in buckets:
        if not b:
            continue
        c = str(b).strip().lower()
        if len(c) == 1 and c in HEX_CHARS and c not in seen:
            seen.add(c)
            out.append(c)
    return sorted(out)


class SqlDialect(ABC):
    name: str = "base"
    supports_information_schema: bool = True
    supports_approx_distinct: bool = False
    # When True the dialect implements ``hash_prefix_to_int`` with a recipe
    # that produces the SAME 56-bit integer on every dialect for the same
    # lowercase-MD5 hex string. This lets the in-DB checksum engine compare
    # per-bucket SUM checksums across heterogeneous databases and SKIP buckets
    # that match (no row transfer). Dialects without it fall back to a full
    # (correct, but no-skip) diff.
    supports_checksum_bucketing: bool = False
    # When True a single connection can reference two DIFFERENT databases in
    # one SQL statement (so the same-endpoint SQL JOIN path is valid even when
    # the two tables live in different databases). SQL Server (3-part naming),
    # Snowflake (cross-db), MySQL (db.table), and Oracle (schema-scoped, DB
    # name ignored) all qualify. Postgres does NOT - a connection is bound to
    # one database - so it overrides this to False, forcing the cross-DB
    # sort-merge path when the databases differ.
    supports_cross_database_join: bool = True

    def ping_sql(self) -> str:
        return "SELECT 1"

    def quote_ident(self, ident: str) -> str:
        return '"' + ident.replace('"', '""') + '"'

    def fq_table(self, database: str | None, schema: str | None, table: str) -> str:
        parts = [p for p in (database, schema, table) if p]
        return ".".join(self.quote_ident(p) for p in parts)

    def cast_to_string(self, expr: str) -> str:
        return f"CAST({expr} AS VARCHAR(4000))"

    # --- string-normalization primitives (overridable per dialect) ---
    # LTRIM(RTRIM(x)) is used for full trim rather than TRIM() because
    # TRIM() isn't available on every supported DB/version (e.g. older
    # SQL Server). LTRIM / RTRIM are universal.
    def trim_expr(self, expr: str) -> str:
        return f"LTRIM(RTRIM({expr}))"

    def ltrim_expr(self, expr: str) -> str:
        return f"LTRIM({expr})"

    def rtrim_expr(self, expr: str) -> str:
        return f"RTRIM({expr})"

    def upper_expr(self, expr: str) -> str:
        return f"UPPER({expr})"

    def _escape_serialized_string(self, expr: str) -> str:
        """Escape reserved text so field separators and NULL cannot collide."""
        escaped = expr
        for char, replacement in (("%", "%25"), ("|", "%7C"),
                                  ("<", "%3C"), (">", "%3E")):
            escaped = f"REPLACE({escaped}, '{char}', '{replacement}')"
        return escaped

    def coalesce_string(self, col: str, normalize=None) -> str:
        """Return the shared NULL-safe, unambiguous serialized value.

        ``normalize`` is passed explicitly per query so cached dialect
        instances never retain one request's options or race with another
        comparison. The standard in-database engine supports the
        type-independent transforms here; materialized engines also normalize
        numbers/timestamps using their column types.
        """
        from app.services.normalize import NULL_SENTINEL
        opts = normalize
        base = self.cast_to_string(col)
        if opts is not None and getattr(opts, "enabled", False):
            if opts.ltrim and opts.rtrim:
                base = self.trim_expr(base)
            elif opts.ltrim:
                base = self.ltrim_expr(base)
            elif opts.rtrim:
                base = self.rtrim_expr(base)
            if opts.case_insensitive:
                base = self.upper_expr(base)

        serialized = self._escape_serialized_string(base)
        if opts is not None and getattr(opts, "enabled", False) and (
            opts.null_equals_empty or opts.null_equals_blank
        ):
            conds = [f"{col} IS NULL"]
            if opts.null_equals_empty:
                conds.append(f"({base}) = ''")
            if opts.null_equals_blank:
                conds.append(f"{self.trim_expr(self.cast_to_string(col))} = ''")
            cond = " OR ".join(conds)
            return f"CASE WHEN {cond} THEN '{NULL_SENTINEL}' ELSE ({serialized}) END"
        return f"CASE WHEN {col} IS NULL THEN '{NULL_SENTINEL}' ELSE ({serialized}) END"

    def md5_hex(self, expr: str) -> str:
        return f"LOWER(MD5({expr}))"

    def substr(self, expr: str, start: int, length: int) -> str:
        return f"SUBSTR({expr}, {start}, {length})"

    def limit_clause(self, n: int) -> str:
        return f"LIMIT {int(n)}"

    def concat_with_sep(self, parts: list[str], sep: str = "||") -> str:
        if not parts:
            return "''"
        sep_lit = "'" + sep.replace("'", "''") + "'"
        return (f" || {sep_lit} || ").join(parts)

    def approx_distinct(self, q_col: str) -> str:
        """Return an APPROX_COUNT_DISTINCT-flavoured expression for the column."""
        return f"COUNT(DISTINCT {q_col})"

    def row_hash_expr(self, columns: Iterable[str], normalize=None) -> str:
        parts = [self.coalesce_string(c, normalize=normalize) for c in columns]
        joined = self.concat_with_sep(parts, "||") if parts else "''"
        return self.md5_hex(joined)

    def aggregate_hash_sql(
        self,
        fq_table: str,
        columns: list[str],
        filter_sql: str | None = None,
        normalize=None,
    ) -> str:
        row_hash = self.row_hash_expr(columns, normalize=normalize)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        bucket_cols = ",\n  ".join(
            f"SUM(CASE WHEN {self.substr('row_hash', 1, 1)} = '{c}' THEN 1 ELSE 0 END) AS b_{c}"
            for c in HEX_CHARS
        )
        return f"""
SELECT
  COUNT(*) AS row_count,
  MIN(row_hash) AS min_hash,
  MAX(row_hash) AS max_hash,
  {bucket_cols}
FROM (
  SELECT {row_hash} AS row_hash
  FROM {fq_table}
  {where}
) sub
""".strip()

    def hash_prefix_to_int(self, hash_expr: str, start: int = 1) -> str:
        """Parse 14 hex chars (56-bit, always positive) of a lowercase-MD5 hex
        string into an INTEGER, beginning at 1-based offset ``start``.

        Must yield the SAME integer on every dialect for the same hex string,
        so the in-DB checksum engine can compare per-bucket SUM checksums
        across heterogeneous databases. ``start=1`` reads chars 1..14; ``start=
        15`` reads chars 15..28 - two INDEPENDENT 56-bit signatures of the same
        128-bit MD5, used together (dual signature) to drive bucket-collision
        odds to effectively zero. Only dialects with
        ``supports_checksum_bucketing = True`` override this. The base raises
        so misuse is caught loudly.
        """
        raise NotImplementedError(
            f"{self.name} dialect does not support checksum bucketing"
        )

    def _chk_exprs(self, dual: bool) -> tuple[str, str]:
        """Return ``(chk1_sql, chk2_sql)`` SUM-checksum expressions over the
        ``row_hash`` alias. ``chk2`` is NULL unless ``dual`` is set and the
        dialect supports checksum bucketing."""
        if not self.supports_checksum_bucketing:
            return "CAST(NULL AS DECIMAL(38,0))", "CAST(NULL AS DECIMAL(38,0))"
        chk1 = f"SUM(CAST({self.hash_prefix_to_int('row_hash', 1)} AS DECIMAL(38,0)))"
        if dual:
            chk2 = f"SUM(CAST({self.hash_prefix_to_int('row_hash', 15)} AS DECIMAL(38,0)))"
        else:
            chk2 = "CAST(NULL AS DECIMAL(38,0))"
        return chk1, chk2

    def _row_hash_for(
        self, key_columns: list[str], all_columns: list[str], normalize=None,
    ) -> str:
        non_key_cols = [c for c in all_columns if c not in key_columns]
        row_cols = non_key_cols if non_key_cols else all_columns
        return self.row_hash_expr(
            [self.quote_ident(c) for c in row_cols], normalize=normalize,
        )

    def bucketed_fingerprint_sql(
        self,
        fq_table: str,
        key_columns: list[str],
        all_columns: list[str],
        filter_sql: str | None = None,
        dual: bool = False,
        normalize=None,
    ) -> str:
        """Per-bucket in-DB fingerprint: one row per first-hex-char bucket with
        ``(bucket, cnt, chk, chk2)``.

        ``cnt`` is the row count in that bucket; ``chk``/``chk2`` are
        order-independent SUM signatures of the row hashes (``chk2`` only when
        ``dual``). The engine compares these <=16 small rows per side to decide
        which buckets to drill - buckets whose ``(cnt, chk, chk2)`` match on
        both sides are trusted identical and never transferred.
        """
        # Fingerprints must include the key as well as payload columns: if
        # keys change while payload stays the same, pruning that bucket would
        # otherwise hide a real difference.
        row_hash = self.row_hash_expr(
            [self.quote_ident(c) for c in all_columns], normalize=normalize,
        )
        where = f"WHERE {filter_sql}" if filter_sql else ""
        bucket = self.substr("row_hash", 1, 1)
        chk1, chk2 = self._chk_exprs(dual)
        return f"""
SELECT {bucket} AS bucket, COUNT(*) AS cnt, {chk1} AS chk, {chk2} AS chk2
FROM (
  SELECT {row_hash} AS row_hash
  FROM {fq_table}
  {where}
) sub
GROUP BY {bucket}
""".strip()

    def key_minmax_sql(
        self,
        fq_table: str,
        key_column: str,
        filter_sql: str | None = None,
    ) -> str:
        """Return min/max, total rows, and non-NULL keys for numeric bisection."""
        q = self.quote_ident(key_column)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        return (
            f"SELECT MIN({q}) AS lo, MAX({q}) AS hi, COUNT(*) AS cnt, "
            f"COUNT({q}) AS non_null_cnt FROM {fq_table} {where}"
        ).strip()

    def range_fingerprint_sql(
        self,
        fq_table: str,
        key_column: str,
        all_columns: list[str],
        lo,
        hi,
        factor: int,
        filter_sql: str | None = None,
        dual: bool = False,
        include_hi: bool = True,
        normalize=None,
    ) -> str:
        """Split a numeric key range into ``factor`` sub-ranges.

        Bounds are kept as decimal values instead of being coerced to ``int``;
        fractional keys therefore retain their actual range. Non-final ranges
        are half-open so a key exactly on a split boundary belongs to one
        segment only. Fingerprints include the complete compared row, including
        the key, so a key-only change cannot be pruned.
        """
        from decimal import Decimal, localcontext

        if factor < 1:
            raise ValueError("factor must be positive")

        def _literal(value) -> tuple[Decimal, str]:
            number = Decimal(str(value))
            if not number.is_finite():
                raise ValueError(f"non-finite numeric key bound: {value!r}")
            if number == 0:
                return number, "0"
            text = format(number, "f")
            if "." in text:
                text = text.rstrip("0").rstrip(".")
            return number, text

        low, low_sql = _literal(lo)
        high, high_sql = _literal(hi)
        if high < low:
            raise ValueError("key range upper bound is below lower bound")
        with localcontext() as ctx:
            ctx.prec = 38
            span = high - low
            seg_size = span / Decimal(factor) if span else Decimal(1)
        seg_size_sql = format(seg_size, "f")
        if "." in seg_size_sql:
            seg_size_sql = seg_size_sql.rstrip("0").rstrip(".")
        if seg_size == 0:
            seg_size_sql = "1"

        q = self.quote_ident(key_column)
        row_hash = self.row_hash_expr(
            [self.quote_ident(c) for c in all_columns], normalize=normalize,
        )
        floored = f"FLOOR(({q} - {low_sql}) / {seg_size_sql})"
        seg_expr = (
            f"CASE WHEN {floored} >= {factor} THEN {factor - 1} "
            f"ELSE {floored} END"
        )
        upper_op = "<=" if include_hi else "<"
        range_pred = f"{q} >= {low_sql} AND {q} {upper_op} {high_sql}"
        where_inner = f"({range_pred})" + (f" AND ({filter_sql})" if filter_sql else "")
        chk1, chk2 = self._chk_exprs(dual)
        return f"""
SELECT seg, COUNT(*) AS cnt, {chk1} AS chk, {chk2} AS chk2
FROM (
  SELECT {seg_expr} AS seg, {row_hash} AS row_hash
  FROM {fq_table}
  WHERE {where_inner}
) sub
GROUP BY seg
""".strip()

    def approx_distinct_sql(
        self,
        fq_table: str,
        key_column: str,
        filter_sql: str | None = None,
    ) -> str:
        """HyperLogLog-style approximate distinct count of the key - an instant
        cardinality estimate for the quick-estimate pre-pass."""
        q = self.quote_ident(key_column)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        distinct = self.approx_distinct(q) if self.supports_approx_distinct else f"COUNT(DISTINCT {q})"
        return f"SELECT {distinct} AS approx_distinct, COUNT(*) AS cnt FROM {fq_table} {where}".strip()

    # ---------- Column stats: legacy per-column path (back-compat) ----------

    def column_stats_sql(
        self,
        fq_table: str,
        column: dict,
        filter_sql: str | None = None,
    ) -> str:
        name = column["name"]
        q = self.quote_ident(name)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        is_numeric = column.get("is_numeric", False)
        avg_expr = f"AVG(CAST({q} AS DOUBLE PRECISION))" if is_numeric else "NULL"
        return f"""
SELECT
  COUNT(*) AS total_rows,
  COUNT({q}) AS non_null_count,
  COUNT(*) - COUNT({q}) AS null_count,
  COUNT(DISTINCT {q}) AS distinct_count,
  {self.cast_to_string(f"MIN({q})")} AS min_val,
  {self.cast_to_string(f"MAX({q})")} AS max_val,
  {avg_expr} AS avg_val
FROM {fq_table}
{where}
""".strip()

    # ---------- Column stats: batched (one SQL per side, many columns) ----------

    def column_stats_batch_sql(
        self,
        fq_table: str,
        columns: list[dict],
        filter_sql: str | None = None,
        use_approx_distinct: bool = True,
    ) -> str:
        if not columns:
            return "SELECT 0 AS total_rows"
        where = f"WHERE {filter_sql}" if filter_sql else ""
        parts = ["COUNT(*) AS total_rows"]
        for i, col in enumerate(columns):
            q = self.quote_ident(col["name"])
            is_numeric = bool(col.get("is_numeric"))
            distinct_expr = (
                self.approx_distinct(q) if use_approx_distinct and self.supports_approx_distinct
                else f"COUNT(DISTINCT {q})"
            )
            avg_expr = f"AVG(CAST({q} AS DOUBLE PRECISION))" if is_numeric else "CAST(NULL AS DOUBLE PRECISION)"
            parts.append(f"COUNT({q}) AS nn_{i}")
            parts.append(f"{distinct_expr} AS dc_{i}")
            parts.append(f"{self.cast_to_string(f'MIN({q})')} AS mn_{i}")
            parts.append(f"{self.cast_to_string(f'MAX({q})')} AS mx_{i}")
            parts.append(f"{avg_expr} AS av_{i}")
            parts.append(f"CAST(NULL AS VARCHAR(1)) AS pad_{i}")
        sel = ",\n  ".join(parts)
        return f"SELECT\n  {sel}\nFROM {fq_table}\n{where}".strip()

    def sample_rows_sql(
        self,
        fq_table: str,
        columns: list[str],
        limit: int,
        filter_sql: str | None = None,
    ) -> str:
        cols = ", ".join(self.quote_ident(c) for c in columns)
        where = f"WHERE {filter_sql}" if filter_sql else ""
        return f"SELECT {cols} FROM {fq_table} {where} {self.limit_clause(limit)}"

    def key_hash_pairs_sql(
        self,
        fq_table: str,
        key_columns: list[str],
        all_columns: list[str],
        filter_sql: str | None = None,
        order_by_key: bool = False,
        bucket_filter: list[str] | None = None,
        stable_order: bool = False,
        normalize=None,
    ) -> str:
        """Emit ``(key_val, row_hash)`` pairs for every row in the table.

        Parameters
        ----------
        bucket_filter
            Optional list of hex chars (``"0".."f"``). When provided, the SQL
            wraps the inner query and adds ``WHERE SUBSTR(row_hash, 1, 1) IN (...)``,
            so only rows whose hash starts with one of the listed buckets are
            returned. Used by the engine to drill into a subset of the row
            space during investigation, cutting cross-DB data transfer by up
            to 16x (sampling one bucket).
        order_by_key
            When ``True``, append ``ORDER BY key_val`` so the caller can do a
            sort-merge on the streaming results.
        stable_order
            When ``True`` (used by the cross-DB sort-merge), emit THREE columns
            ``(key_sort, key_val, row_hash)`` and order by ``key_sort`` - where
            ``key_sort`` is ``LOWER(MD5(key_val))``, a lowercase hex string.

            WHY: a raw cross-DB sort-merge ordered the streams by ``key_val``
            and merged them with a Python ``<`` comparison. That silently
            BREAKS when the two databases order strings differently - a
            case/accent-insensitive collation on one side, a byte/code-point
            collation on the other, ``NULL`` ordering, or numeric-vs-text key
            rendering - producing phantom only-in-source / only-in-target rows.
            A lowercase-hex MD5 contains only ``[0-9a-f]``, which sorts
            IDENTICALLY under every common collation AND matches Python's
            code-point comparison, so both sides and the merge agree. The
            serialized key and row hash break ties deterministically, including
            duplicate keys with different row contents.
        """
        key_parts = [
            self.coalesce_string(self.quote_ident(k), normalize=normalize)
            for k in key_columns
        ]
        key_expr = self.concat_with_sep(key_parts, "||") if key_parts else "''"
        non_key_cols = [c for c in all_columns if c not in key_columns]
        row_cols = non_key_cols if non_key_cols else all_columns
        row_hash = self.row_hash_expr(
            [self.quote_ident(c) for c in row_cols], normalize=normalize,
        )
        where = f"WHERE {filter_sql}" if filter_sql else ""

        if stable_order:
            key_sort = self.md5_hex(key_expr)
            output_cols = "key_sort, key_val, row_hash"
            inner_cols = f"{key_sort} AS key_sort, {key_expr} AS key_val, {row_hash} AS row_hash"
        else:
            output_cols = "key_val, row_hash"
            inner_cols = f"{key_expr} AS key_val, {row_hash} AS row_hash"

        buckets = _normalize_buckets(bucket_filter)
        if buckets:
            # Bucket pruning must use the same full-row fingerprint as the
            # aggregate phase, even though row_hash intentionally excludes keys
            # when a payload is available.
            full_row_hash = self.row_hash_expr(
                [self.quote_ident(c) for c in all_columns], normalize=normalize,
            )
            inner_sql = (
                f"SELECT {inner_cols}, {full_row_hash} AS bucket_hash\n"
                f"FROM {fq_table}\n{where}"
            ).strip()
            in_list = ", ".join(f"'{c}'" for c in buckets)
            sql = (
                f"SELECT {output_cols} FROM (\n{inner_sql}\n) khs\n"
                f"WHERE {self.substr('bucket_hash', 1, 1)} IN ({in_list})"
            )
        else:
            sql = f"SELECT {inner_cols}\nFROM {fq_table}\n{where}".strip()

        if stable_order:
            # Include row_hash so duplicate-key order is stable on both sides.
            sql = f"{sql}\nORDER BY 1, 2, 3"
        elif order_by_key:
            sql = f"{sql}\nORDER BY 1"

        return sql

    def rows_by_keys_sql(
        self,
        fq_table: str,
        key_columns: list[str],
        key_values: list[str],
        all_columns: list[str],
        normalize=None,
    ) -> str:
        cols = ", ".join(self.quote_ident(c) for c in all_columns)
        key_parts = [
            self.coalesce_string(self.quote_ident(k), normalize=normalize)
            for k in key_columns
        ]
        key_expr = self.concat_with_sep(key_parts, "||")
        escaped = ", ".join("'" + v.replace("'", "''") + "'" for v in key_values)
        return f"SELECT {cols} FROM {fq_table} WHERE {key_expr} IN ({escaped})"

    @abstractmethod
    def list_databases_sql(self) -> str: ...

    @abstractmethod
    def list_schemas_sql(self, database: str | None) -> str: ...

    @abstractmethod
    def list_tables_sql(self, database: str | None, schema: str | None) -> str: ...

    @abstractmethod
    def schema_columns_sql(self, database: str | None, schema: str | None, table: str) -> str: ...
