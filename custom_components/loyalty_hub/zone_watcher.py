"""Zone-enter notifications/events, the daily expiry check (ARCHITETTURA §6) and the
§15.5 additions: shopping list lines, unused reminder start, points expiry, low balance."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import datetime

from homeassistant.const import EVENT_STATE_CHANGED
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_change
from homeassistant.util import dt as dt_util

from .const import EVENT_ZONE_ENTERED, EXPIRY_CHECK_HOUR
from .core import notify_logic
from .core.features import F_LOW_BALANCE, F_POINTS_EXPIRY, F_SHOPPING_LIST
from .core.models import Card
from .core.notify_logic import Notification
from .storage import LoyaltyHubData

_LOGGER = logging.getLogger(__name__)


async def async_send_notification(
    hass: HomeAssistant, service: str, notification: Notification
) -> bool:
    if not hass.services.has_service("notify", service):
        _LOGGER.warning("Notify service notify.%s not found", service)
        return False
    try:
        await hass.services.async_call(
            "notify", service, notification.service_data(), blocking=True
        )
    except Exception:  # noqa: BLE001 - a broken phone must not break the loop
        _LOGGER.exception("Failed to send notification via notify.%s", service)
        return False
    return True


class ZoneWatcher:
    """Track zone.* `persons` attribute; supports zones added at runtime."""

    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data
        self._tracked: set[str] = set()
        self._unsub_track: Callable[[], None] | None = None
        self._unsub_bus: Callable[[], None] | None = None

    @callback
    def async_start(self) -> Callable[[], None]:
        self._tracked = set(self.hass.states.async_entity_ids("zone"))
        self._retrack()
        # Catch zones that do not exist yet (created later): state_changed for a
        # zone.* entity we are not tracking.
        self._unsub_bus = self.hass.bus.async_listen(
            EVENT_STATE_CHANGED, self._async_new_zone_event, event_filter=self._is_untracked_zone
        )
        return self.async_stop

    @callback
    def async_stop(self) -> None:
        if self._unsub_track:
            self._unsub_track()
            self._unsub_track = None
        if self._unsub_bus:
            self._unsub_bus()
            self._unsub_bus = None

    @callback
    def _retrack(self) -> None:
        if self._unsub_track:
            self._unsub_track()
            self._unsub_track = None
        if self._tracked:
            self._unsub_track = async_track_state_change_event(
                self.hass, sorted(self._tracked), self._async_zone_event
            )

    @callback
    def _is_untracked_zone(self, event_data: EventStateChangedData) -> bool:
        entity_id: str = event_data["entity_id"]
        return entity_id.startswith("zone.") and entity_id not in self._tracked

    @callback
    def _async_new_zone_event(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        if event.data.get("new_state") is None:
            return  # removed before we tracked it
        self._tracked.add(entity_id)
        self._retrack()
        self._async_zone_event(event)  # the tracker did not see this one

    @callback
    def _async_zone_event(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        new_state = event.data.get("new_state")
        old_state = event.data.get("old_state")
        if new_state is None:
            self._tracked.discard(entity_id)
            return
        if entity_id == notify_logic.ZONE_HOME:
            return
        old_persons = old_state.attributes.get("persons", []) if old_state else []
        entered = notify_logic.entered_persons(old_persons, new_state.attributes.get("persons", []))
        for person_id in entered:
            self.data.entry.async_create_background_task(
                self.hass,
                self._async_person_entered(person_id, entity_id, new_state.name),
                f"loyalty_hub zone enter {person_id}",
            )

    async def _async_person_entered(self, person_id: str, zone_id: str, zone_name: str) -> None:
        person = self.hass.states.get(person_id)
        user_id = person.attributes.get("user_id") if person else None
        if not user_id:
            return
        store = self.data.store
        cards = notify_logic.cards_for_zone(store.cards.values(), user_id, zone_id)
        if not cards:
            return
        if self.data.reminders is not None:
            # §15.5: starts even if the zone notification itself is off.
            self.data.reminders.async_zone_entered(
                user_id, person_id, zone_id, zone_name, cards
            )
        self.hass.bus.async_fire(
            EVENT_ZONE_ENTERED,
            {
                "user_id": user_id,
                "person": person_id,
                "zone": zone_id,
                "card_ids": [c.id for c in cards],
            },
        )
        prefs = store.get_prefs(user_id)
        if not (prefs.zone_notifications and prefs.notify_service):
            return
        now = dt_util.utcnow()
        due = notify_logic.filter_cooldown(cards, user_id, store.notify_log, now)
        if not due:
            return
        # Record before sending so concurrent enters do not double notify.
        notify_logic.record_zone_notified(store.notify_log, user_id, due, now)
        store.async_schedule_save()
        todo_counts: dict[str, int] = {}
        if self.data.feature_on_for(user_id, F_SHOPPING_LIST):
            # §15.7: only the state (count) of the todo entity, never its items.
            for card in due:
                if card.todo_entity and (state := self.hass.states.get(card.todo_entity)):
                    todo_counts[card.id] = notify_logic.todo_count(state.state)
        notification = notify_logic.build_zone_notification(
            zone_id, zone_name, due, self.data.translator(user_id), todo_counts
        )
        await async_send_notification(self.hass, prefs.notify_service, notification)


class ExpiryChecker:
    """Daily (09:00 local) expiry notifications to card owners."""

    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data

    @callback
    def async_start(self) -> Callable[[], None]:
        return async_track_time_change(
            self.hass, self._async_on_time, hour=EXPIRY_CHECK_HOUR, minute=0, second=0
        )

    async def _async_on_time(self, _now: datetime) -> None:
        await self.async_check()

    async def async_check(self) -> None:
        store = self.data.store
        now = dt_util.utcnow()
        today = dt_util.now().date()
        changed = notify_logic.prune_notify_log(store.notify_log, now, today) > 0
        due = notify_logic.expiry_due(
            store.cards.values(), today, self.data.expiry_warning_days, store.notify_log
        )
        for card in due:
            prefs = store.get_prefs(card.owner_id)
            if not (prefs.expiry_notifications and prefs.notify_service):
                continue
            notification = notify_logic.build_expiry_notification(
                card, today, self.data.translator(card.owner_id)
            )
            if await async_send_notification(self.hass, prefs.notify_service, notification):
                notify_logic.record_expiry_notified(store.notify_log, card, now)
                changed = True
        # §15.5 points_expiry: same window and switch, owner only.
        if self.data.feature_enabled(F_POINTS_EXPIRY):
            for card in notify_logic.points_expiry_due(
                store.cards.values(), today, self.data.expiry_warning_days, store.notify_log
            ):
                prefs = store.get_prefs(card.owner_id)
                if not (
                    prefs.expiry_notifications
                    and prefs.notify_service
                    and self.data.feature_on_for(card.owner_id, F_POINTS_EXPIRY)
                ):
                    continue
                notification = notify_logic.build_points_expiry_notification(
                    card, today, self.data.translator(card.owner_id)
                )
                if await async_send_notification(self.hass, prefs.notify_service, notification):
                    notify_logic.record_points_expiry_notified(store.notify_log, card, now)
                    changed = True
        if changed:
            store.async_schedule_save()
        # §15.5 low_balance: also checked daily, for safety.
        await async_check_low_balance(self.hass, self.data, store.cards.values())


async def async_check_low_balance(
    hass: HomeAssistant, data: LoyaltyHubData, cards: Iterable[Card]
) -> None:
    """§15.5: "Low balance" once per low period to every user who sees the voucher
    (normal visibility) with a threshold set."""
    if not data.feature_enabled(F_LOW_BALANCE):
        return
    store = data.store
    vouchers = [c for c in cards if c.kind == notify_logic.KIND_VOUCHER]
    if not vouchers:
        return
    user_ids = [
        u.id for u in await hass.auth.async_get_users() if u.is_active and not u.system_generated
    ]
    today = dt_util.now().date()
    now = dt_util.utcnow()
    changed = False
    for card in vouchers:
        thresholds = {
            uid: store.get_prefs(uid).low_balance_threshold
            for uid in notify_logic.viewer_ids(card, user_ids)
        }
        decision = notify_logic.low_balance_decision(card, thresholds, store.notify_log, today)
        for key in decision.clear:
            store.notify_log.pop(key, None)
            changed = True
        for uid in decision.notify:
            prefs = store.get_prefs(uid)
            if not prefs.notify_service:
                continue
            # Recorded before sending, so concurrent checks do not double notify.
            store.notify_log[notify_logic.low_balance_log_key(uid, card.id)] = notify_logic.iso(now)
            changed = True
            await async_send_notification(
                hass,
                prefs.notify_service,
                notify_logic.build_low_balance_notification(card, data.translator(uid)),
            )
    if changed:
        store.async_schedule_save()
