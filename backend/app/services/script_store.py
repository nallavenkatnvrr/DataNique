"""On-disk SQL script storage with per-connection workspaces and versioning.

Layout under the configured ``scripts_dir`` (see app_settings):

    <scripts_dir>/
        <workspace>/               # one folder per connection workspace
            s3.sql                 # CURRENT version of a script
            backups/               # every previous version, timestamped
                s3__20260811_204500_123.sql
                s3__20260811_205000_456.sql

Save semantics (versioning): when a script is saved and a current file already
exists with DIFFERENT content, the existing current is first copied into
``backups/`` with a timestamp suffix, then the new content overwrites current.
So N distinct saves ⇒ 1 current + (N-1) backups.
"""
from __future__ import annotations

import re
import shutil
from datetime import datetime
from pathlib import Path

from app.services.app_settings import get_scripts_dir

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
_BACKUP_RE = re.compile(r"^(?P<stem>.+)__(?P<ts>\d{8}_\d{6}_\d{3})$")


def _slug(value: str, fallback: str = "item") -> str:
    """Filesystem-safe slug that preserves readability."""
    value = (value or "").strip()
    slug = _SAFE.sub("_", value).strip("._-")
    return slug or fallback


def _workspace_dir(workspace: str, *, create: bool = False) -> Path:
    d = get_scripts_dir() / _slug(workspace, "default")
    if create:
        (d / "backups").mkdir(parents=True, exist_ok=True)
    return d


def _script_stem(name: str) -> str:
    """Normalise a user-supplied script name to a bare stem (no .sql)."""
    name = (name or "").strip()
    if name.lower().endswith(".sql"):
        name = name[:-4]
    return _slug(name, "script")


def _now_stamp() -> str:
    now = datetime.now()
    return now.strftime("%Y%m%d_%H%M%S_") + f"{now.microsecond // 1000:03d}"


def save_script(workspace: str, name: str, content: str) -> dict:
    """Save ``content`` as the current version of ``name`` in ``workspace``.

    Returns metadata including the saved path and the resulting version count.
    """
    ws = _workspace_dir(workspace, create=True)
    stem = _script_stem(name)
    current = ws / f"{stem}.sql"
    backups = ws / "backups"

    backed_up: str | None = None
    if current.exists():
        existing = current.read_text(encoding="utf-8", errors="replace")
        if existing != content:
            backup_path = backups / f"{stem}__{_now_stamp()}.sql"
            shutil.copy2(current, backup_path)
            backed_up = str(backup_path)

    current.write_text(content, encoding="utf-8")

    return {
        "workspace": _slug(workspace, "default"),
        "name": stem,
        "path": str(current),
        "backed_up_path": backed_up,
        "version_count": _version_count(ws, stem),
    }


def _version_count(ws: Path, stem: str) -> int:
    backups = ws / "backups"
    n = 1 if (ws / f"{stem}.sql").exists() else 0
    if backups.exists():
        n += len(list(backups.glob(f"{stem}__*.sql")))
    return n


def list_scripts(workspace: str) -> list[dict]:
    """List current scripts in a workspace (newest-modified first)."""
    ws = _workspace_dir(workspace)
    if not ws.exists():
        return []
    out: list[dict] = []
    for p in ws.glob("*.sql"):
        if not p.is_file():
            continue
        st = p.stat()
        out.append({
            "name": p.stem,
            "path": str(p),
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
            "version_count": _version_count(ws, p.stem),
        })
    out.sort(key=lambda d: d["modified"], reverse=True)
    return out


def load_script(workspace: str, name: str) -> dict:
    ws = _workspace_dir(workspace)
    stem = _script_stem(name)
    current = ws / f"{stem}.sql"
    if not current.exists():
        raise FileNotFoundError(f"Script '{stem}' not found in workspace")
    return {
        "name": stem,
        "path": str(current),
        "content": current.read_text(encoding="utf-8", errors="replace"),
    }


def list_versions(workspace: str, name: str) -> list[dict]:
    """List all versions of a script: the current plus every backup, newest first."""
    ws = _workspace_dir(workspace)
    stem = _script_stem(name)
    out: list[dict] = []

    current = ws / f"{stem}.sql"
    if current.exists():
        st = current.stat()
        out.append({
            "version": "current",
            "path": str(current),
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
        })

    backups = ws / "backups"
    if backups.exists():
        for p in backups.glob(f"{stem}__*.sql"):
            st = p.stat()
            m = _BACKUP_RE.match(p.stem)
            out.append({
                "version": m.group("ts") if m else p.stem,
                "path": str(p),
                "size": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
            })

    out.sort(key=lambda d: d["modified"], reverse=True)
    return out


def load_version(workspace: str, name: str, version: str) -> dict:
    """Load a specific version ('current' or a backup timestamp)."""
    ws = _workspace_dir(workspace)
    stem = _script_stem(name)
    if version == "current":
        return load_script(workspace, name)
    # version is a backup timestamp like 20260811_204500_123
    path = ws / "backups" / f"{stem}__{_slug(version)}.sql"
    if not path.exists():
        raise FileNotFoundError(f"Version '{version}' of '{stem}' not found")
    return {
        "name": stem,
        "version": version,
        "path": str(path),
        "content": path.read_text(encoding="utf-8", errors="replace"),
    }
