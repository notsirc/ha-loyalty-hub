"""Config flow (single instance) + options flow for Loyalty Hub (§13.2, §14.1, §14.3)."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

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
    DOMAIN,
    NAME,
)
from .core.countries import country_choices, resolve_country
from .core.logo_key import LogoKeyError, key_test_error, validate_user_key
from .core.logo_sources import PROVIDER_LOGO_DEV, PROVIDER_ORDER
from .core.price_sites import default_price_sites, suggested_price_sites
from .core.settings import (
    MAX_EXPIRY_WARNING_DAYS,
    MAX_LOGO_MAX_FILES,
    MAX_LOGO_MAX_MB,
    MIN_EXPIRY_WARNING_DAYS,
    MIN_LOGO_MAX_FILES,
    MIN_LOGO_MAX_MB,
    format_price_sites,
    parse_price_sites,
    sanitize_expiry_days,
    sanitize_logo_max_files,
    sanitize_logo_max_mb,
    sanitize_price_sites,
)
from .logos import async_test_logo_dev_key

CONF_LOGO_DEV_TOKEN_CLEAR = "logo_dev_token_clear"
# §14.1: "Test the key before saving" (HA dialogs have no free buttons: the box acts as one).
CONF_TEST_KEY = "test_logo_dev_key"

DEFAULT_PROVIDERS = [PROVIDER_LOGO_DEV]
LOGO_DEV_SIGNUP_URL = "https://www.logo.dev/"


def _check_key(raw: str) -> tuple[str, str | None]:
    """(clean key or "", flow error key or None). Empty input is not an error."""
    raw = (raw or "").strip()
    if not raw:
        return "", None
    try:
        return validate_user_key(raw), None
    except LogoKeyError as exc:
        return "", exc.reason


def _placeholders() -> dict[str, str]:
    return {"signup_url": LOGO_DEV_SIGNUP_URL}


def _country_selector() -> SelectSelector:
    return SelectSelector(
        SelectSelectorConfig(
            options=country_choices(),
            mode=SelectSelectorMode.DROPDOWN,
            translation_key=CONF_DEFAULT_COUNTRY,
            sort=True,
        )
    )


def _providers_selector() -> SelectSelector:
    return SelectSelector(
        SelectSelectorConfig(
            options=list(PROVIDER_ORDER),  # §15.1: the single order
            multiple=True,
            mode=SelectSelectorMode.LIST,
            translation_key=CONF_LOGO_PROVIDERS,
        )
    )


class LoyaltyHubConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def _async_key_error(self, key: str, test: bool) -> str | None:
        """§14.1: test a new key with one request to Logo.dev (when the box is ticked)."""
        if not key or not test:
            return None
        return key_test_error(await async_test_logo_dev_key(self.hass, key))

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """One window: guide, the household's key (tested), providers and country."""
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        errors: dict[str, str] = {}
        providers = list(DEFAULT_PROVIDERS)
        country = resolve_country(self.hass.config.country)
        test_key = True
        if user_input is not None:
            providers = [p for p in user_input.get(CONF_LOGO_PROVIDERS) or [] if p in PROVIDER_ORDER]
            country = resolve_country(user_input.get(CONF_DEFAULT_COUNTRY, country))
            test_key = user_input.get(CONF_TEST_KEY, True) is not False
            key, error = _check_key(user_input.get(CONF_LOGO_DEV_TOKEN, ""))
            if not error:
                error = await self._async_key_error(key, test_key)
            if error:
                errors[CONF_LOGO_DEV_TOKEN] = error
            else:
                options: dict[str, Any] = {
                    # §14.3: the suggested sites of the chosen country, else the generic list.
                    CONF_PRICE_COMPARE: default_price_sites(country),
                    CONF_EXPIRY_WARNING_DAYS: DEFAULT_EXPIRY_WARNING_DAYS,
                    CONF_LOGO_PROVIDERS: providers,
                    CONF_DEFAULT_COUNTRY: country,
                }
                if key:
                    options[CONF_LOGO_DEV_TOKEN] = key
                return self.async_create_entry(title=NAME, data={}, options=options)
        schema = vol.Schema(
            {
                # Never pre-filled: a refused key is not sent back to the browser.
                vol.Optional(CONF_LOGO_DEV_TOKEN): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.PASSWORD)
                ),
                vol.Optional(CONF_TEST_KEY, default=test_key): BooleanSelector(),
                vol.Optional(CONF_LOGO_PROVIDERS, default=providers): _providers_selector(),
                vol.Required(CONF_DEFAULT_COUNTRY, default=country): _country_selector(),
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=schema,
            errors=errors,
            description_placeholders=_placeholders(),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return LoyaltyHubOptionsFlow()


class LoyaltyHubOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        placeholders = {"invalid": ""}
        options = self.config_entry.options
        sites_text = format_price_sites(
            sanitize_price_sites(options.get(CONF_PRICE_COMPARE, DEFAULT_PRICE_COMPARE))
        )
        days = sanitize_expiry_days(
            options.get(CONF_EXPIRY_WARNING_DAYS, DEFAULT_EXPIRY_WARNING_DAYS)
        )
        providers = [p for p in options.get(CONF_LOGO_PROVIDERS) or [] if p in PROVIDER_ORDER]
        max_files = sanitize_logo_max_files(options.get(CONF_LOGO_MAX_FILES))
        max_mb = sanitize_logo_max_mb(options.get(CONF_LOGO_MAX_MB))
        admin_full = options.get(CONF_ADMIN_FULL_ACCESS) is True
        country = resolve_country(
            options.get(CONF_DEFAULT_COUNTRY, self.hass.config.country)
        )
        test_key = True
        if user_input is not None:
            sites_text = user_input.get(CONF_PRICE_COMPARE, "")
            days = sanitize_expiry_days(user_input.get(CONF_EXPIRY_WARNING_DAYS, days))
            providers = [p for p in user_input.get(CONF_LOGO_PROVIDERS) or [] if p in PROVIDER_ORDER]
            max_files = sanitize_logo_max_files(user_input.get(CONF_LOGO_MAX_FILES, max_files))
            max_mb = sanitize_logo_max_mb(user_input.get(CONF_LOGO_MAX_MB, max_mb))
            admin_full = user_input.get(CONF_ADMIN_FULL_ACCESS) is True
            country = resolve_country(user_input.get(CONF_DEFAULT_COUNTRY, country))
            test_key = user_input.get(CONF_TEST_KEY, True) is not False
            # The token is never shown back: empty input keeps the stored one.
            token = options.get(CONF_LOGO_DEV_TOKEN) or ""
            new_token = (user_input.get(CONF_LOGO_DEV_TOKEN) or "").strip()
            if user_input.get(CONF_LOGO_DEV_TOKEN_CLEAR):
                token = ""
            elif new_token:
                checked, key_error = _check_key(new_token)
                if not key_error and test_key:
                    key_error = key_test_error(await async_test_logo_dev_key(self.hass, checked))
                if key_error:
                    errors[CONF_LOGO_DEV_TOKEN] = key_error
                else:
                    token = checked
            sites, invalid = parse_price_sites(sites_text)
            if invalid:
                errors[CONF_PRICE_COMPARE] = "invalid_price_sites"
                placeholders["invalid"] = "; ".join(invalid[:3])
            if not errors:
                data: dict[str, Any] = {
                    CONF_PRICE_COMPARE: sites,
                    CONF_EXPIRY_WARNING_DAYS: days,
                    CONF_LOGO_PROVIDERS: providers,
                    CONF_LOGO_MAX_FILES: max_files,
                    CONF_LOGO_MAX_MB: max_mb,
                    CONF_ADMIN_FULL_ACCESS: admin_full,
                    CONF_DEFAULT_COUNTRY: country,
                }
                if token:
                    data[CONF_LOGO_DEV_TOKEN] = token
                return self.async_create_entry(data=data)
        suggested = suggested_price_sites(country)
        schema = vol.Schema(
            {
                vol.Required(CONF_DEFAULT_COUNTRY, default=country): _country_selector(),
                vol.Optional(CONF_PRICE_COMPARE, default=sites_text): TextSelector(
                    TextSelectorConfig(multiline=True)
                ),
                vol.Required(CONF_EXPIRY_WARNING_DAYS, default=days): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_EXPIRY_WARNING_DAYS,
                        max=MAX_EXPIRY_WARNING_DAYS,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                    )
                ),
                vol.Optional(CONF_LOGO_PROVIDERS, default=providers): _providers_selector(),
                # No default: the stored token is never sent to the browser.
                vol.Optional(CONF_LOGO_DEV_TOKEN): TextSelector(
                    TextSelectorConfig(type=TextSelectorType.PASSWORD)
                ),
                vol.Optional(CONF_TEST_KEY, default=test_key): BooleanSelector(),
                vol.Optional(CONF_LOGO_DEV_TOKEN_CLEAR, default=False): BooleanSelector(),
                vol.Required(CONF_LOGO_MAX_FILES, default=max_files): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_LOGO_MAX_FILES,
                        max=MAX_LOGO_MAX_FILES,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                    )
                ),
                vol.Required(CONF_LOGO_MAX_MB, default=max_mb): NumberSelector(
                    NumberSelectorConfig(
                        min=MIN_LOGO_MAX_MB,
                        max=MAX_LOGO_MAX_MB,
                        step=1,
                        mode=NumberSelectorMode.BOX,
                        unit_of_measurement="MB",
                    )
                ),
                # §11.1: off by default; users are shown a notice when it is on.
                vol.Optional(CONF_ADMIN_FULL_ACCESS, default=admin_full): BooleanSelector(),
            }
        )
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=errors,
            description_placeholders={
                **placeholders,
                **_placeholders(),
                # `{query}` appears literally in the help texts: feed it back as a placeholder
                # so the frontend's ICU formatter renders it instead of failing.
                "query": "{query}",
                "token_status": "✓" if options.get(CONF_LOGO_DEV_TOKEN) else "—",
                # §14.3: the suggested sites of the default country (one per line).
                "suggested_sites": (
                    "\n".join(f"- `{line}`" for line in format_price_sites(suggested).splitlines())
                    if suggested
                    else "—"
                ),
            },
        )
