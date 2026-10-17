"""The compare engine.

1. Read both sides into DuckDB concurrently (``readers`` / ``files``).
2. Pair columns (map, names or positions), pick keys (given, primary key,
   or none), and project both sides to canonical types (``canon``).
3. Keyed: one FULL OUTER hash join on the keys with a null-safe per-column
   comparison; duplicate keys are paired by their ordinal. Unkeyed: a
   multiset diff (64-bit row hash + ordinal).
4. Write every differing row (both sides' original values) to an encrypted
   per-run DuckDB file for browsing and export; the result JSON keeps counts,
   per-column mismatch counts, column statistics and samples.
"""
from __future__ import annotations

import concurrent.futures as cf
import logging
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.engine import canon, files, readers
from app.engine.spec import DEFAULT_EXCLUDED_COLUMNS, CompareSpec, SideSpec
from app.util_time import now_iso

log = logging.getLogger("dv.engine")

ENGINE_NAME = "v2"


class CompareError(RuntimeError):
    pass


@dataclass
class RunContext:
    run_uuid: str
    log: Callable[[str, str], None] = lambda level, msg: None
    progress: Callable[..., None] = lambda **kw: None
    cancelled: Callable[[], bool] = lambda: False
    cancel_hooks: list = field(default_factory=list)
    duck: list = field(default_factory=list)

    def check(self):
        if self.cancelled():
            raise InterruptedError("Cancelled")


# ---------------------------------------------------------------------------
# Per-run encrypted diff store
# ---------------------------------------------------------------------------
def runs_dir() -> Path:
    p = settings.data_dir / "runs"
    p.mkdir(parents=True, exist_ok=True)
    return p


def store_path(run_uuid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8,64}", run_uuid):
        raise ValueError("bad run id")
    return runs_dir() / f"{run_uuid}.duckdb"


def store_key(run_uuid: str) -> str:
    from app.security.vault import vault
    return vault.derive_key(f"diffstore:{run_uuid}").hex()


# DuckDB writes encrypted files only through OpenSSL, which comes with its
# httpfs extension; its built-in mbedtls module can only *read* them (DuckDB
# 1.4.1+). When httpfs can't be loaded (offline PC, blocked
# extensions.duckdb.org) the store is written as a plain working file and
# sealed with the vault's AES-256-GCM right after the run (``storeseal``), so
# differences are never left unencrypted at rest either way.
_crypto_lock = threading.Lock()
_crypto_state: dict[str, Any] = {"native": None, "reason": ""}


def enable_native_crypto(con) -> bool:
    """Load httpfs on ``con`` so DuckDB can write encrypted files. The result
    of the first full attempt (including a one-time INSTALL) is remembered
    for the process; later connections only try a cheap LOAD."""
    if _crypto_state["native"] is False:
        return False
    try:
        con.execute("LOAD httpfs")
        _crypto_state["native"] = True
        return True
    except Exception:
        pass
    with _crypto_lock:
        if _crypto_state["native"] is False:
            return False
        try:
            readers._load_extension(con, "httpfs")
            _crypto_state["native"] = True
            return True
        except Exception as exc:
            _crypto_state.update(native=False, reason=str(exc)[:300])
            log.warning("DuckDB httpfs (OpenSSL) unavailable; diff stores are sealed by the app instead: %s", exc)
            return False


def crypto_status() -> dict:
    return {"native": _crypto_state["native"], "reason": _crypto_state["reason"]}


def store_exists(run_uuid: str) -> bool:
    from app.engine import storeseal
    try:
        return store_path(run_uuid).exists() or storeseal.sealed_path(run_uuid).exists()
    except ValueError:
        return False


def drop_store(run_uuid: str | None) -> None:
    if not run_uuid:
        return
    from app.engine import storeseal
    try:
        p = store_path(run_uuid)
    except ValueError:
        return
    for q in (p, p.with_name(p.name + ".wal")):
        try:
            q.unlink(missing_ok=True)
        except Exception:
            pass
    storeseal.drop(run_uuid)


def attach_store(con, run_uuid: str, alias: str = "rs", read_only: bool = False) -> None:
    """Attach the run's diff store. Writing: encrypted by DuckDB when httpfs
    loads, otherwise a plain working file sealed by ``seal_store``. Reading:
    DuckDB decrypts its own files without httpfs; app-sealed stores are
    opened from a short-lived decrypted cache."""
    from app.engine import storeseal

    def q(path: Path) -> str:
        return path.as_posix().replace("'", "''")

    p = store_path(run_uuid)
    if read_only:
        if p.exists():
            con.execute(f"ATTACH '{q(p)}' AS {alias} (ENCRYPTION_KEY '{store_key(run_uuid)}', READ_ONLY)")
            return
        if storeseal.sealed_path(run_uuid).exists():
            con.execute(f"ATTACH '{q(storeseal.open_plain(run_uuid))}' AS {alias} (READ_ONLY)")
            return
        raise FileNotFoundError("This run has no saved differences")
    if enable_native_crypto(con):
        con.execute(f"ATTACH '{q(p)}' AS {alias} (ENCRYPTION_KEY '{store_key(run_uuid)}')")
    else:
        work = storeseal.work_path(run_uuid)
        for f in (work, work.with_name(work.name + ".wal")):
            f.unlink(missing_ok=True)
        con.execute(f"ATTACH '{q(work)}' AS {alias}")


def seal_store(run_uuid: str) -> None:
    """After DETACH: encrypt an app-sealed working store (no-op for stores
    DuckDB encrypted itself)."""
    from app.engine import storeseal
    if storeseal.work_path(run_uuid).exists():
        storeseal.seal(run_uuid)


def new_duckdb(run_uuid: str):
    import duckdb

    tmp = settings.data_dir / "tmp" / run_uuid
    tmp.mkdir(parents=True, exist_ok=True)
    cfg: dict[str, Any] = {"preserve_insertion_order": False}
    if settings.duckdb_threads:
        cfg["threads"] = int(settings.duckdb_threads)
    if settings.duckdb_memory_limit:
        cfg["memory_limit"] = settings.duckdb_memory_limit
    con = duckdb.connect(":memory:", config=cfg)
    con.execute(f"SET temp_directory='{tmp.as_posix()}'")
    # Spill files: encrypted when DuckDB can write encrypted files. Without
    # httpfs, asking for it makes every spill fail, so they stay plain in
    # data/tmp/<run> (deleted when the run ends and at start-up).
    if enable_native_crypto(con):
        try:
            con.execute("SET temp_file_encryption=true")
        except Exception:
            pass
    for stmt in canon.MACROS.strip().split(";\n"):
        if stmt.strip():
            con.execute(stmt)
    return con, tmp


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _load_record(connection_id: int):
    from app.db.store import Connection, get_session

    s = get_session()
    try:
        rec = s.get(Connection, connection_id)
        if not rec:
            raise CompareError(f"Connection {connection_id} not found")
        s.expunge(rec)
        return rec
    finally:
        s.close()


def side_label(side: SideSpec, record) -> str:
    if side.label:
        return side.label
    if side.kind == "file":
        return side.display()
    name = record.name if record is not None else "?"
    if side.kind == "query":
        return f"{name} · query"
    return f"{name} · {side.display()}"


def _match_name(name: str, candidates: list[str]) -> str | None:
    if name in candidates:
        return name
    low = [c for c in candidates if c.lower() == name.lower()]
    if len(low) == 1:
        return low[0]
    norm = re.sub(r"[^a-z0-9]", "", name.lower())
    alt = [c for c in candidates if re.sub(r"[^a-z0-9]", "", c.lower()) == norm]
    return alt[0] if len(alt) == 1 else None


@dataclass
class Pair:
    source: str
    target: str
    role: str  # key | compare
    s_type: str
    t_type: str
    plan: canon.PairPlan | None = None


def build_pairs(scols: list[tuple[str, str]], tcols: list[tuple[str, str]], spec: CompareSpec):
    o = spec.options
    s_names = [c[0] for c in scols]
    t_names = [c[0] for c in tcols]
    s_type = dict(scols)
    t_type = dict(tcols)
    excluded_cfg = o.excluded_columns
    excluded = {e.lower() for e in (DEFAULT_EXCLUDED_COLUMNS if excluded_cfg is None else excluded_cfg)}
    pairs: list[Pair] = []
    used_s, used_t = set(), set()
    excluded_hit: list[str] = []
    mode = "name"
    if o.column_map:
        mode = "map"
        for m in o.column_map:
            sn = _match_name(m.source, s_names)
            tn = _match_name(m.target, t_names)
            if sn is None:
                raise CompareError(f"Mapped source column {m.source!r} not found")
            if tn is None:
                raise CompareError(f"Mapped target column {m.target!r} not found")
            used_s.add(sn)
            used_t.add(tn)
            if m.role == "ignore":
                excluded_hit.append(sn)
                continue
            pairs.append(Pair(sn, tn, m.role, s_type[sn], t_type[tn]))
        only_s = [n for n in s_names if n not in used_s]
        only_t = [n for n in t_names if n not in used_t]
        return pairs, only_s, only_t, excluded_hit, mode
    if o.match_columns == "position":
        mode = "position"
        for sn, tn in zip(s_names, t_names):
            used_s.add(sn)
            used_t.add(tn)
            if sn.lower() in excluded or tn.lower() in excluded:
                excluded_hit.append(sn)
                continue
            pairs.append(Pair(sn, tn, "compare", s_type[sn], t_type[tn]))
    else:
        remaining_t = list(t_names)
        for sn in s_names:
            tn = _match_name(sn, remaining_t)
            if tn is None:
                continue
            remaining_t.remove(tn)
            used_s.add(sn)
            used_t.add(tn)
            if sn.lower() in excluded or tn.lower() in excluded:
                excluded_hit.append(sn)
                continue
            pairs.append(Pair(sn, tn, "compare", s_type[sn], t_type[tn]))
    only_s = [n for n in s_names if n not in used_s and n.lower() not in excluded]
    only_t = [n for n in t_names if n not in used_t and n.lower() not in excluded]
    return pairs, only_s, only_t, excluded_hit, mode


def _apply_keys(pairs: list[Pair], spec: CompareSpec, scols, pk: list[str], pk_source: str) -> str:
    o = spec.options
    if any(p.role == "key" for p in pairs):
        return "map"
    if o.key_columns:
        for k in o.key_columns:
            hit = None
            for p in pairs:
                if p.source == k or p.target == k:
                    hit = p
                    break
            if hit is None:
                for p in pairs:
                    if p.source.lower() == k.lower() or p.target.lower() == k.lower():
                        hit = p
                        break
            if hit is None:
                raise CompareError(f"Key column {k!r} is not a column on both sides")
            hit.role = "key"
        return "user"
    if o.key_positions:
        names = [c[0] for c in scols]
        for i in o.key_positions:
            if i >= len(names):
                raise CompareError(f"Key position {i} is out of range")
            hit = next((p for p in pairs if p.source == names[i]), None)
            if hit is None:
                raise CompareError(f"Key column {names[i]!r} has no matching target column")
            hit.role = "key"
        return "user"
    if pk:
        hits = []
        for k in pk:
            hit = next((p for p in pairs if p.source.lower() == k.lower() or p.target.lower() == k.lower()), None)
            if hit is None:
                return "none"
            hits.append(hit)
        for h in hits:
            h.role = "key"
        return pk_source
    return "none"


def _num(v):
    return int(v) if v is not None else 0


def _sql_list(names: list[str]) -> str:
    return ", ".join(canon.qi(n) for n in names)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
def run_compare(spec: CompareSpec, rc: RunContext) -> dict:
    t_start = time.perf_counter()
    started_at = now_iso()
    timings: dict[str, int] = {}
    warnings: list[str] = []
    o = spec.options

    src_rec = _load_record(spec.source.connection_id) if spec.source.kind != "file" else None
    tgt_rec = _load_record(spec.target.connection_id) if spec.target.kind != "file" else None
    s_label = side_label(spec.source, src_rec)
    t_label = side_label(spec.target, tgt_rec)

    # In-database strategy (same connection, both tables)
    from app.engine import pushdown

    choice = pushdown.choose(spec, src_rec, tgt_rec, rc)
    if choice:
        rc.log("info", choice["reason"])
        return pushdown.run(spec, src_rec, tgt_rec, s_label, t_label, rc, started_at, t_start)

    con, tmpdir = new_duckdb(rc.run_uuid)
    rc.duck.append(con)
    store = bool(o.store_diffs)
    try:
        if store:
            attach_store(con, rc.run_uuid)

        # ---- metadata (projection + primary key) -------------------------
        rc.progress(phase="connect", message="Reading metadata")
        projections: dict[str, list[str] | None] = {"source": None, "target": None}
        pk: list[str] = []
        pk_source = "none"
        explicit_keys = bool(o.key_columns or o.key_positions or (o.column_map and any(m.role == "key" for m in o.column_map)))
        t0 = time.perf_counter()
        for role, side, rec in (("source", spec.source, src_rec), ("target", spec.target, tgt_rec)):
            if side.kind != "table":
                continue
            try:
                cols = [c["name"] for c in readers.table_columns(rec, side)]
            except Exception as exc:
                rc.log("warn", f"{role}: could not read column metadata ({str(exc)[:160]}); reading all columns")
                continue
            keep = _projection(cols, spec, role)
            if keep and len(keep) < len(cols):
                projections[role] = keep
        if not explicit_keys and o.auto_key:
            for role, side, rec in (("source", spec.source, src_rec), ("target", spec.target, tgt_rec)):
                if side.kind == "table":
                    pk = readers.primary_key(rec, side)
                    if pk:
                        pk_source = f"{role} primary key"
                        rc.log("info", f"Using the {role} table's primary key: {', '.join(pk)}")
                        break
        timings["metadata_ms"] = int((time.perf_counter() - t0) * 1000)
        rc.check()

        # ---- read both sides concurrently --------------------------------
        counts = {"source": 0, "target": 0}
        info: dict[str, dict] = {}

        def on_rows(role):
            def f(n):
                counts[role] = n
                rc.progress(phase="read", rows=dict(counts))
            return f

        incremental = (o.incremental_column, o.since) if o.incremental_column and o.since else None

        cursors: dict[str, Any] = {}
        done_roles: set[str] = set()

        def load(role: str, side: SideSpec, rec, table: str):
            cur = con.cursor()
            rc.duck.append(cur)
            for stmt in ("SET enable_progress_bar=true", "SET enable_progress_bar_print=false", "SET progress_bar_time=0"):
                try:
                    cur.execute(stmt)
                except Exception:
                    pass
            cursors[role] = cur
            try:
                if side.kind == "file":
                    out = files.load_side(cur, table, side, o.max_rows, on_rows(role), rc.cancelled)
                else:
                    out = readers.read_side(cur, table, side, rec, "src" if role == "source" else "tgt",
                                            projections[role], o.max_rows, incremental, on_rows(role),
                                            rc.cancelled, rc.log, rc.cancel_hooks)
                done_roles.add(role)
                rc.progress(pct={role: 100.0})
                return out
            finally:
                try:
                    cur.close()
                except Exception:
                    pass

        rc.progress(phase="read", message="Reading both sides")
        t0 = time.perf_counter()
        reading = threading.Event()
        reading.set()

        # Catalog row counts (no scan) turn "rows read so far" into a
        # percentage for readers that stream batches through Python.
        estimates: dict[str, int] = {}

        def estimate(role: str, side: SideSpec, rec) -> None:
            if side.kind != "table" or rec is None or (side.filter_sql and side.filter_sql.strip()) or incremental:
                return
            try:
                est = readers.estimated_rows(rec, side)
            except Exception:
                est = None
            if est and est > 0:
                estimates[role] = min(est, o.max_rows) if o.max_rows else est

        for role, side, rec in (("source", spec.source, src_rec), ("target", spec.target, tgt_rec)):
            threading.Thread(target=estimate, args=(role, side, rec), daemon=True, name="dv-estimate").start()

        def watch():
            # Percent per side: rows read / catalog estimate when rows are
            # streamed through Python; DuckDB's own progress for scans it
            # drives itself (scanners, file readers), which report no rows.
            while reading.is_set():
                pct = {}
                for role in ("source", "target"):
                    if role in done_roles:
                        continue
                    if counts[role] and estimates.get(role):
                        pct[role] = round(min(99.0, counts[role] * 100.0 / estimates[role]), 1)
                        continue
                    cur = cursors.get(role)
                    if cur is None:
                        continue
                    try:
                        v = cur.query_progress()
                        if v is not None and v > 0:
                            pct[role] = round(float(v), 1)
                    except Exception:
                        pass
                if pct:
                    rc.progress(pct=pct)
                time.sleep(0.4)

        threading.Thread(target=watch, name="dv-read-progress", daemon=True).start()
        try:
            with cf.ThreadPoolExecutor(max_workers=2, thread_name_prefix="dv-read") as ex:
                fut = {
                    "source": ex.submit(load, "source", spec.source, src_rec, "src_raw"),
                    "target": ex.submit(load, "target", spec.target, tgt_rec, "tgt_raw"),
                }
                errors = {}
                for role, f in fut.items():
                    try:
                        info[role] = f.result()
                    except InterruptedError:
                        raise
                    except Exception as exc:
                        errors[role] = exc
                if errors:
                    role, exc = next(iter(errors.items()))
                    raise CompareError(f"Reading the {role} failed: {type(exc).__name__}: {str(exc)[:600]}") from exc
        finally:
            reading.clear()
        timings["read_ms"] = int((time.perf_counter() - t0) * 1000)
        for role in ("source", "target"):
            i = info[role]
            rc.log("info", f"{role.capitalize()}: {i['rows']:,} rows via {i['reader']} in {i['read_ms'] / 1000:.2f}s")
            for a in i.get("attempts") or []:
                if a.get("skipped"):
                    rc.log("debug", f"{role}: {a['reader']} skipped - {a.get('error')}")
        rc.check()

        # ---- schema / pairing --------------------------------------------
        rc.progress(phase="prepare", message="Matching columns")
        t0 = time.perf_counter()
        scols = [(r[0], r[1]) for r in con.execute("DESCRIBE src_raw").fetchall()]
        tcols = [(r[0], r[1]) for r in con.execute("DESCRIBE tgt_raw").fetchall()]
        pairs, only_s, only_t, excluded_hit, mode = build_pairs(scols, tcols, spec)
        key_source = _apply_keys(pairs, spec, scols, pk, pk_source)
        if not pairs:
            raise CompareError("No columns in common to compare. Map the columns or match them by position.")
        n = o.normalize
        for p in pairs:
            p.plan = canon.plan_pair(p.source, p.s_type, p.target, p.t_type, n, for_key=(p.role == "key"))
        keys = [p for p in pairs if p.role == "key"]
        comps = [p for p in pairs if p.role == "compare"]
        if only_s or only_t:
            warnings.append(
                f"Columns only in source: {', '.join(only_s) or '-'}; only in target: {', '.join(only_t) or '-'} "
                "(not compared, not part of the verdict)"
            )

        def view(raw: str, side: str) -> str:
            parts = ["rowid AS __rid"]
            for i, p in enumerate(keys):
                parts.append(f"{p.plan.s_expr if side == 's' else p.plan.t_expr} AS k{i}")
            for i, p in enumerate(comps):
                parts.append(f"{p.plan.s_expr if side == 's' else p.plan.t_expr} AS c{i}")
            return f"CREATE OR REPLACE TEMP VIEW {side} AS SELECT {', '.join(parts)} FROM {raw}"

        con.execute(view("src_raw", "s"))
        con.execute(view("tgt_raw", "t"))
        rows_s = info["source"]["rows"]
        kcols = [f"k{i}" for i in range(len(keys))]
        ccols = [f"c{i}" for i in range(len(comps))]

        dup_s = dup_t = 0
        if keys:
            kl = ", ".join(kcols)
            # a side whose own primary key is the compare key can't have duplicates
            pk_side = key_source.split(" ")[0] if key_source.endswith("primary key") and all(
                p.s_type == p.t_type for p in keys) else None
            dup_s, dup_t = [
                0 if pk_side == role and side.kind == "table" else
                _num(con.execute(f"SELECT count(*) - count(DISTINCT row({kl})) FROM {v}").fetchone()[0])
                for v, role, side in (("s", "source", spec.source), ("t", "target", spec.target))
            ]
            if dup_s or dup_t:
                warnings.append(f"Duplicate keys: {dup_s:,} extra source rows, {dup_t:,} extra target rows; duplicates are paired in value order")
        timings["prepare_ms"] = int((time.perf_counter() - t0) * 1000)
        rc.check()

        # ---- diff ----------------------------------------------------------
        rc.progress(phase="diff", message="Comparing")
        t0 = time.perf_counter()
        if keys:
            order = ", ".join(ccols) if ccols else "__rid"
            use_ord = bool(dup_s or dup_t)
            for v in ("s", "t"):
                if use_ord:
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {v}2 AS SELECT *, row_number() OVER (PARTITION BY {', '.join(kcols)} ORDER BY {order}) AS __o FROM {v}")
                else:
                    con.execute(f"CREATE OR REPLACE TEMP VIEW {v}2 AS SELECT * FROM {v}")
            on = " AND ".join(f"s.{k} IS NOT DISTINCT FROM t.{k}" for k in kcols)
            if use_ord:
                on += " AND s.__o = t.__o"
            dexprs = [canon.distinct_expr(f"s.c{i}", f"t.c{i}", p.plan, n) for i, p in enumerate(comps)]
            dcols = [f"{e} AS d{i}" for i, e in enumerate(dexprs)]
            where = " OR ".join(["sr IS NULL", "tr IS NULL"] + [f"d{i}" for i in range(len(comps))])
            con.execute(
                f"CREATE OR REPLACE TEMP TABLE m AS SELECT * FROM ("
                f"SELECT s.__rid AS sr, t.__rid AS tr{', ' if dcols else ''}{', '.join(dcols)} "
                f"FROM s2 s FULL OUTER JOIN t2 t ON {on}) WHERE {where}"
            )
            strategy = "keyed"
        else:
            hcols = ", ".join(ccols)
            for v in ("s", "t"):
                con.execute(f"CREATE OR REPLACE TEMP VIEW {v}2 AS SELECT __rid, hash({hcols}) AS __h, row_number() OVER (PARTITION BY hash({hcols})) AS __o FROM {v}")
            con.execute(
                "CREATE OR REPLACE TEMP TABLE m AS SELECT * FROM ("
                "SELECT s.__rid AS sr, t.__rid AS tr FROM s2 s FULL OUTER JOIN t2 t ON s.__h = t.__h AND s.__o = t.__o"
                ") WHERE sr IS NULL OR tr IS NULL"
            )
            strategy = "multiset"
            warnings.append("No key columns: rows were compared as whole rows (a changed row shows as one row only in source and one only in target). Pick key columns to see column-level differences.")
        agg = ["count(*) FILTER (WHERE tr IS NULL)", "count(*) FILTER (WHERE sr IS NULL)",
               "count(*) FILTER (WHERE sr IS NOT NULL AND tr IS NOT NULL)"]
        if keys:
            agg += [f"count(*) FILTER (WHERE sr IS NOT NULL AND tr IS NOT NULL AND d{i})" for i in range(len(comps))]
        r = con.execute(f"SELECT {', '.join(agg)} FROM m").fetchone()
        only_src, only_tgt, changed = _num(r[0]), _num(r[1]), _num(r[2])
        col_counts = [_num(x) for x in r[3:]]
        matched_pairs = rows_s - only_src
        matching = matched_pairs - changed
        timings["diff_ms"] = int((time.perf_counter() - t0) * 1000)
        rc.log("info", f"Compared in {timings['diff_ms'] / 1000:.2f}s: {matching:,} equal, {changed:,} changed, "
                       f"{only_src:,} only in source, {only_tgt:,} only in target")
        rc.check()

        return finish(
            con, rc, spec, store=store, keys=keys, comps=comps, pairs=pairs, kcols=kcols, ccols=ccols,
            s_label=s_label, t_label=t_label, src_rec=src_rec, tgt_rec=tgt_rec, info=info,
            scols=scols, tcols=tcols, only_s=only_s, only_t=only_t, excluded_hit=excluded_hit, mode=mode,
            key_source=key_source, strategy=strategy, counts=(only_src, only_tgt, changed, matching, dup_s, dup_t),
            col_counts=col_counts, timings=timings, warnings=warnings, started_at=started_at, t_start=t_start,
            run_strategy="local", stats_enabled=o.column_stats,
        )
    finally:
        try:
            con.close()
        except Exception:
            pass
        import shutil
        shutil.rmtree(tmpdir, ignore_errors=True)


def finish(con, rc: RunContext, spec: CompareSpec, *, store, keys, comps, pairs, kcols, ccols, s_label, t_label,
           src_rec, tgt_rec, info, scols, tcols, only_s, only_t, excluded_hit, mode, key_source, strategy,
           counts, col_counts, timings, warnings, started_at, t_start, run_strategy, stats_enabled,
           raw_select: str = "*") -> dict:
    """Column stats, diff store, samples and the result document (shared
    by the local and in-database strategies)."""
    o = spec.options
    only_src, only_tgt, changed, matching, dup_s, dup_t = counts
    rows_s = info["source"]["rows"]
    rows_t = info["target"]["rows"]
    # ---- column statistics ---------------------------------------------
    stats = []
    if stats_enabled:
        rc.progress(phase="stats", message="Column statistics")
        t0 = time.perf_counter()
        try:
            stats = _column_stats(con, keys + comps, kcols + ccols, distinct=o.distinct_counts)
        except Exception as exc:
            warnings.append(f"Column statistics skipped: {str(exc)[:200]}")
        timings["stats_ms"] = int((time.perf_counter() - t0) * 1000)

    # ---- store + samples -------------------------------------------------
    rc.progress(phase="store", message="Saving differences")
    t0 = time.perf_counter()
    cap = int(o.max_stored_rows or 0)
    stored = {"only_in_source": 0, "only_in_target": 0, "changed": 0}
    key_names = [p.source for p in keys]
    if store:
        lim = f" LIMIT {cap}" if cap else ""
        korder = f" ORDER BY {_sql_list([p.source for p in keys])}" if keys else ""
        korder_t = f" ORDER BY {_sql_list([p.target for p in keys])}" if keys else ""
        con.execute(f"CREATE TABLE rs.only_source AS SELECT {raw_select} FROM src_raw WHERE rowid IN (SELECT sr FROM m WHERE tr IS NULL){korder}{lim}")
        con.execute(f"CREATE TABLE rs.only_target AS SELECT {raw_select} FROM tgt_raw WHERE rowid IN (SELECT tr FROM m WHERE sr IS NULL){korder_t}{lim}")
        if keys:
            diff_list = "list_filter([" + ", ".join(
                f"CASE WHEN m.d{i} THEN {_lit(p.source)} END" for i, p in enumerate(comps)
            ) + "], x -> x IS NOT NULL)" if comps else "[]::VARCHAR[]"
            sel = [f"{diff_list} AS __diff"]
            sel += [f"s.{canon.qi(p.source)} AS {canon.qi('k:' + p.source)}" for p in keys]
            for p in comps:
                sel.append(f"s.{canon.qi(p.source)} AS {canon.qi('s:' + p.source)}")
                sel.append(f"t.{canon.qi(p.target)} AS {canon.qi('t:' + p.source)}")
            con.execute(
                f"CREATE TABLE rs.changed AS SELECT {', '.join(sel)} FROM m "
                f"JOIN src_raw s ON s.rowid = m.sr JOIN tgt_raw t ON t.rowid = m.tr "
                f"WHERE m.sr IS NOT NULL AND m.tr IS NOT NULL"
                + (f" ORDER BY {', '.join(canon.qi('k:' + p.source) for p in keys)}" if keys else "") + lim
            )
        meta = {
            "pairs": [{"source": p.source, "target": p.target, "role": p.role,
                       "source_type": p.s_type, "target_type": p.t_type, "compare_as": p.plan.compare_as}
                      for p in pairs],
            "keys": key_names, "source_label": s_label, "target_label": t_label,
        }
        import json as _json
        con.execute("CREATE TABLE rs.meta AS SELECT ? AS meta", [_json.dumps(meta)])
        for k, tbl in (("only_in_source", "only_source"), ("only_in_target", "only_target"), ("changed", "changed")):
            if k == "changed" and not keys:
                continue
            stored[k] = _num(con.execute(f"SELECT count(*) FROM rs.{tbl}").fetchone()[0])
    samples = _samples(con, keys, comps, o.sample_limit, store, rc.run_uuid, raw_select)
    if store:
        con.execute("DETACH rs")
        seal_store(rc.run_uuid)
    timings["store_ms"] = int((time.perf_counter() - t0) * 1000)

    # ---- file text checks ------------------------------------------------
    file_checks = None
    if o.file_checks and spec.source.kind == "file" and spec.target.kind == "file":
        try:
            pa_, fa, ca = files.resolve(spec.source)
            pb, fb, cb = files.resolve(spec.target)
            if fa in files.TEXT_FORMATS and fb in files.TEXT_FORMATS and not ca and not cb and pa_.is_file() and pb.is_file():
                t0 = time.perf_counter()
                file_checks = files.text_checks(pa_, pb)
                timings["file_checks_ms"] = int((time.perf_counter() - t0) * 1000)
        except Exception as exc:
            warnings.append(f"File format checks skipped: {str(exc)[:200]}")

    elapsed_ms = int((time.perf_counter() - t_start) * 1000)
    verdict = "MATCH" if (only_src == 0 and only_tgt == 0 and changed == 0) else "MISMATCH"
    truncated = bool(cap) and any(stored[k] >= cap for k in stored)
    result = {
        "schema_version": 2,
        "run_uuid": rc.run_uuid,
        "engine": ENGINE_NAME,
        "strategy": run_strategy,
        "status": "SUCCESS",
        "verdict": verdict,
        "started_at": started_at,
        "finished_at": now_iso(),
        "elapsed_ms": elapsed_ms,
        "timings": timings,
        "rows_per_second": int((rows_s + rows_t) / max(elapsed_ms / 1000, 0.001)),
        "source": _side_info(spec.source, src_rec, s_label, info["source"], len(scols)),
        "target": _side_info(spec.target, tgt_rec, t_label, info["target"], len(tcols)),
        "schema_diff": {
            "is_match": not only_s and not only_t and all(p.s_type == p.t_type for p in pairs),
            "mode": mode,
            "only_in_source": only_s,
            "only_in_target": only_t,
            "excluded": excluded_hit,
            "common_columns": [p.source for p in pairs],
            "type_mismatches": [
                {"column": p.source, "target_column": p.target, "source_type": p.s_type,
                 "target_type": p.t_type, "compare_as": p.plan.compare_as}
                for p in pairs if p.s_type != p.t_type
            ],
            "pairs": [
                {"source": p.source, "target": p.target, "role": p.role, "source_type": p.s_type,
                 "target_type": p.t_type, "compare_as": p.plan.compare_as}
                for p in pairs
            ],
        },
        "key_columns": key_names,
        "key_source": key_source,
        "row_diff": {
            "strategy": strategy,
            "key_columns": key_names,
            "compared_columns": [p.source for p in comps],
            "only_in_source_count": only_src,
            "only_in_target_count": only_tgt,
            "key_match_hash_diff_count": changed,
            "matching_count": matching,
            "duplicate_keys": {"source": dup_s, "target": dup_t},
            "column_mismatches": [
                {"column": p.source, "target_column": p.target, "count": c}
                for p, c in zip(comps, col_counts) if c
            ],
            "samples": samples,
            "incomplete": False,
        },
        "column_stats": stats,
        "diff_store": {"available": store, **stored, "truncated": truncated, "limit": cap},
        "file_checks": file_checks,
        "options": spec.options.model_dump(),
        "warnings": warnings,
    }
    return result


def _lit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def _projection(cols: list[str], spec: CompareSpec, role: str) -> list[str] | None:
    o = spec.options
    if o.column_map:
        want = {(m.source if role == "source" else m.target).lower() for m in o.column_map if m.role != "ignore"}
        keep = [c for c in cols if c.lower() in want]
        return keep if keep else None
    if o.match_columns == "position" or o.key_positions:
        return None
    excl = {e.lower() for e in (DEFAULT_EXCLUDED_COLUMNS if o.excluded_columns is None else o.excluded_columns)}
    keys = {k.lower() for k in (o.key_columns or [])}
    if o.incremental_column:
        keys.add(o.incremental_column.lower())
    keep = [c for c in cols if c.lower() not in excl or c.lower() in keys]
    return keep or None


def _side_info(side: SideSpec, rec, label: str, info: dict, ncols: int) -> dict:
    d = {
        "label": label,
        "kind": side.kind,
        "row_count": info["rows"],
        "column_count": ncols,
        "reader": info.get("reader"),
        "read_ms": info.get("read_ms"),
        "rows_per_second": int(info["rows"] / max((info.get("read_ms") or 1) / 1000, 0.001)),
        "reader_attempts": info.get("attempts"),
    }
    if side.kind == "file":
        d.update({"file_name": info.get("file_name"), "format": info.get("format"),
                  "size_bytes": info.get("size_bytes"), "sheet": info.get("sheet"), "path": side.path})
    else:
        d.update({"connection": rec.name, "connection_id": rec.id, "db_type": rec.db_type,
                  "database": side.database or rec.database, "schema": side.schema_name or rec.schema_name,
                  "table": side.table, "filter": side.filter_sql})
        if side.kind == "query":
            d["sql"] = (side.sql or "")[:4000]
    return d


def _column_stats(con, pairs: list[Pair], cols: list[str], distinct: bool = False) -> list[dict]:
    def q(view: str):
        parts = ["count(*)"]
        for c, p in zip(cols, pairs):
            parts += [f"count({c})", f"approx_count_distinct({c})" if distinct else "NULL",
                      f"CAST(min({c}) AS VARCHAR)", f"CAST(max({c}) AS VARCHAR)",
                      f"avg(CAST({c} AS DOUBLE))" if p.plan and p.plan.numeric else "NULL"]
        return con.execute(f"SELECT {', '.join(parts)} FROM {view}").fetchone()
    a, b = q("s"), q("t")
    out = []
    for i, p in enumerate(pairs):
        j = 1 + i * 5

        def side(r):
            total = int(r[0] or 0)
            nn = int(r[j] or 0)
            avg = r[j + 4]
            return {"total_rows": total, "non_null_count": nn, "null_count": total - nn,
                    "distinct_count": int(r[j + 1]) if r[j + 1] is not None else None, "min_val": r[j + 2], "max_val": r[j + 3],
                    "avg_val": round(avg, 6) if isinstance(avg, float) and avg == avg else None}
        sa, sb = side(a), side(b)
        match = (sa["null_count"] == sb["null_count"] and sa["min_val"] == sb["min_val"]
                 and sa["max_val"] == sb["max_val"] and sa["distinct_count"] == sb["distinct_count"])
        out.append({"name": p.source, "target_name": p.target, "role": p.role, "match": match,
                    "source": sa, "target": sb})
    return out


def _rows(cur) -> list[dict]:
    names = [d[0] for d in cur.description]
    return [{n: files.display_value(v) for n, v in zip(names, row)} for row in cur.fetchall()]


def _samples(con, keys: list[Pair], comps: list[Pair], limit: int, store: bool, run_uuid: str,
             raw_select: str = "*") -> dict:
    """First ``limit`` rows of each kind (read from the diff store when it
    exists, which is far cheaper than probing the full side tables)."""
    out = {"only_in_source": [], "only_in_target": [], "key_match_hash_diff_source": [],
           "key_match_hash_diff_target": [], "key_match_column_diffs": []}
    if limit <= 0:
        return out
    if store:
        out["only_in_source"] = _rows(con.execute(f"SELECT * FROM rs.only_source LIMIT {limit}"))
        out["only_in_target"] = _rows(con.execute(f"SELECT * FROM rs.only_target LIMIT {limit}"))
        if not keys:
            return out
        cur = con.execute(f"SELECT * FROM rs.changed LIMIT {limit}")
        names = [d[0] for d in cur.description]
        for row in cur.fetchall():
            rec = dict(zip(names, row))
            sd = {k.source: files.display_value(rec["k:" + k.source]) for k in keys}
            td = dict(sd)
            diffs = []
            dset = set(rec.get("__diff") or [])
            for c in comps:
                sv, tv = files.display_value(rec["s:" + c.source]), files.display_value(rec["t:" + c.source])
                sd[c.source], td[c.source] = sv, tv
                if c.source in dset:
                    diffs.append({"column": c.source, "target_column": c.target, "source": sv, "target": tv})
            out["key_match_hash_diff_source"].append(sd)
            out["key_match_hash_diff_target"].append(td)
            out["key_match_column_diffs"].append({
                "key": " | ".join(str(sd[k.source]) for k in keys),
                "key_values": {k.source: sd[k.source] for k in keys},
                "columns": diffs,
            })
        return out
    out["only_in_source"] = _rows(con.execute(f"SELECT {raw_select} FROM src_raw WHERE rowid IN (SELECT sr FROM m WHERE tr IS NULL) LIMIT {limit}"))
    out["only_in_target"] = _rows(con.execute(f"SELECT {raw_select} FROM tgt_raw WHERE rowid IN (SELECT tr FROM m WHERE sr IS NULL) LIMIT {limit}"))
    if not keys:
        return out
    pick = con.execute(f"SELECT sr, tr, {', '.join(f'd{i}' for i in range(len(comps))) or 'NULL'} FROM m WHERE sr IS NOT NULL AND tr IS NOT NULL LIMIT {limit}").fetchall()
    if not pick:
        return out
    cols_s = [p.source for p in keys + comps]
    cols_t = [p.target for p in keys + comps]
    srows = {r[0]: r[1:] for r in con.execute(f"SELECT rowid, {_sql_list(cols_s)} FROM src_raw WHERE rowid IN ({', '.join(str(p[0]) for p in pick)})").fetchall()}
    trows = {r[0]: r[1:] for r in con.execute(f"SELECT rowid, {_sql_list(cols_t)} FROM tgt_raw WHERE rowid IN ({', '.join(str(p[1]) for p in pick)})").fetchall()}
    for p in pick:
        sv, tv = srows.get(p[0]), trows.get(p[1])
        if sv is None or tv is None:
            continue
        sd = {c: files.display_value(v) for c, v in zip(cols_s, sv)}
        td = {c: files.display_value(v) for c, v in zip(cols_s, tv)}
        out["key_match_hash_diff_source"].append(sd)
        out["key_match_hash_diff_target"].append(td)
        diffs = []
        for i, c in enumerate(comps):
            if p[2 + i]:
                diffs.append({"column": c.source, "target_column": c.target,
                              "source": sd[c.source], "target": td[c.source]})
        out["key_match_column_diffs"].append({
            "key": " | ".join(str(sd[k.source]) for k in keys),
            "key_values": {k.source: sd[k.source] for k in keys},
            "columns": diffs,
        })
    return out
