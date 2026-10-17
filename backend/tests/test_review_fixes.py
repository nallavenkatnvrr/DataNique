"""Regression tests for code-review findings fixed in 0.3."""
from __future__ import annotations


def test_odbc_values_are_brace_escaped():
    from app.connectors.sqlserver_conn import _odbc

    assert _odbc("plain") == "plain"
    assert _odbc("p;w}d") == "{p;w}}d}"
    assert _odbc(" lead") == "{ lead}"
    assert _odbc(None) == ""


def test_auth_and_dead_connection_hints():
    from app.connectors.base import _looks_like_auth_failure, _looks_like_dead_conn

    assert _looks_like_auth_failure(Exception('FATAL: role "bob" does not exist'))
    assert not _looks_like_auth_failure(Exception('role "x" granted'))
    assert not _looks_like_dead_conn(Exception("Unclosed quotation mark after the character string"))
    assert _looks_like_dead_conn(Exception("Attempt to use a closed connection."))


def test_pool_slots_of_role_scoped_purposes_are_counted(monkeypatch):
    from types import SimpleNamespace
    from app.connectors import factory

    rec = SimpleNamespace(id=-4242, db_type="postgres", host="h", port=1, username="u", password_enc=None,
                          database="d", schema_name=None, extra={})
    fp = factory._record_fingerprint(rec)

    class Stub:
        def __init__(self):
            import threading
            self._conn_lock = threading.Lock()

        def dispose(self, force=False):
            pass

    busy = Stub()
    busy._conn_lock.acquire()
    with factory._cache_lock:
        factory._connector_cache[(rec.id, "compare#src#0")] = (busy, fp)
    monkeypatch.setattr(factory, "_pool_enabled", lambda: (True, 3))
    built = []
    monkeypatch.setattr(factory, "get_connector", lambda r, purpose: built.append(purpose) or Stub())
    try:
        factory._get_pooled_connector(rec, "compare#src")
        assert built == ["compare#src#1"]  # slot 0 busy → pool grows
    finally:
        with factory._cache_lock:
            factory._connector_cache.pop((rec.id, "compare#src#0"), None)


def test_ddl_keeps_lengths_and_precision():
    from app.services.ddl_generator import _full_type

    assert _full_type({"data_type": "VARCHAR2", "char_max_length": 50}) == "VARCHAR2(50)"
    assert _full_type({"data_type": "nvarchar", "char_max_length": -1}) == "nvarchar(MAX)"
    assert _full_type({"data_type": "NUMBER", "numeric_precision": 12, "numeric_scale": 2}) == "NUMBER(12,2)"
    assert _full_type({"data_type": "DECIMAL(5,1)"}) == "DECIMAL(5,1)"
    assert _full_type({"data_type": "DATE"}) == "DATE"


def test_refused_requests_still_carry_cors_headers(api_client):
    from app.config import settings

    origin = settings.get_cors_origins()[0]
    r = api_client.get("/api/connections", headers={"Origin": origin, "X-DV-Session": "nope"})
    assert r.status_code == 401
    assert r.headers.get("access-control-allow-origin") == origin


def test_unknown_api_path_is_404(api_client):
    assert api_client.get("/api/definitely-not-a-route").status_code == 404
