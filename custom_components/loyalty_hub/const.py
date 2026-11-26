"""Constants for Loyalty Hub."""

from __future__ import annotations

from typing import Final

from .core.settings import (  # noqa: F401  (re-exported)
    DEFAULT_EXPIRY_WARNING_DAYS,
    DEFAULT_PRICE_COMPARE,
)

DOMAIN: Final = "loyalty_hub"
NAME: Final = "Loyalty Hub"

STORAGE_KEY: Final = "loyalty_hub.data"
STORAGE_VERSION: Final = 1
SAVE_DELAY: Final = 1

CONF_PRICE_COMPARE: Final = "price_compare"
CONF_EXPIRY_WARNING_DAYS: Final = "expiry_warning_days"

# Dispatcher signal; payload: list[Card] snapshots (before and/or after a change).
SIGNAL_CARDS_CHANGED: Final = f"{DOMAIN}_cards_changed"

# Dispatcher signal (§14.2); payload: (requesting user id, logo_refresh event dict).
SIGNAL_LOGO_REFRESH: Final = f"{DOMAIN}_logo_refresh"

# §14.1: repair issue of the removed Logo.dev trial (v0.4.2), deleted at startup.
OLD_ISSUE_TRIAL_EXPIRED: Final = "logo_dev_trial_expired"

# Dispatcher signal; payload: owner user id of the trash entry that changed (§12.5).
SIGNAL_TRASH_CHANGED: Final = f"{DOMAIN}_trash_changed"

EVENT_ZONE_ENTERED: Final = "loyalty_hub_zone_entered"

PANEL_URL_PATH: Final = "loyalty-hub"
PANEL_COMPONENT: Final = "loyalty-hub-panel"
PANEL_TITLE: Final = "Loyalty Hub"
PANEL_ICON: Final = "mdi:wallet-membership"

STATIC_URL: Final = "/loyalty_hub_static"
FRONTEND_DIR: Final = "frontend"
PANEL_JS: Final = "loyalty-hub-panel.js"
CARD_JS: Final = "loyalty-hub-card.js"

EXPIRY_CHECK_HOUR: Final = 9

CONF_LOGO_PROVIDERS: Final = "logo_providers"
CONF_LOGO_DEV_TOKEN: Final = "logo_dev_token"  # never logged, never sent to clients
CONF_LOGO_MAX_FILES: Final = "logo_max_files"
CONF_LOGO_MAX_MB: Final = "logo_max_mb"
CONF_ADMIN_FULL_ACCESS: Final = "admin_full_access"
# §14.3: country of the shop list for users without their own choice.
CONF_DEFAULT_COUNTRY: Final = "default_country"
LOGO_DIR: Final = ("loyalty_hub", "logos")  # under hass.config.path()
LOGO_VIEW_URL: Final = "/api/loyalty_hub/logo/{card_id}"
I18N_DIR: Final = "i18n"

# §12.2: how often due trash entries are deleted permanently.
TRASH_CHECK_INTERVAL_SECONDS: Final = 60
# §12.3: Companion app event fired when a notification action is pressed.
EVENT_NOTIFICATION_ACTION: Final = "mobile_app_notification_action"
# §12.5: above this many changed cards, subscribers reload everything.
MAX_EVENT_CARD_IDS: Final = 50

# §15.4/§15.5: dispatcher signal; payload: (user id, event dict) for one user only
# (`inbox_changed`, `nfc_linked`).
SIGNAL_USER_EVENT: Final = f"{DOMAIN}_user_event"
# §15.5: dispatcher signal, no payload: `settings_changed` to every subscriber.
SIGNAL_SETTINGS_CHANGED: Final = f"{DOMAIN}_settings_changed"
# §15.5 nfc: HA event fired when a tag is scanned.
EVENT_TAG_SCANNED: Final = "tag_scanned"
