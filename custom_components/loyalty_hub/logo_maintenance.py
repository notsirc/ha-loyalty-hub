"""Logo cache and bulk refresh (ARCHITETTURA §14.2).

Rules live in core/logo_cache.py; this module only does HA I/O. One round at a
time for the whole instance (refresh_all and the cache share the same lock),
one request every 3 s, in the background.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.start import async_at_started
from homeassistant.util import dt as dt_util

from .const import SIGNAL_LOGO_REFRESH
from .core.errors import LimitReachedError, LoyaltyError
from .core.logo_cache import (
    CACHE_CHECK_INTERVAL,
    PAUSE_SECONDS,
    RefreshJob,
    RefreshProgress,
    checked_after_failure,
    checked_now,
    expired_jobs,
    refresh_all_jobs,
)
from .core.models import set_logo_checked
from .logos import async_lookup_in_order, async_store_logo
from .storage import LoyaltyHubData

_LOGGER = logging.getLogger(__name__)

# Outcome of one job.
_UPDATED = "updated"
_SAME = "same"
_FAILED = "failed"


class LogoMaintenance:
    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data
        self._running = False
        # Test hook: pause between two requests.
        self.pause_seconds = PAUSE_SECONDS

    @property
    def running(self) -> bool:
        return self._running

    @callback
    def async_start(self) -> Callable[[], None]:
        unsubs = [
            async_track_time_interval(
                self.hass, self._async_hourly, CACHE_CHECK_INTERVAL, name="loyalty_hub logo cache"
            ),
            async_at_started(self.hass, self._async_on_started),
        ]

        @callback
        def _stop() -> None:
            for unsub in unsubs:
                unsub()

        return _stop

    # ------------------------------------------------------------ cache

    async def _async_hourly(self, _now: datetime) -> None:
        self.async_check_cache()

    async def _async_on_started(self, _hass: HomeAssistant) -> None:
        self.async_check_cache()

    @callback
    def async_check_cache(self) -> int:
        """Start a cache round if `days` is set and logos expired. Returns the job count."""
        days = self.data.logo_cache_days
        if days is None or self._running:
            return 0
        jobs = expired_jobs(
            list(self.data.store.cards.values()),
            self.data.logo_providers,
            dt_util.utcnow(),
            days,
        )
        if not jobs:
            return 0
        self._start(jobs, requester=None, cache_days=days)
        return len(jobs)

    # ------------------------------------------------------------ refresh_all

    @callback
    def async_start_refresh_all(self, user_id: str, is_admin: bool) -> int:
        """`logo/refresh_all`: own cards (admin: all). limit_reached if a round is running."""
        if self._running:
            raise LimitReachedError("A logo refresh is already running")
        jobs = refresh_all_jobs(
            list(self.data.store.cards.values()),
            self.data.logo_providers,
            None if is_admin else user_id,
        )
        if not jobs:
            return 0
        self._start(jobs, requester=user_id, cache_days=None)
        return len(jobs)

    @callback
    def async_send_progress(self, requester: str, progress: RefreshProgress) -> None:
        """Counts only, to the requesting user's subscriptions."""
        async_dispatcher_send(self.hass, SIGNAL_LOGO_REFRESH, requester, progress.event())

    # ------------------------------------------------------------ round

    @callback
    def _start(self, jobs: list[RefreshJob], requester: str | None, cache_days: int | None) -> None:
        self._running = True
        self.data.entry.async_create_background_task(
            self.hass,
            self._async_run(jobs, requester, cache_days),
            "loyalty_hub logo refresh",
        )

    async def _async_run(
        self, jobs: list[RefreshJob], requester: str | None, cache_days: int | None
    ) -> None:
        progress = RefreshProgress(total=len(jobs))
        try:
            # Background tasks start eagerly: let the caller send `{total}` first.
            await asyncio.sleep(0)
            if requester is not None:
                self.async_send_progress(requester, progress)
            for i, job in enumerate(jobs):
                if i:
                    await asyncio.sleep(self.pause_seconds)
                outcome = await self._async_one(job, cache_days)
                progress.done += 1
                if outcome == _UPDATED:
                    progress.updated += 1
                elif outcome == _FAILED:
                    progress.failed += 1
                if requester is not None:
                    self.async_send_progress(requester, progress)
            _LOGGER.debug(
                "Logo refresh: %d checked, %d updated, %d failed",
                progress.done, progress.updated, progress.failed,
            )
        finally:
            self._running = False
            progress.running = False
            if requester is not None:
                self.async_send_progress(requester, progress)

    async def _async_one(self, job: RefreshJob, cache_days: int | None) -> str:
        """One card. Any failure keeps the local copy."""
        data = self.data
        try:
            blob, mime, provider = await async_lookup_in_order(
                self.hass, data, job.providers, job.domain
            )
        except LoyaltyError:
            self._mark_checked(job, cache_days, failed=True)
            return _FAILED
        card = data.store.cards.get(job.card_id)
        if card is None or (card.logo or {}).get("version") != job.version:
            return _SAME  # deleted, trashed or changed meanwhile: leave it alone
        if card.logo and card.logo.get("mime") == mime:
            current = await self.hass.async_add_executor_job(data.logos.read, card.id, mime)
            if current == blob:
                self._mark_checked(job, cache_days, failed=False)
                return _SAME  # same bytes: same version, devices keep their cache
        try:
            stored = await async_store_logo(
                self.hass,
                data,
                job.card_id,
                provider,
                mime,
                blob,
                domain=job.domain,
                expected_version=job.version,
            )
        except (LoyaltyError, OSError) as exc:  # limit_reached, card deleted, disk full...
            _LOGGER.debug("Logo refresh not saved: %s", getattr(exc, "code", type(exc).__name__))
            self._mark_checked(job, cache_days, failed=True)
            return _FAILED
        return _UPDATED if stored is not None else _SAME

    @callback
    def _mark_checked(self, job: RefreshJob, cache_days: int | None, failed: bool) -> None:
        """Cache rounds only: same bytes -> checked now; failure -> retry in a day."""
        if cache_days is None:
            return
        card = self.data.store.cards.get(job.card_id)
        if card is None or (card.logo or {}).get("version") != job.version:
            return
        now = dt_util.utcnow()
        set_logo_checked(
            card, checked_after_failure(now, cache_days) if failed else checked_now(now)
        )
        self.data.store.async_schedule_save()
