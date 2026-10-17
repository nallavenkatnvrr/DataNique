"""Optional API-token gate — pure logic, so it's unit-testable without a server.

The app has no login. When ``DV_API_TOKEN`` is configured, every ``/api/*``
request (except the exempt liveness paths) must present the matching token.
The HTTP wiring lives in ``app.main``; the *decision* lives here so it can be
tested in isolation.
"""
from __future__ import annotations

import hmac

# Paths that must always be reachable without a token (liveness / readiness).
EXEMPT_PATHS: frozenset[str] = frozenset({"/api/health"})

# Paths on which the admin token is required regardless of the normal api_token gate.
ADMIN_PREFIXES: tuple[str, ...] = (
    "/api/admin/",
    "/api/connections/cache/",
    "/api/compare/stop",
    "/api/health/detailed",
)


def tokens_match(supplied: str | None, expected: str) -> bool:
    """Constant-time token comparison.

    Uses :func:`hmac.compare_digest` so a wrong token takes the same time to
    reject regardless of how many leading characters happen to be correct —
    closing the timing side-channel that a plain ``!=`` opens.
    """
    if not supplied:
        return False
    return hmac.compare_digest(supplied, expected)


def should_block(path: str, supplied: str | None, expected: str) -> bool:
    """Return True if a request to ``path`` should be rejected as unauthorized.

    * When ``expected`` is empty the gate is disabled — never block.
    * Only ``/api/*`` paths are guarded (static assets / SPA are untouched).
    * Exempt paths are always allowed.
    * Otherwise the supplied token must match (constant-time).
    """
    if not expected:
        return False
    if not path.startswith("/api/"):
        return False
    if path in EXEMPT_PATHS:
        return False
    return not tokens_match(supplied, expected)


def should_block_admin(path: str, supplied: str | None, expected: str) -> bool:
    """Return True if a request to a destructive ADMIN path should be rejected.

    Independent of the normal api_token gate: only guards the privileged paths,
    and only when an ``expected`` admin token is configured.
    """
    if not expected:
        return False
    if not any(path.startswith(p) for p in ADMIN_PREFIXES):
        return False
    return not tokens_match(supplied, expected)
