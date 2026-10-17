"""Shared pytest fixtures and helpers.

These tests are pure-logic unit tests - they never touch a live database.
A lightweight ``FakeConnector`` stands in for the real DB connectors so the
DDL / INSERT generators can be exercised deterministically.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Make ``app`` importable when pytest is invoked from the backend dir.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

# Point the app at a throwaway SQLite file BEFORE ``app.config`` is imported
# anywhere, so the router tests never touch the real data_validator.db. This
# runs at conftest import time - earlier than any test module - so the
# ``Settings()`` singleton picks it up. Harmless for the pure-logic tests,
# which never open the (now-redirected) engine.
_TEST_DATA_DIR = Path(tempfile.mkdtemp(prefix="dv_test_"))
_TEST_DB_PATH = _TEST_DATA_DIR / "data_validator.db"
os.environ["DV_SQLITE_URL"] = f"sqlite:///{_TEST_DB_PATH.as_posix()}"
os.environ["DV_DATA_DIR"] = str(_TEST_DATA_DIR)
os.environ["DV_SECRET_KEY_FILE"] = str(_TEST_DATA_DIR / ".secret_key")
os.environ["DV_ALLOWED_HOSTS"] = "testserver"
os.environ.pop("DV_VAULT_PASSWORD", None)
os.environ.pop("DV_ENCRYPTION_KEY", None)

TEST_PASSWORD = "Test-password-1"
# Ensure the token gate is OFF by default for tests (a stray env var on the
# dev machine must not make every request 401).
os.environ.pop("DV_API_TOKEN", None)


def pytest_sessionfinish(session, exitstatus):
    """Remove the throwaway data dir when the run ends."""
    import shutil
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)


def unlocked_session_token() -> str:
    """Create (once) and unlock the vault; return a fresh session token."""
    from app.security.vault import vault

    if not vault.is_initialized:
        return vault.setup(TEST_PASSWORD)["token"]
    if not vault.is_unlocked:
        return vault.unlock(TEST_PASSWORD)
    return vault.new_session()


@pytest.fixture
def api_client():
    """A FastAPI ``TestClient`` bound to a freshly-initialized temp DB.

    Uses the app WITHOUT entering its lifespan context manager, so background
    threads (watchdog / heartbeat / spark) never start during tests. Tables
    are created explicitly via ``init_db()``.
    """
    from fastapi.testclient import TestClient
    from app.db.store import init_db
    from app.main import app

    init_db()
    client = TestClient(app)
    client.headers["X-DV-Session"] = unlocked_session_token()
    return client


class FakeConnector:
    """Minimal stand-in for ``app.connectors.base.Connector``.

    Only implements the surface used by ``ddl_generator``:
    ``dialect``, ``get_columns`` and ``execute_rows``.
    """

    def __init__(self, dialect, columns, rows=None):
        self.dialect = dialect
        self._columns = columns
        self._rows = rows or []

    def get_columns(self, database, schema, table):
        return self._columns

    def execute_rows(self, sql, limit=None):
        return self._rows


@pytest.fixture
def fake_connector():
    return FakeConnector
