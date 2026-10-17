"""User settings API — configurable on-disk locations for scripts & exports."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import app_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


class SettingsPayload(BaseModel):
    scripts_dir: str | None = None
    exports_dir: str | None = None


@router.get("")
def get_settings() -> dict:
    return app_settings.get_settings()


@router.put("")
def put_settings(payload: SettingsPayload) -> dict:
    patch = {k: v for k, v in payload.model_dump().items() if v is not None}
    # Validate that provided paths are writable before persisting.
    for key in ("scripts_dir", "exports_dir"):
        if key in patch and patch[key]:
            p = Path(str(patch[key])).expanduser()
            try:
                p.mkdir(parents=True, exist_ok=True)
                probe = p / ".dv_write_test"
                probe.write_text("ok", encoding="utf-8")
                probe.unlink(missing_ok=True)
            except Exception as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot write to {key} '{patch[key]}': {e}",
                )
    return app_settings.update_settings(patch)
