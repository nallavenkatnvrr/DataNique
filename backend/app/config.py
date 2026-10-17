from ipaddress import ip_address
from pathlib import Path

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(Path(__file__).resolve().parent.parent / ".env"), env_prefix="DV_", extra="ignore",
    )

    app_name: str = "Datanique"
    backend_dir: Path = Path(__file__).resolve().parent.parent
    data_dir: Path = Path(__file__).resolve().parent.parent / "data"
    sqlite_url: str = ""
    secret_key_file: str = ".secret_key"
    cors_origins: str = "http://localhost:5173,http://localhost:5174,http://localhost:5175,http://127.0.0.1:5173,http://127.0.0.1:5174,http://127.0.0.1:5175"

    # ----- Encryption -----
    #
    # Saved passwords, history, templates and diff stores are encrypted with
    # the master-password vault (app/security/vault.py, data/vault.json).
    # DV_VAULT_PASSWORD=...  unlocks it at startup for unattended servers.
    #
    # DV_ENCRYPTION_KEY / secret_key_file are the LEGACY Fernet key of
    # earlier versions: only read to migrate old passwords into the vault,
    # after which the key file is deleted.
    encryption_key: str = ""

    # ----- Network binding + optional API token -----
    #
    # SECURITY: this app has NO built-in login and the SQL IDE runs arbitrary
    # SQL against every saved connection. Binding to all interfaces would let
    # anyone on the network reach that. Default to loopback only. Override
    # DV_BIND_HOST=0.0.0.0 CONSCIOUSLY (e.g. behind a trusted reverse proxy).
    #
    # DV_BIND_HOST=127.0.0.1   # interface uvicorn binds to. 0.0.0.0 = all.
    # DV_BIND_PORT=8000        # port
    # DV_API_TOKEN=            # when non-empty, every /api/* request (except
    #                          # /api/health) must send it as the
    #                          # `X-API-Token` header.
    #                          # Empty (default) = no auth, loopback-only trust.
    bind_host: str = "127.0.0.1"
    bind_port: int = 8000
    api_token: str = ""
    # Extra Host header names accepted while bound to loopback (comma list),
    # e.g. a hosts-file alias. Everything else is refused (DNS rebinding).
    allowed_hosts: str = ""

    # DV_ADMIN_TOKEN=          # when non-empty, admin actions plus compare stop
    #                          # and detailed health require `X-Admin-Token`,
    #                          # INDEPENDENT of DV_API_TOKEN. Destructive actions
    #                          # and SQL diagnostics can be protected even when
    #                          # the rest of the API is open on loopback. Empty =
    #                          # the normal api_token gate (if any) is the only
    #                          # protection.
    admin_token: str = ""

    @model_validator(mode="after")
    def require_api_token_for_network_bind(self):
        try:
            loopback = ip_address(self.bind_host).is_loopback
        except ValueError:
            loopback = self.bind_host.strip().lower() == "localhost"
        if not loopback and not self.api_token:
            raise ValueError("DV_API_TOKEN is required when DV_BIND_HOST is not loopback")
        return self

    default_row_diff_limit: int = 1000
    pull_down_max_rows: int = 1_000_000

    # ----- DuckDB configuration -----
    #
    # DuckDB is embedded so most users don't need to tune anything. Defaults
    # auto-size to system RAM. Override only if DuckDB starts spilling
    # heavily (you'll see it in the backend log as "Out of Memory" or
    # slow runs on large tables).
    #
    # DV_DUCKDB_MEMORY_LIMIT=8GB     # cap memory usage (e.g. "4GB", "70%")
    # DV_DUCKDB_THREADS=4            # parallelism; default = all cores
    # DV_DUCKDB_BATCH_SIZE=250000    # rows per source-DB fetch; bigger = fewer
    #                                # round-trips, more memory per batch. Sweet
    #                                # spot for 16GB VMs: 250k-500k. For 10M+
    #                                # row tables on a workstation with 64GB+,
    #                                # try 1_000_000.
    # DV_DUCKDB_USE_ARROW=true       # set to "false" to force the pandas path
    #                                # for diagnostics if Arrow ingest misbehaves
    #                                # on a quirky column type.
    duckdb_memory_limit: str = ""
    duckdb_threads: int = 0
    duckdb_batch_size: int = 250_000
    duckdb_use_arrow: bool = True

    # ----- Connection robustness -----
    #
    # These tune how aggressively to give up on hanging or dead database
    # connections. Defaults are conservative — bump them if you're on a
    # very slow VPN or hitting a server that takes a long time to auth.
    #
    # DV_CONNECT_TIMEOUT=30      # seconds — how long to wait for initial
    #                              TCP+auth before bailing
    # DV_TEST_TIMEOUT=30         # seconds — overall budget for the "Test
    #                              connection" UI button before the
    #                              endpoint gives up and returns an error
    # DV_QUERY_TIMEOUT=0         # seconds — kill long-running queries
    #                              after this many seconds. 0 = no limit
    #                              (default). Set e.g. 600 to abort
    #                              queries that run > 10 min.
    # DV_KEEPALIVE_MINUTES=5     # how often to send TCP keepalive on idle
    #                              connections. 0 = disabled.
    # DV_VALIDATE_BEFORE_USE=1   # if 1, ping a cached connection before
    #                              reuse to catch silently-dead conns.
    #                              Adds ~10ms per cursor open. Default on.
    # DV_HEARTBEAT_SECONDS=240   # background ping interval (seconds)
    #                              for cached connectors. 0 = disabled.
    #                              Default 240 (4 min) keeps idle conns
    #                              warm on networks that drop sessions
    #                              after 5-10 min of inactivity.
    # DV_CONNECT_RETRIES=2       # extra attempts to open a NEW connection
    #                              when the initial connect fails with a
    #                              transient error (network blip, brief auth
    #                              token refresh). 0 = no retry. Default 2.
    # DV_CONNECT_RETRY_BACKOFF=1.5  # base seconds between connect retries;
    #                              grows linearly (1x, 2x, 3x...). Default 1.5.
    connect_timeout: int = 30
    test_timeout: int = 30
    query_timeout: int = 0
    keepalive_minutes: int = 5
    validate_before_use: bool = True
    heartbeat_seconds: int = 240
    connect_retries: int = 2
    connect_retry_backoff: float = 1.5

    # ----- Connection pooling (opt-in, OFF by default) -----
    #
    # By default each (connection, purpose) reuses ONE persistent connector
    # (see app/connectors/factory.py). Concurrent compare runs against the
    # SAME connection therefore serialize on that connector's lock. Enabling
    # pooling lets the "compare" purpose hand out up to N connectors for the
    # same connection so concurrent runs proceed in parallel.
    #
    # SAFETY: pooling is NEVER applied to Snowflake — opening extra sessions
    # can trigger an SSO browser pop-up. It only applies to password-auth
    # databases (postgres/mysql/sqlserver/oracle). Leave OFF unless multiple
    # users hit the same connection at once.
    #
    # DV_CONNECTION_POOL_ENABLED=false  # master switch (default off)
    # DV_CONNECTION_POOL_SIZE=2         # max connectors per (connection,compare)
    connection_pool_enabled: bool = False
    connection_pool_size: int = 2

    # ----- Fast-read engines (ConnectorX / DuckDB native scanners) -----
    #
    # The Polars / Pandas / DuckDB engines read Snowflake and Oracle via
    # fast Arrow paths already. Postgres / MySQL / SQL Server fall back to
    # a row-by-row DB-API cursor, which is 5-6x slower for bulk reads.
    #
    # These flags enable optional accelerated read paths for those three
    # databases. Both are SAFE — if the library/extension is missing or the
    # accelerated read fails for any reason, the engine silently falls back
    # to the existing cursor path. No correctness impact, only speed.
    #
    # DV_FAST_READ_ENABLED=true      # master switch for all fast-read paths
    # DV_CONNECTORX_ENABLED=true     # use ConnectorX (Rust, parallel Arrow)
    #                                # for Postgres/MySQL/SQL Server in the
    #                                # Polars + Pandas engines. Requires
    #                                # `pip install connectorx`.
    # DV_CONNECTORX_PARTITIONS=4     # parallel read partitions. ConnectorX
    #                                # splits the table on a numeric/temporal
    #                                # key into N ranges read concurrently.
    #                                # 0/1 = single connection. Higher = faster
    #                                # but more load on the source DB.
    # DV_DUCKDB_SCANNER_ENABLED=true # use DuckDB's postgres/mysql ATTACH
    #                                # scanners to push the whole compare into
    #                                # DuckDB C++ for Postgres/MySQL. No new
    #                                # pip dependency (DuckDB autoloads the
    #                                # extension). SQL Server not supported.
    fast_read_enabled: bool = True
    connectorx_enabled: bool = True
    connectorx_partitions: int = 4
    duckdb_scanner_enabled: bool = True

    # ----- Engine robustness guards -----
    #
    # DV_MAX_COMPARE_ROWS=0          # hard ceiling on rows pulled per side
    #                                # into an in-memory engine (pandas/polars/
    #                                # duckdb). 0 = use each engine's own
    #                                # default budget. Set e.g. 50_000_000 to
    #                                # fail fast with a clear error instead of
    #                                # OOMing on an unexpectedly huge table.
    # DV_HASH_ALGO=md5               # row-hash algorithm. "md5" (default,
    #                                # cross-engine identical) or "xxh3"/"xxh64"
    #                                # (3-5x faster, requires `pip install
    #                                # xxhash`; only valid when BOTH sides use
    #                                # the same engine — never mix with the
    #                                # SQL-side md5 of the standard engine).
    max_compare_rows: int = 0
    hash_algo: str = "md5"

    # ----- v2 engine -----
    # DV_MAX_PARALLEL_COMPARES=3     # compares that run at the same time
    # DV_PUSHDOWN_MIN_ROWS=20000000  # same-connection tables at least this
    #                                # big are diffed inside the database
    # DV_MAX_UPLOAD_MB=20480         # largest accepted file upload
    # DV_READER_ORDER_<DBTYPE>=...   # override the reader chain, e.g.
    #                                # DV_READER_ORDER_SQLSERVER=arrow_odbc,cursor
    max_parallel_compares: int = 3
    pushdown_min_rows: int = 20_000_000
    max_upload_mb: int = 20480

    def get_cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
if not settings.sqlite_url:
    db_path = settings.data_dir / "data_validator.db"
    settings.sqlite_url = f"sqlite:///{db_path.as_posix()}"
