from __future__ import annotations

import concurrent.futures
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.connectors import factory as connector_factory
from app.connectors.factory import SUPPORTED_DB_TYPES, db_type_metadata, get_connector
from app.db.store import Connection as ConnectionRecord, get_session
from app.security.crypto import encrypt


router = APIRouter(prefix="/api/connections", tags=["connections"])


# Dedicated pool for "Test connection" — keep separate from the engines so
# a stuck DB driver can never starve the run-compare side. Daemon threads
# so the process can exit cleanly even if a driver is blocked in a kernel
# socket call.
_TEST_POOL = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="dv-conn-test"
)


def _run_test_with_timeout(connector, timeout_s: int) -> dict:
    """Run ``connector.test()`` in a worker thread with a hard timeout.

    If the test hangs longer than ``timeout_s`` seconds (typical: 30),
    we abandon the thread and surface a clean timeout error. The DB
    driver may still be blocked in a syscall but the HTTP request
    returns immediately so the UI button unsticks.
    """
    future = _TEST_POOL.submit(connector.test)
    try:
        return future.result(timeout=timeout_s)
    except concurrent.futures.TimeoutError:
        # Future is still running but the network call is hung. Don't
        # try to cancel — Python can't interrupt a syscall mid-flight.
        # The worker thread will eventually error out and be reclaimed.
        raise TimeoutError(
            f"Connection test exceeded {timeout_s}s timeout. The DB host may be "
            f"unreachable, the firewall may be blocking the port, or the server is "
            f"refusing the connection. Tune via DV_CONNECT_TIMEOUT / DV_TEST_TIMEOUT."
        )


class ConnectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    db_type: str
    host: str | None = None
    port: int | None = None
    username: str | None = None
    password: str | None = None
    database: str | None = None
    schema_name: str | None = None
    extra: dict[str, Any] | None = None
    is_active: bool = True


class ConnectionOut(BaseModel):
    id: int
    name: str
    db_type: str
    host: str | None
    port: int | None
    username: str | None
    database: str | None
    schema_name: str | None
    extra: dict[str, Any] | None
    is_active: bool
    has_password: bool
    created_at: datetime
    updated_at: datetime


def _to_out(r: ConnectionRecord) -> ConnectionOut:
    return ConnectionOut(
        id=r.id,
        name=r.name,
        db_type=r.db_type,
        host=r.host,
        port=r.port,
        username=r.username,
        database=r.database,
        schema_name=r.schema_name,
        extra=r.extra,
        is_active=r.is_active,
        has_password=bool(r.password_enc),
        created_at=r.created_at,
        updated_at=r.updated_at,
    )


@router.get("/types")
def list_db_types() -> list[dict]:
    return db_type_metadata()


@router.get("")
def list_connections() -> list[ConnectionOut]:
    session = get_session()
    try:
        rows = session.query(ConnectionRecord).order_by(ConnectionRecord.name).all()
        return [_to_out(r) for r in rows]
    finally:
        session.close()


@router.post("", status_code=201)
def create_connection(payload: ConnectionIn) -> ConnectionOut:
    if payload.db_type.lower() not in SUPPORTED_DB_TYPES:
        raise HTTPException(400, f"Unsupported db_type {payload.db_type!r}. Supported: {SUPPORTED_DB_TYPES}")
    session = get_session()
    try:
        existing = session.query(ConnectionRecord).filter(ConnectionRecord.name == payload.name).first()
        if existing:
            raise HTTPException(409, f"Connection with name {payload.name!r} already exists")
        record = ConnectionRecord(
            name=payload.name,
            db_type=payload.db_type.lower(),
            host=payload.host,
            port=payload.port,
            username=payload.username,
            password_enc=encrypt(payload.password),
            database=payload.database,
            schema_name=payload.schema_name,
            extra=payload.extra or {},
            is_active=payload.is_active,
        )
        session.add(record)
        session.commit()
        session.refresh(record)
        return _to_out(record)
    finally:
        session.close()


@router.put("/{conn_id}")
def update_connection(conn_id: int, payload: ConnectionIn) -> ConnectionOut:
    if payload.db_type.lower() not in SUPPORTED_DB_TYPES:
        raise HTTPException(400, f"Unsupported db_type {payload.db_type!r}. Supported: {SUPPORTED_DB_TYPES}")
    session = get_session()
    try:
        record = session.get(ConnectionRecord, conn_id)
        if not record:
            raise HTTPException(404, "Connection not found")
        record.name = payload.name
        record.db_type = payload.db_type.lower()
        record.host = payload.host
        record.port = payload.port
        record.username = payload.username
        if payload.password:
            record.password_enc = encrypt(payload.password)
        record.database = payload.database
        record.schema_name = payload.schema_name
        record.extra = payload.extra or {}
        record.is_active = payload.is_active
        session.commit()
        session.refresh(record)
        # Evict the cached connector so the next request picks up the new
        # credentials/host/role instead of silently using the stale ones.
        connector_factory.evict_connector(conn_id)
        return _to_out(record)
    finally:
        session.close()


@router.delete("/{conn_id}")
def delete_connection(conn_id: int) -> Response:
    session = get_session()
    try:
        record = session.get(ConnectionRecord, conn_id)
        if not record:
            raise HTTPException(404, "Connection not found")
        session.delete(record)
        session.commit()
        # Free the underlying DB connection now rather than letting it
        # linger until the process exits.
        connector_factory.evict_connector(conn_id)
        return Response(status_code=204)
    finally:
        session.close()


@router.post("/{conn_id}/test")
def test_connection(conn_id: int) -> dict:
    session = get_session()
    try:
        record = session.get(ConnectionRecord, conn_id)
        if not record:
            raise HTTPException(404, "Connection not found")
        connector = get_connector(record, purpose="test")
        try:
            from app.config import settings
            timeout_s = int(getattr(settings, "test_timeout", 30) or 30)
            res = _run_test_with_timeout(connector, timeout_s)
            return {"ok": True, **res}
        except Exception as exc:
            # If the test failed (or timed out), the cached connection
            # (if any) is likely bad — evict so the next attempt rebuilds
            # from scratch with a fresh socket.
            # Only the test slot: running compares and IDE sessions keep theirs.
            connector_factory.evict_connector(conn_id, purpose="test")
            return {"ok": False, "error": str(exc)[:1000]}
    finally:
        session.close()


@router.post("/test-payload")
def test_unsaved_connection(payload: ConnectionIn) -> dict:
    record = ConnectionRecord(
        id=-1,  # Sentinel: factory will NOT cache this (see factory.get_connector).
        name=payload.name,
        db_type=payload.db_type.lower(),
        host=payload.host,
        port=payload.port,
        username=payload.username,
        password_enc=encrypt(payload.password),
        database=payload.database,
        schema_name=payload.schema_name,
        extra=payload.extra or {},
        is_active=payload.is_active,
    )
    connector = None
    try:
        from app.config import settings
        timeout_s = int(getattr(settings, "test_timeout", 30) or 30)
        connector = get_connector(record, purpose="test")
        res = _run_test_with_timeout(connector, timeout_s)
        return {"ok": True, **res}
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:1000]}
    finally:
        # The unsaved-test path is uncacheable (id=-1) so the Connector is
        # ours to dispose; otherwise we'd leak the underlying connection.
        if connector is not None:
            try:
                connector.dispose(force=True)
            except Exception:
                pass


@router.post("/cache/evict-all", status_code=204)
def evict_all_connectors() -> Response:
    """Drop every cached Connector.

    Useful if connection state on the DB side has changed out from under us
    (token revoked, role removed, password rotated by an external system).
    Next request rebuilds connectors from scratch.
    """
    connector_factory.evict_all()
    return Response(status_code=204)
