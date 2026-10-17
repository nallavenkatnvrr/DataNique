from __future__ import annotations

from pathlib import Path

from app.connectors.base import Connector
from app.sql_dialects.snowflake import SnowflakeDialect
from app.security.crypto import decrypt


_dialect = SnowflakeDialect()


class SnowflakeConnector(Connector):
    """Snowflake connector supporting multiple authentication methods.

    Authentication mode is selected via ``record.extra['authenticator']``:

    * ``snowflake`` (default)      - classic user/password
    * ``externalbrowser``          - SSO via the user's local browser (Okta, Azure AD, etc.)
    * ``oauth``                    - OAuth bearer token (token stored in the password field)
    * ``https://<okta>.okta.com/`` - native Okta endpoint URL (user + password)
    * ``snowflake_jwt``            - key-pair auth (private key file, optional passphrase)

    Notes
    -----
    * ``externalbrowser`` blocks the backend process until the browser flow completes;
      it is only suitable when the backend runs on the *same* machine as the user.
      For headless / server deployments use ``oauth`` or ``snowflake_jwt``.
    * SSO and MFA tokens are cached locally (``client_store_temporary_credential`` and
      ``client_request_mfa_token``) so the browser pops at most once per token lifetime
      rather than once per query. On Windows the tokens are stored in Credential
      Manager; on macOS in Keychain; on Linux in a file under ``~/.cache/snowflake/``.
    """

    db_type = "snowflake"

    @property
    def dialect(self):
        return _dialect

    def connect(self):
        import snowflake.connector  # type: ignore

        # Read connection-robustness settings
        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
            query_timeout_s = int(getattr(settings, "query_timeout", 0) or 0)
        except Exception:
            connect_timeout, query_timeout_s = 30, 0

        extra = self.record.extra or {}
        authenticator = (extra.get("authenticator") or "snowflake").strip()
        auth_lc = authenticator.lower()

        # The Snowflake driver auto-appends .snowflakecomputing.com to the
        # account identifier.  Strip it if the user pasted the full hostname
        # (e.g. "MYORG-MYACCOUNT.snowflakecomputing.com") to avoid a doubled
        # domain that causes "Failed to get the response. Hanging?" errors.
        raw_account = (extra.get("account") or self.record.host or "").strip()
        for suffix in (".snowflakecomputing.com", ".snowflakecomputing.com/"):
            if raw_account.lower().endswith(suffix):
                raw_account = raw_account[: -len(suffix)]
                break

        params: dict = {
            "account": raw_account,
            "user": self.record.username,
            "database": self.record.database,
            "schema": self.record.schema_name,
            "warehouse": extra.get("warehouse"),
            "role": extra.get("role"),
            # login_timeout covers TCP+TLS handshake + auth round-trip.
            # SSO/MFA round-trips can take a while - generous default,
            # but respect the env override if set lower.
            "login_timeout": int(extra.get("login_timeout") or connect_timeout or 120),
            # network_timeout aborts a single network operation that has
            # been hung longer than N seconds (e.g. server stops responding
            # mid-query). 0/unset = no timeout = can hang forever.
            "network_timeout": query_timeout_s if query_timeout_s > 0 else None,
            # Keep the session alive between queries so the engine can run
            # multiple compares on one login.
            "client_session_keep_alive": True,
            # How often the keep-alive heartbeat fires. Snowflake's default
            # is 14400s (4 hours), too long for corporate networks that
            # silently drop idle sessions after 5-10 min. 900s = 15 min
            # ensures heartbeats happen well within any firewall idle
            # timeout window.
            "client_session_keep_alive_heartbeat_frequency": 900,
            # Cache the SSO/MFA token in the OS credential store so the user
            # doesn't get hammered by browser pop-ups. Harmless for password
            # auth - the connector ignores these when the auth mode doesn't
            # apply.
            "client_store_temporary_credential": True,
            "client_request_mfa_token": True,
            "application": "DataValidator",
        }

        if auth_lc in ("snowflake", "", "password"):
            # Classic password auth (default; backward compatible)
            params["password"] = decrypt(self.record.password_enc)

        elif auth_lc == "externalbrowser":
            # SSO via the local browser. No password needed.
            params["authenticator"] = "externalbrowser"

        elif auth_lc == "oauth":
            # OAuth bearer token; we reuse the password slot to store the token.
            params["authenticator"] = "oauth"
            token = decrypt(self.record.password_enc)
            if not token:
                raise ValueError(
                    "OAuth authenticator selected but no token found in the password field"
                )
            params["token"] = token

        elif auth_lc == "snowflake_jwt":
            # Key-pair auth. The private key path lives in extra['private_key_path'];
            # an optional passphrase lives in the (encrypted) password field.
            params["authenticator"] = "snowflake_jwt"
            params["private_key"] = _load_jwt_key(extra, decrypt(self.record.password_enc))

        elif auth_lc.startswith("https://"):
            # Native SSO endpoint (Okta etc.) - still uses user + password.
            params["authenticator"] = authenticator
            params["password"] = decrypt(self.record.password_enc)

        else:
            # Unknown authenticator - pass it through and let snowflake-connector decide.
            params["authenticator"] = authenticator
            pwd = decrypt(self.record.password_enc)
            if pwd:
                params["password"] = pwd

        # Drop empty values so the connector applies its own defaults.
        params = {k: v for k, v in params.items() if v not in (None, "")}
        return snowflake.connector.connect(**params)


def _load_jwt_key(extra: dict, passphrase: str | None) -> bytes:
    """Load a PEM private key from disk and return DER-encoded PKCS#8 bytes."""
    from cryptography.hazmat.primitives import serialization

    pk_path = extra.get("private_key_path")
    if not pk_path:
        raise ValueError(
            "snowflake_jwt authenticator selected but extra['private_key_path'] is empty"
        )
    pem = Path(pk_path).expanduser().read_bytes()
    pwd_bytes = passphrase.encode("utf-8") if passphrase else None
    key = serialization.load_pem_private_key(pem, password=pwd_bytes)
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
