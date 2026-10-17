"""Granular value-normalization options shared by every compare engine.

Background
----------
Comparisons hash each row and diff the hashes. Before hashing, values can be
*normalized* so that logically-equal values that merely *look* different
(e.g. Oracle ``NUMBER`` ``12.50`` vs Snowflake ``12.5``, or a ``DATE``
rendered ``15-MAY-90`` vs ``1990-05-15``) don't show up as false
differences.

The trap: blanket normalization (the old single ``canonicalize_hash``
boolean) ALSO trimmed strings and could hide REAL data-quality defects -
trailing spaces, ``NULL`` vs ``''`` vs ``'   '``. For a data *validator*
that's exactly backwards: those are the differences you want surfaced.

So normalization is split into two classes of toggle:

* **Representation** (``numbers`` / ``timestamps`` / ``booleans``) - pure
  cross-DB rendering artifacts that are never themselves a data issue.
  Default **ON** when normalization is enabled.
* **String handling** (``rtrim`` / ``ltrim`` / ``case_insensitive`` /
  ``null_equals_empty`` / ``null_equals_blank``) - each can mask a real
  difference, so every one is **opt-in** (default **OFF**).

Each engine (pandas / polars / duckdb / spark / trino / standard) reads the
SAME :class:`NormalizeOptions` and applies the flags in its own substrate
(pandas Series ops, Polars expressions, or per-dialect SQL).
"""
from __future__ import annotations

from dataclasses import dataclass

# Sentinel emitted for a SQL NULL when it is NOT being coalesced to
# empty/blank. Kept identical across every engine so hashes line up.
NULL_SENTINEL = "<<NULL>>"


def serialize_value(value) -> str:
    """Encode one already-canonical value for unambiguous row/key hashing.

    The pipe separator is escaped so values cannot impersonate field
    boundaries; percent and angle brackets are escaped as well so a literal
    ``NULL_SENTINEL`` cannot collide with a SQL NULL. Escape percent first so
    the escape sequences themselves remain unambiguous. Ordinary values and
    NULLs retain their historical spelling unless they contain reserved text.
    """
    if value is None or type(value).__name__ in ("NAType", "NaTType"):
        return NULL_SENTINEL
    try:
        if value != value:
            return NULL_SENTINEL
    except Exception:
        pass
    text = str(value)
    return (text.replace("%", "%25")
                .replace("|", "%7C")
                .replace("<", "%3C")
                .replace(">", "%3E"))


def serialize_row(values) -> str:
    """Serialize values with the shared, NULL-safe field-boundary encoding."""
    return "||".join(serialize_value(value) for value in values)


@dataclass(frozen=True)
class NormalizeOptions:
    """Resolved, engine-agnostic normalization configuration."""

    enabled: bool = False
    # --- representation (default ON when enabled) ---
    numbers: bool = True
    timestamps: bool = True
    booleans: bool = True
    # --- string handling (default OFF - each can hide a real diff) ---
    rtrim: bool = False
    ltrim: bool = False
    case_insensitive: bool = False
    null_equals_empty: bool = False
    null_equals_blank: bool = False

    @property
    def trims(self) -> bool:
        """True if any whitespace trimming is requested."""
        return self.rtrim or self.ltrim

    @property
    def coalesces_null(self) -> bool:
        """True if NULL is to be treated as equal to empty/blank."""
        return self.null_equals_empty or self.null_equals_blank

    @classmethod
    def disabled(cls) -> "NormalizeOptions":
        return cls(enabled=False)

    @classmethod
    def from_request(
        cls,
        normalize: dict | None,
        canonicalize_hash: bool = False,
    ) -> "NormalizeOptions":
        """Resolve the effective options from a request.

        Precedence:
          1. An explicit ``normalize`` object (the new UI) wins.
          2. Else legacy ``canonicalize_hash=True`` maps to the OLD blanket
             behavior (representation ON **and** trim ON) so existing saved
             templates / API callers keep their semantics.
          3. Else disabled (raw cast - same logical value must be byte-equal).
        """
        if normalize is not None:
            g = normalize.get
            return cls(
                enabled=bool(g("enabled", True)),
                numbers=bool(g("numbers", True)),
                timestamps=bool(g("timestamps", True)),
                booleans=bool(g("booleans", True)),
                rtrim=bool(g("rtrim", False)),
                ltrim=bool(g("ltrim", False)),
                case_insensitive=bool(g("case_insensitive", False)),
                null_equals_empty=bool(g("null_equals_empty", False)),
                null_equals_blank=bool(g("null_equals_blank", False)),
            )
        if canonicalize_hash:
            return cls(
                enabled=True,
                numbers=True, timestamps=True, booleans=True,
                ltrim=True, rtrim=True,
            )
        return cls(enabled=False)

    def describe(self) -> str:
        """Short human-readable summary for engine logs."""
        if not self.enabled:
            return "off (raw cast)"
        parts = []
        if self.numbers:
            parts.append("numbers")
        if self.timestamps:
            parts.append("timestamps")
        if self.booleans:
            parts.append("booleans")
        if self.ltrim:
            parts.append("ltrim")
        if self.rtrim:
            parts.append("rtrim")
        if self.case_insensitive:
            parts.append("case-insensitive")
        if self.null_equals_empty:
            parts.append("null=empty")
        if self.null_equals_blank:
            parts.append("null=blank")
        return ", ".join(parts) if parts else "enabled (no transforms)"
