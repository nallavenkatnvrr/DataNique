"""Unit tests for app.services.normalize.NormalizeOptions."""
from __future__ import annotations

import hashlib

import pytest

from app.services.normalize import NormalizeOptions, NULL_SENTINEL, serialize_row, serialize_value


def test_disabled_default():
    opts = NormalizeOptions.disabled()
    assert opts.enabled is False
    assert opts.describe() == "off (raw cast)"


def test_from_request_none_is_disabled():
    opts = NormalizeOptions.from_request(None)
    assert opts.enabled is False


def test_legacy_canonicalize_hash_maps_to_blanket():
    """Legacy canonicalize_hash=True => representation ON and trims ON."""
    opts = NormalizeOptions.from_request(None, canonicalize_hash=True)
    assert opts.enabled is True
    assert opts.numbers and opts.timestamps and opts.booleans
    assert opts.ltrim and opts.rtrim
    assert opts.trims is True


def test_explicit_normalize_object_wins_over_legacy():
    opts = NormalizeOptions.from_request({"enabled": True, "rtrim": True}, canonicalize_hash=True)
    assert opts.enabled is True
    assert opts.rtrim is True
    # ltrim not requested -> stays default off despite legacy flag
    assert opts.ltrim is False


def test_representation_defaults_on_when_enabled():
    opts = NormalizeOptions.from_request({"enabled": True})
    assert opts.numbers is True
    assert opts.timestamps is True
    assert opts.booleans is True
    # string handling stays opt-out
    assert opts.rtrim is False
    assert opts.ltrim is False
    assert opts.case_insensitive is False


def test_string_flags_are_opt_in():
    opts = NormalizeOptions.from_request({
        "enabled": True,
        "rtrim": True,
        "case_insensitive": True,
        "null_equals_empty": True,
    })
    assert opts.rtrim is True
    assert opts.case_insensitive is True
    assert opts.null_equals_empty is True
    assert opts.coalesces_null is True


def test_trims_property():
    assert NormalizeOptions(enabled=True, ltrim=True).trims is True
    assert NormalizeOptions(enabled=True, rtrim=True).trims is True
    assert NormalizeOptions(enabled=True).trims is False


def test_coalesces_null_property():
    assert NormalizeOptions(enabled=True, null_equals_empty=True).coalesces_null is True
    assert NormalizeOptions(enabled=True, null_equals_blank=True).coalesces_null is True
    assert NormalizeOptions(enabled=True).coalesces_null is False


def test_describe_lists_active_transforms():
    opts = NormalizeOptions(enabled=True, numbers=True, timestamps=False,
                            booleans=False, rtrim=True, case_insensitive=True)
    desc = opts.describe()
    assert "numbers" in desc
    assert "timestamps" not in desc
    assert "rtrim" in desc
    assert "case-insensitive" in desc


def test_describe_enabled_no_transforms():
    opts = NormalizeOptions(enabled=True, numbers=False, timestamps=False, booleans=False)
    assert opts.describe() == "enabled (no transforms)"


def test_options_are_frozen():
    opts = NormalizeOptions(enabled=True)
    try:
        opts.enabled = False  # type: ignore[misc]
        raised = False
    except Exception:
        raised = True
    assert raised, "NormalizeOptions should be immutable (frozen dataclass)"


def test_null_sentinel_stable():
    # The sentinel must be identical across engines for hashes to line up.
    assert NULL_SENTINEL == "<<NULL>>"


def test_row_serialization_disambiguates_separators_and_null_sentinel():
    assert serialize_row(("a||b", "c")) != serialize_row(("a", "b||c"))
    assert serialize_row((None, "x")) != serialize_row((NULL_SENTINEL, "x"))
    assert serialize_value("%7C") != serialize_value("|")
