"""Persistence wrapper around homeassistant.helpers.storage.Store."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from .const import (
    CONF_ADMIN_FULL_ACCESS,
    CONF_DEFAULT_COUNTRY,
    CONF_EXPIRY_WARNING_DAYS,
    CONF_LOGO_DEV_TOKEN,
    CONF_LOGO_MAX_FILES,
    CONF_LOGO_MAX_MB,
    CONF_LOGO_PROVIDERS,
    CONF_PRICE_COMPARE,
    DEFAULT_EXPIRY_WARNING_DAYS,
    DEFAULT_PRICE_COMPARE,
    SAVE_DELAY,
    SIGNAL_CARDS_CHANGED,
    SIGNAL_SETTINGS_CHANGED,
    SIGNAL_TRASH_CHANGED,
    SIGNAL_USER_EVENT,
    STORAGE_KEY,
    STORAGE_VERSION,
)
from .core.admin_access import default_state as default_admin_access
from .core.admin_access import load_state as load_admin_access
from .core import features as feature_rules
from .core.i18n import Translator, resolve_language
from .core.inbox import load_inbox
from .core.countries import resolve_country
from .core.logo_cache import default_cache_state, load_cache_state
from .core.logo_key import logo_dev_state
from .core.logo_preview import PreviewStore
from .core.logo_sources import PROVIDER_LOGO_DEV, PROVIDER_ORDER
from .core.models import Card, UserPrefs, default_prefs
from .core.permissions import Actor
from .core.trash import TrashEntry
from .core.settings import (
    sanitize_currency,
    sanitize_expiry_days,
    sanitize_logo_max_files,
    sanitize_logo_max_mb,
    sanitize_price_sites,
)

if TYPE_CHECKING:
    from .logos import LogoFiles
    from .logo_maintenance import LogoMaintenance
    from .inbox_notify import InboxNotifier
    from .nfc import NfcManager
    from .reminders import UnusedReminders
    from .trash_notify import TrashManager

_LOGGER = logging.getLogger(__name__)


class LoyaltyStore:
    """In-memory model backed by a private, atomically written Store."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY, private=True, atomic_writes=True
        )
        self.cards: dict[str, Card] = {}
        self.prefs: dict[str, UserPrefs] = {}
        self.notify_log: dict[str, str] = {}
        # §11.1: {enabled, changed_at, epoch} of the admin_full_access option.
        self.admin_access: dict[str, Any] = default_admin_access()
        # §12.2: deleted cards, {card_id: TrashEntry}.
        self.trash: dict[str, TrashEntry] = {}
        # §14.2: logo cache, {days: int | None} (None = keep forever).
        self.logo_cache: dict[str, Any] = default_cache_state()
        # §15.5: {feature_id: bool}; a missing id is off.
        self.features: dict[str, bool] = {}
        # §15.4: {user_id: [{card_id, by, at, kind}]}.
        self.inbox: dict[str, list[dict[str, str]]] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        for card_id, raw in (data.get("cards") or {}).items():
            try:
                self.cards[card_id] = Card.from_dict(raw)
            except (KeyError, TypeError, ValueError):
                _LOGGER.warning("Skipping corrupted card %s in storage", card_id)
        for user_id, raw in (data.get("prefs") or {}).items():
            try:
                self.prefs[user_id] = UserPrefs.from_dict({**raw, "user_id": user_id})
            except (KeyError, TypeError, ValueError):
                _LOGGER.warning("Skipping corrupted prefs for %s", user_id)
        self.notify_log = dict(data.get("notify_log") or {})
        self.admin_access = load_admin_access(data.get("admin_access"))
        self.logo_cache = load_cache_state(data.get("logo_cache"))
        self.features = feature_rules.load_features(data.get("features"))
        self.inbox = load_inbox(data.get("inbox"))
        for card_id, raw in (data.get("trash") or {}).items():
            if card_id in self.cards:
                continue  # restored card: the live copy wins
            try:
                self.trash[card_id] = TrashEntry.from_dict(raw)
            except (KeyError, TypeError, ValueError):
                _LOGGER.warning("Skipping corrupted trash item %s in storage", card_id)

    @callback
    def _data_to_save(self) -> dict[str, Any]:
        return {
            # §12.1: compact storage format (API output keeps using to_dict()).
            "cards": {cid: card.to_storage() for cid, card in self.cards.items()},
            "prefs": {uid: p.to_storage() for uid, p in self.prefs.items()},
            "notify_log": dict(self.notify_log),
            "admin_access": dict(self.admin_access),
            "trash": {cid: entry.to_storage() for cid, entry in self.trash.items()},
            "logo_cache": dict(self.logo_cache),
            "features": dict(self.features),
            "inbox": {uid: [dict(e) for e in items] for uid, items in self.inbox.items()},
        }

    @callback
    def async_schedule_save(self) -> None:
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY)

    async def async_flush(self) -> None:
        """Write pending data immediately (used on unload)."""
        await self._store.async_save(self._data_to_save())

    @callback
    def async_cards_changed(self, *cards: Card) -> None:
        """Persist and notify listeners (websocket subscribers, sensor)."""
        self.async_schedule_save()
        async_dispatcher_send(self.hass, SIGNAL_CARDS_CHANGED, list(cards))

    @callback
    def async_trash_changed(self, *owner_ids: str) -> None:
        """Persist and tell the owners of the entries (and admins) to reload the trash."""
        self.async_schedule_save()
        for owner_id in dict.fromkeys(owner_ids):
            async_dispatcher_send(self.hass, SIGNAL_TRASH_CHANGED, owner_id)

    @callback
    def async_user_event(self, user_id: str, event: dict[str, Any]) -> None:
        """Send a subscribe event to one user only (inbox_changed, nfc_linked)."""
        async_dispatcher_send(self.hass, SIGNAL_USER_EVENT, user_id, dict(event))

    @callback
    def async_settings_changed(self) -> None:
        """Persist and tell every subscriber to reload `settings` (§15.5)."""
        self.async_schedule_save()
        async_dispatcher_send(self.hass, SIGNAL_SETTINGS_CHANGED)

    def get_prefs(self, user_id: str) -> UserPrefs:
        return self.prefs.get(user_id) or default_prefs(user_id)


@dataclass
class LoyaltyHubData:
    """Runtime data stored in entry.runtime_data and hass.data[DOMAIN]."""

    store: LoyaltyStore
    entry: ConfigEntry
    logos: LogoFiles
    catalogs: dict[str, dict[str, str]] = field(default_factory=dict)
    # §12.2/§12.3: permanent deletion and the owner's notification (set in setup).
    trash: TrashManager | None = None
    # §14.2: logo cache and refresh_all (set in setup).
    maintenance: LogoMaintenance | None = None
    # §15.4/§15.5 (set in setup).
    inbox_notifier: InboxNotifier | None = None
    nfc: NfcManager | None = None
    reminders: UnusedReminders | None = None
    # §14.2: in-memory logo previews (never persisted).
    previews: PreviewStore = field(default_factory=PreviewStore)
    # §14.2: one logo file operation at a time per card.
    _logo_locks: dict[str, asyncio.Lock] = field(default_factory=dict)

    def logo_lock(self, card_id: str) -> asyncio.Lock:
        lock = self._logo_locks.get(card_id)
        if lock is None:
            lock = self._logo_locks[card_id] = asyncio.Lock()
        return lock

    def translator(self, user_id: str | None) -> Translator:
        """Notification language: prefs.language -> hass.config.language -> en."""
        prefs_lang = self.store.get_prefs(user_id).language if user_id else None
        lang = resolve_language(
            self.catalogs, [prefs_lang, self.store.hass.config.language]
        )
        return Translator(self.catalogs, lang)

    def feature_enabled(self, feature: str) -> bool:
        """§15.5: switched on by the administrator."""
        return feature_rules.is_enabled(self.store.features, feature)

    def feature_on_for(self, user_id: str, feature: str) -> bool:
        """§15.5: on for the admin and not switched off by this user (per-user features)."""
        prefs = self.store.get_prefs(user_id)
        return feature_rules.enabled_for(self.store.features, prefs.features_off, feature)

    def require_feature(self, feature: str) -> None:
        feature_rules.require(self.store.features, feature)

    @property
    def logo_dev_token(self) -> str | None:
        """The household's Logo.dev key (options, §14.1). Never logged nor sent out."""
        token = self.entry.options.get(CONF_LOGO_DEV_TOKEN)
        return token.strip() if isinstance(token, str) and token.strip() else None

    @property
    def logo_dev_state(self) -> str:
        """`ready` | `no_key` | `disabled` (provider off in the options)."""
        enabled = PROVIDER_LOGO_DEV in (self.entry.options.get(CONF_LOGO_PROVIDERS) or [])
        return logo_dev_state(enabled, self.logo_dev_token)

    @property
    def logo_providers(self) -> list[str]:
        """Enabled online providers, in canonical order; logo_dev only when `ready`."""
        enabled = set(self.entry.options.get(CONF_LOGO_PROVIDERS) or [])
        return [
            p
            for p in PROVIDER_ORDER  # §15.1
            if p in enabled and (p != PROVIDER_LOGO_DEV or self.logo_dev_token)
        ]

    @property
    def logo_cache_days(self) -> int | None:
        return self.store.logo_cache.get("days")

    @property
    def default_country(self) -> str:
        """§14.3: the admin's country (options), else HA's country, else "other"."""
        stored = self.entry.options.get(CONF_DEFAULT_COUNTRY)
        if stored is not None:
            return resolve_country(stored)
        return resolve_country(self.store.hass.config.country)

    @property
    def currency(self) -> str:
        """§14.3: HA's currency (fallback EUR)."""
        return sanitize_currency(getattr(self.store.hass.config, "currency", None))

    @property
    def price_compare(self) -> list[dict[str, str]]:
        return sanitize_price_sites(
            self.entry.options.get(CONF_PRICE_COMPARE, DEFAULT_PRICE_COMPARE)
        )

    @property
    def admin_full_access(self) -> bool:
        """Option "admin sees and edits everything" (§11.1), default off."""
        return self.entry.options.get(CONF_ADMIN_FULL_ACCESS) is True

    def actor(self, user: Any) -> Actor:
        """Permission context for an HA user (connection.user / request user)."""
        is_admin = bool(getattr(user, "is_admin", False))
        return Actor(user.id, is_admin, is_admin and self.admin_full_access)

    @property
    def logo_max_files(self) -> int:
        return sanitize_logo_max_files(self.entry.options.get(CONF_LOGO_MAX_FILES))

    @property
    def logo_max_bytes(self) -> int:
        return sanitize_logo_max_mb(self.entry.options.get(CONF_LOGO_MAX_MB)) * 1024 * 1024

    @property
    def expiry_warning_days(self) -> int:
        return sanitize_expiry_days(
            self.entry.options.get(CONF_EXPIRY_WARNING_DAYS, DEFAULT_EXPIRY_WARNING_DAYS)
        )
