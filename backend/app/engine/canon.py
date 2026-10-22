"""Canonical comparison expressions.

Both sides of every column pair are projected to the SAME DuckDB type so the
diff can use plain ``IS DISTINCT FROM`` and hash joins. The rules (with the
default normalization) are:

==========================  ===============================================
pair                        compared as
==========================  ===============================================
int / int                   native integer
int|decimal / decimal       DECIMAL(38, max scale)
float with anything numeric DOUBLE (FLOAT when either side is 32-bit)
date / timestamp(tz)        TIMESTAMP (tz converted to UTC), optional truncation
bool / bool                 BOOLEAN
string / string             VARCHAR with the opt-in trims / case / null rules
string / number             canonical number text ('012.50' = 12.5)
string / date-time          canonical timestamp text
bool / number|string        'true' / 'false' (1/0, Y/N, yes/no, t/f)
anything else               VARCHAR
==========================  ===============================================
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.engine.spec import Normalize

NUMERIC = {"int", "decimal", "float"}
TEMPORAL = {"date", "timestamp", "timestamptz"}

MACROS = r"""
CREATE OR REPLACE MACRO dv_numtxt(x) AS
  CASE WHEN x IS NULL THEN NULL ELSE
    regexp_replace(regexp_replace(CAST(x AS VARCHAR), '(\.[0-9]*?)0+$', '\1'), '\.$', '')
  END;
CREATE OR REPLACE MACRO dv_dectxt(x) AS
  dv_numtxt(COALESCE(CAST(TRY_CAST(x AS DECIMAL(18,10)) AS VARCHAR), CAST(TRY_CAST(x AS DECIMAL(38,10)) AS VARCHAR)));
CREATE OR REPLACE MACRO dv_str2num(x) AS
  COALESCE(dv_dectxt(trim(CAST(x AS VARCHAR))), CAST(x AS VARCHAR));
CREATE OR REPLACE MACRO dv_sig15(x) AS
  CASE WHEN x IS NULL OR x = 0 OR isinf(x) OR isnan(x) THEN x
       ELSE round(x, 14 - CAST(floor(log10(abs(x))) AS INTEGER)) END;
CREATE OR REPLACE MACRO dv_booltxt(x) AS
  CASE
    WHEN x IS NULL THEN NULL
    WHEN lower(trim(CAST(x AS VARCHAR))) IN ('true','t','yes','y','1','1.0','on') THEN 'true'
    WHEN lower(trim(CAST(x AS VARCHAR))) IN ('false','f','no','n','0','0.0','off') THEN 'false'
    ELSE CAST(x AS VARCHAR)
  END;
"""


def family(dtype: str) -> str:
    t = (dtype or "").upper().strip()
    if t in ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT",
             "UINTEGER", "UBIGINT", "UHUGEINT", "INT1", "INT2", "INT4", "INT8", "INT", "VARINT", "BIGNUM"):
        return "int"
    if t.startswith("DECIMAL") or t.startswith("NUMERIC"):
        return "decimal"
    if t in ("DOUBLE", "FLOAT", "REAL", "FLOAT4", "FLOAT8"):
        return "float"
    if t == "BOOLEAN":
        return "bool"
    if t == "DATE":
        return "date"
    if t in ("TIMESTAMP WITH TIME ZONE", "TIMESTAMPTZ"):
        return "timestamptz"
    if t.startswith("TIMESTAMP"):
        return "timestamp"
    if t in ("TIME", "TIME WITH TIME ZONE", "TIMETZ"):
        return "time"
    if t in ("VARCHAR", "TEXT", "STRING", "CHAR", "BPCHAR", "JSON") or t.startswith("VARCHAR") or t.startswith("ENUM"):
        return "string"
    if t == "UUID":
        return "uuid"
    if t in ("BLOB", "BYTEA", "VARBINARY"):
        return "blob"
    return "other"


def decimal_scale(dtype: str) -> int:
    m = re.match(r"(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)", (dtype or "").upper())
    return int(m.group(2)) if m else 0


def qi(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


@dataclass
class PairPlan:
    s_expr: str
    t_expr: str
    compare_as: str
    numeric: bool = False
    # relative tolerance (doubles agree to ~15 significant digits)
    rel_tol: float = 0.0


def _string_rules(e: str, n: Normalize) -> str:
    if n.ltrim and n.rtrim:
        e = f"trim({e})"
    elif n.rtrim:
        e = f"rtrim({e})"
    elif n.ltrim:
        e = f"ltrim({e})"
    if n.case_insensitive:
        e = f"lower({e})"
    if n.null_equals_blank:
        e = f"CASE WHEN trim({e}) = '' THEN NULL ELSE {e} END"
    elif n.null_equals_empty:
        e = f"NULLIF({e}, '')"
    return e


def _ts(e: str, fam: str, n: Normalize) -> str:
    if fam == "timestamptz":
        e = f"timezone('UTC', {e})"
    else:
        e = f"CAST({e} AS TIMESTAMP)"
    prec = {"ms": "millisecond", "s": "second", "min": "minute", "day": "day"}.get(n.timestamp_precision)
    if prec:
        e = f"date_trunc('{prec}', {e})"
    return e


def _ts_text(e: str) -> str:
    return f"strftime({e}, '%Y-%m-%d %H:%M:%S.%f')"


# Numbers as canonical text: the value at 10 decimals, trailing zeros
# dropped ('012.50' and 12.5 both give '12.5'). dv_dectxt parses through
# DECIMAL(18,10) first, which is up to 30x faster in DuckDB than
# DECIMAL(38,10), and only falls back to the wide type for values with more
# than 8 digits before the point; both give the same text.
def _num_text(e: str, fam: str) -> str:
    if fam == "int":
        return f"CAST({e} AS VARCHAR)"
    return f"COALESCE(dv_dectxt({e}), CAST({e} AS VARCHAR))"


def _side_text(e: str, fam: str, target: str, n: Normalize) -> str:
    """Express one side as canonical text of kind ``target``."""
    if target == "number":
        if fam in NUMERIC:
            return _num_text(e, fam)
        if fam == "bool":
            return f"CASE WHEN {e} THEN '1' WHEN NOT {e} THEN '0' END"
        return f"dv_str2num({_string_rules(e, n) if fam == 'string' else e})"
    if target == "timestamp":
        if fam in TEMPORAL:
            return _ts_text(_ts(e, fam, n))
        src = _string_rules(e, n) if fam == "string" else f"CAST({e} AS VARCHAR)"
        parsed = _ts(f"TRY_CAST(trim({src}) AS TIMESTAMP)", "timestamp", n)
        return f"COALESCE({_ts_text(parsed)}, {src})"
    if target == "bool":
        if fam == "bool":
            return f"CASE WHEN {e} THEN 'true' WHEN NOT {e} THEN 'false' END"
        if fam in NUMERIC:
            return f"dv_booltxt({_num_text(e, fam)})"
        return f"dv_booltxt({_string_rules(e, n) if fam == 'string' else e})"
    src = f"CAST({e} AS VARCHAR)"
    return _string_rules(src, n) if fam == "string" else src


def plan_pair(s_col: str, s_type: str, t_col: str, t_type: str, n: Normalize,
              s_alias: str = "", t_alias: str = "", for_key: bool = False) -> PairPlan:
    fs, ft = family(s_type), family(t_type)
    S = (s_alias + "." if s_alias else "") + qi(s_col)
    T = (t_alias + "." if t_alias else "") + qi(t_col)

    # numbers
    if fs in NUMERIC and ft in NUMERIC:
        if fs == "float" or ft == "float":
            if not n.numbers and fs == ft == "float" and s_type.upper() == t_type.upper():
                return PairPlan(S, T, s_type.upper(), numeric=True)
            f32 = {s_type.upper(), t_type.upper()} & {"FLOAT", "REAL", "FLOAT4"}
            if f32:
                return PairPlan(f"CAST({S} AS FLOAT)", f"CAST({T} AS FLOAT)", "FLOAT", numeric=True)
            if n.numbers:
                # doubles agree to 15 significant digits across systems
                # (Excel, text exports, other databases)
                if for_key:
                    return PairPlan(f"dv_sig15(CAST({S} AS DOUBLE))", f"dv_sig15(CAST({T} AS DOUBLE))",
                                    "DOUBLE (15 digits)", numeric=True)
                return PairPlan(f"CAST({S} AS DOUBLE)", f"CAST({T} AS DOUBLE)", "DOUBLE (15 digits)",
                                numeric=True, rel_tol=1e-14)
            return PairPlan(f"CAST({S} AS DOUBLE)", f"CAST({T} AS DOUBLE)", "DOUBLE", numeric=True)
        if fs == ft == "int":
            if s_type.upper() == t_type.upper():
                return PairPlan(S, T, s_type.upper(), numeric=True)
            return PairPlan(f"CAST({S} AS HUGEINT)", f"CAST({T} AS HUGEINT)", "HUGEINT", numeric=True)
        if not n.numbers and s_type.upper() != t_type.upper():
            return PairPlan(f"CAST({S} AS VARCHAR)", f"CAST({T} AS VARCHAR)", "VARCHAR (strict)")
        scale = max(decimal_scale(s_type), decimal_scale(t_type))
        typ = f"DECIMAL(38,{min(scale, 37)})"
        return PairPlan(f"CAST({S} AS {typ})", f"CAST({T} AS {typ})", typ, numeric=True)

    # same non-string family
    if fs == ft and fs in ("bool", "blob", "uuid", "time"):
        if s_type.upper() == t_type.upper():
            return PairPlan(S, T, s_type.upper())
        return PairPlan(f"CAST({S} AS VARCHAR)", f"CAST({T} AS VARCHAR)", "VARCHAR")

    # date / time
    if fs in TEMPORAL and ft in TEMPORAL:
        if fs == ft == "date":
            return PairPlan(S, T, "DATE")
        if n.timestamps or fs == ft:
            return PairPlan(_ts(S, fs, n), _ts(T, ft, n), "TIMESTAMP")
        return PairPlan(f"CAST({S} AS VARCHAR)", f"CAST({T} AS VARCHAR)", "VARCHAR (strict)")

    # strings
    if fs == "string" and ft == "string":
        return PairPlan(_string_rules(S, n), _string_rules(T, n), "VARCHAR")

    # mixed families → canonical text
    fams = {fs, ft}
    if "bool" in fams and n.booleans and (fams - {"bool"}) <= (NUMERIC | {"string"}):
        target = "bool"
    elif fams & NUMERIC and fams <= (NUMERIC | {"string"}) and n.numbers:
        target = "number"
    elif fams & TEMPORAL and fams <= (TEMPORAL | {"string"}) and n.timestamps:
        target = "timestamp"
    else:
        target = "text"
    label = {"bool": "boolean text", "number": "number text", "timestamp": "timestamp text", "text": "VARCHAR"}[target]
    return PairPlan(_side_text(S, fs, target, n), _side_text(T, ft, target, n), label)


def distinct_expr(a: str, b: str, plan: PairPlan, n: Normalize) -> str:
    near = []
    if plan.numeric and n.numeric_tolerance > 0:
        near.append(f"abs(CAST({a} AS DOUBLE) - CAST({b} AS DOUBLE)) <= {float(n.numeric_tolerance)!r}")
    if plan.rel_tol:
        near.append(f"abs({a} - {b}) <= {plan.rel_tol!r} * greatest(abs({a}), abs({b}))")
    if near:
        return f"(({a}) IS DISTINCT FROM ({b}) AND NOT coalesce({' OR '.join(near)}, false))"
    return f"(({a}) IS DISTINCT FROM ({b}))"
