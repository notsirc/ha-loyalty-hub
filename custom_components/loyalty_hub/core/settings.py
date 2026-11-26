"""Integration settings helpers (price compare sites, expiry days, logo limits)."""

from __future__ import annotations

from typing import Any

DEFAULT_PRICE_COMPARE: list[dict[str, str]] = [
    {"name": "Trovaprezzi", "url": "https://www.trovaprezzi.it/categoria.aspx?libera={query}"},
    {"name": "Idealo", "url": "https://www.idealo.it/prechcat.html?q={query}"},
    {"name": "Google Shopping", "url": "https://www.google.com/search?tbm=shop&q={query}"},
    {"name": "Amazon", "url": "https://www.amazon.it/s?k={query}"},
]
DEFAULT_EXPIRY_WARNING_DAYS = 7
MIN_EXPIRY_WARNING_DAYS = 0
MAX_EXPIRY_WARNING_DAYS = 365

# §11.3: logo storage limits (admin options).
DEFAULT_LOGO_MAX_FILES = 1000
MIN_LOGO_MAX_FILES = 1
MAX_LOGO_MAX_FILES = 2000
DEFAULT_LOGO_MAX_MB = 200
MIN_LOGO_MAX_MB = 1
MAX_LOGO_MAX_MB = 300


def format_price_sites(sites: list[dict[str, str]]) -> str:
    return "\n".join(f"{s['name']}|{s['url']}" for s in sites)


def parse_price_sites(text: str) -> tuple[list[dict[str, str]], list[str]]:
    """Parse "Name|https://url?q={query}" lines. Returns (sites, invalid lines)."""
    sites: list[dict[str, str]] = []
    invalid: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        name, sep, url = line.partition("|")
        name, url = name.strip(), url.strip()
        if (
            not sep
            or not name
            or len(name) > 60
            or not url.lower().startswith(("https://", "http://"))
            or "{query}" not in url
        ):
            invalid.append(line)
            continue
        sites.append({"name": name, "url": url})
    return sites, invalid


def sanitize_price_sites(value: Any) -> list[dict[str, str]]:
    """Return stored sites if valid, else defaults."""
    if not isinstance(value, list):
        return [dict(s) for s in DEFAULT_PRICE_COMPARE]
    text = format_price_sites(
        [s for s in value if isinstance(s, dict) and "name" in s and "url" in s]
    )
    sites, _ = parse_price_sites(text)
    return sites


def sanitize_expiry_days(value: Any) -> int:
    try:
        days = int(value)
    except (TypeError, ValueError):
        return DEFAULT_EXPIRY_WARNING_DAYS
    return max(MIN_EXPIRY_WARNING_DAYS, min(MAX_EXPIRY_WARNING_DAYS, days))


def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def sanitize_logo_max_files(value: Any) -> int:
    return _clamp_int(value, DEFAULT_LOGO_MAX_FILES, MIN_LOGO_MAX_FILES, MAX_LOGO_MAX_FILES)


def sanitize_logo_max_mb(value: Any) -> int:
    return _clamp_int(value, DEFAULT_LOGO_MAX_MB, MIN_LOGO_MAX_MB, MAX_LOGO_MAX_MB)


def sanitize_currency(value: Any, fallback: str = "EUR") -> str:
    """HA's currency (§14.3) as a 3-letter upper-case code, else the fallback."""
    if isinstance(value, str):
        code = value.strip().upper()
        if len(code) == 3 and code.isascii() and code.isalpha():
            return code
    return fallback
