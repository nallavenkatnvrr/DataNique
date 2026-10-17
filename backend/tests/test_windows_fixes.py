"""Regression tests for problems seen on the first Windows runs of 0.3:

* DuckDB without httpfs can't write encrypted files ("read-only crypto
  module") → diff stores are sealed by the app instead.
* Snowflake Arrow chunks whose batches were converted to different types
  ("Schema at index N was different") and batches whose types change
  between chunks.
"""
from __future__ import annotations

import io

import pytest

from tests.test_engine import _csv, _rd, _run

pa = pytest.importorskip("pyarrow")


@pytest.fixture
def no_native_crypto(monkeypatch):
    from app.engine import core
    monkeypatch.setitem(core._crypto_state, "native", False)
    monkeypatch.setitem(core._crypto_state, "reason", "test: httpfs unavailable")
    yield


def test_diff_store_is_sealed_when_duckdb_cannot_encrypt(api_client, tmp_path, no_native_crypto):
    from app.config import settings
    from app.engine import storeseal

    a = _csv(tmp_path / "a.csv", "id,name\n" + "".join(f"{i},n{i}\n" for i in range(1, 301)))
    b = _csv(tmp_path / "b.csv", "id,name\n" + "".join(f"{i},n{i}{'x' if i % 100 == 0 else ''}\n" for i in range(1, 302)))
    res = _run(api_client, a, b, {"key_columns": ["id"], "sample_limit": 2})
    uid = res["run_uuid"]
    assert _rd(res) == (297, 3, 0, 1)
    assert len(res["row_diff"]["samples"]["key_match_column_diffs"]) == 2

    runs = settings.data_dir / "runs"
    sealed = runs / f"{uid}.dvs"
    assert sealed.exists() and not (runs / f"{uid}.duckdb").exists()
    assert not storeseal.work_path(uid).exists()          # plain working copy removed
    assert b"n100x" not in sealed.read_bytes()

    page = api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "changed"}).json()
    assert page["total"] == 3
    assert api_client.get(f"/api/compare/runs/{uid}/diff/meta").json()["counts"]["changed"] == 3
    t = api_client.post(f"/api/compare/runs/{uid}/export", json={"kind": "changed", "format": "csv"}).json()
    sess = api_client.headers.pop("X-DV-Session")
    try:
        assert b"n100x" in api_client.get(t["url"]).content
    finally:
        api_client.headers["X-DV-Session"] = sess

    # Locking removes decrypted copies; a tampered file no longer opens.
    storeseal.purge_cache()
    assert not list(storeseal.work_dir().glob(f"{uid}*"))
    raw = bytearray(sealed.read_bytes())
    raw[len(raw) // 2] ^= 0xFF
    sealed.write_bytes(bytes(raw))
    assert api_client.get(f"/api/compare/runs/{uid}/diff", params={"kind": "changed"}).status_code >= 400

    assert api_client.delete(f"/api/compare/runs/{uid}").status_code == 204
    assert not sealed.exists()


def test_sealed_file_round_trip_and_truncation(tmp_path):
    from app.engine import storeseal
    from tests.conftest import unlocked_session_token

    unlocked_session_token()
    src = tmp_path / "plain.bin"
    data = bytes(range(256)) * (storeseal.CHUNK // 256 * 2 + 7)   # > 2 chunks
    src.write_bytes(data)
    enc, dec = tmp_path / "x.dvs", tmp_path / "x.out"
    storeseal.encrypt_file(src, enc, "ab" * 16)
    storeseal.decrypt_file(enc, dec, "ab" * 16)
    assert dec.read_bytes() == data
    with pytest.raises(Exception):                       # wrong run id = wrong key / AAD
        storeseal.decrypt_file(enc, dec, "cd" * 16)
    enc.write_bytes(enc.read_bytes()[: storeseal.CHUNK + 16 + 20])   # drop the last chunks
    with pytest.raises(Exception):
        storeseal.decrypt_file(enc, dec, "ab" * 16)


def test_batches_with_changing_types_are_ingested():
    import datetime as dt

    import duckdb
    from app.engine import readers
    from app.engine.spec import SideSpec

    con = duckdb.connect()
    b1 = pa.table({
        "k": pa.array([1, 2], pa.int8()),
        "ts": pa.array([dt.datetime(2020, 1, 1), None], pa.timestamp("ns")),
        "late": pa.array([None, None], pa.null()),
        "never": pa.array([None, None], pa.null()),
    })
    b2 = pa.table({
        "k": pa.array([30000], pa.int32()),
        "ts": pa.array([dt.datetime(9999, 12, 31)], pa.timestamp("us")),
        "late": pa.array(["text"], pa.string()),
        "never": pa.array([None], pa.null()),
    })
    ctx = readers.ReadContext(con, "t", SideSpec(kind="query", connection_id=1, sql="x"), None, "src", "x",
                              None, None, 0, lambda n: None, lambda: False, lambda *a: None, [])
    assert readers._ingest_batches(ctx, [b1, b2]) == 3
    types = {r[0]: r[1] for r in con.execute("DESCRIBE t").fetchall()}
    assert types == {"k": "BIGINT", "ts": "TIMESTAMP", "late": "VARCHAR", "never": "VARCHAR"}
    assert con.execute("SELECT max(k), max(ts)::VARCHAR, max(late) FROM t").fetchone() == (30000, "9999-12-31 00:00:00", "text")


def test_snowflake_chunk_with_mixed_batch_types():
    """A Snowflake chunk where one batch holds 9999-12-31 (converted to
    timestamp[us]) and the others timestamp[ns] used to fail with
    "Schema at index 1 was different"."""
    pytest.importorskip("snowflake.connector.nanoarrow_arrow_iterator")
    from snowflake.connector.arrow_context import ArrowConverterContext
    from snowflake.connector.constants import IterUnit
    from snowflake.connector.result_batch import _create_nanoarrow_iterator

    from app.engine import readers

    def md(lt, scale):
        return {"logicalType": lt, "scale": str(scale), "precision": "38" if lt == "FIXED" else "0",
                "charLength": "0", "byteLength": "0", "finalType": "T"}
    st = pa.struct([pa.field("epoch", pa.int64(), False), pa.field("fraction", pa.int32(), False)])
    schema = pa.schema([pa.field("MEMBER_ID", pa.int32(), False, metadata=md("FIXED", 0)),
                        pa.field("END_DATE", st, True, metadata=md("TIMESTAMP_NTZ", 9))])

    def batch(cks, secs):
        return pa.record_batch([pa.array(cks, pa.int32()),
                                pa.StructArray.from_arrays([pa.array(secs, pa.int64()), pa.array([0] * len(secs), pa.int32())],
                                                           fields=list(st))], schema=schema)
    buf = io.BytesIO()
    with pa.ipc.new_stream(buf, schema) as w:
        w.write_batch(batch([1, 2], [1600000000, 1700000000]))
        w.write_batch(batch([3], [253402214400]))
    readers._patch_snowflake_arrow()
    t = next(_create_nanoarrow_iterator(buf.getvalue(), ArrowConverterContext({"TIMEZONE": "UTC"}), False, False,
                                        False, IterUnit.TABLE_UNIT))
    assert t.num_rows == 3
    assert t.column("END_DATE").type == pa.timestamp("us")
    assert t.column("END_DATE")[2].as_py().year == 9999


def test_job_is_done_only_after_the_run_is_saved(api_client, tmp_path, monkeypatch):
    """A job reported "done" must already be in history (the live page opens
    the result as soon as it sees "done"). CI caught this as a race."""
    import time as _time
    from app.engine import jobs

    real = jobs.persist_run

    def slow_persist(*a, **kw):
        _time.sleep(0.8)
        return real(*a, **kw)

    monkeypatch.setattr(jobs, "persist_run", slow_persist)
    a = _csv(tmp_path / "a.csv", "id,v\n1,a\n2,b\n")
    b = _csv(tmp_path / "b.csv", "id,v\n1,a\n2,c\n")
    r = api_client.post("/api/jobs/compare", json={"source": a, "target": b, "options": {"key_columns": ["id"]}})
    job = r.json()
    deadline = _time.time() + 60
    while _time.time() < deadline:
        snap = api_client.get(f"/api/jobs/{job['id']}").json()
        if snap["status"] not in ("queued", "running"):
            break
        _time.sleep(0.02)
    assert snap["status"] == "done"
    run = api_client.get(f"/api/compare/runs/{snap['run_uuid']}")
    assert run.status_code == 200 and run.json()["result"]["row_diff"]["key_match_hash_diff_count"] == 1
