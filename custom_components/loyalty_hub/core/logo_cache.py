"""Logo cache and bulk refresh rules (ARCHITETTURA §14.2). Pure Python.

- `refresh_all`: the user's own cards (admin: every card) whose logo comes from an
  online provider, or without a logo but with a `logo_domain`; never uploads or
  imports, never the trash (callers pass live cards only).
- Cache (`logo_cache.days`): online logos older than `days` (`checked_at ?? updated_at`)
  are downloaded again with their own provider, if still available.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .logo_sources import AUTO_ORDER, PROVIDERS
from .models import Card

ONLINE_SOURCES = PROVIDERS  # logo_dev, website, logoapi (§15.1)
MIN_CACHE_DAYS = 1
MAX_CACHE_DAYS = 365
PAUSE_SECONDS = 3.0
CACHE_CHECK_INTERVAL = timedelta(hours=1)
RETRY_AFTER = timedelta(days=1)


# ---------------------------------------------------------------- stored state


def default_cache_state() -> dict[str, Any]:
    """`{days: None}` = keep logos forever (default)."""
    return {"days": None}


def valid_days(value: Any) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and MIN_CACHE_DAYS <= value <= MAX_CACHE_DAYS
    )


def load_cache_state(raw: Any) -> dict[str, Any]:
    days = raw.get("days") if isinstance(raw, dict) else None
    return {"days": days if valid_days(days) else None}


# ---------------------------------------------------------------- jobs


@dataclass(frozen=True)
class RefreshJob:
    card_id: str
    providers: tuple[str, ...]  # tried in order, the first that works wins
    domain: str
    version: int | None  # logo version when the job was made (None = no logo)


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _domain(card: Card) -> str | None:
    # The card field wins (the user may have changed it), as in the frontend "Refresh logo".
    logo = card.logo or {}
    return card.logo_domain or logo.get("domain")


def _version(card: Card) -> int | None:
    version = (card.logo or {}).get("version")
    return version if isinstance(version, int) else None


def refresh_all_jobs(
    cards: Iterable[Card], available: list[str], owner_id: str | None
) -> list[RefreshJob]:
    """Jobs of `logo/refresh_all`. `owner_id` None = every card (admin).

    Provider order: the logo's current provider (if still available), then the
    "auto" order. Cards with no available provider are left out.
    """
    jobs: list[RefreshJob] = []
    for card in cards:
        if owner_id is not None and card.owner_id != owner_id:
            continue
        source = (card.logo or {}).get("source")
        if card.logo and source not in ONLINE_SOURCES:
            continue  # upload / import: never touched
        domain = _domain(card)
        if not domain:
            continue
        order: list[str] = []
        if source in available:
            order.append(source)
        order += [p for p in AUTO_ORDER if p in available and p not in order]
        if order:
            jobs.append(RefreshJob(card.id, tuple(order), domain, _version(card)))
    return jobs


def is_expired(logo: dict[str, Any] | None, now: datetime, days: int | None) -> bool:
    """Online logo whose last check (`checked_at ?? updated_at`) is `days` old or more."""
    if not logo or days is None or logo.get("source") not in ONLINE_SOURCES:
        return False
    last = _parse(logo.get("checked_at")) or _parse(logo.get("updated_at"))
    return last is None or now - last >= timedelta(days=days)


def expired_jobs(
    cards: Iterable[Card], available: list[str], now: datetime, days: int | None
) -> list[RefreshJob]:
    """Cache jobs: expired online logos whose own provider is still available."""
    if days is None:
        return []
    jobs: list[RefreshJob] = []
    for card in cards:
        logo = card.logo
        if not is_expired(logo, now, days):
            continue
        provider = logo.get("source")
        domain = _domain(card)
        if provider not in available or not domain:
            continue
        jobs.append(RefreshJob(card.id, (provider,), domain, _version(card)))
    return jobs


def checked_now(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat(timespec="seconds")


def checked_after_failure(now: datetime, days: int) -> str:
    """`checked_at` after a failed cache refresh: a new attempt one day later."""
    return checked_now(now - timedelta(days=days) + RETRY_AFTER)


# ---------------------------------------------------------------- progress


@dataclass
class RefreshProgress:
    """Counts only (§14.2): never names, ids or domains of the cards."""

    total: int
    done: int = 0
    updated: int = 0
    failed: int = 0
    running: bool = True

    def event(self) -> dict[str, Any]:
        return {
            "event": "logo_refresh",
            "done": self.done,
            "total": self.total,
            "updated": self.updated,
            "failed": self.failed,
            "running": self.running,
        }
