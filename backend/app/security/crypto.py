"""Credential encryption.

New values are encrypted with the vault's data key (``app.security.vault``,
AES-256-GCM, ``dv2:`` prefix). Values written by earlier versions are Fernet
tokens keyed by ``DV_ENCRYPTION_KEY`` or ``backend/.secret_key``; they are
still readable so the vault can migrate them at setup, after which the key
file is deleted.
"""
from __future__ import annotations

import logging
from pathlib import Path

from app.config import settings
from app.security.vault import PREFIX, VaultLocked, vault

log = logging.getLogger("dv.crypto")

__all__ = ["encrypt", "decrypt", "legacy_key_path", "legacy_decrypt", "VaultLocked"]


def legacy_key_path() -> Path:
    p = Path(settings.secret_key_file)
    return p if p.is_absolute() else settings.backend_dir / p


def _legacy_fernet():
    from cryptography.fernet import Fernet

    env_key = (settings.encryption_key or "").strip()
    if env_key:
        return Fernet(env_key.encode("utf-8"))
    p = legacy_key_path()
    if p.exists():
        return Fernet(p.read_bytes().strip())
    return None


def legacy_decrypt(ciphertext: str) -> str:
    f = _legacy_fernet()
    if f is None:
        raise ValueError(
            "This password was saved by an older version and its key file is gone; re-enter it"
        )
    return f.decrypt(ciphertext.encode("utf-8")).decode("utf-8")


def encrypt(plaintext: str | None) -> str | None:
    if plaintext is None or plaintext == "":
        return None
    return vault.encrypt_text(plaintext)


def decrypt(ciphertext: str | None) -> str | None:
    if ciphertext is None or ciphertext == "":
        return None
    if ciphertext.startswith(PREFIX):
        return vault.decrypt_text(ciphertext)
    return legacy_decrypt(ciphertext)
