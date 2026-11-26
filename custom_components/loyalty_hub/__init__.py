"""Loyalty Hub: loyalty cards and vouchers for Home Assistant."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.typing import ConfigType
from homeassistant.util import dt as dt_util

from . import websocket_api
from .const import (
    CARD_JS,
    DOMAIN,
    EXPIRY_CHECK_HOUR,
    FRONTEND_DIR,
    I18N_DIR,
    LOGO_DIR,
    OLD_ISSUE_TRIAL_EXPIRED,
    PANEL_COMPONENT,
    PANEL_ICON,
    PANEL_JS,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
)
from .core.admin_access import transition as admin_access_transition
from .core.i18n import load_catalogs
from .inbox_notify import InboxNotifier
from .logos import LogoFiles, LogoView
from .storage import LoyaltyHubData, LoyaltyStore
from .logo_maintenance import LogoMaintenance
from .nfc import NfcManager
from .reminders import UnusedReminders
from .trash_notify import TrashManager
from .zone_watcher import ExpiryChecker, ZoneWatcher

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type LoyaltyHubConfigEntry = ConfigEntry[LoyaltyHubData]

_STATIC_REGISTERED = f"{DOMAIN}_static_registered"
_CARD_URL = f"{DOMAIN}_card_url"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register websocket commands and the logo view once (they use hass.data[DOMAIN])."""
    websocket_api.async_register(hass)
    hass.http.register_view(LogoView())
    return True


def _file_hash(path: Path) -> str:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:10]
    except OSError:
        return "0"


async def _async_register_frontend(hass: HomeAssistant) -> None:
    frontend_path = Path(__file__).parent / FRONTEND_DIR
    exists = await hass.async_add_executor_job(frontend_path.is_dir)
    if not exists:
        _LOGGER.error("Frontend build missing at %s: run `npm run build`", frontend_path)
        return
    if not hass.data.get(_STATIC_REGISTERED):
        # Static paths cannot be unregistered: register once per HA run.
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(frontend_path), cache_headers=True)]
        )
        hass.data[_STATIC_REGISTERED] = True

    panel_v = await hass.async_add_executor_job(_file_hash, frontend_path / PANEL_JS)
    card_v = await hass.async_add_executor_job(_file_hash, frontend_path / CARD_JS)

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        module_url=f"{STATIC_URL}/{PANEL_JS}?v={panel_v}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=False,
        config={},
    )
    card_url = f"{STATIC_URL}/{CARD_JS}?v={card_v}"
    frontend.add_extra_js_url(hass, card_url)
    hass.data[_CARD_URL] = card_url


def _unregister_frontend(hass: HomeAssistant) -> None:
    frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    if card_url := hass.data.pop(_CARD_URL, None):
        frontend.remove_extra_js_url(hass, card_url)


async def async_setup_entry(hass: HomeAssistant, entry: LoyaltyHubConfigEntry) -> bool:
    store = LoyaltyStore(hass)
    await store.async_load()
    catalogs = await hass.async_add_executor_job(
        load_catalogs, Path(__file__).parent / I18N_DIR
    )
    data = LoyaltyHubData(
        store=store,
        entry=entry,
        logos=LogoFiles(Path(hass.config.path(*LOGO_DIR))),
        catalogs=catalogs,
    )
    entry.runtime_data = data
    hass.data[DOMAIN] = data

    # §11.1: an options change reloads the entry, so this sees every toggle.
    admin_access = admin_access_transition(
        store.admin_access, data.admin_full_access, dt_util.utcnow()
    )
    if admin_access != store.admin_access:
        store.admin_access = admin_access
        store.async_schedule_save()

    await _async_register_frontend(hass)

    # §12.2: permanent deletion of due trash entries, now and every 60 s.
    trash_manager = TrashManager(hass, data)
    data.trash = trash_manager
    await trash_manager.async_purge_due()
    entry.async_on_unload(trash_manager.async_start())

    # §14.1: the Logo.dev trial is gone: remove its old repair issue (cleanup).
    ir.async_delete_issue(hass, DOMAIN, OLD_ISSUE_TRIAL_EXPIRED)

    # §14.2: logo cache (hourly and after start) and refresh_all.
    maintenance = LogoMaintenance(hass, data)
    data.maintenance = maintenance
    entry.async_on_unload(maintenance.async_start())

    # §15.4 / §15.5: inbox notification, NFC tags, unused-card reminder.
    inbox_notifier = InboxNotifier(hass, data)
    data.inbox_notifier = inbox_notifier
    entry.async_on_unload(inbox_notifier.async_start())
    nfc = NfcManager(hass, data)
    data.nfc = nfc
    entry.async_on_unload(nfc.async_start())
    reminders = UnusedReminders(hass, data)
    data.reminders = reminders
    entry.async_on_unload(reminders.async_start())

    entry.async_on_unload(ZoneWatcher(hass, data).async_start())
    checker = ExpiryChecker(hass, data)
    entry.async_on_unload(checker.async_start())

    async def _startup_check(_hass: HomeAssistant) -> None:
        # Catch up if HA was down at 09:00 (notify_log prevents duplicates).
        if dt_util.now().hour >= EXPIRY_CHECK_HOUR:
            await checker.async_check()

    entry.async_on_unload(async_at_started(hass, _startup_check))
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _async_options_updated(hass: HomeAssistant, entry: LoyaltyHubConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: LoyaltyHubConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.store.async_flush()
        _unregister_frontend(hass)
        hass.data.pop(DOMAIN, None)
    return unloaded
