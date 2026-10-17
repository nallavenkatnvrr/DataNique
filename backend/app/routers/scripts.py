"""Saved SQL scripts API — per-connection workspaces with on-disk versioning."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import script_store

router = APIRouter(prefix="/api/scripts", tags=["scripts"])


class ScriptSavePayload(BaseModel):
    workspace: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=128)
    content: str = ""


@router.post("/save")
def save_script(payload: ScriptSavePayload) -> dict:
    return script_store.save_script(payload.workspace, payload.name, payload.content)


@router.get("")
def list_scripts(workspace: str) -> list[dict]:
    return script_store.list_scripts(workspace)


@router.get("/load")
def load_script(workspace: str, name: str) -> dict:
    try:
        return script_store.load_script(workspace, name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/versions")
def list_versions(workspace: str, name: str) -> list[dict]:
    return script_store.list_versions(workspace, name)


@router.get("/version")
def load_version(workspace: str, name: str, version: str) -> dict:
    try:
        return script_store.load_version(workspace, name, version)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
