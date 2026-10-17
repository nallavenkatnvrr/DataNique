"""Seal data written before the vault existed, and wipe it on a vault reset."""
from __future__ import annotations

import json
import logging
import shutil

from sqlalchemy import text

from app.config import settings
from app.security.vault import PREFIX, vault

log = logging.getLogger("dv.vault")


def run_summary(result: dict | None) -> dict:
    """Small, list-friendly digest of a run result (stored next to it)."""
    r = result or {}
    rd = r.get("row_diff") or {}
    src = r.get("source") or {}
    tgt = r.get("target") or {}
    return {
        "verdict": r.get("verdict"),
        "engine": r.get("engine"),
        "elapsed_ms": r.get("elapsed_ms"),
        "source_rows": src.get("row_count"),
        "target_rows": tgt.get("row_count"),
        "only_in_source": rd.get("only_in_source_count"),
        "only_in_target": rd.get("only_in_target_count"),
        "changed": rd.get("key_match_hash_diff_count"),
        "matching": rd.get("matching_count"),
        "source_kind": src.get("kind"),
        "target_kind": tgt.get("kind"),
        "incremental_column": (r.get("options") or {}).get("incremental_column"),
    }


def _seal(value):
    if value is None or (isinstance(value, str) and value.startswith(PREFIX)):
        return value, False
    if not isinstance(value, str):
        value = json.dumps(value, default=str)
    return vault.encrypt_text(value), True


def seal_existing_data() -> dict:
    """Encrypt every plaintext secret / payload in the SQLite store with the
    (now unlocked) vault key. Idempotent."""
    from app.db.store import engine, init_db
    from app.security.crypto import legacy_decrypt, legacy_key_path

    init_db()
    report = {"connections": 0, "passwords_lost": [], "runs": 0, "templates": 0}
    with engine.begin() as conn:
        for cid, name, pw in conn.execute(text("SELECT id, name, password_enc FROM connections")).fetchall():
            if not pw or pw.startswith(PREFIX):
                continue
            try:
                plain = legacy_decrypt(pw)
                conn.execute(text("UPDATE connections SET password_enc=:p WHERE id=:i"),
                             {"p": vault.encrypt_text(plain), "i": cid})
                report["connections"] += 1
            except Exception:
                conn.execute(text("UPDATE connections SET password_enc=NULL WHERE id=:i"), {"i": cid})
                report["passwords_lost"].append(name)

        rows = conn.execute(text(
            "SELECT id, source_label, target_label, options, result, error, summary, verdict FROM compare_runs"
        )).fetchall()
        for rid, sl, tl, opts, res, err, summ, verdict in rows:
            updates = {}
            for col, val in (("source_label", sl), ("target_label", tl), ("options", opts),
                             ("result", res), ("error", err), ("summary", summ)):
                sealed, changed = _seal(val)
                if changed:
                    updates[col] = sealed
            if summ is None and res and not str(res).startswith(PREFIX):
                try:
                    parsed = json.loads(res)
                    updates["summary"] = vault.encrypt_text(json.dumps(run_summary(parsed), default=str))
                    if verdict is None:
                        updates["verdict"] = (parsed.get("verdict") or None)
                except Exception:
                    pass
            if updates:
                sets = ", ".join(f"{k}=:{k}" for k in updates)
                conn.execute(text(f"UPDATE compare_runs SET {sets} WHERE id=:id"), {**updates, "id": rid})
                report["runs"] += 1

        for tid, desc, payload in conn.execute(text("SELECT id, description, payload FROM compare_templates")).fetchall():
            updates = {}
            for col, val in (("description", desc), ("payload", payload)):
                sealed, changed = _seal(val)
                if changed:
                    updates[col] = sealed
            if updates:
                sets = ", ".join(f"{k}=:{k}" for k in updates)
                conn.execute(text(f"UPDATE compare_templates SET {sets} WHERE id=:id"), {**updates, "id": tid})
                report["templates"] += 1

    # Rewrite the file so freed pages holding the old plaintext are gone.
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("VACUUM")
    except Exception:
        log.warning("VACUUM after sealing failed", exc_info=True)

    key_file = legacy_key_path()
    if key_file.exists() and not report["passwords_lost"]:
        try:
            key_file.unlink()
            report["legacy_key_deleted"] = True
        except Exception:
            log.warning("Could not delete the old key file %s", key_file)
    log.info("Vault migration: %s", report)
    return report


def wipe_encrypted_data() -> None:
    """Vault reset: drop everything that cannot be decrypted any more.
    Connection names, hosts and options stay; saved passwords go."""
    from app.db.store import engine, init_db

    init_db()
    with engine.begin() as conn:
        conn.execute(text("UPDATE connections SET password_enc=NULL"))
        conn.execute(text("DELETE FROM compare_runs"))
        conn.execute(text("DELETE FROM compare_batches"))
        conn.execute(text("DELETE FROM compare_templates"))
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("VACUUM")
    except Exception:
        pass
    for sub in ("runs", "uploads"):
        shutil.rmtree(settings.data_dir / sub, ignore_errors=True)
