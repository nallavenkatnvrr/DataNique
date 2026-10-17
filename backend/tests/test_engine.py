"""Compare engine v2: files of every format, normalization rules, keyed and
whole-row diffs, duplicates, mappings, the encrypted diff store, exports,
bulk jobs and (with a live PostgreSQL) the database readers."""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import time
import zipfile
from pathlib import Path

import pytest

pa = pytest.importorskip("pyarrow")


def _run(api_client, source: dict, target: dict, options: dict | None = None, timeout: float = 120) -> dict:
    r = api_client.post("/api/jobs/compare", json={"source": source, "target": target, "options": options or {}})
    assert r.status_code == 200, r.text
    job = r.json()
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = api_client.get(f"/api/jobs/{job['id']}").json()
        if snap["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert snap["status"] == "done", snap
    return api_client.get(f"/api/compare/runs/{snap['run_uuid']}").json()["result"]


def _csv(path: Path, text: str) -> dict:
    path.write_text(text, encoding="utf-8", newline="")
    return {"kind": "file", "path": str(path)}


def _rd(res):
    rd = res["row_diff"]
    return rd["matching_count"], rd["key_match_hash_diff_count"], rd["only_in_source_count"], rd["only_in_target_count"]


def test_keyed_diff_counts_and_column_mismatches(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,name,amount\n1,Ann,10.50\n2,Bob,20\n3,Cy,30\n4,Di,40\n")
    b = _csv(tmp_path / "b.csv", "id,name,amount\n1,Ann,10.5\n2,Bob,21\n3,CY,30\n5,Ed,50\n")
    res = _run(api_client, a, b, {"key_columns": ["id"]})
    assert res["verdict"] == "MISMATCH"
    assert _rd(res) == (1, 2, 1, 1)
    mism = {m["column"]: m["count"] for m in res["row_diff"]["column_mismatches"]}
    assert mism == {"name": 1, "amount": 1}
    diffs = {d["key"]: [c["column"] for c in d["columns"]] for d in res["row_diff"]["samples"]["key_match_column_diffs"]}
    assert diffs == {"2": ["amount"], "3": ["name"]}
    assert res["diff_store"]["changed"] == 2


def test_identical_files_match_and_text_checks(api_client, tmp_path):
    body = "id,v\n1,a\n2,b\n"
    a = _csv(tmp_path / "a.csv", body)
    b = _csv(tmp_path / "b.csv", body.replace("\n", "\r\n"))
    res = _run(api_client, a, b, {"key_columns": ["id"]})
    assert res["verdict"] == "MATCH"
    fc = res["file_checks"]
    assert fc["source"]["line_ending"] == "LF" and fc["target"]["line_ending"] == "CRLF"
    assert not fc["identical_bytes"]
    assert fc["line_diff"]["samples"][0]["reasons"] == ["line ending"]


def test_whole_row_compare_without_keys_is_a_multiset(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "x,y\n1,a\n1,a\n2,b\n3,c\n")
    b = _csv(tmp_path / "b.csv", "x,y\n1,a\n2,b\n3,c\n3,c\n")
    res = _run(api_client, a, b, {"auto_key": False})
    assert res["row_diff"]["strategy"] == "multiset"
    assert _rd(res) == (3, 0, 1, 1)


def test_duplicate_keys_are_paired(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "k,v\n1,a\n1,b\n2,c\n")
    b = _csv(tmp_path / "b.csv", "k,v\n1,b\n1,a\n2,c\n2,c\n")
    res = _run(api_client, a, b, {"key_columns": ["k"]})
    assert res["row_diff"]["duplicate_keys"] == {"source": 1, "target": 2}
    assert _rd(res) == (3, 0, 0, 1)


@pytest.mark.parametrize("left,right,equal", [
    ("12.50", "12.5", True),            # decimal formatting
    ("0012.5", "12.5", True),           # number stored as text vs number
    ("12.51", "12.5", False),
    ("2024-01-02", "2024-01-02 00:00:00", True),  # date vs midnight timestamp
    ("2024-01-02", "2024-01-02 00:00:01", False),
])
def test_representation_normalization(api_client, tmp_path, left, right, equal):
    a = _csv(tmp_path / "a.csv", f"id,v\n1,{left}\n")
    b = _csv(tmp_path / "b.csv", f"id,v\n1,{right}\n")
    res = _run(api_client, a, b, {"key_columns": ["id"]})
    assert (res["verdict"] == "MATCH") is equal, res["schema_diff"]["pairs"]


def test_booleans_and_text_numbers_across_types(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,flag,code\n1,true,7\n2,false,8\n")
    b = _csv(tmp_path / "b.csv", "id,flag,code\n1,Y,007\n2,N,8\n")
    res = _run(api_client, a, b, {"key_columns": ["id"], "file_checks": False})
    assert res["verdict"] == "MATCH", res["row_diff"]


def test_strict_mode_and_string_rules(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,s\n1,abc \n2,\n3,X\n")
    b = _csv(tmp_path / "b.csv", "id,s\n1,abc\n2,\"\"\n3,x\n")
    opts = {"key_columns": ["id"], "file_checks": False}
    res = _run(api_client, a, b, opts)
    assert res["row_diff"]["key_match_hash_diff_count"] == 2  # trailing space, case
    res = _run(api_client, a, b, {**opts, "normalize": {"rtrim": True, "case_insensitive": True, "null_equals_empty": True}})
    assert res["verdict"] == "MATCH"


def test_numeric_tolerance(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v\n1,1.001\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,1.002\n")
    assert _run(api_client, a, b, {"key_columns": ["id"]})["verdict"] == "MISMATCH"
    assert _run(api_client, a, b, {"key_columns": ["id"], "normalize": {"numeric_tolerance": 0.01}})["verdict"] == "MATCH"


def test_doubles_agree_to_15_significant_digits(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v\n1,32.14285714285715\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,32.142857142857146\n")
    assert _run(api_client, a, b, {"key_columns": ["id"]})["verdict"] == "MATCH"


def test_column_map_renames_and_ignores(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "cust_id,full_name,audit\n1,Ann,x\n2,Bob,y\n")
    b = _csv(tmp_path / "b.csv", "CustomerID,Name,audit\n1,Ann,z\n2,Bob,w\n")
    res = _run(api_client, a, b, {"column_map": [
        {"source": "cust_id", "target": "CustomerID", "role": "key"},
        {"source": "full_name", "target": "Name"},
        {"source": "audit", "target": "audit", "role": "ignore"},
    ]})
    assert res["verdict"] == "MATCH"
    assert res["schema_diff"]["mode"] == "map" and res["schema_diff"]["excluded"] == ["audit"]


def test_match_by_position_and_key_positions(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "a,b\n1,x\n2,y\n")
    b = _csv(tmp_path / "b.csv", "c,d\n1,x\n2,z\n")
    res = _run(api_client, a, b, {"match_columns": "position", "key_positions": [0]})
    assert _rd(res) == (1, 1, 0, 0)


def test_schema_drift_is_reported_not_in_verdict(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v,extra\n1,a,q\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,a\n")
    res = _run(api_client, a, b, {"key_columns": ["id"]})
    assert res["verdict"] == "MATCH"
    assert res["schema_diff"]["only_in_source"] == ["extra"]
    assert any("only in source" in w for w in res["warnings"])


def test_default_exclusions_and_explicit_empty(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v,INSERT_TMSTP\n1,a,2020-01-01\n")
    b = _csv(tmp_path / "b.csv", "id,v,INSERT_TMSTP\n1,a,2021-01-01\n")
    assert _run(api_client, a, b, {"key_columns": ["id"]})["verdict"] == "MATCH"
    assert _run(api_client, a, b, {"key_columns": ["id"], "excluded_columns": []})["verdict"] == "MISMATCH"


def test_bad_key_is_a_clear_error(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v\n1,a\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,a\n")
    r = api_client.post("/api/jobs/compare", json={"source": a, "target": b, "options": {"key_columns": ["nope"]}}).json()
    for _ in range(200):
        s = api_client.get(f"/api/jobs/{r['id']}").json()
        if s["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert s["status"] == "error" and "nope" in s["error"]
    run = api_client.get(f"/api/compare/runs/{s['run_uuid']}").json()
    assert run["status"] == "ERROR" and run["verdict"] == "ERROR"


# ---------------------------------------------------------------------------
# Formats
# ---------------------------------------------------------------------------
@pytest.fixture
def table():
    return pa.table({
        "id": pa.array([1, 2, 3], pa.int64()),
        "name": ["a", "b", None],
        "amount": pa.array([1.5, 2.25, 3.0]),
        "day": pa.array([dt.date(2024, 1, 1), dt.date(2024, 2, 1), None], pa.date32()),
        "at": pa.array([dt.datetime(2024, 1, 1, 12, 0, 1), None, dt.datetime(2024, 3, 1)], pa.timestamp("us")),
    })


def _write_all(table, d: Path) -> dict[str, dict]:
    import fastavro
    import pyarrow.csv as pcsv
    import pyarrow.feather as feather
    import pyarrow.orc as orc
    import pyarrow.parquet as pq
    import xlsxwriter

    out = {}
    pcsv.write_csv(table, d / "t.csv")
    out["csv"] = {"kind": "file", "path": str(d / "t.csv")}
    with open(d / "t.csv", "rb") as s, gzip.open(d / "t.csv.gz", "wb") as g:
        g.write(s.read())
    out["gz"] = {"kind": "file", "path": str(d / "t.csv.gz")}
    with zipfile.ZipFile(d / "t.zip", "w") as z:
        z.write(d / "t.csv", "inner/t.csv")
    out["zip"] = {"kind": "file", "path": str(d / "t.zip")}
    (d / "t.tsv").write_text((d / "t.csv").read_text().replace(",", "\t"))
    out["tsv"] = {"kind": "file", "path": str(d / "t.tsv")}
    pq.write_table(table, d / "t.parquet")
    out["parquet"] = {"kind": "file", "path": str(d / "t.parquet")}
    with open(d / "t.jsonl", "w") as f:
        for r in table.to_pylist():
            f.write(json.dumps(r, default=str) + "\n")
    out["jsonl"] = {"kind": "file", "path": str(d / "t.jsonl")}
    orc.write_table(table, d / "t.orc")
    out["orc"] = {"kind": "file", "path": str(d / "t.orc")}
    feather.write_feather(table, d / "t.arrow")
    out["arrow"] = {"kind": "file", "path": str(d / "t.arrow")}
    schema = {"type": "record", "name": "r", "fields": [
        {"name": "id", "type": "long"}, {"name": "name", "type": ["null", "string"]},
        {"name": "amount", "type": "double"},
        {"name": "day", "type": ["null", {"type": "int", "logicalType": "date"}]},
        {"name": "at", "type": ["null", {"type": "long", "logicalType": "timestamp-micros"}]},
    ]}
    with open(d / "t.avro", "wb") as f:
        fastavro.writer(f, schema, table.to_pylist())
    out["avro"] = {"kind": "file", "path": str(d / "t.avro")}
    wb = xlsxwriter.Workbook(str(d / "t.xlsx"))
    ws = wb.add_worksheet("Data")
    fmt = wb.add_format({"num_format": "yyyy-mm-dd hh:mm:ss"})
    ws.write_row(0, 0, table.column_names)
    for i, r in enumerate(table.to_pylist(), start=1):
        for j, c in enumerate(table.column_names):
            v = r[c]
            if isinstance(v, (dt.date, dt.datetime)):
                ws.write_datetime(i, j, v if isinstance(v, dt.datetime) else dt.datetime(v.year, v.month, v.day), fmt)
            elif v is not None:
                ws.write(i, j, v)
    wb.close()
    out["xlsx"] = {"kind": "file", "path": str(d / "t.xlsx"), "options": {"sheet": "Data"}}
    return out


@pytest.mark.parametrize("fmt", ["gz", "zip", "tsv", "parquet", "jsonl", "orc", "arrow", "avro", "xlsx"])
def test_every_format_matches_csv(api_client, tmp_path, table, fmt):
    sides = _write_all(table, tmp_path)
    res = _run(api_client, sides["csv"], sides[fmt], {"key_columns": ["id"]})
    assert res["verdict"] == "MATCH", (fmt, res["row_diff"]["column_mismatches"], res["schema_diff"]["pairs"])
    assert res["target"]["row_count"] == 3


def test_fixed_width_file(api_client, tmp_path):
    (tmp_path / "f.dat").write_text("1   Ann  \n2   Bob  \n")
    a = {"kind": "file", "path": str(tmp_path / "f.dat"), "format": "fixed",
         "options": {"fixed_columns": [{"name": "id", "width": 4}, {"name": "name", "width": 5}]}}
    b = _csv(tmp_path / "b.csv", "id,name\n1,Ann\n2,Bob\n")
    assert _run(api_client, a, b, {"key_columns": ["id"]})["verdict"] == "MATCH"


def test_upload_inspect_and_compare(api_client, tmp_path, table):
    sides = _write_all(table, tmp_path)
    up = api_client.post("/api/files", files={"file": ("t.xlsx", open(sides["xlsx"]["path"], "rb"))}).json()
    assert up["inspect"]["format"] == "excel" and up["inspect"]["sheets"] == ["Data"]
    assert [c["name"] for c in up["inspect"]["columns"]] == table.column_names
    res = _run(api_client, {"kind": "file", "file_id": up["file_id"]}, sides["parquet"], {"key_columns": ["id"]})
    assert res["verdict"] == "MATCH"
    ins = api_client.post("/api/files/inspect", json={"path": sides["csv"]["path"]}).json()
    assert ins["detected"]["delimiter"] == "," and ins["row_count"] == 3
    assert api_client.delete(f"/api/files/{up['file_id']}").json()["ok"]


def test_browse_folder_lists_supported_files(api_client, tmp_path, table):
    _write_all(table, tmp_path)
    (tmp_path / "notes.docx").write_text("x")
    out = api_client.get("/api/files/browse", params={"path": str(tmp_path)}).json()
    names = {e["name"] for e in out["entries"]}
    assert "t.parquet" in names and "notes.docx" not in names


# ---------------------------------------------------------------------------
# Diff store, exports, report
# ---------------------------------------------------------------------------
def test_diff_store_browse_filter_export_and_encryption(api_client, tmp_path):
    rows_a = "id,name,v\n" + "".join(f"{i},n{i},{i}\n" for i in range(1, 501))
    rows_b = "id,name,v\n" + "".join(f"{i},n{i},{i + (1 if i % 50 == 0 else 0)}\n" for i in range(2, 502))
    a = _csv(tmp_path / "a.csv", rows_a)
    b = _csv(tmp_path / "b.csv", rows_b)
    res = _run(api_client, a, b, {"key_columns": ["id"], "sample_limit": 5})
    uid = res["run_uuid"]
    assert _rd(res) == (489, 10, 1, 1)
    assert len(res["row_diff"]["samples"]["key_match_column_diffs"]) == 5
    page = api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "changed", "limit": 3}).json()
    assert page["total"] == 10 and len(page["rows"]) == 3
    assert [c["name"] for c in page["columns"]][:4] == ["__diff", "k:id", "s:name", "t:name"]
    assert api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "changed", "column": "name"}).json()["total"] == 0
    assert api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "changed", "search": "n250"}).json()["total"] == 1
    assert api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "only_target"}).json()["rows"][0][0] == 501
    meta = api_client.get(f"/api/compare/runs/{uid}/diff/meta").json()
    assert meta["counts"] == {"only_source": 1, "only_target": 1, "changed": 10}

    from app.config import settings
    store = settings.data_dir / "runs" / f"{uid}.duckdb"
    assert store.exists() and b"n250" not in store.read_bytes()
    import duckdb
    con = duckdb.connect()
    with pytest.raises(Exception):
        con.execute(f"ATTACH '{store.as_posix()}' AS x (READ_ONLY)")
        con.execute("SELECT * FROM x.changed").fetchall()

    session = api_client.headers.pop("X-DV-Session")
    try:
        assert api_client.post(f"/api/compare/runs/{uid}/export", json={"kind": "changed", "format": "csv"}).status_code == 401
    finally:
        api_client.headers["X-DV-Session"] = session
    for fmt in ("csv", "parquet", "json", "xlsx"):
        t = api_client.post(f"/api/compare/runs/{uid}/export", json={"kind": "changed", "format": fmt}).json()
        api_client.headers.pop("X-DV-Session")
        try:
            dl = api_client.get(t["url"])
            assert dl.status_code == 200 and len(dl.content) == t["size_bytes"]
            assert api_client.get(t["url"]).status_code == 404  # one-time
        finally:
            api_client.headers["X-DV-Session"] = session
        if fmt == "csv":
            assert b"n250" in dl.content
    rep = api_client.post(f"/api/compare/runs/{uid}/report").json()
    dl = api_client.get(rep["url"])
    with zipfile.ZipFile(__import__("io").BytesIO(dl.content)) as z:
        sheets = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet")]
        assert len(sheets) >= 5
        assert all(b"<f>" not in z.read(n) for n in sheets)
    assert api_client.get(f"/api/compare/runs/{uid}/excel").status_code == 200
    assert api_client.delete(f"/api/compare/runs/{uid}").status_code == 204
    assert not store.exists()


def test_history_filters_and_metrics(api_client, tmp_path):
    a = _csv(tmp_path / "a.csv", "id,v\n1,a\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,b\n")
    res = _run(api_client, a, b, {"key_columns": ["id"]})
    runs = api_client.get("/api/compare/runs", params={"verdict": "MISMATCH", "kind": "file"}).json()
    assert any(r["run_uuid"] == res["run_uuid"] for r in runs["items"])
    m = api_client.get("/api/metrics/dashboard").json()
    assert m["total_runs"] >= 1 and m["recent_runs"]


def test_bulk_job_and_auto_pairing(api_client, tmp_path):
    s, t = tmp_path / "s", tmp_path / "t"
    s.mkdir()
    t.mkdir()
    for name, diff in (("customers", False), ("orders", True), ("lonely", False)):
        (s / f"{name}.csv").write_text("id,v\n1,a\n2,b\n")
        if name != "lonely":
            (t / f"STG_{name.upper()}.csv").write_text("id,v\n1,a\n2," + ("z" if diff else "b") + "\n")
    pairs = api_client.post("/api/jobs/pair", json={
        "source": {"kind": "folder", "path": str(s)}, "target": {"kind": "folder", "path": str(t)},
        "strip_prefix": "stg_",
    }).json()
    assert len(pairs["pairs"]) == 2 and pairs["unmatched_source"][0]["name"] == "lonely.csv"
    items = [{"name": p["source"]["name"], "source": p["source"]["side"], "target": p["target"]["side"],
              "options": {"key_columns": ["id"]}} for p in pairs["pairs"]]
    job = api_client.post("/api/jobs/bulk", json={"name": "nightly", "items": items, "concurrency": 2}).json()
    for _ in range(400):
        snap = api_client.get(f"/api/jobs/{job['id']}").json()
        if snap["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert snap["status"] == "done" and snap["counts"] == {"match": 1, "mismatch": 1}
    batch = api_client.get(f"/api/compare/batches/{job['batch_uuid']}").json()
    assert len(batch["runs"]) == 2 and batch["status"] == "SUCCESS"


def test_cancel_a_running_job(api_client, monkeypatch, tmp_path):
    from app.engine import core

    def slow(spec, rc):
        for _ in range(200):
            rc.check()
            time.sleep(0.02)
        return {}

    monkeypatch.setattr(core, "run_compare", slow)
    a = _csv(tmp_path / "a.csv", "id\n1\n")
    job = api_client.post("/api/jobs/compare", json={"source": a, "target": a}).json()
    time.sleep(0.1)
    api_client.post(f"/api/jobs/{job['id']}/cancel")
    for _ in range(200):
        s = api_client.get(f"/api/jobs/{job['id']}").json()
        if s["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert s["status"] == "cancelled"


def test_legacy_template_payload_converts():
    from app.engine.spec import from_legacy_compare

    spec = from_legacy_compare({
        "source": {"connection_id": 1, "schema_name": "s", "table": "a", "filter_sql": "x > 1"},
        "target": {"connection_id": 2, "table": "b"},
        "key_columns": ["id"], "engine": "polars", "normalize": {"enabled": True, "rtrim": True},
        "column_map": [{"source": "a", "target": "b", "role": "key"}],
    })
    assert spec.source.filter_sql == "x > 1" and spec.options.normalize.rtrim
    assert spec.options.column_map[0].role == "key"


def test_side_spec_rejects_filter_injection():
    from pydantic import ValidationError
    from app.engine.spec import SideSpec

    with pytest.raises(ValidationError):
        SideSpec(kind="table", connection_id=1, table="t", filter_sql="1=1; DROP TABLE x")


# ---------------------------------------------------------------------------
# Live PostgreSQL (DV_TEST_PG="host:port/db/user[/password]")
# ---------------------------------------------------------------------------
PG = os.environ.get("DV_TEST_PG")


@pytest.fixture
def pg_conn(api_client):
    if not PG:
        pytest.skip("set DV_TEST_PG=host:port/db/user[/password] to run the PostgreSQL reader tests")
    hp, db, user, *pw = PG.split("/")
    host, port = hp.split(":")
    r = api_client.post("/api/connections", json={
        "name": f"pg_{time.time_ns()}", "db_type": "postgres", "host": host, "port": int(port),
        "username": user, "password": pw[0] if pw else "x", "database": db,
    })
    cid = r.json()["id"]
    from app.connectors.factory import get_connector
    from app.engine.core import _load_record
    c = get_connector(_load_record(cid), purpose="test")
    with c.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS dvtest CASCADE")
        cur.execute("CREATE SCHEMA dvtest")
        cur.execute("CREATE TABLE dvtest.a (id int PRIMARY KEY, name text, amount numeric(10,2), at timestamp, flag boolean)")
        cur.execute("CREATE TABLE dvtest.b (id bigint PRIMARY KEY, name varchar(20), amount numeric(12,3), at timestamp, flag boolean)")
        cur.execute("INSERT INTO dvtest.a SELECT g, 'n'||g, g*1.5, '2024-01-01'::timestamp + g*interval '1 minute', g%2=0 FROM generate_series(1,5000) g")
        cur.execute("INSERT INTO dvtest.b SELECT g, 'n'||g, g*1.5, '2024-01-01'::timestamp + g*interval '1 minute', g%2=0 FROM generate_series(2,5001) g")
        cur.execute("UPDATE dvtest.b SET name='changed' WHERE id=100")
    yield cid
    with c.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS dvtest CASCADE")


@pytest.mark.parametrize("strategy", ["local", "in_database"])
def test_postgres_tables_with_primary_key(api_client, pg_conn, strategy):
    a = {"kind": "table", "connection_id": pg_conn, "schema_name": "dvtest", "table": "a"}
    b = {"kind": "table", "connection_id": pg_conn, "schema_name": "dvtest", "table": "b"}
    res = _run(api_client, a, b, {"strategy": strategy})
    assert res["key_columns"] == ["id"] and res["key_source"] == "source primary key"
    assert _rd(res) == (4998, 1, 1, 1)
    assert res["strategy"] == strategy


def test_postgres_reader_fallback_chain(api_client, pg_conn, monkeypatch):
    from app.engine import readers

    a = {"kind": "table", "connection_id": pg_conn, "schema_name": "dvtest", "table": "a", "filter_sql": "id <= 100"}
    b = {"kind": "query", "connection_id": pg_conn, "sql": "select * from dvtest.a where id <= 100;"}
    for chain in ("adbc_postgres,cursor", "cursor"):
        monkeypatch.setenv("DV_READER_ORDER_POSTGRES", chain)
        res = _run(api_client, a, b, {"key_columns": ["id"]})
        assert res["verdict"] == "MATCH", chain
        assert res["source"]["reader"].startswith(chain.split(",")[0].replace("_", " ").replace("adbc postgres", "adbc postgresql").split(" ")[0])
    monkeypatch.delenv("DV_READER_ORDER_POSTGRES")
    _ = readers


def test_postgres_table_vs_csv_file(api_client, pg_conn, tmp_path):
    lines = ["id,name,amount,at,flag"] + [
        f"{g},n{g},{g * 1.5:.2f},{(dt.datetime(2024, 1, 1) + dt.timedelta(minutes=g)).isoformat(sep=' ')},{'true' if g % 2 == 0 else 'false'}"
        for g in range(1, 5001)]
    f = _csv(tmp_path / "a.csv", "\n".join(lines) + "\n")
    a = {"kind": "table", "connection_id": pg_conn, "schema_name": "dvtest", "table": "a"}
    res = _run(api_client, a, f)
    assert res["verdict"] == "MATCH", res["row_diff"]["column_mismatches"]
