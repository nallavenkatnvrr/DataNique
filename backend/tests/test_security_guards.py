"""Unit tests for the security guards (pure logic, no server needed).

Covers:
* ``app.security.sql_guard`` — the ``filter_sql`` stacked-statement / comment
  tripwire.
* ``app.security.api_token`` — the optional API-token gate decision.
"""
from __future__ import annotations

from app.security.sql_guard import injection_reason
from app.security.api_token import (
    should_block,
    should_block_admin,
    tokens_match,
    EXEMPT_PATHS,
    ADMIN_PREFIXES,
)


# ------------------------------------------------------------- filter_sql guard

def test_filter_guard_allows_plain_predicate():
    assert injection_reason("status = 'A' AND amount > 0") is None


def test_filter_guard_allows_none_and_blank():
    assert injection_reason(None) is None
    assert injection_reason("") is None
    assert injection_reason("   ") is None


def test_filter_guard_allows_semicolon_inside_literal():
    # A ';' that lives inside a quoted string is data, not a statement break.
    assert injection_reason("note = 'a;b'") is None


def test_filter_guard_allows_dashes_inside_literal():
    # '--' inside a string literal must not trip the comment check.
    assert injection_reason("code = 'x--y'") is None


def test_filter_guard_blocks_stacked_statement():
    reason = injection_reason("1=1; DROP TABLE users")
    assert reason is not None
    assert "stacked" in reason.lower()


def test_filter_guard_allows_trailing_semicolon_only():
    # A lone trailing ';' with nothing after it is harmless.
    assert injection_reason("id > 0;") is None


def test_filter_guard_blocks_line_comment():
    reason = injection_reason("id > 0 -- rest ignored")
    assert reason is not None
    assert "comment" in reason.lower()


def test_filter_guard_blocks_block_comment():
    assert injection_reason("id > 0 /* sneaky */") is not None


# --------------------------------------------------------------- api-token gate

def test_token_gate_disabled_when_no_expected_token():
    # Empty expected token = gate off = never block.
    assert should_block("/api/connections", None, "") is False
    assert should_block("/api/connections", "whatever", "") is False


def test_token_gate_ignores_non_api_paths():
    assert should_block("/", None, "secret") is False
    assert should_block("/assets/app.js", None, "secret") is False


def test_token_gate_exempts_health():
    assert "/api/health" in EXEMPT_PATHS
    assert should_block("/api/health", None, "secret") is False


def test_token_gate_blocks_missing_token():
    assert should_block("/api/connections", None, "secret") is True


def test_token_gate_blocks_wrong_token():
    assert should_block("/api/connections", "nope", "secret") is True


def test_token_gate_allows_correct_token():
    assert should_block("/api/connections", "secret", "secret") is False


# ----------------------------------------------------- constant-time token compare

def test_tokens_match_true_only_on_exact():
    assert tokens_match("secret", "secret") is True
    assert tokens_match("secre", "secret") is False
    assert tokens_match("secrets", "secret") is False
    assert tokens_match("SECRET", "secret") is False


def test_tokens_match_empty_supplied_is_false():
    assert tokens_match(None, "secret") is False
    assert tokens_match("", "secret") is False


# --------------------------------------------------------------- admin token gate

def test_admin_gate_disabled_when_no_expected_token():
    assert should_block_admin("/api/admin/kill-execution/x", None, "") is False


def test_admin_gate_only_guards_admin_prefixes():
    # A normal API path is NOT the admin surface — admin gate ignores it.
    assert should_block_admin("/api/connections", None, "adm") is False


def test_admin_gate_blocks_admin_path_without_token():
    assert should_block_admin("/api/admin/evict-connector/1", None, "adm") is True
    assert should_block_admin("/api/connections/cache/evict-all", None, "adm") is True


def test_admin_gate_allows_admin_path_with_token():
    assert should_block_admin("/api/admin/restart-watchdog", "adm", "adm") is False


def test_admin_gate_blocks_wrong_token():
    assert should_block_admin("/api/admin/restart-watchdog", "nope", "adm") is True


def test_admin_prefixes_cover_expected_surfaces():
    assert "/api/admin/" in ADMIN_PREFIXES
    assert "/api/connections/cache/" in ADMIN_PREFIXES
    assert "/api/compare/stop" in ADMIN_PREFIXES
    assert "/api/health/detailed" in ADMIN_PREFIXES


def test_admin_gate_protects_stop_and_detailed_health():
    assert should_block_admin("/api/compare/stop", None, "adm") is True
    assert should_block_admin("/api/health/detailed", None, "adm") is True
    assert should_block_admin("/api/health", None, "adm") is False
