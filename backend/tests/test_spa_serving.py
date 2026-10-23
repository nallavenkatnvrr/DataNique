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
    assert "root:" not in c.get("/runs/assets/../../../../etc/passwd").text
    assert c.get("/api/nothing").status_code == 404


def test_cache_headers_and_missing_files(tmp_path):
    """index.html is revalidated every time (so an update is picked up), hashed
    files are cached for good, and a file an old version asks for is a 404."""
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<div id="root"></div>')
    (tmp_path / "assets" / "Page-abc123.js").write_text("export const x = 1")
    app = FastAPI()
    _mount_spa(app, str(tmp_path))
    c = TestClient(app)

    assert c.get("/").headers["cache-control"] == "no-cache"
    assert c.get("/history").headers["cache-control"] == "no-cache"
    assert "immutable" in c.get("/assets/Page-abc123.js").headers["cache-control"]
    old = c.get("/assets/Page-OLD999.js")
    assert old.status_code == 404 and "javascript" not in old.headers.get("content-type", "")
    assert c.get("/runs/assets/Page-OLD999.js").status_code == 404
