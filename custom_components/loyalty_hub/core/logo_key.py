"""Logo.dev key: validation, state and key-test classification (ARCHITETTURA §14.1).

Pure Python (no homeassistant imports). Keys are never logged nor returned to clients.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote

from .errors import ERR_INVALID_FORMAT, ValidationError

# Config/options flow error keys (translated in strings.json).
ERR_SECRET_KEY = "secret_key_not_allowed"
ERR_INVALID_KEY = "invalid_key"
ERR_KEY_REJECTED = "key_rejected"
ERR_KEY_RATE_LIMITED = "key_rate_limited"
ERR_CANNOT_CONNECT = "cannot_connect"

# State of the Logo.dev provider for the frontend (`settings.logo_dev.state`).
STATE_READY = "ready"
STATE_NO_KEY = "no_key"
STATE_DISABLED = "disabled"

# Results of the key test (`logo/test_key`).
TEST_OK = "ok"
TEST_REJECTED = "rejected"
TEST_RATE_LIMITED = "rate_limited"
TEST_UNREACHABLE = "unreachable"
TEST_MISSING = "missing"

_TEST_ERRORS = {
    TEST_REJECTED: ERR_KEY_REJECTED,
    TEST_RATE_LIMITED: ERR_KEY_RATE_LIMITED,
    TEST_UNREACHABLE: ERR_CANNOT_CONNECT,
}

_KEY_RE = re.compile(r"^pk_[A-Za-z0-9_-]{8,200}$")


class LogoKeyError(ValidationError):
    """A user key was refused; `reason` is one of the ERR_* flow error keys."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason, ERR_INVALID_FORMAT)
        self.reason = reason


def validate_user_key(value: Any) -> str:
    """The cleaned key, or LogoKeyError with the flow error key."""
    if not isinstance(value, str):
        raise LogoKeyError(ERR_INVALID_KEY)
    key = value.strip()
    if key.lower().startswith("sk_"):
        raise LogoKeyError(ERR_SECRET_KEY)
    if not _KEY_RE.match(key):
        raise LogoKeyError(ERR_INVALID_KEY)
    return key


def logo_dev_state(enabled: bool, key: str | None) -> str:
    """`disabled` (provider off in the options) wins over a missing key."""
    if not enabled:
        return STATE_DISABLED
    return STATE_READY if key else STATE_NO_KEY


def key_test_url(key: str) -> str:
    """URL of the key test: Logo.dev's own logo, so a valid key always answers."""
    return (
        f"https://img.logo.dev/logo.dev?token={quote(key, safe='')}"
        "&size=64&format=png&fallback=404"
    )


def classify_test_status(status: int | None) -> str:
    """HTTP status of the key test -> result. None = network error / timeout."""
    if status is None:
        return TEST_UNREACHABLE
    if 200 <= status < 300 or status == 404:
        return TEST_OK  # 404 = valid key, logo missing
    if status in (401, 403):
        return TEST_REJECTED
    if status == 429:
        return TEST_RATE_LIMITED
    return TEST_UNREACHABLE


def key_test_error(result: str) -> str | None:
    """Flow error key for a key-test result (None when the key works)."""
    return _TEST_ERRORS.get(result)
