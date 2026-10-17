"""File upload, inspection and (desktop) folder browsing."""
from __future__ import annotations

import os
import shutil
import string
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.config import settings
from app.engine import files as F
from app.engine.spec import FileOptions, SideSpec

router = APIRouter(prefix="/api/files", tags=["files"])


def upload_limit_bytes() -> int:
    return int(getattr(settings, "max_upload_mb", 20480) or 20480) * 1024 * 1024


@router.post("")
async def upload(file: UploadFile = File(...)) -> dict:
    limit = upload_limit_bytes()
    fid = F.new_file_id()
    d = F.uploads_dir() / fid
    d.mkdir(parents=True)
    dest = d / F.safe_name(file.filename or "upload")
    total = 0
    try:
        with open(dest, "wb") as out:
            while True:
                chunk = await file.read(4 * 1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise HTTPException(413, f"File exceeds the {limit / (1024 * 1024):g} MB upload limit")
                out.write(chunk)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    info: dict = {"file_id": fid, "name": dest.name, "size_bytes": total}
    try:
        info["inspect"] = F.inspect(SideSpec(kind="file", file_id=fid), preview_rows=20)
    except Exception as exc:
        info["inspect_error"] = str(exc)[:500]
    return info


@router.delete("/{file_id}")
def delete_upload(file_id: str) -> dict:
    if not file_id.isalnum():
        raise HTTPException(400, "bad id")
    shutil.rmtree(F.uploads_dir() / file_id, ignore_errors=True)
    return {"ok": True}


class InspectIn(BaseModel):
    file_id: str | None = None
    path: str | None = None
    format: str | None = None
    options: FileOptions = FileOptions()


@router.post("/inspect")
def inspect(body: InspectIn, preview: int = Query(50, ge=0, le=500)) -> dict:
    try:
        side = SideSpec(kind="file", file_id=body.file_id, path=body.path, format=body.format, options=body.options)
        return F.inspect(side, preview_rows=preview)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:
        raise HTTPException(400, f"Could not read the file: {type(exc).__name__}: {str(exc)[:500]}")


@router.get("/browse")
def browse(path: str = Query("")) -> dict:
    """List a folder on the machine running Datanique (for picking files by
    path instead of uploading them)."""
    p = path.strip().strip('"')
    if not p:
        roots = []
        if os.name == "nt":
            for letter in string.ascii_uppercase:
                d = f"{letter}:\\"
                if os.path.exists(d):
                    roots.append({"name": d, "path": d, "dir": True})
        home = str(Path.home())
        return {"path": "", "parent": None, "entries": [{"name": "Home", "path": home, "dir": True}] + roots + ([] if os.name == "nt" else [{"name": "/", "path": "/", "dir": True}])}
    d = Path(os.path.expandvars(os.path.expanduser(p)))
    if not d.is_dir():
        raise HTTPException(400, f"Not a folder: {d}")
    entries = []
    try:
        for e in sorted(d.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            if e.name.startswith("."):
                continue
            try:
                is_dir = e.is_dir()
                sfx = [s.lower() for s in e.suffixes]
                if not is_dir and not (any(s in F.EXT_FORMATS for s in sfx) or (sfx and sfx[-1] in (".gz", ".zst", ".zip"))):
                    continue
                entries.append({"name": e.name, "path": str(e), "dir": is_dir,
                                "size_bytes": None if is_dir else e.stat().st_size})
            except OSError:
                continue
            if len(entries) >= 2000:
                break
    except PermissionError:
        raise HTTPException(403, f"No permission to read {d}")
    parent = str(d.parent) if d.parent != d else None
    return {"path": str(d), "parent": parent, "entries": entries}
