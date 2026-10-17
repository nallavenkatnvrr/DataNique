"""Dialect-aware SQL statement splitter (Python port of frontend/src/lib/sqlSplit.ts).

Both implementations follow the same rules and share test cases
(``frontend/src/lib/sqlSplit.test.ts`` / ``backend/tests/test_sql_split.py``):

* strings ``'...'`` with ``''`` escapes; backslash escapes for MySQL and
  Snowflake, and for Postgres ``E'...'`` strings; Oracle ``q'[...]'`` quotes
* quoted identifiers ``"..."``, ```...``` (MySQL), ``[...]`` (SQL Server)
* comments ``--`` and ``/* */``; ``#`` (MySQL); ``//`` (Snowflake); nested
  block comments (Postgres)
* dollar quoting ``$$...$$`` / ``$tag$...$tag$`` (Postgres, Snowflake)
* BEGIN/CASE ... END depth (semicolons inside a block do not split), Oracle
  PL/SQL units terminated by a ``/`` line, SQL Server modules and the ``GO``
  batch separator, MySQL ``DELIMITER`` commands

The SQL IDE frontend normally sends pre-split statements; this splitter is
used when a client submits a raw script.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class SqlStatement:
    text: str
    start: int  # offset of the first character of ``text`` in the input
    end: int    # offset just past the last character of ``text``


_NOT_A_BLOCK_AFTER_BEGIN = {"TRAN", "TRANSACTION", "WORK", "DISTRIBUTED", "NAME", "ISOLATION", "READ"}
_END_KEEPS_DEPTH = {"IF", "LOOP", "WHILE", "REPEAT", "FOR"}
_GO_RE = re.compile(r"^GO(\s+\d+)?\s*$", re.IGNORECASE)
_SLASH_RE = re.compile(r"^/\s*$")
_DELIMITER_RE = re.compile(r"^DELIMITER\s+(\S+)\s*$", re.IGNORECASE)
_DOLLAR_RE = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_PAIRS = {"[": "]", "(": ")", "{": "}", "<": ">"}


def normalize_dialect(db_type: str | None) -> str:
    d = (db_type or "").lower()
    if d in ("snowflake", "oracle", "sqlserver", "mysql"):
        return d
    if d in ("postgres", "postgresql"):
        return "postgres"
    if d == "mariadb":
        return "mysql"
    return "generic"


def _ident_start(c: str) -> bool:
    return ("A" <= c <= "Z") or ("a" <= c <= "z") or c == "_"


def _ident_part(c: str) -> bool:
    return _ident_start(c) or ("0" <= c <= "9") or c in "$#"


def _classify(words: list[str], dialect: str) -> tuple[bool, bool]:
    w = words[:6] + [""] * 6
    plsql = False
    tsql_module = False
    if dialect == "oracle":
        if w[0] in ("DECLARE", "BEGIN"):
            plsql = True
        if w[0] == "CREATE":
            i = 1
            if w[i] == "OR" and w[i + 1] == "REPLACE":
                i += 2
            if w[i] in ("EDITIONABLE", "NONEDITIONABLE"):
                i += 1
            if w[i] in ("PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "LIBRARY"):
                plsql = True
    if dialect == "sqlserver" and w[0] in ("CREATE", "ALTER"):
        i = 1
        if w[0] == "CREATE" and w[i] == "OR" and w[i + 1] == "ALTER":
            i += 2
        if w[i] in ("PROC", "PROCEDURE", "FUNCTION", "TRIGGER", "VIEW"):
            tsql_module = True
    return plsql, tsql_module


def split_statements(sql: str, db_type: str | None = None) -> list[SqlStatement]:
    """Split ``sql`` into executable statements with their offsets."""
    dialect = normalize_dialect(db_type)
    n = len(sql)
    out: list[SqlStatement] = []

    backslash_in_single = dialect in ("mysql", "snowflake")
    dollar_quotes = dialect in ("postgres", "snowflake", "generic")
    hash_comments = dialect == "mysql"
    slash_comments = dialect == "snowflake"
    bracket_idents = dialect in ("sqlserver", "generic")
    backtick_idents = dialect in ("mysql", "generic")
    nested_comments = dialect == "postgres"
    q_quotes = dialect in ("oracle", "generic")
    count_begin = dialect != "postgres"
    go_separator = dialect == "sqlserver"
    slash_terminator = dialect == "oracle"
    delimiter_command = dialect == "mysql"

    st = {
        "delimiter": ";",
        "start": 0,
        "has_code": False,
        "words": [],
        "plsql": False,
        "tsql": False,
        "depth": 0,
    }

    def reset(nxt: int) -> None:
        st.update(start=nxt, has_code=False, words=[], plsql=False, tsql=False, depth=0)

    def emit(end: int) -> None:
        if not st["has_code"]:
            return
        a, b = st["start"], end
        while a < b and sql[a].isspace():
            a += 1
        while b > a and sql[b - 1].isspace():
            b -= 1
        if b > a:
            out.append(SqlStatement(sql[a:b], a, b))

    def at_line_start(pos: int) -> bool:
        p = pos - 1
        while p >= 0 and sql[p] in " \t":
            p -= 1
        return p < 0 or sql[p] == "\n"

    def line_end(pos: int) -> int:
        e = sql.find("\n", pos)
        return n if e < 0 else e

    def peek_word(pos: int) -> str:
        p = pos
        while p < n and sql[p].isspace():
            p += 1
        if p < n and _ident_start(sql[p]):
            e = p + 1
            while e < n and _ident_part(sql[e]):
                e += 1
            return sql[p:e].upper()
        return sql[p] if p < n else ""

    i = 0
    while i < n:
        c = sql[i]
        c2 = sql[i + 1] if i + 1 < n else ""

        # whole-line commands
        if c in "GgDd/" and at_line_start(i):
            le = line_end(i)
            line = sql[i:le].rstrip("\r")
            if go_separator and _GO_RE.match(line):
                emit(i)
                reset(le)
                i = le
                continue
            if slash_terminator and _SLASH_RE.match(line):
                emit(i)
                reset(le)
                i = le
                continue
            if delimiter_command and not st["has_code"]:
                m = _DELIMITER_RE.match(line)
                if m:
                    st["delimiter"] = m.group(1) or ";"
                    reset(le)
                    i = le
                    continue

        # comments
        if (c == "-" and c2 == "-") or (hash_comments and c == "#") or (slash_comments and c == "/" and c2 == "/"):
            while i < n and sql[i] != "\n":
                i += 1
            continue
        if c == "/" and c2 == "*":
            depth = 1
            i += 2
            while i < n and depth > 0:
                if nested_comments and sql.startswith("/*", i):
                    depth += 1
                    i += 2
                elif sql.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            continue

        # custom delimiter
        if st["delimiter"] != ";" and sql.startswith(st["delimiter"], i):
            emit(i)
            i += len(st["delimiter"])
            reset(i)
            continue

        # strings / quoted identifiers
        if q_quotes and c in "qQ" and c2 == "'" and i + 2 < n and not (i > 0 and _ident_part(sql[i - 1])):
            close = _PAIRS.get(sql[i + 2], sql[i + 2]) + "'"
            end = sql.find(close, i + 3)
            st["has_code"] = True
            i = n if end < 0 else end + 2
            continue
        if c == "'":
            e_string = (
                dialect == "postgres" and i > 0 and sql[i - 1] in "Ee"
                and not (i > 1 and _ident_part(sql[i - 2]))
            )
            allow_backslash = backslash_in_single or e_string
            i += 1
            while i < n:
                ch = sql[i]
                if allow_backslash and ch == "\\":
                    i += 2
                    continue
                if ch == "'":
                    if i + 1 < n and sql[i + 1] == "'":
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            st["has_code"] = True
            continue
        if c == '"' or (backtick_idents and c == "`") or (bracket_idents and c == "["):
            close = "]" if c == "[" else c
            i += 1
            while i < n:
                if sql[i] == close:
                    if i + 1 < n and sql[i + 1] == close:
                        i += 2
                        continue
                    i += 1
                    break
                i += 1
            st["has_code"] = True
            continue
        if dollar_quotes and c == "$" and not (i > 0 and _ident_part(sql[i - 1])):
            m = _DOLLAR_RE.match(sql, i)
            if m:
                tag = m.group(0)
                end = sql.find(tag, i + len(tag))
                st["has_code"] = True
                i = n if end < 0 else end + len(tag)
                continue

        # words
        if _ident_start(c) and not (i > 0 and _ident_part(sql[i - 1])):
            e = i + 1
            while e < n and _ident_part(sql[e]):
                e += 1
            word = sql[i:e].upper()
            st["has_code"] = True
            if len(st["words"]) < 6:
                st["words"].append(word)
                st["plsql"], st["tsql"] = _classify(st["words"], dialect)
            if word == "CASE":
                st["depth"] += 1
            elif word == "BEGIN":
                nxt = peek_word(e)
                if (count_begin and nxt not in (";", "") and nxt not in _NOT_A_BLOCK_AFTER_BEGIN) or (
                    dialect == "postgres" and nxt == "ATOMIC"
                ):
                    st["depth"] += 1
            elif word == "END":
                if peek_word(e) not in _END_KEEPS_DEPTH and st["depth"] > 0:
                    st["depth"] -= 1
            i = e
            continue

        if c == ";" and st["delimiter"] == ";" and not st["plsql"] and not st["tsql"] and st["depth"] == 0:
            emit(i)
            reset(i + 1)
            i += 1
            continue

        if not c.isspace():
            st["has_code"] = True
        i += 1

    emit(n)
    return out


def split_sql_statements(sql: str, db_type: str | None = None) -> list[str]:
    """Convenience wrapper returning statement texts only."""
    return [s.text for s in split_statements(sql, db_type)]
