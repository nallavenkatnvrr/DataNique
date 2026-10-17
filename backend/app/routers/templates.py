"""Saved compare templates: CRUD.

A template stores a full ``CompareRequest``-shaped payload under a name so
the user can re-run a compare or assemble a batch without re-entering the
source/target/keys/engine/options every time.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.db.store import CompareTemplate, get_session


router = APIRouter(prefix="/api/templates", tags=["templates"])


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    description: str | None = None
    payload: dict[str, Any]


class TemplateUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    description: str | None = None
    payload: dict[str, Any] | None = None


def _serialize(t: CompareTemplate) -> dict:
    return {
        "id": t.id,
        "name": t.name,
        "description": t.description,
        "payload": t.payload,
        "created_at": t.created_at.isoformat() + "Z",
        "updated_at": t.updated_at.isoformat() + "Z",
    }


@router.get("")
def list_templates() -> list[dict]:
    session = get_session()
    try:
        rows = session.query(CompareTemplate).order_by(CompareTemplate.name.asc()).all()
        return [_serialize(t) for t in rows]
    finally:
        session.close()


@router.get("/{template_id}")
def get_template(template_id: int) -> dict:
    session = get_session()
    try:
        t = session.get(CompareTemplate, template_id)
        if not t:
            raise HTTPException(404, "Template not found")
        return _serialize(t)
    finally:
        session.close()


@router.post("")
def create_template(req: TemplateCreate) -> dict:
    session = get_session()
    try:
        existing = session.query(CompareTemplate).filter(CompareTemplate.name == req.name).first()
        if existing:
            raise HTTPException(409, f"A template named {req.name!r} already exists")
        t = CompareTemplate(name=req.name, description=req.description, payload=req.payload)
        session.add(t)
        session.commit()
        session.refresh(t)
        return _serialize(t)
    finally:
        session.close()


@router.put("/{template_id}")
def update_template(template_id: int, req: TemplateUpdate) -> dict:
    session = get_session()
    try:
        t = session.get(CompareTemplate, template_id)
        if not t:
            raise HTTPException(404, "Template not found")
        if req.name is not None and req.name != t.name:
            clash = session.query(CompareTemplate).filter(
                CompareTemplate.name == req.name, CompareTemplate.id != template_id
            ).first()
            if clash:
                raise HTTPException(409, f"A template named {req.name!r} already exists")
            t.name = req.name
        if req.description is not None:
            t.description = req.description
        if req.payload is not None:
            t.payload = req.payload
        session.commit()
        session.refresh(t)
        return _serialize(t)
    finally:
        session.close()


@router.delete("/{template_id}")
def delete_template(template_id: int) -> Response:
    session = get_session()
    try:
        t = session.get(CompareTemplate, template_id)
        if not t:
            raise HTTPException(404, "Template not found")
        session.delete(t)
        session.commit()
        return Response(status_code=204)
    finally:
        session.close()
