"""Import/export orchestration (base64, limits, validation, dedup)."""

from __future__ import annotations

import base64
import binascii
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timezone, tzinfo
from typing import Any, Callable

from .barcode import DEFAULT_FORMAT
from .catima import export_catima, parse_catima_full
from .csv_io import export_csv, parse_csv
from .errors import ERR_INVALID_CODE, ERR_INVALID_FORMAT, LoyaltyError, ValidationError
from .logos import MIME_PNG
from .models import (
    FALLBACK_CURRENCY,
    VIS_PRIVATE,
    VIS_SHARED,
    Card,
    add_transaction,
    card_key,
    create_card,
    new_id,
    set_logo,
)
from .wallet_assistant import parse_wallet_assistant

FORMAT_CATIMA = "catima"
FORMAT_CSV = "csv"
FORMAT_WALLET_ASSISTANT = "wallet_assistant"
FORMATS = (FORMAT_CATIMA, FORMAT_CSV, FORMAT_WALLET_ASSISTANT)
# Import-only formats (no exporter).
EXPORT_FORMATS = (FORMAT_CATIMA, FORMAT_CSV)
MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_CARDS = 1000
MAX_ERRORS_REPORTED = 50


@dataclass
class ImportResult:
    cards: list[Card] = field(default_factory=list)
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    # card.id -> PNG bytes of imported logos (card.logo already set, source "import").
    logos: dict[str, bytes] = field(default_factory=dict)
    # Wallet-Assistant only: items of other existing HA users (subset of skipped).
    skipped_other_users: int | None = None
    # card.id -> Wallet-Assistant logo slug (for the WA logo cache lookup).
    logo_slugs: dict[str, str] = field(default_factory=dict)
    # Set by the HA layer when import_logos was requested.
    logos_imported: int | None = None
    # Wallet-Assistant admin import: cards created for other users (in `imported`).
    imported_for_others: int | None = None
    # Set by the HA layer: logos not written because of the storage limits.
    logos_skipped_limit: int | None = None
    # §15.4: admin import, items of users who refuse cards from others (in `skipped`).
    skipped_refused: int | None = None

    @property
    def imported(self) -> int:
        return len(self.cards)

    def to_response(self) -> dict[str, Any]:
        errors = self.errors[:MAX_ERRORS_REPORTED]
        if len(self.errors) > MAX_ERRORS_REPORTED:
            errors.append(f"... {len(self.errors) - MAX_ERRORS_REPORTED} more errors")
        out: dict[str, Any] = {
            "imported": self.imported,
            "skipped": self.skipped,
            "errors": errors,
        }
        if self.skipped_other_users is not None:
            out["skipped_other_users"] = self.skipped_other_users
        if self.logos_imported is not None:
            out["logos_imported"] = self.logos_imported
        if self.imported_for_others is not None:
            out["imported_for_others"] = self.imported_for_others
        if self.logos_skipped_limit is not None:
            out["logos_skipped_limit"] = self.logos_skipped_limit
        if self.skipped_refused is not None:
            out["skipped_refused"] = self.skipped_refused
        return out


def decode_base64(data_base64: Any) -> bytes:
    if not isinstance(data_base64, str):
        raise ValidationError("data_base64 must be a string", ERR_INVALID_FORMAT)
    payload = data_base64.strip()
    if payload.startswith("data:") and "," in payload:  # tolerate data: URLs
        payload = payload.split(",", 1)[1]
    if len(payload) > (MAX_IMPORT_BYTES * 4) // 3 + 8:
        raise ValidationError("file too large (max 5 MB)", ERR_INVALID_FORMAT)
    try:
        raw = base64.b64decode(payload, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError("invalid base64 data", ERR_INVALID_FORMAT) from exc
    if len(raw) > MAX_IMPORT_BYTES:
        raise ValidationError("file too large (max 5 MB)", ERR_INVALID_FORMAT)
    if not raw:
        raise ValidationError("empty file", ERR_INVALID_FORMAT)
    return raw


def import_payload(
    fmt: str,
    data_base64: Any,
    owner_id: str,
    existing: Iterable[Card] = (),
    now: datetime | None = None,
    tz: tzinfo = timezone.utc,
    id_factory: Callable[[], str] = new_id,
    known_user_ids: Collection[str] = (),
    default_currency: str = FALLBACK_CURRENCY,
) -> ImportResult:
    """Parse + validate an import. Created cards are private and owned by owner_id.

    Rows duplicating (name, code) of a card the owner already has are skipped.
    Rows with an invalid code for their format fall back to CODE_128.
    """
    if fmt not in FORMATS:
        raise ValidationError(f"unknown format {fmt!r}", ERR_INVALID_FORMAT)
    return import_bytes(
        fmt,
        decode_base64(data_base64),
        owner_id,
        existing,
        now,
        tz,
        id_factory,
        known_user_ids,
        default_currency=default_currency,
    )


def check_import_size(raw: bytes) -> bytes:
    if len(raw) > MAX_IMPORT_BYTES:
        raise ValidationError("file too large (max 5 MB)", ERR_INVALID_FORMAT)
    if not raw:
        raise ValidationError("empty file", ERR_INVALID_FORMAT)
    return raw


def import_bytes(
    fmt: str,
    raw: bytes,
    owner_id: str,
    existing: Iterable[Card] = (),
    now: datetime | None = None,
    tz: tzinfo = timezone.utc,
    id_factory: Callable[[], str] = new_id,
    known_user_ids: Collection[str] = (),
    importer_is_admin: bool = False,
    default_currency: str = FALLBACK_CURRENCY,
    refusing_user_ids: Collection[str] = (),
) -> ImportResult:
    """Like import_payload, on raw bytes (e.g. a local file read by the server).

    `known_user_ids` (Wallet-Assistant only): ids of the existing HA users, for
    the privacy filter. `importer_is_admin` (Wallet-Assistant only, §11.2):
    items of other existing users are imported for their original owner,
    shared with the importing admin only. `default_currency` (§14.3): HA's
    currency, for rows without one. Imported cards never have a previous logo.
    `refusing_user_ids` (§15.4): users with `refuse_from_others`; their items are
    skipped and counted in `skipped_refused`. Cards imported for others get
    `created_by` = the importing admin.
    """
    if fmt not in FORMATS:
        raise ValidationError(f"unknown format {fmt!r}", ERR_INVALID_FORMAT)
    check_import_size(raw)
    icons: list[bytes | None] = []
    spending: list[list[dict[str, Any]]] = []
    slugs: list[str | None] = []
    owners: list[str | None] = []
    other_users: int | None = None
    pre_skipped = 0
    if fmt == FORMAT_CATIMA:
        parsed = parse_catima_full(raw, tz)
        rows, errors, icons = parsed.rows, parsed.errors, parsed.icons
    elif fmt == FORMAT_WALLET_ASSISTANT:
        wa = parse_wallet_assistant(raw, owner_id, known_user_ids, importer_is_admin)
        rows = [item.row for item in wa.items]
        owners = [item.owner_id for item in wa.items]
        spending = [item.spending for item in wa.items]
        slugs = [item.logo_slug for item in wa.items]
        errors = wa.errors
        other_users = wa.skipped_other_users
        pre_skipped = wa.skipped_other_users + wa.skipped_promotions
    else:
        rows, errors = parse_csv(raw)
    result = ImportResult(
        errors=list(errors),
        skipped=len(errors) + pre_skipped,
        skipped_other_users=other_users,
    )
    if fmt == FORMAT_WALLET_ASSISTANT and importer_is_admin:
        result.imported_for_others = 0
        result.skipped_refused = 0
    refusing = set(refusing_user_ids)
    existing = list(existing)
    # Dedup keys per owner (an admin import may create cards for other users).
    seen: dict[str, set[tuple[str, str]]] = {}

    def _seen(owner: str) -> set[tuple[str, str]]:
        if owner not in seen:
            seen[owner] = {card_key(c) for c in existing if c.owner_id == owner}
        return seen[owner]

    for idx, row in enumerate(rows, start=1):
        if result.imported >= MAX_IMPORT_CARDS:
            result.skipped += len(rows) - idx + 1
            result.errors.append(f"limit of {MAX_IMPORT_CARDS} cards reached")
            break
        other = owners[idx - 1] if idx - 1 < len(owners) else None
        card_owner = other or owner_id
        if other and other in refusing:
            result.skipped += 1
            if result.skipped_refused is not None:
                result.skipped_refused += 1
            continue
        if other:
            # Visible only to the original owner and the importing admin.
            row = {**row, "visibility": VIS_SHARED, "shared_with": [owner_id]}
        else:
            row = {**row, "visibility": VIS_PRIVATE, "shared_with": []}
        key = card_key(row)
        if key in _seen(card_owner):
            result.skipped += 1
            continue
        try:
            try:
                card = create_card(row, card_owner, now, id_factory, default_currency)
            except LoyaltyError as exc:
                if exc.code != ERR_INVALID_CODE:
                    raise
                card = create_card(
                    {**row, "barcode_format": DEFAULT_FORMAT.value},
                    card_owner,
                    now,
                    id_factory,
                    default_currency,
                )
        except LoyaltyError as exc:
            result.skipped += 1
            result.errors.append(f"card {idx} ({row.get('name', '?')}): {exc.message}")
            continue
        _seen(card_owner).add(key)
        if other:
            card.created_by = owner_id  # §15.4: the importing admin
        if other and result.imported_for_others is not None:
            result.imported_for_others += 1
        for tx in spending[idx - 1] if idx - 1 < len(spending) else []:
            try:
                # Spending recorded in Wallet-Assistant by the card's user.
                add_transaction(
                    card,
                    tx["amount"],
                    card_owner,
                    note=tx["note"],
                    tx_date=tx["date"],
                    now=now,
                    id_factory=id_factory,
                )
            except LoyaltyError as exc:
                result.errors.append(f"card {idx} ({card.name}): spending skipped: {exc.message}")
        if card.transactions:
            card.updated_at = card.created_at
        if idx - 1 < len(slugs) and slugs[idx - 1]:
            result.logo_slugs[card.id] = slugs[idx - 1]
        icon = icons[idx - 1] if idx - 1 < len(icons) else None
        if icon:
            set_logo(card, "import", MIME_PNG, now)
            result.logos[card.id] = icon
        result.cards.append(card)
    return result


def export_payload(
    fmt: str,
    cards: list[Card],
    now: datetime | None = None,
    tz: tzinfo = timezone.utc,
    icons: dict[str, bytes] | None = None,
) -> dict[str, str]:
    if fmt not in EXPORT_FORMATS:
        raise ValidationError(f"unknown format {fmt!r}", ERR_INVALID_FORMAT)
    stamp = (now or datetime.now(timezone.utc)).astimezone(tz).strftime("%Y%m%d")
    cards = sorted(cards, key=lambda c: c.name.casefold())
    if fmt == FORMAT_CATIMA:
        data = export_catima(cards, tz, icons)
        filename, mime = f"loyalty_hub_catima_{stamp}.zip", "application/zip"
    else:
        data = export_csv(cards)
        filename, mime = f"loyalty_hub_{stamp}.csv", "text/csv"
    return {
        "filename": filename,
        "mime": mime,
        "data_base64": base64.b64encode(data).decode("ascii"),
    }
