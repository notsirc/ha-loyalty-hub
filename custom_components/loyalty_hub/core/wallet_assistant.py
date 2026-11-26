"""Wallet-Assistant import (ARCHITETTURA §10.3). Pure parsing, no IO.

Reads `wallet_assistant_items.json` (current) and the older
`cardwallet_cards.json` (legacy: `card_id` instead of `item_id`, `type`
instead of `item_type`). The file holds the items of every HA user: only the
importer's items, or items of users unknown to this instance, are imported.
An admin importer also imports the items of other existing users, for their
original owner (§11.2).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Collection
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from .barcode import BarcodeFormat
from .errors import ERR_INVALID_FORMAT, ValidationError
from .logo_sources import validate_domain
from .models import KIND_CARD, KIND_VOUCHER, MAX_CODE, MAX_NAME, MAX_NOTES, MAX_TX_NOTE

LOCAL_FILES = ("wallet_assistant_items.json", "cardwallet_cards.json")
LOGO_CACHE_DIR = "wallet_assistant_logos"
LOGO_CACHE_SIZES = (256, 128, 64, 32)  # tried in this order (largest first)

# JsBarcode format names -> ZXing names. Anything else -> CODE_128.
FORMAT_MAP: dict[str, BarcodeFormat] = {
    "CODE128": BarcodeFormat.CODE_128,
    "CODE39": BarcodeFormat.CODE_39,
    "EAN13": BarcodeFormat.EAN_13,
    "EAN8": BarcodeFormat.EAN_8,
    "UPC": BarcodeFormat.UPC_A,
    "ITF14": BarcodeFormat.ITF,
    "CODABAR": BarcodeFormat.CODABAR,
}

TYPE_MAP = {
    "loyalty": KIND_CARD,
    "card": KIND_CARD,
    "voucher": KIND_VOUCHER,
    "giftcard": KIND_VOUCHER,
}
TYPE_PROMOTION = "promotion"

# Same rule as Wallet-Assistant's normalize_logo_slug (domain or brand slug), so that its
# exported logo names are read the same way. This regular expression and the checks in
# normalize_slug() come from Wallet-Assistant (https://github.com/myTselectionPublic/Wallet-Assistant),
# Copyright (c) 2026 myT, MIT License (full text in THIRD_PARTY_NOTICES.md).
_SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")


@dataclass
class WalletItem:
    """One importable item: editable card fields + spend transactions."""

    row: dict[str, Any]
    # [{"amount": float, "date": iso datetime, "note": str}]
    spending: list[dict[str, Any]] = field(default_factory=list)
    logo_slug: str | None = None
    # Owner of the card to create: None = the importer (§11.2: an admin imports
    # the items of other existing users for their original owner).
    owner_id: str | None = None


@dataclass
class WalletParse:
    items: list[WalletItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    skipped_other_users: int = 0
    skipped_promotions: int = 0


def logo_cache_filenames(slug: str) -> list[str]:
    """Wallet-Assistant logo cache file names for a slug, largest size first."""
    return [
        hashlib.sha256(f"{slug}|{size}".encode()).hexdigest()[:32] + ".webp"
        for size in LOGO_CACHE_SIZES
    ]


def normalize_slug(value: Any) -> str | None:
    slug = str(value or "").strip().lower()
    if not slug or ".." in slug or not _SLUG_RE.match(slug):
        return None
    return slug


def map_format(fmt: Any, default_view: Any = None) -> str:
    if str(default_view or "").strip().lower() == "qr":
        return BarcodeFormat.QR_CODE.value
    key = str(fmt or "").strip().upper()
    return FORMAT_MAP.get(key, BarcodeFormat.CODE_128).value


def _amount(value: Any) -> float | None:
    if isinstance(value, bool) or value is None or value == "":
        return None
    try:
        num = float(str(value).replace(",", "."))
    except ValueError:
        return None
    return round(num, 2) if math.isfinite(num) and num >= 0 else None


def _date(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip()[:10]).isoformat()
    except ValueError:
        return None


def _load(data: bytes) -> list[Any]:
    try:
        parsed = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ValidationError("invalid Wallet-Assistant JSON", ERR_INVALID_FORMAT) from exc
    if isinstance(parsed, dict):
        parsed = parsed.get("items", parsed.get("cards"))
    if not isinstance(parsed, list):
        raise ValidationError(
            "Wallet-Assistant file must be a list of items", ERR_INVALID_FORMAT
        )
    return parsed


def _item(raw: dict[str, Any]) -> WalletItem:
    kind = TYPE_MAP.get(str(raw.get("item_type") or raw.get("type") or "").lower(), KIND_CARD)
    row: dict[str, Any] = {
        "kind": kind,
        "name": str(raw.get("name") or "").strip()[:MAX_NAME],
        "code": str(raw.get("code") or "").strip()[:MAX_CODE],
        "barcode_format": map_format(raw.get("format"), raw.get("default_view")),
    }
    notes = str(raw.get("notes") or "").strip()
    promo_url = str(raw.get("promo_url") or raw.get("url") or "").strip()
    if promo_url:
        notes = f"{notes}\nLink: {promo_url}" if notes else f"Link: {promo_url}"
    if notes:
        row["notes"] = notes[:MAX_NOTES]
    if expiry := _date(raw.get("expires_on") or raw.get("expiry_date")):
        row["expiry"] = expiry
    slug = normalize_slug(raw.get("logo_slug"))
    if slug:
        try:
            if domain := validate_domain(slug):
                row["logo_domain"] = domain
        except ValidationError:
            pass  # brand slug without TLD: still usable for the WA logo cache
    currency = str(raw.get("currency") or "").strip().upper()
    if _CURRENCY_RE.match(currency):
        row["currency"] = currency
    spending: list[dict[str, Any]] = []
    if kind == KIND_VOUCHER:
        initial = _amount(raw.get("initial_value"))
        if initial is not None:
            row["initial_balance"] = initial
        for entry in raw.get("spending") or []:
            if not isinstance(entry, dict):
                continue
            amount = _amount(entry.get("amount"))
            spent_on = _date(entry.get("spent_on"))
            if not amount or spent_on is None:
                continue
            spending.append(
                {
                    "amount": amount,
                    "date": f"{spent_on}T12:00:00+00:00",
                    "note": str(entry.get("note") or "").strip()[:MAX_TX_NOTE],
                }
            )
    return WalletItem(row=row, spending=spending, logo_slug=slug)


def parse_wallet_assistant(
    data: bytes,
    importer_id: str,
    known_user_ids: Collection[str],
    importer_is_admin: bool = False,
) -> WalletParse:
    """Parse a Wallet-Assistant/cardwallet JSON file.

    Items whose `user_id` is another existing HA user are skipped (privacy),
    unless the importer is an admin: then they are kept with `owner_id` set to
    that user. Items of the importer or of users unknown here (file from
    another instance) are imported for the importer. Promotions are skipped.
    """
    result = WalletParse()
    for idx, raw in enumerate(_load(data), start=1):
        if not isinstance(raw, dict):
            result.errors.append(f"item {idx}: not an object")
            continue
        user_id = str(raw.get("user_id") or "")
        other_owner: str | None = None
        if user_id and user_id != importer_id and user_id in known_user_ids:
            if not importer_is_admin:
                result.skipped_other_users += 1
                continue
            other_owner = user_id
        if str(raw.get("item_type") or raw.get("type") or "").lower() == TYPE_PROMOTION:
            result.skipped_promotions += 1
            continue
        item = _item(raw)
        item.owner_id = other_owner
        result.items.append(item)
    return result
