from typing import Any
import json
import logging

from sqlalchemy import (
    create_engine, Column, Integer, String, Text, DateTime, Boolean, JSON, event, text,
)
from sqlalchemy.orm import declarative_base, sessionmaker, Session
from sqlalchemy.types import TypeDecorator

from app.config import settings
from app.util_time import utcnow_naive

log = logging.getLogger("dv.store")

engine = create_engine(
    settings.sqlite_url,
    connect_args={"check_same_thread": False, "timeout": 30},
    future=True,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record):  # pragma: no cover - trivial
    try:
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        # Deleted (decrypted-then-rewritten) pages are zeroed, not left behind.
        cur.execute("PRAGMA secure_delete=ON")
        cur.close()
    except Exception:
        pass


SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)
Base = declarative_base()


# ---------------------------------------------------------------------------
# Encrypted column types. Values are sealed with the vault's data key on the
# way in and opened on the way out; rows written before the vault existed
# (plain JSON / text) are still readable and get sealed by the migration
# that runs when the vault is created.
# ---------------------------------------------------------------------------
class EncryptedText(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from app.security.vault import vault
        if not vault.is_initialized:
            return str(value)
        return vault.encrypt_text(str(value))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from app.security.vault import PREFIX, vault
        if isinstance(value, str) and value.startswith(PREFIX):
            return vault.decrypt_text(value)
        return value


class EncryptedJSON(TypeDecorator):
    impl = Text
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        from app.security.vault import vault
        s = json.dumps(value, default=str, separators=(",", ":"))
        if not vault.is_initialized:
            return s
        return vault.encrypt_text(s)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        from app.security.vault import PREFIX, vault
        if isinstance(value, str) and value.startswith(PREFIX):
            value = vault.decrypt_text(value)
        if isinstance(value, (dict, list)):
            return value
        try:
            return json.loads(value)
        except Exception:
            return None


class Connection(Base):
    __tablename__ = "connections"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True, index=True)
    db_type = Column(String(32), nullable=False)
    host = Column(String(256), nullable=True)
    port = Column(Integer, nullable=True)
    username = Column(String(256), nullable=True)
    # dv2: AES-GCM with the vault key (see app.security.crypto)
    password_enc = Column(Text, nullable=True)
    database = Column(String(256), nullable=True)
    schema_name = Column(String(256), nullable=True)
    extra = Column(JSON, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow_naive)
    updated_at = Column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)


class CompareRun(Base):
    __tablename__ = "compare_runs"

    id = Column(Integer, primary_key=True, index=True)
    run_uuid = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(String(32), nullable=False, default="RUNNING")
    # MATCH / MISMATCH / ERROR (plain so lists and the dashboard can count
    # without decrypting every result)
    verdict = Column(String(32), nullable=True)
    kind = Column(String(32), nullable=True)  # table / query / file / mixed
    batch_id = Column(String(64), nullable=True, index=True)

    source_connection_id = Column(Integer, nullable=False)
    target_connection_id = Column(Integer, nullable=False)
    source_label = Column(EncryptedText, nullable=False)
    target_label = Column(EncryptedText, nullable=False)

    options = Column(EncryptedJSON, nullable=True)
    # Small dict for list views (counts, timings, engine)
    summary = Column(EncryptedJSON, nullable=True)
    result = Column(EncryptedJSON, nullable=True)
    error = Column(EncryptedText, nullable=True)

    started_at = Column(DateTime, nullable=False, default=utcnow_naive)
    finished_at = Column(DateTime, nullable=True)


class CompareBatch(Base):
    """A bulk run: many compare pairs started together."""
    __tablename__ = "compare_batches"

    id = Column(Integer, primary_key=True, index=True)
    batch_uuid = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(String(32), nullable=False, default="RUNNING")
    name = Column(EncryptedText, nullable=True)
    summary = Column(EncryptedJSON, nullable=True)
    started_at = Column(DateTime, nullable=False, default=utcnow_naive)
    finished_at = Column(DateTime, nullable=True)


class CompareTemplate(Base):
    """A saved compare configuration that can be re-run or batched."""
    __tablename__ = "compare_templates"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(128), nullable=False, unique=True, index=True)
    description = Column(EncryptedText, nullable=True)
    payload = Column(EncryptedJSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=utcnow_naive)
    updated_at = Column(DateTime, nullable=False, default=utcnow_naive, onupdate=utcnow_naive)


_ADDED_COLUMNS = {
    "compare_runs": {
        "verdict": "VARCHAR(32)",
        "kind": "VARCHAR(32)",
        "batch_id": "VARCHAR(64)",
        "summary": "TEXT",
    },
}

_initialized = False


def init_db() -> None:
    """Create tables and add columns introduced after the first release."""
    global _initialized
    Base.metadata.create_all(bind=engine)
    if _initialized:
        return
    with engine.begin() as conn:
        for table, cols in _ADDED_COLUMNS.items():
            have = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}
            for name, ddl in cols.items():
                if name not in have:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
    _initialized = True


def get_session() -> Session:
    return SessionLocal()


def json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))
