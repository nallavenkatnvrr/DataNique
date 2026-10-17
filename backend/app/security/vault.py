"""Master-password vault.

Everything sensitive the app stores (saved database passwords, compare
history, diff stores, templates) is encrypted with one random 256-bit data
key (the DEK). The DEK itself is never written to disk in the clear:

* ``vault.json`` holds the DEK wrapped (AES-256-GCM) by a key derived from
  the master password with scrypt, and a second copy wrapped by a key
  derived from the recovery key shown once at setup.
* "Remember on this computer" stores the DEK in the operating system's
  credential store (Windows Credential Manager / macOS Keychain / Secret
  Service) through ``keyring``, so the app opens without the password for
  that OS user only.

While the vault is locked the DEK is not in memory and every API call except
the vault endpoints is refused (HTTP 423). Unlocking issues a session token
that the UI sends as ``X-DV-Session``; requests without it are refused
(HTTP 401), which also blocks cross-site requests from other web pages.

Ciphertext format (text columns, JSON blobs): ``dv2:`` + base64url(nonce ||
AES-GCM ciphertext+tag). Binary helpers return raw ``nonce || ct``.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

from app.config import settings

log = logging.getLogger("dv.vault")

PREFIX = "dv2:"
_AAD = b"datanique/dv2"
_KEYRING_SERVICE = "Datanique vault"
_CHECK_PLAINTEXT = b"datanique-vault-check"
# scrypt cost: n=2^17, r=8 -> 128 MiB and roughly 0.3-0.6 s on a laptop.
_SCRYPT_N = 1 << 17
_SCRYPT_R = 8
_SCRYPT_P = 1
_SESSION_IDLE_SECONDS = 12 * 3600
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


class VaultLocked(RuntimeError):
    """Raised when encrypted data is touched while the vault is locked."""


class VaultError(ValueError):
    """Bad password, bad recovery key, or an invalid state transition."""


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _scrypt(secret: str, salt: bytes, n: int = _SCRYPT_N, r: int = _SCRYPT_R, p: int = _SCRYPT_P) -> bytes:
    return hashlib.scrypt(
        secret.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=256 * 1024 * 1024, dklen=32,
    )


def _normalize_recovery(code: str) -> str:
    return "".join(ch for ch in (code or "").upper() if ch.isalnum())


def _new_recovery_code() -> str:
    raw = "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(24))
    return "-".join(raw[i:i + 4] for i in range(0, 24, 4))


def password_problems(password: str) -> list[str]:
    """Minimal strength rules; the UI shows the same list."""
    problems = []
    if len(password or "") < 10:
        problems.append("at least 10 characters")
    classes = sum(bool(any(f(c) for c in password or "")) for f in (str.islower, str.isupper, str.isdigit))
    other = any(not c.isalnum() for c in password or "")
    if classes + int(other) < 2:
        problems.append("mix letters with digits or symbols")
    return problems


@dataclass
class _Session:
    token: str
    created: float
    last_seen: float


@dataclass
class _Runtime:
    dek: bytes | None = None
    unlocked_by: str | None = None  # password | recovery | remembered | env
    sessions: dict[str, _Session] = field(default_factory=dict)
    failures: int = 0
    next_attempt_at: float = 0.0
    manual_lock: bool = False
    last_activity: float = field(default_factory=time.time)


class Vault:
    def __init__(self, path: Path | None = None):
        self._path = path
        self._lock = threading.RLock()
        self._rt = _Runtime()
        self._listeners: list = []

    # ------------------------------------------------------------------ files
    @property
    def path(self) -> Path:
        return self._path or (settings.data_dir / "vault.json")

    def _read(self) -> dict | None:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None

    def _write(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        os.replace(tmp, self.path)

    def on_change(self, fn) -> None:
        """Register ``fn(state)`` called after lock / unlock."""
        self._listeners.append(fn)

    def _notify(self) -> None:
        for fn in list(self._listeners):
            try:
                fn(self.state)
            except Exception:
                log.debug("vault listener failed", exc_info=True)

    # ------------------------------------------------------------------ state
    @property
    def is_initialized(self) -> bool:
        return self.path.exists()

    @property
    def is_unlocked(self) -> bool:
        return self._rt.dek is not None

    @property
    def state(self) -> str:
        if not self.is_initialized:
            return "setup"
        return "unlocked" if self.is_unlocked else "locked"

    def status(self) -> dict:
        meta = self._read() or {}
        now = time.time()
        return {
            "state": self.state,
            "remembered": bool(meta.get("remember")) and self._keyring_get(meta.get("id")) is not None,
            "remember_available": keyring_available(),
            "auto_lock_minutes": int(meta.get("auto_lock_minutes") or 0),
            "unlocked_by": self._rt.unlocked_by,
            "retry_after": max(0, int(self._rt.next_attempt_at - now + 0.999)) if self._rt.next_attempt_at > now else 0,
            "created_at": meta.get("created_at"),
            "has_recovery": bool((meta.get("wrapped") or {}).get("recovery")),
        }

    # ------------------------------------------------------------------ keyring
    def _keyring_get(self, vault_id: str | None) -> bytes | None:
        if not vault_id:
            return None
        try:
            import keyring  # type: ignore
            val = keyring.get_password(_KEYRING_SERVICE, vault_id)
            return _b64d(val) if val else None
        except Exception:
            return None

    def _keyring_set(self, vault_id: str, dek: bytes) -> bool:
        try:
            import keyring  # type: ignore
            keyring.set_password(_KEYRING_SERVICE, vault_id, _b64e(dek))
            return True
        except Exception as exc:
            log.warning("Could not store the vault key in the OS credential store: %s", exc)
            return False

    def _keyring_delete(self, vault_id: str | None) -> None:
        if not vault_id:
            return
        try:
            import keyring  # type: ignore
            keyring.delete_password(_KEYRING_SERVICE, vault_id)
        except Exception:
            pass

    # ------------------------------------------------------------------ wrap
    @staticmethod
    def _wrap(kek: bytes, dek: bytes, vault_id: str) -> dict:
        nonce = secrets.token_bytes(12)
        ct = AESGCM(kek).encrypt(nonce, dek, b"datanique-vault-v1:" + vault_id.encode())
        return {"nonce": _b64e(nonce), "ct": _b64e(ct)}

    @staticmethod
    def _unwrap(kek: bytes, blob: dict, vault_id: str) -> bytes:
        return AESGCM(kek).decrypt(_b64d(blob["nonce"]), _b64d(blob["ct"]), b"datanique-vault-v1:" + vault_id.encode())

    @staticmethod
    def _check_blob(dek: bytes) -> dict:
        nonce = secrets.token_bytes(12)
        return {"nonce": _b64e(nonce), "ct": _b64e(AESGCM(dek).encrypt(nonce, _CHECK_PLAINTEXT, None))}

    @staticmethod
    def _check_ok(dek: bytes, blob: dict | None) -> bool:
        if not blob:
            return False
        try:
            return AESGCM(dek).decrypt(_b64d(blob["nonce"]), _b64d(blob["ct"]), None) == _CHECK_PLAINTEXT
        except Exception:
            return False

    def _kdf_entry(self, secret: str) -> tuple[dict, bytes]:
        salt = secrets.token_bytes(16)
        return (
            {"name": "scrypt", "n": _SCRYPT_N, "r": _SCRYPT_R, "p": _SCRYPT_P, "salt": _b64e(salt)},
            _scrypt(secret, salt),
        )

    @staticmethod
    def _kek_from(entry: dict, secret: str) -> bytes:
        return _scrypt(secret, _b64d(entry["salt"]), int(entry["n"]), int(entry["r"]), int(entry["p"]))

    # ------------------------------------------------------------------ lifecycle
    def setup(self, password: str, remember: bool = False) -> dict:
        """Create the vault. Returns ``{"recovery_key", "token"}``."""
        problems = password_problems(password)
        if problems:
            raise VaultError("Password needs " + " and ".join(problems))
        with self._lock:
            if self.is_initialized:
                raise VaultError("The vault already exists")
            vault_id = uuid.uuid4().hex
            dek = secrets.token_bytes(32)
            recovery = _new_recovery_code()
            pw_kdf, pw_kek = self._kdf_entry(password)
            rc_kdf, rc_kek = self._kdf_entry(_normalize_recovery(recovery))
            meta = {
                "version": 1,
                "id": vault_id,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "wrapped": {
                    "password": {"kdf": pw_kdf, **self._wrap(pw_kek, dek, vault_id)},
                    "recovery": {"kdf": rc_kdf, **self._wrap(rc_kek, dek, vault_id)},
                },
                "check": self._check_blob(dek),
                "remember": False,
                "auto_lock_minutes": 0,
            }
            self._write(meta)
            self._set_unlocked(dek, "password")
            if remember:
                self.set_remember(True)
            token = self.new_session()
        self._notify()
        return {"recovery_key": recovery, "token": token}

    def _set_unlocked(self, dek: bytes, how: str) -> None:
        self._rt.dek = dek
        self._rt.unlocked_by = how
        self._rt.failures = 0
        self._rt.next_attempt_at = 0.0
        self._rt.manual_lock = False
        self._rt.last_activity = time.time()

    def _throttle(self) -> None:
        now = time.time()
        if self._rt.next_attempt_at > now:
            wait = int(self._rt.next_attempt_at - now + 0.999)
            raise VaultError(f"Too many attempts. Try again in {wait} s")

    def _failed(self) -> None:
        self._rt.failures += 1
        if self._rt.failures >= 5:
            delay = min(60, 2 ** (self._rt.failures - 4))
            self._rt.next_attempt_at = time.time() + delay

    def unlock(self, password: str, remember: bool | None = None) -> str:
        with self._lock:
            meta = self._read()
            if not meta:
                raise VaultError("The vault has not been set up")
            self._throttle()
            entry = meta["wrapped"]["password"]
            try:
                dek = self._unwrap(self._kek_from(entry["kdf"], password), entry, meta["id"])
            except Exception:
                self._failed()
                raise VaultError("Wrong password") from None
            self._set_unlocked(dek, "password")
            if remember is not None:
                self.set_remember(remember)
            token = self.new_session()
        self._notify()
        return token

    def resume(self) -> str:
        """Session for a UI when the vault is already open through the OS
        credential store ("remember on this computer")."""
        with self._lock:
            meta = self._read() or {}
            if self._rt.manual_lock:
                raise VaultError("The vault was locked; enter the password")
            if not self.is_unlocked:
                self.try_auto_unlock()
            if not self.is_unlocked or self._rt.unlocked_by not in ("remembered", "env"):
                raise VaultError("Password required")
            if self._rt.unlocked_by == "remembered" and self._keyring_get(meta.get("id")) is None:
                raise VaultError("Password required")
            return self.new_session()

    def try_auto_unlock(self) -> bool:
        """At startup: open with the OS-stored key (or ``DV_VAULT_PASSWORD``)."""
        with self._lock:
            if self.is_unlocked or self._rt.manual_lock:
                return self.is_unlocked
            meta = self._read()
            if not meta:
                return False
            env_pw = os.environ.get("DV_VAULT_PASSWORD")
            if env_pw:
                try:
                    entry = meta["wrapped"]["password"]
                    dek = self._unwrap(self._kek_from(entry["kdf"], env_pw), entry, meta["id"])
                    self._set_unlocked(dek, "env")
                except Exception:
                    log.error("DV_VAULT_PASSWORD did not unlock the vault")
                    return False
            elif meta.get("remember"):
                dek = self._keyring_get(meta.get("id"))
                if not dek or not self._check_ok(dek, meta.get("check")):
                    return False
                self._set_unlocked(dek, "remembered")
            else:
                return False
        self._notify()
        return True

    def recover(self, recovery_key: str, new_password: str) -> dict:
        """Open with the recovery key and set a new password. Returns a new
        recovery key (the old one stays valid only until this succeeds)."""
        problems = password_problems(new_password)
        if problems:
            raise VaultError("Password needs " + " and ".join(problems))
        with self._lock:
            meta = self._read()
            if not meta:
                raise VaultError("The vault has not been set up")
            self._throttle()
            entry = meta["wrapped"].get("recovery")
            if not entry:
                raise VaultError("This vault has no recovery key")
            try:
                dek = self._unwrap(self._kek_from(entry["kdf"], _normalize_recovery(recovery_key)), entry, meta["id"])
            except Exception:
                self._failed()
                raise VaultError("Wrong recovery key") from None
            recovery = _new_recovery_code()
            pw_kdf, pw_kek = self._kdf_entry(new_password)
            rc_kdf, rc_kek = self._kdf_entry(_normalize_recovery(recovery))
            meta["wrapped"] = {
                "password": {"kdf": pw_kdf, **self._wrap(pw_kek, dek, meta["id"])},
                "recovery": {"kdf": rc_kdf, **self._wrap(rc_kek, dek, meta["id"])},
            }
            self._write(meta)
            self._set_unlocked(dek, "recovery")
            self._rt.sessions.clear()
            token = self.new_session()
        self._notify()
        return {"recovery_key": recovery, "token": token}

    def change_password(self, old_password: str, new_password: str) -> None:
        problems = password_problems(new_password)
        if problems:
            raise VaultError("Password needs " + " and ".join(problems))
        with self._lock:
            meta = self._read()
            if not meta:
                raise VaultError("The vault has not been set up")
            self._throttle()
            entry = meta["wrapped"]["password"]
            try:
                dek = self._unwrap(self._kek_from(entry["kdf"], old_password), entry, meta["id"])
            except Exception:
                self._failed()
                raise VaultError("Current password is wrong") from None
            pw_kdf, pw_kek = self._kdf_entry(new_password)
            meta["wrapped"]["password"] = {"kdf": pw_kdf, **self._wrap(pw_kek, dek, meta["id"])}
            self._write(meta)

    def new_recovery_key(self, password: str) -> str:
        with self._lock:
            meta = self._read()
            if not meta:
                raise VaultError("The vault has not been set up")
            self._throttle()
            entry = meta["wrapped"]["password"]
            try:
                dek = self._unwrap(self._kek_from(entry["kdf"], password), entry, meta["id"])
            except Exception:
                self._failed()
                raise VaultError("Wrong password") from None
            recovery = _new_recovery_code()
            rc_kdf, rc_kek = self._kdf_entry(_normalize_recovery(recovery))
            meta["wrapped"]["recovery"] = {"kdf": rc_kdf, **self._wrap(rc_kek, dek, meta["id"])}
            self._write(meta)
            return recovery

    def set_remember(self, on: bool) -> bool:
        with self._lock:
            meta = self._read()
            if not meta or not self.is_unlocked:
                raise VaultError("Unlock the vault first")
            ok = True
            if on:
                ok = self._keyring_set(meta["id"], self._rt.dek)  # type: ignore[arg-type]
            else:
                self._keyring_delete(meta["id"])
            meta["remember"] = bool(on and ok)
            self._write(meta)
            return meta["remember"]

    def set_auto_lock(self, minutes: int) -> None:
        with self._lock:
            meta = self._read()
            if not meta:
                raise VaultError("The vault has not been set up")
            meta["auto_lock_minutes"] = max(0, min(int(minutes), 24 * 60))
            self._write(meta)

    def lock(self, manual: bool = True) -> None:
        with self._lock:
            self._rt.dek = None
            self._rt.unlocked_by = None
            self._rt.sessions.clear()
            self._rt.manual_lock = manual
        self._notify()

    def reset(self) -> None:
        """Forget the vault entirely (forgotten password, no recovery key).
        The caller wipes the encrypted data first."""
        with self._lock:
            meta = self._read() or {}
            self._keyring_delete(meta.get("id"))
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            self._rt = _Runtime()
        self._notify()

    # ------------------------------------------------------------------ sessions
    def new_session(self) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._rt.sessions[token] = _Session(token, now, now)
        return token

    def check_session(self, token: str | None) -> bool:
        if not token or not self.is_unlocked:
            return False
        now = time.time()
        meta_auto = self._auto_lock_seconds()
        if meta_auto and now - self._rt.last_activity > meta_auto:
            log.info("Vault auto-locked after %s s idle", meta_auto)
            self.lock(manual=True)
            return False
        for t, s in list(self._rt.sessions.items()):
            if now - s.last_seen > _SESSION_IDLE_SECONDS:
                self._rt.sessions.pop(t, None)
        sess = None
        for t, s in self._rt.sessions.items():
            if hmac.compare_digest(t, token):
                sess = s
                break
        if sess is None:
            return False
        sess.last_seen = now
        return True

    def touch(self) -> None:
        self._rt.last_activity = time.time()

    def end_session(self, token: str | None) -> None:
        if token:
            self._rt.sessions.pop(token, None)

    _auto_cache: tuple[float, int] = (0.0, 0)

    def _auto_lock_seconds(self) -> int:
        ts, val = self._auto_cache
        if time.time() - ts > 5:
            meta = self._read() or {}
            val = int(meta.get("auto_lock_minutes") or 0) * 60
            self._auto_cache = (time.time(), val)
        return val

    # ------------------------------------------------------------------ crypto
    def _key(self) -> bytes:
        dek = self._rt.dek
        if dek is None:
            raise VaultLocked("The vault is locked")
        return dek

    def encrypt_bytes(self, data: bytes, aad: bytes = _AAD) -> bytes:
        nonce = secrets.token_bytes(12)
        return nonce + AESGCM(self._key()).encrypt(nonce, data, aad)

    def decrypt_bytes(self, blob: bytes, aad: bytes = _AAD) -> bytes:
        return AESGCM(self._key()).decrypt(blob[:12], blob[12:], aad)

    def encrypt_text(self, text: str) -> str:
        return PREFIX + _b64e(self.encrypt_bytes(text.encode("utf-8")))

    def decrypt_text(self, token: str) -> str:
        if not token.startswith(PREFIX):
            raise ValueError("not a dv2 ciphertext")
        return self.decrypt_bytes(_b64d(token[len(PREFIX):])).decode("utf-8")

    def derive_key(self, purpose: str) -> bytes:
        """Independent sub-key (HKDF-SHA256) for e.g. one run's diff store."""
        return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=purpose.encode("utf-8")).derive(self._key())


def keyring_available() -> bool:
    try:
        import keyring  # type: ignore
        from keyring.backends import fail  # type: ignore
        kr = keyring.get_keyring()
        if isinstance(kr, fail.Keyring):
            return False
        name = type(kr).__module__ + "." + type(kr).__name__
        return "chainer" not in name.lower() or bool(getattr(kr, "backends", None))
    except Exception:
        return False


vault = Vault()


def is_ciphertext(value: Any) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)
