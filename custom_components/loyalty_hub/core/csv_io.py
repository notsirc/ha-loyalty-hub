"""Generic CSV import/export.

Export header: name,code,barcode_format,color,notes,points,expiry,kind,initial_balance,currency,reloadable
Import is tolerant: `,` `;` or tab delimiter, BOM, Italian header aliases,
decimal comma, dates YYYY-MM-DD / DD/MM/YYYY / DD-MM-YYYY / DD.MM.YYYY.
"""

from __future__ import annotations

import csv
import io
import re
from datetime import date
from typing import Any

from .errors import ValidationError
from .models import KIND_CARD, KIND_VOUCHER, Card

CSV_COLUMNS = [
    "name",
    "code",
    "barcode_format",
    "color",
    "notes",
    "points",
    "expiry",
    "kind",
    "initial_balance",
    "currency",
    "reloadable",
]

HEADER_ALIASES: dict[str, str] = {
    "name": "name",
    "nome": "name",
    "store": "name",
    "negozio": "name",
    "code": "code",
    "codice": "code",
    "cardid": "code",
    "barcode": "code",
    "barcode_format": "barcode_format",
    "format": "barcode_format",
    "formato": "barcode_format",
    "barcodetype": "barcode_format",
    "color": "color",
    "colour": "color",
    "colore": "color",
    "notes": "notes",
    "note": "notes",
    "points": "points",
    "punti": "points",
    "expiry": "expiry",
    "scadenza": "expiry",
    "kind": "kind",
    "tipo": "kind",
    "initial_balance": "initial_balance",
    "saldo_iniziale": "initial_balance",
    "saldo": "initial_balance",
    "balance": "initial_balance",
    "currency": "currency",
    "valuta": "currency",
    "reloadable": "reloadable",
    "ricaricabile": "reloadable",
}

_TRUE = {"1", "true", "yes", "y", "si", "sì", "x", "vero"}
_FALSE = {"0", "false", "no", "n", "falso"}

KIND_ALIASES = {
    "card": KIND_CARD,
    "tessera": KIND_CARD,
    "carta": KIND_CARD,
    "voucher": KIND_VOUCHER,
    "buono": KIND_VOUCHER,
    "gift": KIND_VOUCHER,
    "giftcard": KIND_VOUCHER,
}

_DMY_RE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$")


class ParseError(ValidationError):
    """Unreadable CSV (invalid_format)."""


def _norm_header(h: str) -> str:
    return re.sub(r"[\s\-]+", "_", h.strip().strip("﻿").lower())


def _parse_date(value: str) -> str:
    value = value.strip()
    if m := _DMY_RE.match(value):
        day, month, year = (int(x) for x in m.groups())
        return date(year, month, day).isoformat()
    return date.fromisoformat(value[:10]).isoformat()


def _parse_float(value: str) -> float:
    value = value.strip().replace(" ", "").replace("€", "")
    if "," in value and "." in value:
        value = value.replace(".", "").replace(",", ".")  # 1.234,56
    else:
        value = value.replace(",", ".")
    return float(value)


def _parse_int(value: str) -> int:
    value = value.strip().replace(" ", "").replace(".", "").replace("'", "")
    if "," in value:
        value = value.split(",", 1)[0]
    return int(value)


def _detect_delimiter(first_line: str) -> str:
    counts = {d: first_line.count(d) for d in (",", ";", "\t")}
    return max(counts, key=lambda d: counts[d]) if any(counts.values()) else ","


def parse_csv(data: bytes) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (rows as editable-field dicts, errors)."""
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    text = text.lstrip("﻿")
    lines = text.splitlines()
    first = next((ln for ln in lines if ln.strip()), "")
    if not first:
        raise ParseError("empty CSV")
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=_detect_delimiter(first))
    header: list[str | None] | None = None
    out: list[dict[str, Any]] = []
    errors: list[str] = []
    for row in reader:
        if not row or all(not c.strip() for c in row):
            continue
        if header is None:
            header = [HEADER_ALIASES.get(_norm_header(h)) for h in row]
            if "name" not in header or "code" not in header:
                raise ParseError("CSV header must contain name and code columns")
            continue
        line_no = reader.line_num
        raw = {}
        for i, key in enumerate(header):
            if key and i < len(row) and key not in raw:
                raw[key] = row[i].strip()
        try:
            out.append(_row_to_card(raw))
        except (ValueError, KeyError) as exc:
            errors.append(f"row {line_no}: {exc}")
    return out, errors


def _row_to_card(raw: dict[str, str]) -> dict[str, Any]:
    card: dict[str, Any] = {}
    for key, value in raw.items():
        if value == "":
            continue
        if key == "points":
            card["points"] = _parse_int(value)
        elif key == "initial_balance":
            card["initial_balance"] = _parse_float(value)
        elif key == "expiry":
            card["expiry"] = _parse_date(value)
        elif key == "kind":
            kind = KIND_ALIASES.get(value.lower())
            if kind is None:
                raise ValueError(f"unknown kind {value!r}")
            card["kind"] = kind
        elif key == "color":
            card["color"] = value if value.startswith("#") else f"#{value}"
        elif key == "currency":
            card["currency"] = value.upper()
        elif key == "reloadable":
            flag = value.strip().lower()
            if flag not in _TRUE | _FALSE:
                raise ValueError(f"invalid reloadable value {value!r}")
            card["reloadable"] = flag in _TRUE
        else:
            card[key] = value
    if "initial_balance" in card and "kind" not in card:
        card["kind"] = KIND_VOUCHER
    return card


def export_csv(cards: list[Card]) -> bytes:
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(CSV_COLUMNS)
    for c in cards:
        writer.writerow(
            [
                c.name,
                c.code,
                c.barcode_format,
                c.color,
                c.notes,
                "" if c.points is None else c.points,
                c.expiry or "",
                c.kind,
                # Transactions are not exported: write the current balance so a
                # re-import starts from the real remaining amount.
                "" if c.balance is None else f"{c.balance:.2f}",
                c.currency,
                "true" if c.reloadable else "false",
            ]
        )
    return buf.getvalue().encode("utf-8")
