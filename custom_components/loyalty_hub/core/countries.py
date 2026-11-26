"""Country codes for the shop lists (ARCHITETTURA §14.3). Pure Python."""

from __future__ import annotations

import re
from collections.abc import Collection
from typing import Any

from .errors import ERR_INVALID_FORMAT, ValidationError
from .shop_countries import SHOP_COUNTRIES

# A country without a shop list.
OTHER = "other"
MAX_USER_COUNTRIES = 2

# Countries using another country's list (San Marino and Vatican City -> Italy).
ALIASES = {"sm": "it", "va": "it"}

_CC_RE = re.compile(r"^[a-z]{2}$")


def normalize_country(value: Any) -> str | None:
    """Lower-case two-letter code (aliases applied), "other", or None if invalid."""
    if not isinstance(value, str):
        return None
    code = value.strip().lower()
    if code == OTHER:
        return OTHER
    if not _CC_RE.match(code):
        return None
    return ALIASES.get(code, code)


def country_choices(available: Collection[str] = SHOP_COUNTRIES) -> list[str]:
    """Options of the country selector: the countries with data + "other"."""
    return [*available, OTHER]


def resolve_country(value: Any, available: Collection[str] = SHOP_COUNTRIES) -> str:
    """A country with a shop list, else "other" (e.g. hass.config.country)."""
    code = normalize_country(value)
    return code if code is not None and (code == OTHER or code in available) else OTHER


def validate_countries(
    value: Any, available: Collection[str] = SHOP_COUNTRIES
) -> list[str] | None:
    """UserPrefs.countries: None (admin default) or up to 2 distinct valid codes."""
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > MAX_USER_COUNTRIES:
        raise ValidationError(
            f"countries must be a list of at most {MAX_USER_COUNTRIES} codes", ERR_INVALID_FORMAT
        )
    if not value:
        return None
    out: list[str] = []
    for item in value:
        code = normalize_country(item)
        if code is None or (code != OTHER and code not in available):
            raise ValidationError(f"unknown country: {item!r}", ERR_INVALID_FORMAT)
        if code in out:
            raise ValidationError("countries must be distinct", ERR_INVALID_FORMAT)
        out.append(code)
    return out


def load_countries(value: Any, available: Collection[str] = SHOP_COUNTRIES) -> list[str] | None:
    """Lenient loader for stored prefs: invalid data -> None."""
    try:
        return validate_countries(value, available)
    except ValidationError:
        return None
