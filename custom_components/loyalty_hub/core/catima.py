"""Catima import/export.

Catima exports a ZIP containing `catima.csv`, a multi-section CSV (version 2):

    2
    <blank>
    _id                       <- groups section
    <group rows>
    <blank>
    _id,store,note,...        <- cards section
    <card rows>
    <blank>
    cardId,groupId            <- cardsToGroups section
    <rows>
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, time, timezone, tzinfo
from decimal import Decimal, InvalidOperation
from typing import Any

from .barcode import normalize_format
from .errors import ValidationError
from .logos import MAX_LOGO_BYTES, MIME_PNG, sniff_image
from .models import KIND_VOUCHER, Card

CATIMA_VERSION = "2"
CATIMA_CSV_NAME = "catima.csv"
CARD_COLUMNS = [
    "_id",
    "store",
    "note",
    "validfrom",
    "expiry",
    "balance",
    "balancetype",
    "cardid",
    "barcodeid",
    "barcodetype",
    "headercolor",
    "starstatus",
    "lastused",
    "archive",
]
_MAX_UNCOMPRESSED = 5 * 1024 * 1024
_ICON_RE = re.compile(r"^card_(\d+)_icon\.png$", re.IGNORECASE)


@dataclass
class CatimaParse:
    rows: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    # Aligned with rows: PNG bytes of `card_<id>_icon.png`, or None.
    icons: list[bytes | None] = field(default_factory=list)


class ParseError(ValidationError):
    """Unreadable file (invalid_format)."""


def _extract(data: bytes) -> tuple[str, dict[str, bytes]]:
    """Return (csv text, {catima card id: icon bytes})."""
    icons: dict[str, bytes] = {}
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                infos = [i for i in zf.infolist() if not i.is_dir()]
                target = next(
                    (i for i in infos if i.filename.rsplit("/", 1)[-1].lower() == CATIMA_CSV_NAME),
                    None,
                ) or next((i for i in infos if i.filename.lower().endswith(".csv")), None)
                if target is None:
                    raise ParseError("catima.csv not found in zip")
                if target.flag_bits & 0x1:
                    raise ParseError("password-protected Catima exports are not supported")
                if target.file_size > _MAX_UNCOMPRESSED:
                    raise ParseError("catima.csv too large")
                raw = zf.read(target)
                for info in infos:
                    m = _ICON_RE.match(info.filename.rsplit("/", 1)[-1])
                    if m and not info.flag_bits & 0x1 and info.file_size <= MAX_LOGO_BYTES:
                        icons[m.group(1)] = zf.read(info)
        except zipfile.BadZipFile as exc:
            raise ParseError("invalid zip file") from exc
    else:
        raw = data
    try:
        return raw.decode("utf-8-sig"), icons
    except UnicodeDecodeError:
        return raw.decode("latin-1"), icons


def _color_from_argb(value: str) -> str | None:
    try:
        num = int(value.strip())
    except (ValueError, AttributeError):
        return None
    return f"#{num & 0xFFFFFF:06X}"


def _color_to_argb(color: str) -> int:
    rgb = int(color.lstrip("#"), 16) & 0xFFFFFF
    val = 0xFF000000 | rgb
    return val - (1 << 32) if val >= (1 << 31) else val


def _date_from_catima(value: str, tz: tzinfo) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    if value.lstrip("-").isdigit():
        num = int(value)
        # Millis normally; tolerate seconds.
        seconds = num / 1000 if abs(num) > 10**11 else num
        return datetime.fromtimestamp(seconds, tz).date().isoformat()
    try:
        return date.fromisoformat(value[:10]).isoformat()
    except ValueError:
        return None


def _date_to_millis(value: str | None, tz: tzinfo) -> str:
    if not value:
        return ""
    d = date.fromisoformat(value)
    return str(int(datetime.combine(d, time(0, 0), tz).timestamp() * 1000))


def _decimal(value: str) -> Decimal | None:
    value = (value or "").strip().replace(",", ".")
    if not value:
        return None
    try:
        return Decimal(value)
    except InvalidOperation:
        return None


def parse_catima(data: bytes, tz: tzinfo = timezone.utc) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (rows as editable-field dicts, errors)."""
    res = parse_catima_full(data, tz)
    return res.rows, res.errors


def parse_catima_full(data: bytes, tz: tzinfo = timezone.utc) -> CatimaParse:
    """Parse cards plus their `card_<id>_icon.png` icons (PNG only)."""
    text, icon_files = _extract(data)
    rows = list(csv.reader(io.StringIO(text, newline="")))
    header_idx = None
    for idx, row in enumerate(rows):
        cells = [c.strip().lower() for c in row]
        if cells and cells[0] == "_id" and "store" in cells and "cardid" in cells:
            header_idx = idx
            break
    if header_idx is None:
        raise ParseError("Catima cards section not found")

    header = [c.strip().lower() for c in rows[header_idx]]
    res = CatimaParse()
    out, errors = res.rows, res.errors
    for line_no, row in enumerate(rows[header_idx + 1 :], start=header_idx + 2):
        if not row or all(not c.strip() for c in row):
            break  # end of cards section
        rec = {header[i]: row[i] for i in range(min(len(header), len(row)))}
        name = (rec.get("store") or "").strip()
        code = (rec.get("barcodeid") or "").strip() or (rec.get("cardid") or "").strip()
        if not name or not code:
            errors.append(f"row {line_no}: missing store or card id")
            continue
        card: dict[str, Any] = {"name": name[:80], "code": code}
        fmt = normalize_format(rec.get("barcodetype") or "")
        if fmt is not None:
            card["barcode_format"] = fmt.value
        if (note := rec.get("note") or ""):
            card["notes"] = note[:1000]
        if (color := _color_from_argb(rec.get("headercolor") or "")):
            card["color"] = color
        card["favorite"] = (rec.get("starstatus") or "").strip() == "1"
        if (exp := _date_from_catima(rec.get("expiry") or "", tz)):
            card["expiry"] = exp
        balance = _decimal(rec.get("balance") or "")
        btype = (rec.get("balancetype") or "").strip().upper()
        if balance is not None:
            if btype and btype.isalpha() and len(btype) == 3:
                if balance > 0:
                    card["kind"] = KIND_VOUCHER
                    card["initial_balance"] = float(balance)
                    card["currency"] = btype
            elif not btype and balance > 0:
                card["points"] = int(balance)
        out.append(card)
        icon = icon_files.get((rec.get("_id") or "").strip())
        if icon is not None:
            try:
                icon = icon if sniff_image(icon) == MIME_PNG else None
            except ValidationError:
                icon = None
        res.icons.append(icon)
    return res


def export_catima(
    cards: list[Card],
    tz: tzinfo = timezone.utc,
    icons: Mapping[str, bytes] | None = None,
) -> bytes:
    """Build a Catima-importable zip (version 2).

    `icons` maps card.id -> image bytes; only PNG is written (Catima expects
    `card_<id>_icon.png`), other formats are skipped.
    """
    icons = icons or {}
    icon_files: dict[str, bytes] = {}
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow([CATIMA_VERSION])
    writer.writerow([])
    writer.writerow(["_id"])
    writer.writerow([])
    writer.writerow(CARD_COLUMNS)
    for idx, card in enumerate(cards, start=1):
        icon = icons.get(card.id)
        if icon:
            try:
                if sniff_image(icon) == MIME_PNG:
                    icon_files[f"card_{idx}_icon.png"] = icon
            except ValidationError:
                pass
        balance_s, btype = "0", ""
        if card.kind == KIND_VOUCHER and card.balance is not None:
            balance_s = f"{card.balance:.2f}"
            btype = card.currency
        elif card.points is not None:
            balance_s = str(card.points)
        last_used = ""
        if card.last_used:
            try:
                last_used = str(int(datetime.fromisoformat(card.last_used).timestamp()))
            except ValueError:
                last_used = ""
        writer.writerow(
            [
                idx,
                card.name,
                card.notes,
                "",
                _date_to_millis(card.expiry, tz),
                balance_s,
                btype,
                card.code,
                "",
                card.barcode_format,
                _color_to_argb(card.color),
                1 if card.favorite else 0,
                last_used,
                0,
            ]
        )
    writer.writerow([])
    writer.writerow(["cardId", "groupId"])
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(CATIMA_CSV_NAME, buf.getvalue().encode("utf-8"))
        for name, blob in icon_files.items():
            zf.writestr(name, blob)
    return out.getvalue()
