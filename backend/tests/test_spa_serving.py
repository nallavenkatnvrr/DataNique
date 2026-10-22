"""The backend serves the built UI; a reload on a nested page must still get
the real script files (the build references them relatively)."""
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import _mount_spa


def test_nested_page_reload_gets_assets(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<div id="root"></div><script src="./assets/app.js"></script>')
    (tmp_path / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "logo.svg").write_text("<svg/>")
    app = FastAPI()
    _mount_spa(app, str(tmp_path))
    c = TestClient(app)

    assert c.get("/runs/abc").text.startswith('<div id="root">')          # deep link -> the app
    r = c.get("/runs/assets/app.js")                                       # relative asset after reload
    assert r.status_code == 200 and "javascript" in r.headers["content-type"] and "console.log" in r.text
    assert c.get("/jobs/x/assets/app.js").text == "console.log(1)"
    assert c.get("/runs/logo.svg").text == "<svg/>"
    assert c.get("/runs/assets/../../etc/passwd").text.startswith('<div id="root">')
    assert c.get("/api/nothing").status_code == 404
