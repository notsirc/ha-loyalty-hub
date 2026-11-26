"""Suggested price comparison sites per country (ARCHITETTURA §14.3). Pure Python.

Used as the default sites at the first configuration (country chosen there) and
shown as suggestions in the options. `{query}` is replaced by the searched text.
"""

from __future__ import annotations

from .settings import DEFAULT_PRICE_COMPARE

SUGGESTED_PRICE_SITES: dict[str, list[dict[str, str]]] = {
    "it": [dict(s) for s in DEFAULT_PRICE_COMPARE],
    "de": [
        {"name": "Idealo", "url": "https://www.idealo.de/preisvergleich/MainSearchProductCategory.html?q={query}"},
        {"name": "Geizhals", "url": "https://geizhals.de/?fs={query}"},
        {"name": "Google Shopping", "url": "https://www.google.de/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.de/s?k={query}"},
    ],
    "at": [
        {"name": "Geizhals", "url": "https://geizhals.at/?fs={query}"},
        {"name": "Idealo", "url": "https://www.idealo.at/preisvergleich/MainSearchProductCategory.html?q={query}"},
        {"name": "Google Shopping", "url": "https://www.google.at/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.de/s?k={query}"},
    ],
    "ch": [
        {"name": "Toppreise", "url": "https://www.toppreise.ch/produktsuche?q={query}"},
        {"name": "Google Shopping", "url": "https://www.google.ch/search?tbm=shop&q={query}"},
    ],
    "fr": [
        {"name": "Idealo", "url": "https://www.idealo.fr/prechcat.html?q={query}"},
        {"name": "LeDénicheur", "url": "https://ledenicheur.fr/search?search={query}"},
        {"name": "Google Shopping", "url": "https://www.google.fr/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.fr/s?k={query}"},
    ],
    "es": [
        {"name": "Idealo", "url": "https://www.idealo.es/prechcat.html?q={query}"},
        {"name": "Google Shopping", "url": "https://www.google.es/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.es/s?k={query}"},
    ],
    "gb": [
        {"name": "PriceSpy", "url": "https://pricespy.co.uk/search?search={query}"},
        {"name": "Idealo", "url": "https://www.idealo.co.uk/prechcat.html?q={query}"},
        {"name": "Google Shopping", "url": "https://www.google.co.uk/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.co.uk/s?k={query}"},
    ],
    "us": [
        {"name": "Google Shopping", "url": "https://www.google.com/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.com/s?k={query}"},
        {"name": "eBay", "url": "https://www.ebay.com/sch/i.html?_nkw={query}"},
    ],
    "nl": [
        {"name": "Tweakers Pricewatch", "url": "https://tweakers.net/zoeken/?keyword={query}"},
        {"name": "Kieskeurig", "url": "https://www.kieskeurig.nl/search?q={query}"},
        {"name": "Google Shopping", "url": "https://www.google.nl/search?tbm=shop&q={query}"},
        {"name": "Amazon", "url": "https://www.amazon.nl/s?k={query}"},
    ],
    "se": [
        {"name": "Prisjakt", "url": "https://www.prisjakt.nu/search?search={query}"},
        {"name": "Google Shopping", "url": "https://www.google.se/search?tbm=shop&q={query}"},
    ],
    "pl": [
        {"name": "Ceneo", "url": "https://www.ceneo.pl/;szukaj-{query}"},
        {"name": "Google Shopping", "url": "https://www.google.pl/search?tbm=shop&q={query}"},
    ],
}


def suggested_price_sites(country: str | None) -> list[dict[str, str]] | None:
    """Copy of the suggested sites of a country, or None if there are none."""
    sites = SUGGESTED_PRICE_SITES.get(country or "")
    return [dict(s) for s in sites] if sites else None


def default_price_sites(country: str | None) -> list[dict[str, str]]:
    """Sites for a new installation: the country's suggestions, else the generic list."""
    return suggested_price_sites(country) or [dict(s) for s in DEFAULT_PRICE_COMPARE]
