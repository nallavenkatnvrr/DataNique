"""Router-level tests using FastAPI's TestClient against a temp SQLite DB.

These exercise the HTTP surface end-to-end (routing, validation, serialization,
persistence) WITHOUT touching any real database driver - every endpoint tested
here either works purely on the local SQLite store or fails BEFORE a DB
connection is attempted (e.g. the filter_sql guard rejects at request-validation
time).

The ``api_client`` fixture (see conftest.py) binds to a throwaway SQLite file
and creates the tables via ``init_db()``.
"""
from __future__ import annotations

import uuid

import pytest


def _unique(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# --------------------------------------------------------------------------
# Health + metadata
# --------------------------------------------------------------------------

def test_health_ok(api_client):
    r = api_client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"


def test_session_or_api_token_required_and_cors_preflight(api_client, monkeypatch):
    from app.config import settings

    origin = settings.get_cors_origins()[0]
    monkeypatch.setattr(settings, "api_token", "secret")
    monkeypatch.setattr(settings, "admin_token", "")
    session = api_client.headers.pop("X-DV-Session")
    try:
        assert api_client.get("/api/connections").status_code == 401
        assert api_client.get("/api/connections?api_token=secret").status_code == 401
        assert api_client.get("/api/connections", headers={"X-API-Token": "secret"}).status_code == 200
        assert api_client.get("/api/connections", headers={"X-DV-Session": session}).status_code == 200
        assert api_client.get("/api/connections", headers={"X-DV-Session": "forged"}).status_code == 401
    finally:
        api_client.headers["X-DV-Session"] = session

    preflight = api_client.options(
        "/api/connections",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-dv-session",
        },
    )
    assert preflight.status_code == 200
    assert preflight.headers.get("access-control-allow-origin") == origin
    assert "x-dv-session" in preflight.headers.get("access-control-allow-headers", "").lower()


def test_foreign_host_header_is_refused(api_client):
    r = api_client.get("/api/connections", headers={"Host": "evil.example.com"})
    assert r.status_code == 421


def test_admin_token_protects_stop_and_detailed_health(api_client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "api_token", "")
    monkeypatch.setattr(settings, "admin_token", "admin-secret")
    assert api_client.post("/api/compare/stop", json={}).status_code == 401
    assert api_client.get("/api/health/detailed").status_code == 401
    assert api_client.post(
        "/api/compare/stop", json={}, headers={"X-Admin-Token": "admin-secret"}
    ).status_code == 200
    assert api_client.get(
        "/api/health/detailed", headers={"X-Admin-Token": "admin-secret"}
    ).status_code == 200


def test_list_db_types(api_client):
    r = api_client.get("/api/connections/types")
    assert r.status_code == 200
    types = {t["type"] for t in r.json()}
    # The five supported engines must all be advertised.
    assert {"snowflake", "oracle", "sqlserver", "postgres", "mysql"} <= types


# --------------------------------------------------------------------------
# Connections CRUD
# --------------------------------------------------------------------------

def _make_connection(api_client, name: str | None = None, **overrides) -> dict:
    payload = {
        "name": name or _unique("conn"),
        "db_type": "postgres",
        "host": "localhost",
        "port": 5432,
        "username": "u",
        "password": "secret",
        "database": "db",
    }
    payload.update(overrides)
    r = api_client.post("/api/connections", json=payload)
    assert r.status_code == 201, r.text
    return r.json()


def test_create_connection_encrypts_password_and_hides_it(api_client):
    out = _make_connection(api_client)
    # Password is never echoed back; only the has_password flag is exposed.
    assert "password" not in out
    assert out["has_password"] is True
    assert out["db_type"] == "postgres"


def test_create_connection_rejects_unsupported_db_type(api_client):
    r = api_client.post("/api/connections", json={
        "name": _unique("bad"), "db_type": "mongodb",
    })
    assert r.status_code == 400


def test_create_connection_rejects_duplicate_name(api_client):
    name = _unique("dup")
    _make_connection(api_client, name=name)
    r = api_client.post("/api/connections", json={
        "name": name, "db_type": "postgres",
    })
    assert r.status_code == 409


def test_list_and_get_roundtrip(api_client):
    created = _make_connection(api_client)
    r = api_client.get("/api/connections")
    assert r.status_code == 200
    ids = {c["id"] for c in r.json()}
    assert created["id"] in ids


def test_update_connection(api_client):
    created = _make_connection(api_client)
    r = api_client.put(f"/api/connections/{created['id']}", json={
        "name": created["name"], "db_type": "postgres",
        "host": "newhost", "port": 5433, "username": "u2",
        "database": "db2",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["host"] == "newhost"
    assert body["port"] == 5433


def test_update_rejects_unsupported_db_type(api_client):
    created = _make_connection(api_client)
    r = api_client.put(f"/api/connections/{created['id']}", json={
        "name": created["name"], "db_type": "mongodb",
    })
    assert r.status_code == 400


def test_update_missing_connection_404(api_client):
    r = api_client.put("/api/connections/999999", json={
        "name": _unique("x"), "db_type": "postgres",
    })
    assert r.status_code == 404


def test_delete_connection(api_client):
    created = _make_connection(api_client)
    r = api_client.delete(f"/api/connections/{created['id']}")
    assert r.status_code == 204
    # Second delete now 404s.
    r2 = api_client.delete(f"/api/connections/{created['id']}")
    assert r2.status_code == 404


# --------------------------------------------------------------------------
# Compare - filter_sql guard (rejects BEFORE any DB connection is made)
# --------------------------------------------------------------------------

def _compare_payload(src_id: int, tgt_id: int, *, filter_source=None, filter_target=None) -> dict:
    src = {"connection_id": src_id, "table": "t"}
    tgt = {"connection_id": tgt_id, "table": "t"}
    if filter_source is not None:
        src["filter_sql"] = filter_source
    if filter_target is not None:
        tgt["filter_sql"] = filter_target
    return {"source": src, "target": tgt}


def test_compare_rejects_stacked_statement_in_source_filter(api_client):
    a = _make_connection(api_client)
    b = _make_connection(api_client)
    r = api_client.post("/api/compare/run", json=_compare_payload(
        a["id"], b["id"], filter_source="1=1; DROP TABLE users",
    ))
    assert r.status_code == 400
    assert "filter_sql" in r.json()["detail"]


def test_compare_rejects_comment_in_target_filter(api_client):
    a = _make_connection(api_client)
    b = _make_connection(api_client)
    r = api_client.post("/api/compare/run", json=_compare_payload(
        a["id"], b["id"], filter_target="id > 0 -- ignore rest",
    ))
    assert r.status_code == 400


def test_streamed_compare_rejects_stacked_filter(api_client):
    a = _make_connection(api_client)
    b = _make_connection(api_client)
    r = api_client.post("/api/compare/run/stream", json=_compare_payload(
        a["id"], b["id"], filter_source="id > 0; DROP TABLE users",
    ))
    assert r.status_code == 400
    assert "filter_sql" in r.json()["detail"]


def test_compare_missing_connection_404(api_client):
    # No connections with these ids → load_connection raises 404 before compare.
    r = api_client.post("/api/compare/run", json=_compare_payload(10 ** 9, 10 ** 9 + 1))
    assert r.status_code == 404


# --------------------------------------------------------------------------
# Compare history (read-only, empty-state + not-found paths)
# --------------------------------------------------------------------------

def test_list_runs_shape(api_client):
    r = api_client.get("/api/compare/runs?limit=5&offset=0")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"items", "total", "limit", "offset"}
    assert isinstance(body["items"], list)


def test_get_missing_run_404(api_client):
    r = api_client.get(f"/api/compare/runs/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_delete_missing_run_404(api_client):
    r = api_client.delete(f"/api/compare/runs/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_watermark_empty_state(api_client):
    r = api_client.get("/api/compare/watermark", params={
        "source_label": "s", "target_label": "t", "incremental_column": "updated_at",
        "source_connection_id": 101, "target_connection_id": 202,
    })
    assert r.status_code == 200
    assert r.json()["last_compared_at"] is None


def test_watermark_only_advances_after_a_match(api_client):
    from datetime import datetime
    from app.db.store import CompareRun, get_session

    s = get_session()
    try:
        for verdict, started in (("MISMATCH", datetime(2025, 1, 3)), ("MATCH", datetime(2025, 1, 2))):
            s.add(CompareRun(
                run_uuid=uuid.uuid4().hex, status="SUCCESS", verdict=verdict,
                source_connection_id=31, target_connection_id=32,
                source_label="wm_s", target_label="wm_t",
                options={"incremental_column": "UPDATED_AT"}, result={"verdict": verdict},
                started_at=started, finished_at=started,
            ))
        s.commit()
    finally:
        s.close()
    r = api_client.get("/api/compare/watermark", params={
        "source_label": "wm_s", "target_label": "wm_t", "incremental_column": "updated_at",
        "source_connection_id": 31, "target_connection_id": 32,
    }).json()
    assert r["last_compared_at"] == "2025-01-02T00:00:00Z"


def test_excel_report_does_not_turn_sample_strings_into_formulas():
    from io import BytesIO
    from zipfile import ZipFile
    from app.reports.excel import build_excel_report

    result = {
        "source": {"connection": "src", "db_type": "postgres", "table": "t", "row_count": 1},
        "target": {"connection": "tgt", "db_type": "postgres", "table": "t", "row_count": 1},
        "status": "SUCCESS",
        "verdict": "MISMATCH",
        "row_diff": {
            "strategy": "test",
            "samples": {"only_in_source": [{"payload": '=HYPERLINK("https://invalid", "click")'}]},
        },
    }
    workbook = build_excel_report(result)
    with ZipFile(BytesIO(workbook)) as archive:
        worksheets = [archive.read(name) for name in archive.namelist() if name.startswith("xl/worksheets/")]
    assert worksheets
    assert all(b"<f>" not in sheet and b"<f " not in sheet for sheet in worksheets)


# --------------------------------------------------------------------------
# Compare /stop - pure eviction, no DB work
# --------------------------------------------------------------------------

def test_stop_compare_ok(api_client, monkeypatch):
    from app.config import settings
    from app.connectors import factory

    monkeypatch.setattr(settings, "admin_token", "")
    calls = []
    monkeypatch.setattr(
        factory, "evict_compare_connectors",
        lambda connection_id, force=True: calls.append((connection_id, force)) or ["compare#src"],
    )
    r = api_client.post("/api/compare/stop", json={
        "source_connection_id": 1, "target_connection_id": 2,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert isinstance(body["evicted"], list)
    assert calls == [(1, True), (2, True)]


def test_stream_disconnect_cancels_the_job(api_client, monkeypatch):
    import asyncio
    import threading

    from app.engine import core
    from app.routers import compare
    from app.routers._compare_shared import CompareRequest

    a = _make_connection(api_client)
    b = _make_connection(api_client)
    started = threading.Event()
    finished = threading.Event()

    def blocked(spec, rc):
        rc.log("info", "started")
        started.set()
        for _ in range(100):
            if rc.cancelled():
                finished.set()
                raise InterruptedError("Cancelled")
            threading.Event().wait(0.05)
        return {}

    monkeypatch.setattr(core, "run_compare", blocked)
    request = CompareRequest(source={"connection_id": a["id"], "table": "s"},
                             target={"connection_id": b["id"], "table": "t"})

    async def disconnect():
        response = await compare.run_stream(request)
        iterator = response.body_iterator
        assert started.wait(timeout=5)
        assert (await iterator.__anext__()).endswith("\n")
        await iterator.aclose()

    asyncio.run(disconnect())
    assert finished.wait(timeout=5)


def test_compare_eviction_helper_covers_all_compare_slots(monkeypatch):
    from app.connectors import factory

    connection_id = -777
    purposes = [
        "compare", "compare#src", "compare#tgt#0", "checksum", "default",
        "sql_ide:tab", "metadata",
    ]

    class ConnectorStub:
        def __init__(self):
            self.force_values = []

        def dispose(self, force=False):
            self.force_values.append(force)

    stubs = {purpose: ConnectorStub() for purpose in purposes}
    with factory._cache_lock:
        original = dict(factory._connector_cache)
        for purpose, stub in stubs.items():
            factory._connector_cache[(connection_id, purpose)] = (stub, "fingerprint")
    try:
        evicted = factory.evict_compare_connectors(connection_id, force=True)
        assert set(evicted) == {"compare", "compare#src", "compare#tgt#0", "checksum", "default"}
        assert all(stubs[purpose].force_values == [True] for purpose in evicted)
        assert (connection_id, "sql_ide:tab") in factory._connector_cache
        assert (connection_id, "metadata") in factory._connector_cache
    finally:
        with factory._cache_lock:
            factory._connector_cache.clear()
            factory._connector_cache.update(original)


def test_file_upload_limit_is_enforced_while_reading(api_client, monkeypatch):
    from app.routers import files

    monkeypatch.setattr(files, "upload_limit_bytes", lambda: 4)
    response = api_client.post("/api/files", files={"file": ("source.csv", b"12345", "text/csv")})
    assert response.status_code == 413


def test_sql_ide_rejects_max_rows_above_cap(api_client):
    connection = _make_connection(api_client)
    session_response = api_client.post("/api/sql-ide/sessions", json={
        "connection_id": connection["id"],
    })
    assert session_response.status_code == 201
    session_id = session_response.json()["session_id"]
    response = api_client.post(
        f"/api/sql-ide/sessions/{session_id}/execute",
        json={"sql": "SELECT 1", "max_rows": 1_000_001},
    )
    assert response.status_code == 422
    assert api_client.delete(f"/api/sql-ide/sessions/{session_id}").status_code == 204


def test_sql_statement_splitter_preserves_semicolons_in_literals():
    from app.services.query_session import _split_sql_statements

    statements = _split_sql_statements(
        "SELECT 'a;''b'; SELECT \"x;y\"; SELECT [a;b]; "
        "SELECT `c;d`; SELECT $$e;f$$; SELECT q'[g;h]'"
    )
    assert len(statements) == 6
    assert statements[0] == "SELECT 'a;''b'"
    assert statements[1] == 'SELECT "x;y"'
    assert statements[2] == "SELECT [a;b]"
    assert statements[3] == "SELECT `c;d`"
    assert statements[4] == "SELECT $$e;f$$"
    assert statements[5] == "SELECT q'[g;h]'"


def test_sql_server_temp_table_prefix_is_not_treated_as_a_comment():
    from app.services.query_session import _split_sql_statements

    statements = _split_sql_statements(
        "CREATE TABLE #temp (id int); INSERT INTO #temp VALUES (1); SELECT * FROM #temp;",
        "sqlserver",
    )
    assert len(statements) == 3
    assert statements[-1] == "SELECT * FROM #temp"


def test_query_session_connection_change_and_delete_evict_scoped_connectors(monkeypatch):
    from app.services.query_session import QuerySessionManager

    evicted = []
    monkeypatch.setattr(
        "app.connectors.factory.evict_connector",
        lambda connection_id, purpose=None, force=False: evicted.append((connection_id, purpose, force)),
    )
    manager = QuerySessionManager(max_workers=1)
    session = manager.create_session(11)
    purpose = f"sql_ide:{session.session_id}"

    assert manager.change_connection(session.session_id, 22)
    assert manager.get_session(session.session_id).connection_id == 22
    assert (11, purpose, True) in evicted
    assert (22, purpose, True) in evicted

    assert manager.delete_session(session.session_id)
    assert evicted.count((22, purpose, True)) == 2
    manager.shutdown()


def test_query_session_admission_is_atomic_and_queued_cancel_releases_slot(monkeypatch):
    import concurrent.futures
    import threading
    from app.services import query_session

    class ManualPool:
        def __init__(self):
            self.futures = []

        def submit(self, *args, **kwargs):
            future = concurrent.futures.Future()
            self.futures.append(future)
            return future

        def shutdown(self, wait=False, cancel_futures=False):
            if cancel_futures:
                for future in self.futures:
                    future.cancel()

    manager = query_session.QuerySessionManager(max_workers=1)
    manager._pool.shutdown(wait=False)
    manager._pool = ManualPool()
    session = manager.create_session(91)
    original_uuid4 = query_session.uuid.uuid4
    barrier = threading.Barrier(query_session.MAX_CONCURRENT_PER_CONNECTION + 1)

    def synchronized_uuid4():
        barrier.wait(timeout=3)
        return original_uuid4()

    monkeypatch.setattr(query_session.uuid, "uuid4", synchronized_uuid4)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as submitters:
        pending = [
            submitters.submit(manager.execute, session.session_id, f"SELECT {i}")
            for i in range(4)
        ]
        accepted = []
        rejected = 0
        for future in pending:
            try:
                accepted.append(future.result(timeout=5))
            except RuntimeError:
                rejected += 1
    monkeypatch.setattr(query_session.uuid, "uuid4", original_uuid4)

    assert len(accepted) == query_session.MAX_CONCURRENT_PER_CONNECTION
    assert rejected == 1
    assert manager._running_per_conn[91] == 3
    assert manager.cancel_execution(session.session_id, accepted[0].exec_id) is True
    assert manager._running_per_conn[91] == 2

    replacement = manager.execute(session.session_id, "SELECT replacement")
    assert replacement is not None
    assert manager._running_per_conn[91] == 3
    manager.shutdown(timeout=0.1)
    assert manager._running_per_conn == {}


def test_query_manager_shutdown_wait_is_bounded(monkeypatch):
    import threading
    import time

    from app.connectors import factory
    from app.services.query_session import QuerySessionManager

    manager = QuerySessionManager(max_workers=1)
    session = manager.create_session(93)
    entered_cleanup = threading.Event()
    release_cleanup = threading.Event()
    evictions = []

    def blocked_evict(connection_id, purpose=None, force=True):
        evictions.append((connection_id, purpose, force))
        entered_cleanup.set()
        release_cleanup.wait(timeout=2)

    monkeypatch.setattr(factory, "evict_connector", blocked_evict)
    started = time.monotonic()
    manager.shutdown(timeout=0.05)
    elapsed = time.monotonic() - started
    assert entered_cleanup.wait(timeout=1)
    release_cleanup.set()

    assert elapsed < 0.5
    assert evictions == [(93, f"sql_ide:{session.session_id}", True)]


def test_query_cancel_interrupts_only_its_session_connector(monkeypatch):
    import threading
    import time
    from contextlib import contextmanager
    from types import SimpleNamespace

    from app.connectors import factory
    from app.db import store
    from app.services.query_session import ExecStatus, QuerySessionManager

    manager = QuerySessionManager(max_workers=2)
    session_a = manager.create_session(92, "tab-a")
    session_b = manager.create_session(92, "tab-b")
    purpose_a = f"sql_ide:{session_a.session_id}"
    purpose_b = f"sql_ide:{session_b.session_id}"
    entered = {purpose_a: threading.Event(), purpose_b: threading.Event()}
    released = {purpose_a: threading.Event(), purpose_b: threading.Event()}
    connectors = {}
    evictions = []

    class FakeDbSession:
        def get(self, _model, connection_id):
            return SimpleNamespace(id=connection_id, db_type="postgres")

        def close(self):
            pass

    class FakeCursor:
        description = None
        rowcount = 0

        def __init__(self, purpose):
            self.purpose = purpose

        def execute(self, _sql):
            entered[self.purpose].set()
            released[self.purpose].wait(timeout=5)

        def nextset(self):
            return False

        def close(self):
            pass

    class FakeConnector:
        def __init__(self, purpose):
            self._conn_lock = threading.RLock()
            self._cursor = FakeCursor(purpose)
            self.purpose = purpose

        @contextmanager
        def cursor(self):
            with self._conn_lock:
                yield self._cursor

        def dispose(self, force=False):
            if force:
                released[self.purpose].set()

    def get_fake_connector(_record, purpose="default"):
        connectors.setdefault(purpose, FakeConnector(purpose))
        return connectors[purpose]

    def evict_fake_connector(connection_id, purpose=None, force=True):
        evictions.append((connection_id, purpose, force))
        connector = connectors.get(purpose)
        if connector:
            connector.dispose(force=force)

    monkeypatch.setattr(store, "get_session", FakeDbSession)
    monkeypatch.setattr(factory, "get_connector", get_fake_connector)
    monkeypatch.setattr(factory, "evict_connector", evict_fake_connector)

    exec_a = manager.execute(session_a.session_id, "SELECT block")
    exec_b = manager.execute(session_b.session_id, "SELECT block")
    assert exec_a is not None and exec_b is not None
    assert entered[purpose_a].wait(timeout=3)
    assert entered[purpose_b].wait(timeout=3)

    assert manager.cancel_execution(session_a.session_id, exec_a.exec_id) is True
    assert released[purpose_a].wait(timeout=1)
    assert not released[purpose_b].is_set()
    assert evictions == [(92, purpose_a, True)]

    released[purpose_b].set()
    deadline = time.monotonic() + 3
    while exec_b.status not in (ExecStatus.SUCCESS, ExecStatus.ERROR, ExecStatus.CANCELLED):
        if time.monotonic() >= deadline:
            pytest.fail("second SQL IDE session did not finish")
        time.sleep(0.01)
    assert exec_a.status == ExecStatus.CANCELLED
    assert exec_b.status == ExecStatus.SUCCESS
    deadline = time.monotonic() + 3
    while 92 in manager._running_per_conn:
        if time.monotonic() >= deadline:
            pytest.fail("cancelled query did not release its admission slot")
        time.sleep(0.01)
    manager.shutdown(timeout=0.1)


# --------------------------------------------------------------------------
# Templates CRUD (JSON payload persisted to SQLite)
# --------------------------------------------------------------------------

def test_template_crud_roundtrip(api_client):
    name = _unique("tpl")
    payload = {
        "name": name,
        "description": "test template",
        "payload": {
            "source": {"connection_id": 1, "table": "t"},
            "target": {"connection_id": 2, "table": "t"},
        },
    }
    r = api_client.post("/api/templates", json=payload)
    assert r.status_code in (200, 201), r.text
    created = r.json()
    tid = created["id"]

    r = api_client.get("/api/templates")
    assert r.status_code == 200
    assert any(t["id"] == tid for t in r.json())

    r = api_client.delete(f"/api/templates/{tid}")
    assert r.status_code in (200, 204)
