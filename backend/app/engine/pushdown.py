"""In-database strategy for two tables on the same connection.

The database runs one FULL OUTER JOIN on the keys and returns only the rows
that differ (with both sides' values), plus two COUNT(*)s. Nothing else
leaves the server, which is what you want for very large tables with few
differences. The returned rows go through the same diff store / result code
as the local strategy.
"""
from __future__ import annotations

import concurrent.futures as cf
import time

from app.config import settings
from app.engine import canon, readers
from app.engine.spec import CompareSpec, SideSpec

_NUM = ("INT", "NUMBER", "NUMERIC", "DECIMAL", "FLOAT", "DOUBLE", "REAL", "MONEY")
_TIME = ("DATE", "TIME")
_STR = ("CHAR", "TEXT", "STRING", "CLOB", "VARCHAR")


def _fam(t: str) -> str:
    u = (t or "").upper()
    if any(k in u for k in _TIME):
        return "time"
    if any(k in u for k in _NUM):
        return "num"
    if any(k in u for k in _STR):
        return "str"
    return u


def choose(spec: CompareSpec, src_rec, tgt_rec, rc) -> dict | None:
    o = spec.options
    if o.strategy == "local":
        return None
    eligible = (
        spec.source.kind == "table" and spec.target.kind == "table"
        and src_rec is not None and tgt_rec is not None and src_rec.id == tgt_rec.id
        and (src_rec.db_type or "").lower() in ("postgres", "sqlserver", "oracle", "snowflake")
        and not o.max_rows
        and not o.key_positions and o.match_columns == "name"
    )
    db_ok = True
    if eligible and (src_rec.db_type or "").lower() == "postgres":
        db_ok = (spec.source.database or src_rec.database) == (spec.target.database or src_rec.database)
    if o.strategy == "in_database":
        if not eligible or not db_ok:
            rc.log("warn", "In-database compare needs two tables on the same connection (not MySQL); using the local engine")
            return None
        return {"reason": "In-database compare: the database joins both tables and returns only differences"}
    if not eligible or not db_ok:
        return None
    est = readers.estimated_rows(src_rec, spec.source)
    threshold = int(getattr(settings, "pushdown_min_rows", 20_000_000) or 20_000_000)
    if est is not None and est >= threshold:
        return {"reason": f"In-database compare chosen automatically (~{est:,} rows on one connection)"}
    return None


def run(spec: CompareSpec, rec, _tgt_rec, s_label: str, t_label: str, rc, started_at: str, t_start: float) -> dict:
    from app.connectors.factory import get_compare_connector
    from app.engine import core

    o = spec.options
    timings: dict[str, int] = {}
    warnings: list[str] = []
    connector = get_compare_connector(rec, role="meta")
    dialect = connector.dialect
    db_type = (rec.db_type or "").lower()

    t0 = time.perf_counter()
    s_meta = readers.table_columns(rec, spec.source)
    t_meta = readers.table_columns(rec, spec.target)
    scols = [(c["name"], c.get("data_type") or "") for c in s_meta]
    tcols = [(c["name"], c.get("data_type") or "") for c in t_meta]
    pairs, only_s, only_t, excluded_hit, mode = core.build_pairs(scols, tcols, spec)
    pk = [] if (o.key_columns or (o.column_map and any(m.role == "key" for m in o.column_map))) else readers.primary_key(rec, spec.source)
    key_source = core._apply_keys(pairs, spec, scols, pk, "source primary key" if pk else "none")
    keys = [p for p in pairs if p.role == "key"]
    comps = [p for p in pairs if p.role == "compare"]
    if not keys:
        raise core.CompareError("The in-database strategy needs key columns (or a primary key)")
    timings["metadata_ms"] = int((time.perf_counter() - t0) * 1000)

    n = o.normalize
    q = dialect.quote_ident

    def norm_expr(alias: str, col: str, typ: str, other_typ: str) -> str:
        e = f"{alias}.{q(col)}"
        if _fam(typ) != _fam(other_typ):
            e = dialect.cast_to_string(e)
            typ = "VARCHAR"
        if _fam(typ) == "str":
            if n.rtrim and n.ltrim:
                e = dialect.trim_expr(e)
            elif n.rtrim:
                e = dialect.rtrim_expr(e)
            elif n.ltrim:
                e = dialect.ltrim_expr(e)
            if n.case_insensitive:
                e = dialect.upper_expr(e)
        return e

    def ne(a: str, b: str) -> str:
        return f"(({a} <> {b}) OR ({a} IS NULL AND {b} IS NOT NULL) OR ({a} IS NOT NULL AND {b} IS NULL))"

    def sub(side: SideSpec, cols: list[str]) -> str:
        db = None if db_type == "postgres" else side.database
        fq = dialect.fq_table(db, side.schema_name or rec.schema_name, side.table)
        where = f" WHERE ({side.filter_sql})" if side.filter_sql and side.filter_sql.strip() else ""
        if o.incremental_column and o.since:
            where += (" AND " if where else " WHERE ") + readers._incremental_pred(dialect, db_type, o.incremental_column, o.since)
        return f"(SELECT 1 AS dv_m, {', '.join(q(c) for c in cols)} FROM {fq}{where})"

    s_cols = [p.source for p in keys + comps]
    t_cols = [p.target for p in keys + comps]
    on = " AND ".join(f"{norm_expr('a', p.source, p.s_type, p.t_type)} = {norm_expr('b', p.target, p.t_type, p.s_type)}" for p in keys)
    diffs = [ne(norm_expr('a', p.source, p.s_type, p.t_type), norm_expr('b', p.target, p.t_type, p.s_type)) for p in comps]
    select = ["CASE WHEN b.dv_m IS NULL THEN 'S' WHEN a.dv_m IS NULL THEN 'T' ELSE 'C' END AS dv_side"]
    select += [f"a.{q(c)} AS {q('s_' + str(i))}" for i, c in enumerate(s_cols)]
    select += [f"b.{q(c)} AS {q('t_' + str(i))}" for i, c in enumerate(t_cols)]
    where = " OR ".join(["a.dv_m IS NULL", "b.dv_m IS NULL"] + diffs)
    diff_sql = (f"SELECT {', '.join(select)} FROM {sub(spec.source, s_cols)} a "
                f"FULL OUTER JOIN {sub(spec.target, t_cols)} b ON {on} WHERE {where}")

    def count(side: SideSpec, role: str) -> int:
        c = get_compare_connector(rec, role=role)
        db = None if db_type == "postgres" else side.database
        fq = dialect.fq_table(db, side.schema_name or rec.schema_name, side.table)
        w = f" WHERE ({side.filter_sql})" if side.filter_sql and side.filter_sql.strip() else ""
        row = c.execute_one(f"SELECT COUNT(*) FROM {fq}{w}")
        return int(row[0])

    con, tmpdir = core.new_duckdb(rc.run_uuid)
    rc.duck.append(con)
    try:
        if o.store_diffs:
            core.attach_store(con, rc.run_uuid)
        rc.progress(phase="read", message="Database is comparing")
        t0 = time.perf_counter()
        rows_seen = {"source": 0, "target": 0}
        with cf.ThreadPoolExecutor(max_workers=3, thread_name_prefix="dv-push") as ex:
            f_s = ex.submit(count, spec.source, "cnt_s")
            f_t = ex.submit(count, spec.target, "cnt_t")
            diff_side = SideSpec(kind="query", connection_id=rec.id, sql=diff_sql)

            def on_rows(n):
                rows_seen["source"] = n
                rc.progress(phase="read", rows={"differences": n})
            cur = con.cursor()
            rc.duck.append(cur)
            d_info = readers.read_side(cur, "dr", diff_side, rec, "src", None, 0, None, on_rows,
                                       rc.cancelled, rc.log, rc.cancel_hooks)
            rows_s, rows_t = f_s.result(), f_t.result()
        timings["read_ms"] = int((time.perf_counter() - t0) * 1000)
        rc.log("info", f"Database returned {d_info['rows']:,} differing rows in {timings['read_ms'] / 1000:.2f}s "
                       f"(source {rows_s:,} rows, target {rows_t:,} rows) via {d_info['reader']}")
        rc.check()

        t0 = time.perf_counter()
        s_names = [canon.qi(c) for c in s_cols]
        con.execute("CREATE TEMP TABLE dr2 AS SELECT row_number() OVER () AS n, * FROM dr")
        con.execute("CREATE TABLE src_raw AS SELECT n AS __n, " + ", ".join(
            f"{canon.qi('s_' + str(i))} AS {s_names[i]}" for i in range(len(s_cols))) + " FROM dr2 WHERE dv_side IN ('S','C')")
        con.execute("CREATE TABLE tgt_raw AS SELECT n AS __n, " + ", ".join(
            f"{canon.qi('t_' + str(i))} AS {canon.qi(c)}" for i, c in enumerate(t_cols)) + " FROM dr2 WHERE dv_side IN ('T','C')")
        dcols = []
        for i, p in enumerate(comps):
            j = len(keys) + i
            plan = canon.plan_pair(p.source, "VARCHAR", p.target, "VARCHAR", n)  # placeholder for typing
            dcols.append(f"(s.{s_names[j]} IS DISTINCT FROM t.{canon.qi(p.target)}) AS d{i}")
            p.plan = plan
        for p in keys:
            p.plan = canon.plan_pair(p.source, "VARCHAR", p.target, "VARCHAR", n)
        con.execute(
            "CREATE TEMP TABLE m AS SELECT s.rowid AS sr, t.rowid AS tr" + (", " if dcols else "") + ", ".join(dcols)
            + " FROM dr2 d LEFT JOIN src_raw s ON s.__n = d.n LEFT JOIN tgt_raw t ON t.__n = d.n"
        )
        # Real column types of the returned rows (for the result)
        st = dict((r[0], r[1]) for r in con.execute("DESCRIBE src_raw").fetchall())
        tt = dict((r[0], r[1]) for r in con.execute("DESCRIBE tgt_raw").fetchall())
        for p in pairs:
            p.plan.compare_as = "database"
        agg = ["count(*) FILTER (WHERE tr IS NULL)", "count(*) FILTER (WHERE sr IS NULL)",
               "count(*) FILTER (WHERE sr IS NOT NULL AND tr IS NOT NULL)"]
        agg += [f"count(*) FILTER (WHERE sr IS NOT NULL AND tr IS NOT NULL AND d{i})" for i in range(len(comps))]
        r = con.execute(f"SELECT {', '.join(agg)} FROM m").fetchone()
        only_src, only_tgt, changed = int(r[0]), int(r[1]), int(r[2])
        col_counts = [int(x or 0) for x in r[3:]]
        matching = rows_s - only_src - changed
        timings["diff_ms"] = int((time.perf_counter() - t0) * 1000)
        if changed and not any(col_counts):
            warnings.append("Some rows differ only by values the database compares differently from their text form")
        info = {
            "source": {"rows": rows_s, "reader": f"in-database ({d_info['reader']})", "read_ms": timings["read_ms"]},
            "target": {"rows": rows_t, "reader": f"in-database ({d_info['reader']})", "read_ms": timings["read_ms"]},
        }
        _ = (st, tt)
        return core.finish(
            con, rc, spec, store=bool(o.store_diffs), keys=keys, comps=comps, pairs=pairs,
            kcols=[], ccols=[], s_label=s_label, t_label=t_label, src_rec=rec, tgt_rec=rec, info=info,
            scols=scols, tcols=tcols, only_s=only_s, only_t=only_t, excluded_hit=excluded_hit, mode=mode,
            key_source=key_source, strategy="keyed", counts=(only_src, only_tgt, changed, matching, 0, 0),
            col_counts=col_counts, timings=timings, warnings=warnings, started_at=started_at, t_start=t_start,
            run_strategy="in_database", stats_enabled=False, raw_select="* EXCLUDE (__n)",
        )
    finally:
        try:
            con.close()
        except Exception:
            pass
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)
