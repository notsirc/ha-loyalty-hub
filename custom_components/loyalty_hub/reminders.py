"""Unused-card reminder (ARCHITETTURA §15.5 `unused_reminder`).

On a zone enter with cards (same logic as §6) a 10 min timer starts (in memory,
lost on restart). When it fires and the person is still in the zone and none of
those cards was used since entering, the user gets "Did you use the card X?".
With one card the notification has the action `LOYALTY_HUB_USED_<token>`
(random token, only its sha256 kept in memory for 2 h, as §12.3).
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later
from homeassistant.util import dt as dt_util

from .const import EVENT_NOTIFICATION_ACTION
from .core import models
from .core import notify_logic
from .core.features import F_UNUSED_REMINDER
from .core.models import Card, iso
from .core.permissions import Actor, can_view
from .storage import LoyaltyHubData
from .zone_watcher import async_send_notification


@dataclass
class _Token:
    token_hash: str
    user_id: str
    card_id: str
    expires_at: datetime


class UnusedReminders:
    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data
        self._timers: dict[tuple[str, str], CALLBACK_TYPE] = {}
        self._tokens: list[_Token] = []

    @callback
    def async_start(self) -> Callable[[], None]:
        unsub = self.hass.bus.async_listen(EVENT_NOTIFICATION_ACTION, self._async_on_action)

        @callback
        def _stop() -> None:
            unsub()
            for cancel in self._timers.values():
                cancel()
            self._timers.clear()
            self._tokens.clear()

        return _stop

    @callback
    def async_zone_entered(
        self, user_id: str, person_id: str, zone_id: str, zone_name: str, cards: list[Card]
    ) -> None:
        """Called by the zone watcher for every enter with cards (even if the zone
        notification itself is off)."""
        if not cards or not self.data.feature_on_for(user_id, F_UNUSED_REMINDER):
            return
        key = (user_id, zone_id)
        if cancel := self._timers.pop(key, None):
            cancel()
        entered_at = dt_util.utcnow()
        card_ids = [c.id for c in cards]

        @callback
        def _fire(_now: datetime) -> None:
            self._timers.pop(key, None)
            self.data.entry.async_create_background_task(
                self.hass,
                self._async_check(user_id, person_id, zone_id, zone_name, card_ids, entered_at),
                "loyalty_hub unused reminder",
            )

        self._timers[key] = async_call_later(
            self.hass, notify_logic.UNUSED_DELAY.total_seconds(), _fire
        )

    async def _async_check(
        self,
        user_id: str,
        person_id: str,
        zone_id: str,
        zone_name: str,
        card_ids: list[str],
        entered_at: datetime,
    ) -> None:
        if not self.data.feature_on_for(user_id, F_UNUSED_REMINDER):
            return
        zone = self.hass.states.get(zone_id)
        if zone is None or person_id not in (zone.attributes.get("persons") or []):
            return  # already left
        store = self.data.store
        prefs = store.get_prefs(user_id)
        if not prefs.notify_service:
            return
        actor = Actor(user_id)  # normal visibility, never admin_all
        cards = [
            c
            for cid in card_ids
            if (c := store.cards.get(cid)) is not None and can_view(c, actor)
        ]
        cards = notify_logic.unused_since(cards, entered_at)
        now = dt_util.utcnow()
        if not cards or not notify_logic.unused_cooldown_ok(store.notify_log, user_id, zone_id, now):
            return
        store.notify_log[notify_logic.unused_log_key(user_id, zone_id)] = iso(now)
        store.async_schedule_save()
        token: str | None = None
        if len(cards) == 1:
            token = secrets.token_urlsafe(24)
            self._prune_tokens(now)
            self._tokens.append(
                _Token(
                    notify_logic.hash_token(token),
                    user_id,
                    cards[0].id,
                    now + notify_logic.UNUSED_TOKEN_TTL,
                )
            )
        notification = notify_logic.build_unused_notification(
            zone_id, zone_name, cards, self.data.translator(user_id), token
        )
        await async_send_notification(self.hass, prefs.notify_service, notification)

    def _prune_tokens(self, now: datetime) -> None:
        self._tokens = [t for t in self._tokens if t.expires_at > now]

    @callback
    def _async_on_action(self, event: Event) -> None:
        token = notify_logic.parse_used_action(event.data.get("action"))
        if token is None:
            return
        now = dt_util.utcnow()
        self._prune_tokens(now)
        match = next(
            (t for t in self._tokens if notify_logic.token_matches(token, t.token_hash)), None
        )
        if match is None:
            return  # unknown or expired: ignore silently
        # Only the user's own device (mobile_app uses the device user's context).
        context_user = event.context.user_id if event.context else None
        if context_user != match.user_id:
            return
        self._tokens.remove(match)
        if not self.data.feature_on_for(match.user_id, F_UNUSED_REMINDER):
            return  # switched off meanwhile: its commands are blocked too (§15.5)
        card = self.data.store.cards.get(match.card_id)
        if card is None or not can_view(card, Actor(match.user_id)):
            return
        if models.mark_used(card, now, dt_util.as_local(now)):
            self.data.store.async_cards_changed(card)
