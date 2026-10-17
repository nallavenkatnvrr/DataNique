"""Master-password vault, encrypted storage and the API lock."""
from __future__ import annotations

import json
import sqlite3
import sys
import types
import uuid

import pytest

from tests.conftest import TEST_PASSWORD, unlocked_session_token

PW = "Another-pass-2"


@pytest.fixture
def v(tmp_path):
    from app.security.vault import Vault
    return Vault(tmp_path / "vault.json")


@pytest.fixture
def fake_keyring(monkeypatch):
    store: dict = {}
    mod = types.ModuleType("keyring")
    mod.get_password = lambda svc, user: store.get((svc, user))
    mod.set_password = lambda svc, user, pw: store.__setitem__((svc, user), pw)
    mod.delete_password = lambda svc, user: store.pop((svc, user), None)
    monkeypatch.setitem(sys.modules, "keyring", mod)
    return store


def test_setup_unlock_lock_cycle(v):
    from app.security.vault import VaultError, VaultLocked

    assert v.state == "setup"
    out = v.setup(PW)
    assert v.state == "unlocked" and len(out["recovery_key"]) == 29
    assert v.check_session(out["token"])
    ct = v.encrypt_text("secret value")
    assert ct.startswith("dv2:") and "secret" not in ct
    assert v.decrypt_text(ct) == "secret value"
    v.lock()
    assert v.state == "locked"
    assert not v.check_session(out["token"])
    with pytest.raises(VaultLocked):
        v.decrypt_text(ct)
    with pytest.raises(VaultError):
        v.unlock("wrong password 1")
    token = v.unlock(PW)
    assert v.check_session(token)
    assert v.decrypt_text(ct) == "secret value"


def test_password_rules(v):
    from app.security.vault import VaultError, password_problems

    assert password_problems("short")
    assert password_problems("onlylowercaseletters")
    assert not password_problems("letters and 123")
    with pytest.raises(VaultError):
        v.setup("short")


def test_wrong_passwords_are_throttled(v):
    from app.security.vault import VaultError

    v.setup(PW)
    v.lock()
    for _ in range(5):
        with pytest.raises(VaultError, match="Wrong password"):
            v.unlock("nope nope 1")
    with pytest.raises(VaultError, match="Too many attempts"):
        v.unlock(PW)
    assert v.status()["retry_after"] > 0


def test_recovery_key_resets_password_and_rotates(v):
    from app.security.vault import VaultError

    out = v.setup(PW)
    ct = v.encrypt_text("keep me")
    v.lock()
    with pytest.raises(VaultError):
        v.recover("AAAA-BBBB-CCCC-DDDD-EEEE-FFFF", "Brand-new-pass-3")
    v._rt.next_attempt_at = 0
    new = v.recover(out["recovery_key"].lower().replace("-", " "), "Brand-new-pass-3")
    assert v.decrypt_text(ct) == "keep me"
    v.lock()
    with pytest.raises(VaultError):
        v.unlock(PW)
    v.unlock("Brand-new-pass-3")
    v.lock()
    with pytest.raises(VaultError):
        v.recover(out["recovery_key"], "Another-new-pass-4")  # old key is gone
    v._rt.next_attempt_at = 0
    v.recover(new["recovery_key"], "Another-new-pass-4")


def test_change_password_keeps_data(v):
    v.setup(PW)
    ct = v.encrypt_text("data")
    v.change_password(PW, "Changed-pass-5")
    v.lock()
    v.unlock("Changed-pass-5")
    assert v.decrypt_text(ct) == "data"


def test_remember_on_this_computer(v, fake_keyring):
    from app.security.vault import Vault, VaultError

    v.setup(PW, remember=True)
    ct = v.encrypt_text("remembered")
    assert fake_keyring  # DEK stored in the OS credential store
    fresh = Vault(v.path)  # simulates an app restart
    assert fresh.state == "locked"
    assert fresh.try_auto_unlock()
    assert fresh.status()["unlocked_by"] == "remembered"
    assert fresh.decrypt_text(ct) == "remembered"
    assert fresh.check_session(fresh.resume())
    fresh.lock()  # "Lock now" must require the password even when remembered
    with pytest.raises(VaultError):
        fresh.resume()
    fresh.unlock(PW)
    fresh.set_remember(False)
    assert not fake_keyring
    again = Vault(v.path)
    assert not again.try_auto_unlock()


def test_env_password_unlocks_unattended(v, monkeypatch):
    from app.security.vault import Vault

    v.setup(PW)
    monkeypatch.setenv("DV_VAULT_PASSWORD", PW)
    fresh = Vault(v.path)
    assert fresh.try_auto_unlock()
    assert fresh.status()["unlocked_by"] == "env"


def test_auto_lock_after_idle(v, monkeypatch):
    import app.security.vault as mod

    out = v.setup(PW)
    v.set_auto_lock(5)
    v._auto_cache = (0.0, 0)
    now = mod.time.time()
    monkeypatch.setattr(mod.time, "time", lambda: now + 6 * 60)
    assert not v.check_session(out["token"])
    assert v.state == "locked"


def test_derived_keys_are_independent(v):
    v.setup(PW)
    assert v.derive_key("diffstore:a") != v.derive_key("diffstore:b")
    assert len(v.derive_key("x")) == 32


# ---------------------------------------------------------------------------
# Encrypted storage
# ---------------------------------------------------------------------------
def _raw(sql: str):
    from app.db.store import engine
    path = engine.url.database
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def test_runs_templates_and_passwords_are_encrypted_at_rest(api_client):
    from app.db.store import CompareRun, get_session

    uid = uuid.uuid4().hex
    s = get_session()
    try:
        s.add(CompareRun(run_uuid=uid, status="SUCCESS", verdict="MATCH", source_connection_id=1,
                         target_connection_id=2, source_label="SECRET_SOURCE_LABEL", target_label="tgt",
                         result={"rows": ["SECRET_ROW_VALUE"]}, summary={"verdict": "MATCH"}))
        s.commit()
    finally:
        s.close()
    raw = _raw(f"SELECT source_label, result, summary FROM compare_runs WHERE run_uuid='{uid}'")[0]
    assert all(str(x).startswith("dv2:") for x in raw)
    assert "SECRET" not in json.dumps(raw)
    r = api_client.get(f"/api/compare/runs/{uid}").json()
    assert r["source_label"] == "SECRET_SOURCE_LABEL" and r["result"]["rows"] == ["SECRET_ROW_VALUE"]

    c = api_client.post("/api/connections", json={"name": f"enc_{uid[:6]}", "db_type": "postgres", "password": "TOPSECRETPW"}).json()
    pw = _raw(f"SELECT password_enc FROM connections WHERE id={c['id']}")[0][0]
    assert pw.startswith("dv2:") and "TOPSECRET" not in pw

    t = api_client.post("/api/templates", json={"name": f"tpl_{uid[:6]}", "description": "DESC_SECRET", "payload": {"q": "SELECT_SECRET"}}).json()
    raw_t = _raw(f"SELECT description, payload FROM compare_templates WHERE id={t['id']}")[0]
    assert all(x.startswith("dv2:") for x in raw_t)
    assert api_client.get(f"/api/templates/{t['id']}").json()["payload"] == {"q": "SELECT_SECRET"}


def test_legacy_rows_are_sealed_by_migration(api_client, monkeypatch):
    from cryptography.fernet import Fernet
    from app.db.store import engine, Connection, get_session
    from app.security import crypto
    from app.security.vault_migrate import seal_existing_data
    from sqlalchemy import text

    key = Fernet.generate_key()
    monkeypatch.setattr(crypto.settings, "encryption_key", key.decode(), raising=False)
    legacy_pw = Fernet(key).encrypt(b"old-db-password").decode()
    uid = uuid.uuid4().hex
    name = f"legacy_{uid[:6]}"
    with engine.begin() as conn:
        conn.execute(text("INSERT INTO connections (name, db_type, password_enc, is_active, created_at, updated_at) "
                          "VALUES (:n, 'postgres', :p, 1, '2025-01-01', '2025-01-01')"), {"n": name, "p": legacy_pw})
        conn.execute(text("INSERT INTO compare_runs (run_uuid, status, source_connection_id, target_connection_id, "
                          "source_label, target_label, result, started_at) VALUES (:u, 'SUCCESS', 1, 2, 'plain_s', 'plain_t', :r, '2025-01-01')"),
                     {"u": uid, "r": json.dumps({"verdict": "MATCH", "row_diff": {"matching_count": 3}})})
    report = seal_existing_data()
    assert report["connections"] >= 1 and report["runs"] >= 1
    row = _raw(f"SELECT password_enc FROM connections WHERE name='{name}'")[0][0]
    assert row.startswith("dv2:")
    s = get_session()
    try:
        rec = s.query(Connection).filter(Connection.name == name).first()
        assert crypto.decrypt(rec.password_enc) == "old-db-password"
    finally:
        s.close()
    raw = _raw(f"SELECT result, source_label, verdict FROM compare_runs WHERE run_uuid='{uid}'")[0]
    assert raw[0].startswith("dv2:") and raw[1].startswith("dv2:") and raw[2] == "MATCH"
    listed = api_client.get("/api/compare/runs", params={"q": "plain_s"}).json()
    assert any(i["run_uuid"] == uid and i["summary"]["matching"] == 3 for i in listed["items"])


# ---------------------------------------------------------------------------
# HTTP lock
# ---------------------------------------------------------------------------
def test_locked_api_returns_423_and_unlock_restores(api_client):
    from app.security.vault import vault

    assert api_client.get("/api/vault/status").json()["state"] == "unlocked"
    api_client.post("/api/vault/lock")
    try:
        r = api_client.get("/api/connections")
        assert r.status_code == 423 and r.json()["code"] == "vault_locked"
        assert api_client.get("/api/health").status_code == 200
        assert api_client.post("/api/vault/unlock", json={"password": "wrong-pass-9"}).status_code == 401
        vault._rt.failures = 0
        vault._rt.next_attempt_at = 0
        tok = api_client.post("/api/vault/unlock", json={"password": TEST_PASSWORD}).json()["token"]
        assert api_client.get("/api/connections", headers={"X-DV-Session": tok}).status_code == 200
    finally:
        if not vault.is_unlocked:
            vault.unlock(TEST_PASSWORD)
        api_client.headers["X-DV-Session"] = unlocked_session_token()


def test_setup_twice_is_refused(api_client):
    assert api_client.post("/api/vault/setup", json={"password": "Whatever-pass-1"}).status_code == 409


def test_password_check_endpoint(api_client):
    assert api_client.post("/api/vault/password-check", json={"password": "abc"}).json()["problems"]
