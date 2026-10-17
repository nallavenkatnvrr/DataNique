"""DDL, INSERT, and EXEC statement generators.

Generates SQL scripts from table metadata for the SQL IDE:
- CREATE TABLE DDL
- INSERT INTO statements (from sample data)
- EXEC / CALL procedure statements
"""
from __future__ import annotations


from app.connectors.base import Connector


def generate_ddl(
    connector: Connector,
    database: str | None,
    schema: str | None,
    table: str,
) -> str:
    """Generate a CREATE TABLE DDL statement from column metadata."""
    cols = connector.get_columns(database, schema, table)
    dialect = connector.dialect
    fq = dialect.fq_table(database, schema, table)

    lines: list[str] = []
    for c in cols:
        name = dialect.quote_ident(c["name"])
        dtype = _full_type(c)
        nullable = "NULL" if c.get("nullable") else "NOT NULL"
        lines.append(f"    {name} {dtype} {nullable}")

    col_defs = ",\n".join(lines)
    return f"CREATE TABLE {fq} (\n{col_defs}\n);"


_SIZED_CHAR = ("CHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "NCHAR", "BINARY", "VARBINARY",
               "CHARACTER VARYING", "CHARACTER", "RAW")
_SIZED_NUM = ("DECIMAL", "NUMERIC", "NUMBER")


def _full_type(c) -> str:
    """Type with its length / precision / scale (metadata often reports
    them separately, e.g. VARCHAR2 + 50)."""
    dtype = (c.get("data_type") or "VARCHAR(255)").strip()
    if "(" in dtype:
        return dtype
    up = dtype.upper()
    length = c.get("char_max_length")
    if up in _SIZED_CHAR and length:
        return f"{dtype}(MAX)" if int(length) < 0 else f"{dtype}({int(length)})"
    prec, scale = c.get("numeric_precision"), c.get("numeric_scale")
    if up in _SIZED_NUM and prec:
        return f"{dtype}({int(prec)},{int(scale or 0)})"
    return dtype


def generate_insert(
    connector: Connector,
    database: str | None,
    schema: str | None,
    table: str,
    limit: int = 100,
) -> str:
    """Generate INSERT INTO statements from sample data."""
    cols = connector.get_columns(database, schema, table)
    dialect = connector.dialect
    fq = dialect.fq_table(database, schema, table)
    col_names = [c["name"] for c in cols]
    quoted_cols = [dialect.quote_ident(c) for c in col_names]

    # Fetch sample rows
    sql = dialect.sample_rows_sql(fq, col_names, limit)
    rows = connector.execute_rows(sql, limit=limit)

    if not rows:
        return f"-- No data found in {fq}"

    statements: list[str] = []
    col_list = ", ".join(quoted_cols)

    for row in rows:
        vals: list[str] = []
        for v in row:
            if v is None:
                vals.append("NULL")
            elif isinstance(v, bool):
                # NOTE: bool must be checked BEFORE int - bool subclasses int,
                # so an (int, float) test would catch True/False first and emit
                # the invalid literal "True"/"False" instead of 1/0.
                vals.append("1" if v else "0")
            elif isinstance(v, (int, float)):
                vals.append(str(v))
            elif isinstance(v, bytes):
                vals.append(f"0x{v.hex()}")
            else:
                escaped = str(v).replace("'", "''")
                vals.append(f"'{escaped}'")
        val_list = ", ".join(vals)
        statements.append(f"INSERT INTO {fq} ({col_list}) VALUES ({val_list});")

    return "\n".join(statements)


def generate_exec_proc(
    db_type: str,
    database: str | None,
    schema: str | None,
    proc_name: str,
    params: list[dict] | None = None,
) -> str:
    """Generate an EXEC/CALL statement for a stored procedure.

    ``params`` is a list of ``{"name": "...", "value": "...", "direction": "IN|OUT|INOUT"}``.
    """
    db_type_lower = (db_type or "").lower()

    # Build fully-qualified name
    parts = [p for p in (database, schema, proc_name) if p]
    fq_name = ".".join(parts)

    param_parts: list[str] = []
    if params:
        for p in params:
            name = p.get("name", "")
            value = p.get("value", "")
            direction = (p.get("direction") or "IN").upper()
            if direction == "OUT":
                param_parts.append(f"@{name} OUTPUT" if db_type_lower == "sqlserver" else f"@{name}")
            elif value == "" or value is None:
                param_parts.append("NULL")
            else:
                # Try numeric
                try:
                    float(value)
                    param_parts.append(value)
                except (ValueError, TypeError):
                    escaped = str(value).replace("'", "''")
                    param_parts.append(f"'{escaped}'")

    param_str = ", ".join(param_parts)

    if db_type_lower == "sqlserver":
        if param_str:
            return f"EXEC {fq_name} {param_str};"
        return f"EXEC {fq_name};"
    elif db_type_lower == "oracle":
        if param_str:
            return f"BEGIN\n    {fq_name}({param_str});\nEND;\n/"
        return f"BEGIN\n    {fq_name};\nEND;\n/"
    elif db_type_lower in ("postgres", "mysql"):
        if param_str:
            return f"CALL {fq_name}({param_str});"
        return f"CALL {fq_name}();"
    elif db_type_lower == "snowflake":
        if param_str:
            return f"CALL {fq_name}({param_str});"
        return f"CALL {fq_name}();"
    else:
        if param_str:
            return f"EXEC {fq_name} {param_str};"
        return f"EXEC {fq_name};"
