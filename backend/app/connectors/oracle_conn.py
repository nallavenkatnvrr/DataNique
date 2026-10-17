from __future__ import annotations

from app.connectors.base import Connector
from app.sql_dialects.oracle import OracleDialect
from app.security.crypto import decrypt


_dialect = OracleDialect()


class OracleConnector(Connector):
    db_type = "oracle"

    @property
    def dialect(self):
        return _dialect

    def connect(self):
        import oracledb  # type: ignore

        # Fetch LOBs inline with the row instead of via separate round-trips.
        # For tables with CLOB/BLOB columns, this eliminates 1 extra network
        # call per LOB per row - massive throughput win on wide tables.
        try:
            oracledb.defaults.fetch_lobs = False
        except Exception:
            pass

        # Read connection-robustness settings (env-tunable via DV_CONNECT_TIMEOUT
        # etc. - see app.config).
        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
            keepalive_minutes = int(getattr(settings, "keepalive_minutes", 5) or 0)
            query_timeout_s = int(getattr(settings, "query_timeout", 0) or 0)
        except Exception:
            connect_timeout, keepalive_minutes, query_timeout_s = 30, 5, 0

        extra = self.record.extra or {}
        host = self.record.host
        port = self.record.port or 1521
        service_name = extra.get("service_name") or self.record.database
        sid = extra.get("sid")

        if extra.get("dsn"):
            dsn = extra["dsn"]
        elif service_name:
            dsn = oracledb.makedsn(host, port, service_name=service_name)
        elif sid:
            dsn = oracledb.makedsn(host, port, sid=sid)
        else:
            dsn = f"{host}:{port}"

        connect_kwargs: dict = dict(
            user=self.record.username,
            password=decrypt(self.record.password_enc),
            dsn=dsn,
            # Fail fast on dead network - was infinite before. With this set,
            # a wrong host or firewall block raises after `connect_timeout`
            # seconds instead of hanging the request thread for minutes.
            tcp_connect_timeout=connect_timeout,
        )
        # TCP keepalive: server-initiated half-close detection. Without it,
        # an idle connection that the Oracle side has silently dropped only
        # gets noticed on the next query.
        if keepalive_minutes > 0:
            connect_kwargs["expire_time"] = keepalive_minutes

        conn = oracledb.connect(**connect_kwargs)

        # Performance tuning: default arraysize=100 causes excessive
        # network round-trips on large tables. 10000 = ~100x fewer trips.
        # (arraysize / prefetchrows are cursor attributes; the module
        # defaults apply them to every cursor this process opens)
        oracledb.defaults.arraysize = 10000
        oracledb.defaults.prefetchrows = 10001

        # Per-statement timeout - abort queries running longer than N
        # seconds. callTimeout is in MILLISECONDS in oracledb. 0 disables.
        if query_timeout_s > 0:
            try:
                conn.call_timeout = query_timeout_s * 1000
            except Exception:
                pass

        return conn
