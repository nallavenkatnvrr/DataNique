"""Unit tests for app.config.Settings."""
from __future__ import annotations

from app.config import settings, Settings


def test_cors_origins_parsed_to_list():
    s = Settings(cors_origins="http://a.com, http://b.com ,http://c.com")
    origins = s.get_cors_origins()
    assert origins == ["http://a.com", "http://b.com", "http://c.com"]


def test_cors_origins_ignores_blanks():
    s = Settings(cors_origins="http://a.com,,  ,http://b.com")
    assert s.get_cors_origins() == ["http://a.com", "http://b.com"]


def test_sqlite_url_defaulted_on_import():
    assert settings.sqlite_url.startswith("sqlite:///")


def test_data_dir_created():
    assert settings.data_dir.exists()


def test_sane_defaults():
    assert settings.app_name == "Datanique"
    assert settings.default_row_diff_limit > 0
    assert settings.hash_algo in ("md5", "xxh3", "xxh64")


def test_security_defaults_are_safe():
    # Loopback-only bind and no tokens/keys by default (opt-in security).
    assert settings.bind_host == "127.0.0.1"
    assert settings.api_token == ""
    assert settings.admin_token == ""
    assert settings.encryption_key == ""


def test_network_bind_requires_api_token():
    import pytest

    with pytest.raises(ValueError, match="DV_API_TOKEN is required"):
        Settings(bind_host="0.0.0.0")
    assert Settings(bind_host="0.0.0.0", api_token="secret").bind_host == "0.0.0.0"


# ------------------------------------------------------- legacy key (migration only)

def test_legacy_fernet_values_still_decrypt_from_env_key(monkeypatch):
    """Passwords saved by earlier versions stay readable until the vault
    re-encrypts them."""
    from cryptography.fernet import Fernet
    import app.security.crypto as crypto

    key = Fernet.generate_key().decode("utf-8")
    monkeypatch.setattr(crypto.settings, "encryption_key", key, raising=False)
    token = Fernet(key.encode()).encrypt(b"hunter2").decode()
    assert crypto.decrypt(token) == "hunter2"


def test_legacy_value_without_key_explains_itself(monkeypatch, tmp_path):
    import pytest
    import app.security.crypto as crypto

    monkeypatch.setattr(crypto.settings, "encryption_key", "", raising=False)
    monkeypatch.setattr(crypto.settings, "secret_key_file", str(tmp_path / "missing"), raising=False)
    with pytest.raises(ValueError, match="re-enter"):
        crypto.decrypt("gAAAAABlegacy")
