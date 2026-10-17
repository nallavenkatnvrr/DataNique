from __future__ import annotations

from app.connectors.base import Connector
from app.sql_dialects.postgres import PostgresDialect
from app.security.crypto import decrypt


_dialect = PostgresDialect()


class PostgresConnector(Connector):
    db_type = "postgres"

    @property
    def dialect(self):
        return _dialect

    def connect(self):
        import psycopg  # type: ignore

        try:
            from app.config import settings
            connect_timeout = int(getattr(settings, "connect_timeout", 30) or 30)
        except Exception:
            connect_timeout = 30

        params = {
            "host": self.record.host,
            "port": self.record.port or 5432,
            "user": self.record.username,
            "password": decrypt(self.record.password_enc),
            "dbname": self.record.database,
            "connect_timeout": connect_timeout,
            # TCP keepalive: kernel sends a probe after `keepalives_idle`
            # seconds of socket inactivity; if no ACK after
            # `keepalives_count` retries spaced `keepalives_interval`
            # apart, the socket is killed and the next operation gets a
            # clean "connection broken" error instead of hanging
            # forever. These tame corporate firewalls / load balancers
            # that silently drop idle sessions after 5-10 min.
            "keepalives": 1,
            "keepalives_idle": 60,
            "keepalives_interval": 10,
            "keepalives_count": 5,
        }
        params = {k: v for k, v in params.items() if v}
        try:
            from app.config import settings as _s
            qt = int(getattr(_s, "query_timeout", 0) or 0)
        except Exception:
            qt = 0
        if qt > 0:
            params["options"] = f"-c statement_timeout={qt * 1000}"
        conn = psycopg.connect(**params, autocommit=True)
        return conn
