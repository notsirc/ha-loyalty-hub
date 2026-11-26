"""NFC tags that open a card (ARCHITETTURA §15.5 `nfc`).

Links are per user (`UserPrefs.nfc_tags`, server-only). Only `tag_scanned`
events carrying a `context.user_id` are accepted; the card is opened only on
that user's own Companion devices. Tag ids are never logged in full.
"""

from __future__ import annotations

import copy
import logging
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.util import dt as dt_util
from homeassistant.util import slugify

from .const import EVENT_TAG_SCANNED
from .core import features as feature_rules
from .core.errors import LoyaltyError
from .core.features import F_NFC
from .core.models import iso
from .core.notify_logic import NOTIFY_GROUP, PANEL_PATH, Notification
from .core.permissions import Actor, can_view
from .storage import LoyaltyHubData
from .zone_watcher import async_send_notification

_LOGGER = logging.getLogger(__name__)

LINK_WINDOW = timedelta(seconds=60)
MOBILE_APP = "mobile_app"
OS_ANDROID = "android"
NFC_TAG = "loyalty_hub_nfc"


def _device_entry_ids(device: Any) -> list[str]:
    """Config entry ids of a device registry entry.

    Recent Home Assistant versions give a device a single `config_entry_id` and deprecate
    `config_entries` (removed in 2027.10); older versions only have the set.
    """
    entry_id = getattr(device, "config_entry_id", None)
    if isinstance(entry_id, str) and entry_id:
        return [entry_id]
    if hasattr(type(device), "config_entry_id"):
        return []  # new API, device without a config entry
    return list(getattr(device, "config_entries", None) or ())


class NfcManager:
    """`link_start` sessions (in memory) and the `tag_scanned` listener."""

    def __init__(self, hass: HomeAssistant, data: LoyaltyHubData) -> None:
        self.hass = hass
        self.data = data
        # {user_id: (card_id, expires_at)}
        self._pending: dict[str, tuple[str, datetime]] = {}

    @callback
    def async_start(self) -> Callable[[], None]:
        return self.hass.bus.async_listen(EVENT_TAG_SCANNED, self._async_on_tag)

    @callback
    def async_link_start(self, user_id: str, card_id: str) -> str:
        """The next tag scanned by this user within 60 s is linked to the card."""
        expires = dt_util.utcnow() + LINK_WINDOW
        self._pending[user_id] = (card_id, expires)
        return iso(expires)

    def tag_names(self) -> dict[str, str]:
        """{tag_id: name} from HA's tag entities (attribute `tag_id`)."""
        out: dict[str, str] = {}
        for state in self.hass.states.async_all("tag"):
            tag_id = state.attributes.get("tag_id")
            if isinstance(tag_id, str) and tag_id:
                out[tag_id] = state.name or ""
        return out

    @callback
    def _async_on_tag(self, event: Event) -> None:
        user_id = event.context.user_id if event.context else None
        tag_id = event.data.get("tag_id")
        if not user_id or not isinstance(tag_id, str) or not tag_id:
            return  # automations/scripts (no user) are ignored
        if not self.data.feature_enabled(F_NFC):
            self._pending.pop(user_id, None)
            return
        pending = self._pending.get(user_id)
        if pending is not None:
            card_id, expires = pending
            del self._pending[user_id]
            if dt_util.utcnow() <= expires:
                self._async_link(user_id, tag_id, card_id)
                return
        if not self.data.feature_on_for(user_id, F_NFC):
            return
        card_id = self.data.store.get_prefs(user_id).nfc_tags.get(tag_id)
        if card_id is None:
            return
        card = self.data.store.cards.get(card_id)
        # Normal visibility only (never admin_all).
        if card is None or not can_view(card, Actor(user_id)):
            return
        self.data.entry.async_create_background_task(
            self.hass,
            self._async_open(user_id, card.id, card.name, event.data.get("device_id")),
            "loyalty_hub nfc open",
        )

    @callback
    def _async_link(self, user_id: str, tag_id: str, card_id: str) -> None:
        store = self.data.store
        card = store.cards.get(card_id)
        if card is None or not can_view(card, Actor(user_id)):
            return
        prefs = copy.deepcopy(store.get_prefs(user_id))
        try:
            prefs.nfc_tags = feature_rules.link_tag(prefs.nfc_tags, tag_id, card_id)
        except LoyaltyError as exc:
            _LOGGER.info("NFC tag %s not linked: %s", feature_rules.redact_tag(tag_id), exc.message)
            return
        store.prefs[user_id] = prefs
        store.async_schedule_save()
        store.async_user_event(user_id, {"event": "nfc_linked", "card_id": card_id})

    # ------------------------------------------------------------ opening the card

    def _user_mobile_entries(self, user_id: str) -> list[Any]:
        return [
            e
            for e in self.hass.config_entries.async_entries(MOBILE_APP)
            if e.data.get("user_id") == user_id and e.data.get("device_name")
        ]

    def _target(self, user_id: str, device_id: Any) -> tuple[str, str] | None:
        """(notify service, os name) of the scanning device, else of prefs.notify_service."""
        if isinstance(device_id, str) and device_id:
            candidates: list[Any] = []
            device = dr.async_get(self.hass).async_get(device_id)
            if device is not None:
                for entry_id in _device_entry_ids(device):
                    entry = self.hass.config_entries.async_get_entry(entry_id)
                    if entry is not None and entry.domain == MOBILE_APP:
                        candidates.append(entry)
            # The Companion app's scan_tag passes the app's own device id (the one in its
            # mobile_app entry), not the device registry id: match that one too.
            candidates.extend(
                e for e in self._user_mobile_entries(user_id) if e.data.get("device_id") == device_id
            )
            for entry in candidates:
                if entry.data.get("user_id") == user_id and entry.data.get("device_name"):
                    service = f"mobile_app_{slugify(entry.data['device_name'])}"
                    if self.hass.services.has_service("notify", service):
                        return service, str(entry.data.get("os_name") or "")
        service = self.data.store.get_prefs(user_id).notify_service
        if not service:
            return None
        os_name = ""
        for entry in self._user_mobile_entries(user_id):
            if f"mobile_app_{slugify(entry.data['device_name'])}" == service:
                os_name = str(entry.data.get("os_name") or "")
                break
        return service, os_name

    async def _async_open(
        self, user_id: str, card_id: str, card_name: str, device_id: Any
    ) -> None:
        target = self._target(user_id, device_id)
        if target is None:
            return
        service, os_name = target
        url = f"{PANEL_PATH}?card={card_id}"
        if os_name.strip().lower() == OS_ANDROID:
            # Opens the Companion app's webview on the card.
            command = _Command(title="", message="command_webview", data={"command": url})
            await async_send_notification(self.hass, service, command)
            return
        t = self.data.translator(user_id)
        notification = Notification(
            title=t("nfc.title"),
            message=t("nfc.message", name=card_name),
            data={"url": url, "clickAction": url, "tag": NFC_TAG, "group": NOTIFY_GROUP},
        )
        await async_send_notification(self.hass, service, notification)


class _Command(Notification):
    """Companion app command: message + data, no title."""

    def service_data(self) -> dict[str, Any]:
        return {"message": self.message, "data": self.data}
