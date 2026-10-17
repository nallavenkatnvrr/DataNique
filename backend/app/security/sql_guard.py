"""Defense-in-depth guard for user-supplied ``filter_sql`` predicates.

TRUST MODEL
-----------
``filter_sql`` (the per-side WHERE predicate on a table compare) is
**interpolated directly** into generated SQL - it is NOT parameterized,
because it's a free-form boolean expression the user writes against columns
we don't know ahead of time. It is therefore treated as **trusted input**:
anyone who can set it already holds the connection's DB credentials and can
run arbitrary SQL through the SQL IDE anyway. In a single-user / trusted
deployment this is by design.

This module does NOT try to make ``filter_sql`` safe against a hostile
author - that's impossible for a free-form predicate. What it DOES do is
catch the obvious "break out of the WHERE clause" shapes (stacked
statements, comment-outs) so that in a *shared* deployment a filter can't
trivially escalate into a second statement (``1=1; DROP TABLE ...``) or
truncate the rest of the generated query with a comment. It's a tripwire,
not a sandbox.
"""
from __future__ import annotations

import re

# Collapse the contents of single-quoted string literals to empty so that a
# legitimate value like ``name = 'a;b'`` or ``note = 'foo -- bar'`` is not
# flagged. Handles the standard '' escape inside a literal.
_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")


def _strip_string_literals(sql: str) -> str:
    return _STRING_LITERAL_RE.sub("''", sql)


def injection_reason(filter_sql: str | None) -> str | None:
    """Return a human-readable reason if ``filter_sql`` looks like it's trying
    to escape its WHERE-clause context, else ``None``.

    Checks (after neutralizing quoted string literals):
      * a ``;`` followed by more non-whitespace SQL - a stacked statement.
      * a SQL line comment ``--`` or block comment ``/*`` - used to truncate
        the remainder of the generated query.
    """
    if not filter_sql or not filter_sql.strip():
        return None

    stripped = _strip_string_literals(filter_sql)

    for m in re.finditer(r";", stripped):
        if stripped[m.end():].strip():
            return "contains ';' followed by additional SQL (stacked statement not allowed)"

    if "--" in stripped:
        return "contains a '--' line comment (not allowed in a filter predicate)"
    if "/*" in stripped or "*/" in stripped:
        return "contains a '/* */' block comment (not allowed in a filter predicate)"

    return None
