"""Trash: permanent deletion and the owner's actionable notification (§12.2, §12.3).

The rules live in core/trash.py; this module only does Home Assistant I/O.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime, timedelta

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import EVENT_NOTIFICATION_ACTION, TRASH_CHECK_INTERVAL_SECONDS
from .core import trash as trash_rules
from .core.errors import NotFoundError
from .core.models import Card
from .core.trash import TrashEntry
from .storage import LoyaltyHubData
from .zone_watcher import async_send_notification

_LOGGER = logging.getLogger(__name__)


class TrashManager:
    """Periodic purge, request notifications and the notification action listener."""

    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data

    @callback
    def async_start(self) -> Callable[[], None]:
        unsub_timer = async_track_time_interval(
            self.hass,
            self._async_on_interval,
            timedelta(seconds=TRASH_CHECK_INTERVAL_SECONDS),
            name="loyalty_hub trash purge",
        )
        unsub_event = self.hass.bus.async_listen(
            EVENT_NOTIFICATION_ACTION, self._async_on_action
        )

        @callback
        def _stop() -> None:
            unsub_timer()
            unsub_event()

        return _stop

    async def _async_on_interval(self, _now: datetime) -> None:
        await self.async_purge_due()

    # ------------------------------------------------------------ deletion

    async def async_purge_due(self) -> int:
        """Delete permanently every entry past retention or purge countdown."""
        store = self.data.store
        ids = trash_rules.due_ids(store.trash, dt_util.utcnow())
        if not ids:
            return 0
        owners: list[str] = []
        removed: list[str] = []
        # Remove every due entry before the first await, so that an entry restored and
        # trashed again meanwhile (same id, not due) is never deleted by this round.
        for card_id in ids:
            entry = store.trash.pop(card_id, None)
            if entry is None:
                continue
            owners.append(entry.owner_id)
            removed.append(card_id)
            for key in trash_rules.notify_log_keys(store.notify_log, card_id):
                del store.notify_log[key]
            if entry.has_pending_request:
                self.async_clear_notification(entry)
        store.async_trash_changed(*owners)
        for card_id in removed:
            # Never delete the file of a live card or of a card trashed again meanwhile.
            if card_id not in store.cards and card_id not in store.trash:
                await self.hass.async_add_executor_job(self.data.logos.delete, card_id)
        return len(owners)

    # ------------------------------------------------------------ notifications

    async def async_send_request(self, entry: TrashEntry, admin_name: str, token: str) -> bool:
        """Notify the owner. False if no notify service is set or sending failed."""
        prefs = self.data.store.get_prefs(entry.owner_id)
        if not prefs.notify_service:
            return False
        notification = trash_rules.build_request_notification(
            entry, admin_name, token, self.data.translator(entry.owner_id)
        )
        return await async_send_notification(self.hass, prefs.notify_service, notification)

    @callback
    def async_clear_notification(self, entry: TrashEntry) -> None:
        """Remove the owner's request notification (best effort, in background)."""
        service = self.data.store.get_prefs(entry.owner_id).notify_service
        if not service or not self.hass.services.has_service("notify", service):
            return
        self.data.entry.async_create_background_task(
            self.hass,
            self._async_clear(service, entry.card_id),
            "loyalty_hub trash clear notification",
        )

    async def _async_clear(self, service: str, card_id: str) -> None:
        try:
            await self.hass.services.async_call(
                "notify", service, trash_rules.clear_notification_data(card_id), blocking=True
            )
        except Exception:  # noqa: BLE001 - best effort only
            _LOGGER.debug("Could not clear the trash notification via notify.%s", service)

    # ------------------------------------------------------------ owner's answer

    @callback
    def async_respond(self, entry: TrashEntry, response: str) -> Card | None:
        """Apply the owner's answer (caller checked ownership). Returns the restored card."""
        store = self.data.store
        was_pending = entry.has_pending_request
        accepted = trash_rules.respond(entry, response)
        card: Card | None = None
        if accepted:
            card = trash_rules.restore(store.cards, store.trash, entry.card_id, dt_util.utcnow())
            store.async_cards_changed(card)
        if was_pending and (accepted or not entry.has_pending_request):
            self.async_clear_notification(entry)
        store.async_trash_changed(entry.owner_id)
        return card

    @callback
    def _async_on_action(self, event: Event) -> None:
        parsed = trash_rules.parse_action(event.data.get("action"))
        if parsed is None:
            return
        response, token = parsed
        entry = trash_rules.find_by_token(self.data.store.trash, token)
        if entry is None:
            return  # unknown, used or replaced token: ignore silently
        # mobile_app fires this event with the context of the device's registered user.
        # Anything else (no user: automations/scripts; another user: fire_event) is ignored,
        # because the token is visible to admins in the `call_service` event.
        context_user = event.context.user_id if event.context else None
        if context_user != entry.owner_id:
            return
        try:
            self.async_respond(entry, response)
        except NotFoundError:
            return
