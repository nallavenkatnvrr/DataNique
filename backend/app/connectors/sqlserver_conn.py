from __future__ import annotations

from app.connectors.base import Connector
from app.sql_dialects.sqlserver import SqlServerDialect
from app.security.crypto import decrypt


_dialect = SqlServerDialect()


# Preferred ODBC drivers in newest-first order. The connector tries the
# user's explicit choice first, then falls back to whichever of these is
# installed on the machine. Matches the names pyodbc.drivers() returns
# on Windows (with "for SQL Server" suffix) and Linux/macOS (msodbcsql
# package).
_PREFERRED_DRIVERS = (
    "ODBC Driver 18 for SQL Server",
    "ODBC Driver 17 for SQL Server",
    "ODBC Driver 13 for SQL Server",
    "SQL Server Native Client 11.0",
    "SQL Server",
)


# Mapping from our internal auth_mode codes to friendly labels. The
# frontend dropdown uses these via the db-types endpoint. Each mode
# adds different options to the ODBC connection string (see connect()).
_AUTH_MODES = {
    "sql": "SQL Server Authentication (username + password)",
    "windows": "Windows Authentication (Trusted_Connection - current user)",
    "ntlm": "NTLM (domain username + password, like DBeaver)",
    "ad_password": "Active Directory - Password",
    "ad_integrated": "Active Directory - Integrated (current Windows session)",
    "ad_interactive": "Active Directory - Interactive (MFA browser prompt)",
    "ad_msi": "Active Directory - Managed Service Identity",
    "ad_service_principal": "Active Directory - Service Principal",
}


def _truthy(value) -> bool:
    """Loose boolean parse for config flags coming from JSON/form input."""
    return str(value).strip().lower() in ("y", "yes", "true", "1", "on")


def _list_installed_sqlserver_drivers() -> list[str]:
    """Return installed ODBC drivers that match 'SQL Server' in the name.

    pyodbc.drivers() reads from the appropriate platform source:
      - Windows: HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI
      - Linux/macOS: /etc/odbcinst.ini or ~/.odbcinst.ini
    """
    try:
        import pyodbc  # type: ignore
    except ImportError:
        return []
    try:
        return [d for d in pyodbc.drivers() if "SQL Server" in d]
    except Exception:
        return []


def _resolve_driver(preferred: str | None) -> tuple[str, list[str]]:
    """Pick the best available driver and return it plus the list of
    installed SQL Server drivers.

    Order of preference:
      1. ``preferred`` if installed (exact match, then case-insensitive)
      2. Newest preferred driver that's installed
      3. Any installed SQL Server driver
      4. Raise if NONE installed
    """
    installed = _list_installed_sqlserver_drivers()
    pref = (preferred or "").strip()

    if pref:
        if pref in installed:
            return pref, installed
        for d in installed:
            if d.lower() == pref.lower():
                return d, installed

    for candidate in _PREFERRED_DRIVERS:
        if candidate in installed:
            return candidate, installed

    if installed:
        return installed[0], installed

    raise RuntimeError(
        "No SQL Server ODBC driver is installed on this machine. "
        "Install 'Microsoft ODBC Driver 17 for SQL Server' or "
        "'ODBC Driver 18 for SQL Server' from Microsoft. "
        "Download: https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server"
    )


def _odbc(value) -> str:
    """Escape an ODBC connection-string value: wrap in braces when it holds
    ; { } or leading/trailing spaces, doubling any closing brace."""
    v = "" if value is None else str(value)
    if any(c in v for c in ";{}=") or v != v.strip():
        return "{" + v.replace("}", "}}") + "}"
    return v


def _format_server(host: str, port: int | None) -> str:
    """Build the SERVER= value, handling named instances correctly.

    SQL Server named instances (HOST\\INSTANCE) use dynamic ports
    resolved by the SQL Server Browser service on UDP/1434. Appending
    ``,port`` to a named instance is WRONG — the driver bypasses the
    Browser lookup and tries to connect to that fixed port instead,
    which usually fails or connects to the wrong instance.

    If host contains backslash → named instance, no port.
    Else → host[,port].
    """
    host = (host or "").strip()
    if "\\" in host:
        return host
    if port:
        return f"{host},{int(port)}"
    return host


class SqlServerConnector(Connector):
    db_type = "sqlserver"

    @property
    def dialect(self):
        return _dialect

    def odbc_connection_string(self) -> str:
        """The ODBC connection string (also used by the Arrow ODBC reader)."""
        return self._conn_str_and_driver()[0]

    def _conn_str_and_driver(self):
        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
        except Exception:
            connect_timeout = 30
        extra = self.record.extra or {}

        # ---- Auth mode (with backward compat for old trusted_connection field) ----
        auth_mode = (extra.get("auth_mode") or "").strip().lower()
        if not auth_mode:
            # Legacy: trusted_connection=Y → windows auth
            legacy_trusted = str(extra.get("trusted_connection", "")).lower() in (
                "y", "yes", "true", "1"
            )
            auth_mode = "windows" if legacy_trusted else "sql"

        if auth_mode not in _AUTH_MODES:
            raise ValueError(
                f"Unknown auth_mode={auth_mode!r}. Supported: {sorted(_AUTH_MODES)}"
            )

        # ---- Driver resolution ----
        preferred_driver = (extra.get("driver") or "").strip() or None
        driver, installed_drivers = _resolve_driver(preferred_driver)

        # ---- Server / DB ----
        server = _format_server(self.record.host, self.record.port)
        database = self.record.database or "master"
        encrypt_opt = extra.get("encrypt", "yes")
        trust_cert = extra.get("trust_server_certificate", "yes")

        parts = [
            f"DRIVER={{{driver}}}",
            f"SERVER={server}",
            f"DATABASE={_odbc(database)}",
            f"Encrypt={encrypt_opt}",
            f"TrustServerCertificate={trust_cert}",
            f"Connection Timeout={connect_timeout}",
            # Max TDS packet size (default 4096). 32767 = 8x fewer network
            # round-trips for large data transfers — the single biggest
            # throughput improvement for SQL Server bulk reads.
            "PacketSize=32767",
        ]

        # ---- Auth-mode-specific options ----
        if auth_mode == "windows":
            parts.append("Trusted_Connection=yes")
        elif auth_mode == "ntlm":
            # NTLM, like DBeaver. Two sub-cases:
            #   1. "Use integrated security" → authenticate as the backend
            #      process's current Windows/domain session (SSPI), same as
            #      windows mode. Credentials are ignored.
            #   2. Explicit domain credentials → DOMAIN\user + password over
            #      NTLM. The Microsoft ODBC driver only honours alternate
            #      NTLM credentials on non-Windows builds via FreeTDS
            #      (UID/PWD/DOMAIN); on Windows the MS driver ignores them
            #      and uses the current session. ConnectorX/Tiberius (the
            #      fast path) performs true cross-platform NTLM with these
            #      credentials.
            if _truthy(extra.get("use_integrated_security")):
                parts.append("Trusted_Connection=yes")
            else:
                domain = (extra.get("domain") or "").strip()
                user = (self.record.username or "").strip()
                # Fold a bare domain into the UID as DOMAIN\user when the
                # username doesn't already carry one. FreeTDS additionally
                # reads the separate DOMAIN keyword.
                if domain and "\\" not in user and "@" not in user:
                    parts.append(f"UID={_odbc(domain + chr(92) + user)}")
                else:
                    parts.append(f"UID={_odbc(user)}")
                parts.append(f"PWD={_odbc(decrypt(self.record.password_enc) or '')}")
                if domain:
                    parts.append(f"DOMAIN={_odbc(domain)}")
        elif auth_mode == "sql":
            parts.append(f"UID={_odbc(self.record.username or '')}")
            parts.append(f"PWD={_odbc(decrypt(self.record.password_enc) or '')}")
        elif auth_mode == "ad_password":
            parts.append("Authentication=ActiveDirectoryPassword")
            parts.append(f"UID={_odbc(self.record.username or '')}")
            parts.append(f"PWD={_odbc(decrypt(self.record.password_enc) or '')}")
        elif auth_mode == "ad_integrated":
            parts.append("Authentication=ActiveDirectoryIntegrated")
        elif auth_mode == "ad_interactive":
            parts.append("Authentication=ActiveDirectoryInteractive")
            if self.record.username:
                parts.append(f"UID={_odbc(self.record.username)}")
        elif auth_mode == "ad_msi":
            parts.append("Authentication=ActiveDirectoryMsi")
            if self.record.username:
                parts.append(f"UID={_odbc(self.record.username)}")
        elif auth_mode == "ad_service_principal":
            parts.append("Authentication=ActiveDirectoryServicePrincipal")
            parts.append(f"UID={_odbc(self.record.username or '')}")
            parts.append(f"PWD={_odbc(decrypt(self.record.password_enc) or '')}")

        conn_str = ";".join(parts)
        return conn_str, driver, installed_drivers

    def connect(self):
        import pyodbc  # type: ignore

        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
            query_timeout_s = int(getattr(settings, "query_timeout", 0) or 0)
        except Exception:
            connect_timeout, query_timeout_s = 30, 0

        conn_str, driver, installed_drivers = self._conn_str_and_driver()

        # ---- Connect with actionable error messages ----
        try:
            conn = pyodbc.connect(conn_str, autocommit=True, timeout=connect_timeout)
        except pyodbc.InterfaceError as exc:
            # IM002 = "Data source name not found and no default driver
            # specified" — almost always means the named driver isn't
            # actually installed.
            msg = str(exc)
            if "IM002" in msg:
                hint_lines = [
                    f"ODBC driver '{driver}' is not installed on this machine.",
                ]
                if installed_drivers:
                    hint_lines.append(
                        f"Installed SQL Server drivers: {installed_drivers}"
                    )
                    hint_lines.append(
                        "Edit the connection and pick one of the installed "
                        "drivers in the 'ODBC Driver' field, or leave it "
                        "blank to auto-detect."
                    )
                else:
                    hint_lines.append(
                        "No SQL Server ODBC drivers found at all. Install "
                        "'Microsoft ODBC Driver 17 for SQL Server' or 18 "
                        "from Microsoft."
                    )
                raise RuntimeError("\n".join(hint_lines)) from exc
            raise
        except pyodbc.OperationalError as exc:
            # 08001 = network connect failure. Suggest named-instance fixes.
            msg = str(exc)
            if "08001" in msg or "Login timeout expired" in msg:
                hints = []
                if "\\" in (self.record.host or ""):
                    hints.append(
                        f"Host looks like a named instance ({self.record.host}). "
                        "Make sure SQL Server Browser service is running on "
                        "the server (UDP/1434), or use the instance's static "
                        "TCP port: set Host to just the server name and Port "
                        "to the instance's static port."
                    )
                if self.record.port and "\\" in (self.record.host or ""):
                    hints.append(
                        f"You set port={self.record.port} on a named-instance "
                        "host - that combination is ignored by the driver; "
                        "the Browser service is queried for the dynamic port."
                    )
                if hints:
                    raise RuntimeError(
                        f"{msg}\n\nHints:\n- " + "\n- ".join(hints)
                    ) from exc
            raise

        if query_timeout_s > 0:
            conn.timeout = query_timeout_s
        return conn
