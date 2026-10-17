"""Timezone-aware time helpers.

``datetime.utcnow()`` is deprecated as of Python 3.12 because it returns a
*naive* datetime that merely happens to hold UTC wall-clock time - a footgun
that silently breaks the moment anyone compares it against an aware value.

These helpers are the single blessed replacement used across the backend:

* :func:`utcnow`        - aware UTC ``datetime`` (use for new code / logic).
* :func:`utcnow_naive`  - *naive* UTC ``datetime``, byte-for-byte the same
  value the old ``datetime.utcnow()`` produced. Used where downstream code
  or DB columns already assume naive UTC, so the migration is a pure drop-in
  with zero behavioral change.
* :func:`now_iso`       - ISO-8601 UTC string with a trailing ``Z`` and
  millisecond precision (the exact shape the frontend log console parses).
"""
from __future__ import annotations

from datetime import datetime, timezone


def utcnow() -> datetime:
    """Timezone-aware current UTC time."""
    return datetime.now(timezone.utc)


def utcnow_naive() -> datetime:
    """Naive UTC time - identical value to the deprecated ``datetime.utcnow()``.

    Kept for the DB columns and the ISO helpers below, which historically
    stored/emitted naive UTC and append their own ``Z``. Using an aware value
    there would emit ``+00:00Z`` (invalid) or store mixed aware/naive rows.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def now_iso() -> str:
    """ISO-8601 UTC timestamp, millisecond precision, trailing ``Z``."""
    return utcnow_naive().isoformat(timespec="milliseconds") + "Z"
