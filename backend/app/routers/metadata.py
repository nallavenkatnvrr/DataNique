from __future__ import annotations

from fastapi import APIRouter, HTTPException

from app.connectors.factory import get_connector
from app.db.store import Connection as ConnectionRecord, get_session


router = APIRouter(prefix="/api/connections", tags=["metadata"])


def _load(conn_id: int) -> ConnectionRecord:
    session = get_session()
    try:
        rec = session.get(ConnectionRecord, conn_id)
        if not rec:
            raise HTTPException(404, "Connection not found")
        return rec
    finally:
        session.close()


@router.get("/{conn_id}/databases")
def list_databases(conn_id: int) -> dict:
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    try:
        names = connector.list_databases()
        return {"databases": names, "default": rec.database}
    except Exception as exc:
        return {"databases": [], "error": str(exc)[:1000], "default": rec.database}


@router.get("/{conn_id}/schemas")
def list_schemas(conn_id: int, database: str | None = None) -> dict:
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    try:
        names = connector.list_schemas(database)
        return {"schemas": names, "default": rec.schema_name}
    except Exception as exc:
        return {"schemas": [], "error": str(exc)[:1000], "default": rec.schema_name}


@router.get("/{conn_id}/tables")
def list_tables(conn_id: int, database: str | None = None, schema: str | None = None) -> dict:
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    try:
        names = connector.list_tables(database, schema)
        return {"tables": names}
    except Exception as exc:
        return {"tables": [], "error": str(exc)[:1000]}


@router.get("/{conn_id}/columns")
def list_columns(conn_id: int, table: str, database: str | None = None, schema: str | None = None) -> dict:
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    try:
        cols = connector.get_columns(database, schema, table)
        return {"columns": [dict(c) for c in cols]}
    except Exception as exc:
        return {"columns": [], "error": str(exc)[:1000]}


# ---------------------------------------------------------------------------
# Object explorer: all object types in one call + object definitions
# ---------------------------------------------------------------------------
#
# Security note: db/schema/name values reaching these helpers come from the
# saved connection record or from UI dropdowns that are themselves populated
# from the live DB - but we still apply defense-in-depth quoting so a name
# containing a quote, bracket, or dot can never break out of its context:
#
#   _lit(s)              - a SQL string LITERAL: single quotes doubled, wrapped.
#   _ident(name, db_type)- a quoted IDENTIFIER: ["..."]/[...] per dialect with
#                          the closing delimiter doubled.
#
# These replace the ad-hoc ``.replace(chr(39), chr(39)+chr(39))`` calls and,
# critically, also quote the database-name IDENTIFIER prefix (previously
# interpolated raw as ``[db].`` / ``db.``).


def _lit(value: str | None) -> str:
    """Render a value as a safe SQL string literal (single-quote-doubled)."""
    return "'" + str(value or "").replace("'", "''") + "'"


def _ident(name: str | None, db_type: str) -> str:
    """Quote a single identifier for the given dialect.

    SQL Server / Sybase use ``[name]`` (closing ``]`` doubled). Everyone
    else uses ANSI ``"name"`` (closing ``"`` doubled).
    """
    n = str(name or "")
    if db_type == "sqlserver":
        return "[" + n.replace("]", "]]") + "]"
    return '"' + n.replace('"', '""') + '"'


def _db_prefix(db: str | None, db_type: str) -> str:
    """``<quoted-db>.`` prefix when a database is given, else empty."""
    return f"{_ident(db, db_type)}." if db else ""


# Per-dialect SQL to list views
_LIST_VIEWS_SQL = {
    "sqlserver": lambda db, sc: (
        f"SELECT TABLE_NAME FROM {_db_prefix(db, 'sqlserver')}INFORMATION_SCHEMA.VIEWS "
        f"WHERE TABLE_SCHEMA = {_lit(sc)} ORDER BY TABLE_NAME"
    ),
    "postgres": lambda db, sc: (
        f"SELECT table_name FROM information_schema.views "
        f"WHERE table_schema = {_lit(sc or 'public')} ORDER BY table_name"
    ),
    "mysql": lambda db, sc: (
        f"SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS "
        f"WHERE TABLE_SCHEMA = {_lit(db)} ORDER BY TABLE_NAME"
    ),
    "oracle": lambda db, sc: (
        f"SELECT VIEW_NAME FROM ALL_VIEWS WHERE OWNER = {_lit((sc or '').upper())} ORDER BY VIEW_NAME"
    ),
    "snowflake": lambda db, sc: (
        f"SELECT TABLE_NAME FROM {_db_prefix(db, 'snowflake')}INFORMATION_SCHEMA.VIEWS "
        f"WHERE TABLE_SCHEMA = {_lit((sc or '').upper())} ORDER BY TABLE_NAME"
    ),
}

# Per-dialect SQL to list procedures
_LIST_PROCS_SQL = {
    "sqlserver": lambda db, sc: (
        f"SELECT ROUTINE_NAME FROM {_db_prefix(db, 'sqlserver')}INFORMATION_SCHEMA.ROUTINES "
        f"WHERE ROUTINE_SCHEMA = {_lit(sc)} "
        f"AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
    ),
    "postgres": lambda db, sc: (
        f"SELECT routine_name FROM information_schema.routines "
        f"WHERE routine_schema = {_lit(sc or 'public')} "
        f"AND routine_type = 'PROCEDURE' ORDER BY routine_name"
    ),
    "mysql": lambda db, sc: (
        f"SELECT ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES "
        f"WHERE ROUTINE_SCHEMA = {_lit(db)} "
        f"AND ROUTINE_TYPE = 'PROCEDURE' ORDER BY ROUTINE_NAME"
    ),
    "oracle": lambda db, sc: (
        f"SELECT OBJECT_NAME FROM ALL_PROCEDURES "
        f"WHERE OWNER = {_lit((sc or '').upper())} "
        f"AND OBJECT_TYPE = 'PROCEDURE' ORDER BY OBJECT_NAME"
    ),
    "snowflake": lambda db, sc: (
        f"SELECT PROCEDURE_NAME FROM {_db_prefix(db, 'snowflake')}INFORMATION_SCHEMA.PROCEDURES "
        f"WHERE PROCEDURE_SCHEMA = {_lit((sc or '').upper())} "
        f"ORDER BY PROCEDURE_NAME"
    ),
}

# Per-dialect SQL to list functions
_LIST_FUNCS_SQL = {
    "sqlserver": lambda db, sc: (
        f"SELECT ROUTINE_NAME FROM {_db_prefix(db, 'sqlserver')}INFORMATION_SCHEMA.ROUTINES "
        f"WHERE ROUTINE_SCHEMA = {_lit(sc)} "
        f"AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
    ),
    "postgres": lambda db, sc: (
        f"SELECT routine_name FROM information_schema.routines "
        f"WHERE routine_schema = {_lit(sc or 'public')} "
        f"AND routine_type = 'FUNCTION' ORDER BY routine_name"
    ),
    "mysql": lambda db, sc: (
        f"SELECT ROUTINE_NAME FROM INFORMATION_SCHEMA.ROUTINES "
        f"WHERE ROUTINE_SCHEMA = {_lit(db)} "
        f"AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME"
    ),
    "oracle": lambda db, sc: (
        f"SELECT OBJECT_NAME FROM ALL_PROCEDURES "
        f"WHERE OWNER = {_lit((sc or '').upper())} "
        f"AND OBJECT_TYPE = 'FUNCTION' ORDER BY OBJECT_NAME"
    ),
    "snowflake": lambda db, sc: (
        f"SELECT FUNCTION_NAME FROM {_db_prefix(db, 'snowflake')}INFORMATION_SCHEMA.FUNCTIONS "
        f"WHERE FUNCTION_SCHEMA = {_lit((sc or '').upper())} "
        f"ORDER BY FUNCTION_NAME"
    ),
}


def _safe_query(connector, sql: str) -> list[str]:
    try:
        return [str(r[0]) for r in connector.execute_rows(sql)]
    except Exception:
        return []


@router.get("/{conn_id}/objects")
def list_objects(conn_id: int, database: str | None = None, schema: str | None = None) -> dict:
    """List all DB objects grouped by type - like DBeaver / Snowflake UI object explorer."""
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    db_type = (rec.db_type or "").lower()
    db = database or rec.database
    sc = schema or rec.schema_name

    tables = _safe_query(connector, connector.dialect.list_tables_sql(db, sc))

    views_fn = _LIST_VIEWS_SQL.get(db_type)
    views = _safe_query(connector, views_fn(db, sc)) if views_fn else []

    procs_fn = _LIST_PROCS_SQL.get(db_type)
    procs = _safe_query(connector, procs_fn(db, sc)) if procs_fn else []

    funcs_fn = _LIST_FUNCS_SQL.get(db_type)
    funcs = _safe_query(connector, funcs_fn(db, sc)) if funcs_fn else []

    return {
        "database": db,
        "schema": sc,
        "tables": tables,
        "views": views,
        "procedures": procs,
        "functions": funcs,
    }


# Per-dialect SQL to get object definition / DDL.
# The qualified-name argument to OBJECT_DEFINITION / GET_DDL is itself a
# string LITERAL, so we build "schema.name" and then pass the whole thing
# through _lit() to neutralize embedded quotes.
_OBJECT_DEF_SQL = {
    "sqlserver": lambda db, sc, name: (
        f"SELECT OBJECT_DEFINITION(OBJECT_ID({_lit((sc + '.' if sc else '') + name)}))"
    ),
    "postgres": lambda db, sc, name: (
        f"SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = {_lit(name)}"
    ),
    "oracle": lambda db, sc, name: (
        f"SELECT DBMS_METADATA.GET_DDL(object_type, object_name, owner) "
        f"FROM all_objects WHERE object_name = {_lit((name or '').upper())} "
        f"AND owner = {_lit((sc or '').upper())} AND ROWNUM = 1"
    ),
    "snowflake": lambda db, sc, name: (
        f"SELECT GET_DDL('TABLE', {_lit((sc + '.' if sc else '') + name)})"
    ),
}


@router.get("/{conn_id}/object-definition")
def get_object_definition(
    conn_id: int,
    name: str,
    object_type: str = "TABLE",
    database: str | None = None,
    schema: str | None = None,
) -> dict:
    """Get the DDL / definition of a database object."""
    rec = _load(conn_id)
    connector = get_connector(rec, purpose="metadata")
    db_type = (rec.db_type or "").lower()
    db = database or rec.database
    sc = schema or rec.schema_name

    # For tables, use our DDL generator
    if object_type.upper() == "TABLE":
        try:
            from app.services.ddl_generator import generate_ddl
            ddl = generate_ddl(connector, db, sc, name)
            return {"definition": ddl, "object_type": "TABLE", "name": name}
        except Exception as exc:
            return {"definition": None, "error": str(exc)[:1000], "name": name}

    # For views/procs/functions, try dialect-specific DDL retrieval
    def_fn = _OBJECT_DEF_SQL.get(db_type)
    if def_fn:
        try:
            sql = def_fn(db, sc, name)
            row = connector.execute_one(sql)
            definition = str(row[0]) if row and row[0] else None
            return {"definition": definition, "object_type": object_type, "name": name}
        except Exception as exc:
            return {"definition": None, "error": str(exc)[:1000], "name": name}

    return {"definition": None, "error": f"DDL retrieval not supported for {db_type}", "name": name}
