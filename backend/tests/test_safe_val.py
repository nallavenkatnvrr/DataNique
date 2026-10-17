"""Result values must reach the browser exactly (no float rounding, valid JSON)."""
import decimal
import json
from datetime import date, datetime

from app.services.query_session import _safe_val


def test_decimal_keeps_scale_and_precision():
    assert _safe_val(decimal.Decimal("47606.70")) == "47606.70"
    assert _safe_val(decimal.Decimal("12345678901234567890.123456789")) == "12345678901234567890.123456789"
    assert _safe_val(decimal.Decimal("13")) == 13
    assert _safe_val(decimal.Decimal("1E+2")) == 100
    assert _safe_val(decimal.Decimal("NaN")) == "NaN"


def test_big_ints_become_strings():
    assert _safe_val(2**53 - 1) == 2**53 - 1
    assert _safe_val(2**63 - 1) == str(2**63 - 1)
    assert _safe_val(True) is True


def test_non_finite_floats_are_valid_json():
    out = [_safe_val(float("nan")), _safe_val(float("inf")), _safe_val(1.5)]
    json.dumps(out, allow_nan=False)
    assert out[2] == 1.5


def test_json_binary_and_temporal():
    assert json.loads(_safe_val({"a": [1, 2], "b": None})) == {"a": [1, 2], "b": None}
    assert _safe_val(b"\x01\xff") == "0x01ff"
    assert _safe_val(memoryview(b"\x00" * 100)).endswith("(100 bytes)")
    assert _safe_val(datetime(2026, 10, 16, 8, 30, 1)) == "2026-10-16 08:30:01"
    assert _safe_val(date(2026, 10, 16)) == "2026-10-16"
