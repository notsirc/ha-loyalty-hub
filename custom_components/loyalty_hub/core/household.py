"""Household shops (ARCHITETTURA §14.3 "Negozi della casa"). Pure Python.

Shops typed by hand on any card of the household, suggested to everybody:
shared cards always, private cards only with `suggest_shop`. Only the shop name,
its domain and its color leave the server: never codes, notes, ids, owners or
how many cards use a shop.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any

from .models import VIS_SHARED, Card

MAX_HOUSEHOLD_SHOPS = 500

_SPACES_RE = re.compile(r"\s+")


def normalize_shop_name(name: str) -> str:
    """Case-, accent- and space-insensitive key."""
    decomposed = unicodedata.normalize("NFKD", name)
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return _SPACES_RE.sub(" ", stripped).strip().casefold()


def is_suggested(card: Card) -> bool:
    return card.shop_custom and (card.visibility == VIS_SHARED or card.suggest_shop)


def household_shops(cards: Iterable[Card]) -> list[dict[str, Any]]:
    """[{name, domain, color}], deduplicated by normalized name + domain, sorted by name.

    `cards` must be the live cards (never the trash). On duplicates the choice is
    deterministic (it does not depend on who owns the cards or when they were made).
    """
    best: dict[tuple[str, str | None], dict[str, Any]] = {}
    for card in cards:
        if not is_suggested(card):
            continue
        name = card.name.strip()
        key = (normalize_shop_name(name), card.logo_domain)
        if not key[0]:
            continue
        candidate = {"name": name, "domain": card.logo_domain, "color": card.color}
        current = best.get(key)
        if current is None or (candidate["name"], candidate["color"]) < (
            current["name"],
            current["color"],
        ):
            best[key] = candidate
    shops = sorted(
        best.values(), key=lambda s: (normalize_shop_name(s["name"]), s["domain"] or "")
    )
    return shops[:MAX_HOUSEHOLD_SHOPS]
