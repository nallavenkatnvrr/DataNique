"""App-level encryption of diff stores when DuckDB can't write encrypted files.

DuckDB writes encrypted databases only with OpenSSL from its httpfs
extension. Without it (offline PC, blocked extensions.duckdb.org) a run
writes its diff store as a plain working file under ``runs/.work`` and this
module seals it right after the run:

    runs/<uuid>.dvs  =  MAGIC | nonce prefix (8) | chunk size (4) | chunks

Each chunk is AES-256-GCM with the per-run key derived from the vault,
nonce = prefix + chunk index, and the run id, chunk index and a "last chunk"
flag as associated data, so reordering, truncation or swapping files between
runs fails authentication.

Reading decrypts into ``runs/.work/<uuid>.open.duckdb`` (attached read-only),
reused while the run is being browsed and removed after 15 idle minutes, when
the vault locks and at start-up.
"""
from __future__ import annotations

import logging
import os
import secrets
import struct
import threading
import time
from pathlib import Path

log = logging.getLogger("dv.engine")

MAGIC = b"DVSEAL1\x00"
CHUNK = 4 * 1024 * 1024
TAG = 16
IDLE_SECONDS = 15 * 60

_lock = threading.Lock()
_last_used: dict[str, float] = {}


def _runs_dir() -> Path:
    from app.engine.core import runs_dir
    return runs_dir()


def work_dir() -> Path:
    p = _runs_dir() / ".work"
    p.mkdir(parents=True, exist_ok=True)
    return p


def _checked(run_uuid: str) -> str:
    from app.engine.core import store_path
    store_path(run_uuid)  # validates the id
    return run_uuid


def sealed_path(run_uuid: str) -> Path:
    return _runs_dir() / f"{_checked(run_uuid)}.dvs"


def work_path(run_uuid: str) -> Path:
    return work_dir() / f"{_checked(run_uuid)}.duckdb"


def _cache_path(run_uuid: str) -> Path:
    return work_dir() / f"{_checked(run_uuid)}.open.duckdb"


def _key(run_uuid: str) -> bytes:
    from app.security.vault import vault
    return vault.derive_key(f"diffseal:{run_uuid}")


def _aad(run_uuid: str, index: int, last: bool) -> bytes:
    return MAGIC + run_uuid.encode() + struct.pack(">IB", index, 1 if last else 0)


def _unlink(p: Path) -> None:
    try:
        p.unlink(missing_ok=True)
    except Exception:  # still open elsewhere (Windows); purged later
        log.debug("could not remove %s", p, exc_info=True)


def encrypt_file(src: Path, dst: Path, run_uuid: str) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aes = AESGCM(_key(run_uuid))
    prefix = secrets.token_bytes(8)
    part = dst.with_name(dst.name + ".part")
    size = src.stat().st_size
    with open(src, "rb") as fi, open(part, "wb") as fo:
        fo.write(MAGIC + prefix + struct.pack(">I", CHUNK))
        index, done = 0, 0
        while True:
            block = fi.read(CHUNK)
            done += len(block)
            last = done >= size
            fo.write(aes.encrypt(prefix + struct.pack(">I", index), block, _aad(run_uuid, index, last)))
            index += 1
            if last:
                break
        fo.flush()
        os.fsync(fo.fileno())
    os.replace(part, dst)


def decrypt_file(src: Path, dst: Path, run_uuid: str) -> None:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    aes = AESGCM(_key(run_uuid))
    part = dst.with_name(dst.name + ".part")
    total = src.stat().st_size
    try:
        with open(src, "rb") as fi, open(part, "wb") as fo:
            head = fi.read(len(MAGIC) + 12)
            if len(head) != len(MAGIC) + 12 or head[:len(MAGIC)] != MAGIC:
                raise ValueError("Not a sealed diff store")
            prefix = head[len(MAGIC):len(MAGIC) + 8]
            chunk = struct.unpack(">I", head[len(MAGIC) + 8:])[0]
            index = 0
            while True:
                block = fi.read(chunk + TAG)
                if len(block) < TAG:
                    raise ValueError("Sealed diff store is truncated")
                last = fi.tell() >= total
                fo.write(aes.decrypt(prefix + struct.pack(">I", index), block, _aad(run_uuid, index, last)))
                index += 1
                if last:
                    break
        os.replace(part, dst)
    except Exception:
        _unlink(part)
        raise


def seal(run_uuid: str) -> None:
    """Encrypt the run's working store and remove the plain copy."""
    work = work_path(run_uuid)
    wal = work.with_name(work.name + ".wal")
    encrypt_file(work, sealed_path(run_uuid), run_uuid)
    _unlink(work)
    _unlink(wal)


def open_plain(run_uuid: str) -> Path:
    """Decrypted read-only copy of a sealed store (cached while in use)."""
    sealed = sealed_path(run_uuid)
    cache = _cache_path(run_uuid)
    with _lock:
        if not (cache.exists() and cache.stat().st_mtime >= sealed.stat().st_mtime):
            decrypt_file(sealed, cache, run_uuid)
        _last_used[run_uuid] = time.monotonic()
        _purge_idle_locked()
    return cache


def _purge_idle_locked() -> None:
    now = time.monotonic()
    for uuid, used in list(_last_used.items()):
        if now - used > IDLE_SECONDS:
            _unlink(_cache_path(uuid))
            _last_used.pop(uuid, None)


def drop(run_uuid: str) -> None:
    """Remove every sealed / working / cached file of a run."""
    with _lock:
        _last_used.pop(run_uuid, None)
        for p in (sealed_path(run_uuid), work_path(run_uuid), _cache_path(run_uuid)):
            _unlink(p)
            _unlink(p.with_name(p.name + ".wal"))
            _unlink(p.with_name(p.name + ".part"))


def purge_cache() -> None:
    """Remove decrypted copies (vault locked)."""
    with _lock:
        _last_used.clear()
        for p in work_dir().glob("*.open.duckdb*"):
            _unlink(p)


def purge_all_work() -> None:
    """Start-up: nothing in .work is in use; working files there belong to
    runs that never finished."""
    with _lock:
        _last_used.clear()
        for p in work_dir().glob("*"):
            _unlink(p)
