"""Inbox of cards created for / transferred to a user, and its grouped notification (§15.4).

The rules live in core/inbox.py; this module only does Home Assistant I/O.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from datetime import datetime

from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util

from .core import inbox as inbox_rules
from .core.models import iso
from .storage import LoyaltyHubData
from .zone_watcher import async_send_notification

EVENT_INBOX_CHANGED = {"event": "inbox_changed"}


class InboxNotifier:
    """Adds inbox entries and sends one grouped notification 2 min after the last one."""

    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data
        # In memory only: a restart loses a pending notification (the banner stays).
        self._timers: dict[str, CALLBACK_TYPE] = {}

    @callback
    def async_start(self) -> Callable[[], None]:
        return self.async_stop

    @callback
    def async_stop(self) -> None:
        for cancel in self._timers.values():
            cancel()
        self._timers.clear()

    @callback
    def async_add(self, user_id: str, card_ids: Iterable[str], by: str, kind: str) -> None:
        """Record arrivals for `user_id` (never the sender himself)."""
        ids = list(card_ids)
        if not ids or user_id == by:
            return
        at = iso(dt_util.utcnow())
        for card_id in ids:
            inbox_rules.add_entry(self.data.store.inbox, user_id, card_id, by, at, kind)
        self.data.store.async_schedule_save()
        self.data.store.async_user_event(user_id, EVENT_INBOX_CHANGED)
        self._async_reschedule(user_id)

    @callback
    def _async_reschedule(self, user_id: str) -> None:
        if cancel := self._timers.pop(user_id, None):
            cancel()

        @callback
        def _fire(_now: datetime) -> None:
            self._timers.pop(user_id, None)
            self.data.entry.async_create_background_task(
                self.hass, self._async_send(user_id), "loyalty_hub inbox notification"
            )

        self._timers[user_id] = async_call_later(
            self.hass, inbox_rules.NOTIFY_DELAY.total_seconds(), _fire
        )

    async def _async_send(self, user_id: str) -> None:
        store = self.data.store
        prefs = store.get_prefs(user_id)
        if not (prefs.inbox_notifications and prefs.notify_service):
            return
        entries, changed = inbox_rules.valid_entries(store.inbox, user_id, store.cards)
        if changed:
            store.async_schedule_save()
        names = {u.id: u.name or "" for u in await self.hass.auth.async_get_users()}
        notification = inbox_rules.build_notification(
            entries, names, self.data.translator(user_id)
        )
        if notification is not None:
            await async_send_notification(self.hass, prefs.notify_service, notification)
