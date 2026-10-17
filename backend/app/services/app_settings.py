"""User-configurable app settings persisted to a small JSON file.

These are runtime preferences the user can change from the Settings page —
distinct from the environment-driven ``app.config.Settings`` (which holds
deployment/immutable config). Right now this stores the on-disk locations for
saved SQL scripts and exported files so the user can keep everything in one
place of their choosing.

Storage: a single ``app_settings.json`` under ``settings.data_dir``. Reads are
cheap and cached in-process; writes are atomic (temp file + replace).
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from app.config import settings as env_settings

_LOCK = threading.RLock()
_SETTINGS_FILE = env_settings.data_dir / "app_settings.json"

# Default locations live under the app data dir so everything works out of the
# box; the user can repoint them anywhere writable from the Settings page.
_DEFAULT_SCRIPTS_DIR = env_settings.data_dir / "scripts"
_DEFAULT_EXPORTS_DIR = env_settings.data_dir / "exports"

_DEFAULTS: dict[str, Any] = {
    "scripts_dir": str(_DEFAULT_SCRIPTS_DIR),
    "exports_dir": str(_DEFAULT_EXPORTS_DIR),
}

_cache: dict[str, Any] | None = None


def _read_raw() -> dict[str, Any]:
    if not _SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_settings() -> dict[str, Any]:
    """Return the effective settings (defaults merged with persisted values)."""
    global _cache
    with _LOCK:
        if _cache is None:
            _cache = {**_DEFAULTS, **_read_raw()}
        return dict(_cache)


def _write_raw(data: dict[str, Any]) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _SETTINGS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    os.replace(tmp, _SETTINGS_FILE)


def update_settings(patch: dict[str, Any]) -> dict[str, Any]:
    """Merge ``patch`` into persisted settings and return the effective set.

    Only known keys are accepted. Directory values are expanded (``~``) and the
    directories are created so later writes never fail on a missing path.
    """
    global _cache
    with _LOCK:
        current = {**_DEFAULTS, **_read_raw()}
        for key in ("scripts_dir", "exports_dir"):
            if key in patch and patch[key]:
                current[key] = str(Path(str(patch[key])).expanduser())
        _write_raw(current)
        _cache = current
        # Best-effort create so the UI can rely on the paths existing.
        for key in ("scripts_dir", "exports_dir"):
            try:
                Path(current[key]).mkdir(parents=True, exist_ok=True)
            except Exception:
                pass
        return dict(current)


def get_scripts_dir() -> Path:
    p = Path(get_settings()["scripts_dir"]).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def get_exports_dir() -> Path:
    p = Path(get_settings()["exports_dir"]).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p
