"""dv_dectxt (fast DECIMAL(18,10) parse with a DECIMAL(38,10) fallback) must
give exactly the text the plain DECIMAL(38,10) conversion gives."""
import duckdb

from app.engine import canon


def _con():
    con = duckdb.connect()
    for stmt in canon.MACROS.strip().split(";\n"):
        if stmt.strip():
            con.execute(stmt)
    return con


VALUES = ["12.5", "012.50", "-0.1", "100", "100.000", "1e3", "0.30000000000000004", "123456789012.5",
          "99999999.99999999999", "-12345678.123456789012", "1.5e-11", " 7 ", "abc", "", "-0",
          "9999999999999999999999999999", "12345678.9", "123456789.1"]


def test_same_text_as_wide_decimal():
    con = _con()
    for v in VALUES:
        fast, slow = con.execute(
            "SELECT dv_str2num(?), COALESCE(dv_numtxt(TRY_CAST(trim(?) AS DECIMAL(38,10))), ?)", [v, v, v]
        ).fetchone()
        assert fast == slow, (v, fast, slow)


def test_double_and_text_agree():
    con = _con()
    expr = canon._num_text("x", "float")
    rows = con.execute(f"SELECT {expr} FROM (SELECT unnest([12.5, 0.1 + 0.2, -3.0, 1e10, 123456789.25]::DOUBLE[]) AS x)").fetchall()
    assert [r[0] for r in rows] == ["12.5", "0.3", "-3", "10000000000", "123456789.25"]
    assert con.execute("SELECT dv_str2num('012.50'), dv_str2num('  -3.000 ')").fetchone() == ("12.5", "-3")
