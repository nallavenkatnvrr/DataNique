"""Vault endpoints: first-run setup, unlock, lock, recovery, settings."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.security.vault import VaultError, password_problems, vault

router = APIRouter(prefix="/api/vault", tags=["vault"])
log = logging.getLogger("dv.vault")

SESSION_HEADER = "X-DV-Session"


class SetupIn(BaseModel):
    password: str = Field(min_length=1, max_length=1024)
    remember: bool = False


class UnlockIn(BaseModel):
    password: str = Field(min_length=1, max_length=1024)
    remember: bool | None = None


class RecoverIn(BaseModel):
    recovery_key: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=1024)


class PasswordIn(BaseModel):
    old_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=1, max_length=1024)


class ConfirmPasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


class SettingsIn(BaseModel):
    remember: bool | None = None
    auto_lock_minutes: int | None = Field(default=None, ge=0, le=1440)


class ResetIn(BaseModel):
    confirm: str


def _bad(exc: Exception, code: int = 400):
    raise HTTPException(code, str(exc))


@router.get("/status")
def status() -> dict:
    return vault.status()


@router.post("/password-check")
def password_check(body: ConfirmPasswordIn) -> dict:
    return {"problems": password_problems(body.password)}


@router.post("/setup")
def setup(body: SetupIn) -> dict:
    try:
        out = vault.setup(body.password, remember=body.remember)
    except VaultError as exc:
        _bad(exc, 409 if "already" in str(exc) else 400)
    from app.security.vault_migrate import seal_existing_data
    try:
        out["migration"] = seal_existing_data()
    except Exception as exc:  # pragma: no cover - surfaced to the UI
        log.exception("Sealing existing data failed")
        out["migration"] = {"error": str(exc)[:500]}
    out["status"] = vault.status()
    return out


@router.post("/unlock")
def unlock(body: UnlockIn) -> dict:
    try:
        token = vault.unlock(body.password, remember=body.remember)
    except VaultError as exc:
        _bad(exc, 429 if "Too many" in str(exc) else 401)
    return {"token": token, "status": vault.status()}


@router.post("/resume")
def resume() -> dict:
    try:
        token = vault.resume()
    except VaultError as exc:
        _bad(exc, 401)
    return {"token": token, "status": vault.status()}


@router.post("/recover")
def recover(body: RecoverIn) -> dict:
    try:
        out = vault.recover(body.recovery_key, body.new_password)
    except VaultError as exc:
        _bad(exc, 429 if "Too many" in str(exc) else 400)
    out["status"] = vault.status()
    return out


@router.post("/lock")
def lock() -> dict:
    vault.lock(manual=True)
    return vault.status()


@router.post("/logout")
def logout(request: Request) -> dict:
    vault.end_session(request.headers.get(SESSION_HEADER))
    return {"ok": True}


@router.post("/change-password")
def change_password(body: PasswordIn) -> dict:
    try:
        vault.change_password(body.old_password, body.new_password)
    except VaultError as exc:
        _bad(exc)
    return {"ok": True}


@router.post("/recovery-key")
def new_recovery_key(body: ConfirmPasswordIn) -> dict:
    try:
        return {"recovery_key": vault.new_recovery_key(body.password)}
    except VaultError as exc:
        _bad(exc)


@router.put("/settings")
def update_settings(body: SettingsIn) -> dict:
    try:
        if body.remember is not None:
            vault.set_remember(body.remember)
        if body.auto_lock_minutes is not None:
            vault.set_auto_lock(body.auto_lock_minutes)
    except VaultError as exc:
        _bad(exc)
    return vault.status()


@router.post("/reset")
def reset(body: ResetIn) -> dict:
    """Forgotten password and no recovery key: start over. Saved passwords,
    history, templates and diff stores are deleted; connections stay."""
    if body.confirm.strip().upper() != "RESET":
        raise HTTPException(400, 'Type RESET to confirm')
    from app.security.vault_migrate import wipe_encrypted_data
    vault.lock(manual=False)
    wipe_encrypted_data()
    vault.reset()
    return vault.status()
