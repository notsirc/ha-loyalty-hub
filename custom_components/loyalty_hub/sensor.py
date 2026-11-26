"""sensor.loyalty_hub_expiring_vouchers: count only, no personal data."""

from __future__ import annotations

from datetime import datetime

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.event import async_track_time_change
from homeassistant.util import dt as dt_util

from . import LoyaltyHubConfigEntry
from .const import DOMAIN, SIGNAL_CARDS_CHANGED
from .core.notify_logic import count_expiring_vouchers
from .storage import LoyaltyHubData


async def async_setup_entry(
    hass: HomeAssistant,
    entry: LoyaltyHubConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([ExpiringVouchersSensor(entry.runtime_data)])


class ExpiringVouchersSensor(SensorEntity):
    _attr_has_entity_name = False
    _attr_name = "Loyalty Hub expiring vouchers"
    _attr_icon = "mdi:ticket-percent-outline"
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_should_poll = False

    def __init__(self, data: LoyaltyHubData) -> None:
        self._data = data
        self._attr_unique_id = f"{DOMAIN}_expiring_vouchers"
        self.entity_id = "sensor.loyalty_hub_expiring_vouchers"

    @property
    def native_value(self) -> int:
        return count_expiring_vouchers(
            self._data.store.cards.values(),
            dt_util.now().date(),
            self._data.expiry_warning_days,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_CARDS_CHANGED, self._async_changed)
        )
        # The window moves with the date: refresh just after midnight.
        self.async_on_remove(
            async_track_time_change(self.hass, self._async_tick, hour=0, minute=0, second=5)
        )

    @callback
    def _async_changed(self, _cards: list) -> None:
        self.async_write_ha_state()

    @callback
    def _async_tick(self, _now: datetime) -> None:
        self.async_write_ha_state()
