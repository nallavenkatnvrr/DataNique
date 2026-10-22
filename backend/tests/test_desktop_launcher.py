"""The desktop launcher (desktop_py/datanique_launcher.py): where each user's
data goes, one instance per data folder, and a stable port per folder."""
import importlib.util
import json
import socket
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[2] / "desktop_py" / "datanique_launcher.py"


@pytest.fixture(scope="module")
def L():
    spec = importlib.util.spec_from_file_location("datanique_launcher_under_test", _SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_data_dir_priority(L, tmp_path):
    env = {"APPDATA": str(tmp_path / "roaming")}
    base = tmp_path / "app"
    base.mkdir()

    d, how = L.resolve_data_dir(environ=env, base_dir=base, user="alice")
    assert (d, how) == (tmp_path / "roaming" / "Datanique" / "backend-data", "AppData")

    (base / "portable").touch()
    d, how = L.resolve_data_dir(environ=env, base_dir=base, user="alice")
    assert (d, how) == (base / "data" / "alice", "portable")
    d, _ = L.resolve_data_dir(environ=env, base_dir=base, user="bob")
    assert d == base / "data" / "bob"  # every account has its own folder

    env["DV_DATA_DIR"] = str(tmp_path / "env-dir")
    d, how = L.resolve_data_dir(environ=env, base_dir=base, user="alice")
    assert (d, how) == ((tmp_path / "env-dir").resolve(), "DV_DATA_DIR")

    d, how = L.resolve_data_dir(str(tmp_path / "cli"), environ=env, base_dir=base, user="alice")
    assert (d, how) == ((tmp_path / "cli").resolve(), "command line")


def test_portable_falls_back_when_not_writable(L, tmp_path, monkeypatch):
    base = tmp_path / "share"
    base.mkdir()
    (base / "portable.txt").touch()
    monkeypatch.setattr(L, "_writable", lambda folder: False)
    d, how = L.resolve_data_dir(environ={"APPDATA": str(tmp_path / "r")}, base_dir=base, user="alice")
    assert d == tmp_path / "r" / "Datanique" / "backend-data"
    assert "not writable" in how


def test_user_name_is_safe_for_a_folder(L):
    assert L.safe_user_name("CORP\\jane.doe") == "CORP_jane.doe"
    assert L.safe_user_name('a:b*c?"d') == "a_b_c__d"
    assert L.safe_user_name("") == "user"
    assert L.safe_user_name(" .. ") == "user"


def test_stable_port_per_folder(L):
    a = L.stable_port(Path("C:/Users/alice/AppData/Roaming/Datanique/backend-data"))
    assert a == L.stable_port(Path("c:/users/ALICE/AppData/Roaming/Datanique/backend-data/"))
    b = L.stable_port(Path("C:/Users/bob/AppData/Roaming/Datanique/backend-data"))
    assert a != b
    assert 20000 <= a < 35000 and 20000 <= b < 35000


def test_port_candidates(L, tmp_path):
    assert L.port_candidates(tmp_path, environ={}) == [L.stable_port(tmp_path)]
    (tmp_path / "webview").mkdir()  # profile from a version that used the fixed port
    assert L.port_candidates(tmp_path, environ={})[0] == L.LEGACY_PORT
    (tmp_path / "desktop.json").write_text(json.dumps({"port": 23456}))
    assert L.port_candidates(tmp_path, environ={})[0] == 23456
    assert L.port_candidates(tmp_path, environ={"DV_DESKTOP_PORT": "24000"})[:2] == [24000, 23456]


def test_choose_port_keeps_the_first_port(L, tmp_path, monkeypatch):
    monkeypatch.delenv("DV_DESKTOP_PORT", raising=False)
    first = L.choose_port(tmp_path, wait=0)
    assert json.loads((tmp_path / "desktop.json").read_text())["port"] == first
    # busy (another program): this launch uses something else, the saved port stays
    with socket.socket() as s:
        s.bind(("127.0.0.1", first))
        s.listen()
        other = L.choose_port(tmp_path, wait=0)
    assert other != first
    assert json.loads((tmp_path / "desktop.json").read_text())["port"] == first
    assert L.choose_port(tmp_path, wait=0) == first


def test_one_instance_per_data_folder(L, tmp_path):
    a, b = L.InstanceLock(tmp_path), L.InstanceLock(tmp_path)
    assert a.acquire()
    assert not b.acquire()
    other = L.InstanceLock(tmp_path / "other-user")
    assert other.acquire()  # a different folder is independent
    a.release()
    assert b.acquire()
    b.release()
    other.release()
