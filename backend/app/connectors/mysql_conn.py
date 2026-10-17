from __future__ import annotations

from app.connectors.base import Connector
from app.sql_dialects.mysql import MySqlDialect
from app.security.crypto import decrypt


_dialect = MySqlDialect()


class MySqlConnector(Connector):
    db_type = "mysql"

    @property
    def dialect(self):
        return _dialect

    def connect(self):
        import pymysql  # type: ignore
        import socket

        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
            query_timeout_s = int(getattr(settings, "query_timeout", 0) or 0)
        except Exception:
            connect_timeout, query_timeout_s = 30, 0

        params = {
            "host": self.record.host,
            "port": self.record.port or 3306,
            "user": self.record.username,
            "password": decrypt(self.record.password_enc) or "",
            "database": self.record.database,
            "connect_timeout": connect_timeout,
            "charset": "utf8mb4",
            # Note: PyMySQL has no protocol compression - passing
            # compress=True raises NotImplementedError before connecting.
            # Autocommit on: every statement sees fresh data instead of a
            # REPEATABLE READ snapshot pinned for the connection's lifetime,
            # and IDE DML is committed (the IDE switches it off per tab for
            # manual-commit mode).
            "autocommit": True,
        }
        if query_timeout_s > 0:
            # PyMySQL splits this into client-side socket read timeout +
            # server-side wait_timeout (latter set as SESSION var below).
            params["read_timeout"] = query_timeout_s
            params["write_timeout"] = query_timeout_s

        params = {k: v for k, v in params.items() if v not in (None, "")}
        if not params.get("database") and self.record.schema_name:
            params["database"] = self.record.schema_name

        conn = pymysql.connect(**params)

        # TCP keepalive on the underlying socket - survives idle periods
        # behind firewalls / load balancers that drop quiet sessions.
        # PyMySQL exposes the raw socket via _sock; we set SO_KEEPALIVE
        # there. Per-platform tunables (TCP_KEEPIDLE etc) are best-effort.
        try:
            sock = conn._sock
            if sock is not None:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
                # Linux only - start probing after 60s, every 10s, give
                # up after 5 probes. Windows uses registry-level
                # defaults; the SO_KEEPALIVE flag alone is enough there.
                for opt_name, val in (
                    ("TCP_KEEPIDLE", 60),
                    ("TCP_KEEPINTVL", 10),
                    ("TCP_KEEPCNT", 5),
                ):
                    opt = getattr(socket, opt_name, None)
                    if opt is not None:
                        try:
                            sock.setsockopt(socket.IPPROTO_TCP, opt, val)
                        except Exception:
                            pass
        except Exception:
            pass

        return conn
