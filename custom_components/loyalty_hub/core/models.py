"""Data model: Card, Transaction, UserPrefs + validation and (de)serialization.

See ARCHITETTURA §2 (and §10, §11 for later fields). The server owns
SERVER_FIELDS; clients may only send EDITABLE_FIELDS.
"""

from __future__ import annotations

import math
import re
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import date, datetime, timedelta, timezone
from collections.abc import Iterable
from typing import Any, Callable

from .barcode import DEFAULT_FORMAT, BarcodeFormat, normalize_format, validate_code
from .errors import ERR_INVALID_FORMAT, LimitReachedError, NotFoundError, ValidationError
from .countries import load_countries, validate_countries
from .features import load_features_off, load_nfc_tags, validate_features_off
from .i18n import MAX_LANGUAGE_LEN, normalize_language
from .logo_sources import validate_domain
from .logos import DEFAULT_LOGO_FIT, LOGO_FITS, make_logo_info

KIND_CARD = "card"
KIND_VOUCHER = "voucher"
KINDS = (KIND_CARD, KIND_VOUCHER)

VIS_PRIVATE = "private"
VIS_SHARED = "shared"
VISIBILITIES = (VIS_PRIVATE, VIS_SHARED)

SHARE_ALL = "*"

DEFAULT_COLOR = "#185FA5"
# §14.3: no fixed default currency: the server sets HA's currency on create/import.
# This is only the fallback when HA has none (and for malformed stored data).
FALLBACK_CURRENCY = "EUR"

MAX_NAME = 80
MAX_CODE = 512
MAX_NOTES = 1000
MAX_TX_NOTE = 200
MAX_LIST_ITEMS = 200

# §11.10: balance pill on voucher tiles.
BALANCE_CORNERS = ("top_left", "bottom_left", "bottom_right")
DEFAULT_BALANCE_CORNER = "bottom_right"
BALANCE_SIZES = ("off", "s", "m", "l")
DEFAULT_BALANCE_SIZE = "s"

# §11.5: store locations (no timestamp, no user).
MAX_LOCATIONS = 20
LOCATION_MERGE_METERS = 100.0
LOCATION_DECIMALS = 5
EARTH_RADIUS_M = 6371008.8

# §15.3: short tab name of a card in a group.
MAX_SHORT_NAME = 20
# §15.5 points_history: at most this many entries (the oldest are dropped).
MAX_POINTS_HISTORY = 200
_TODO_ENTITY_RE = re.compile(r"^todo\.[a-z0-9_]{1,250}$")

# §15.3 / §15.5: limits of the per-user preferences (shape only, never existence).
MAX_PREF_ID = 64
MAX_GROUP_KEY = 300  # group keys embed a domain or a normalized shop name
MAX_GROUP_SPLIT = 500
MAX_GROUP_LINKS = 500
MAX_GROUP_TABS = 200
MAX_GROUP_TAB_ORDER = 50
MAX_GROUP_NAME = 30  # §16.2
MAX_MANUAL_ORDER = 2000
TAB_MODES = ("auto", "manual")
LIST_ORDERS = ("habits", "manual")
DEFAULT_LIST_ORDER = "habits"

# §11.6: usage counters, 7 weekdays (Monday = 0) x 6 slots of 4 hours.
USAGE_SLOTS_PER_DAY = 6
USAGE_LEN = 7 * USAGE_SLOTS_PER_DAY
MARK_USED_COOLDOWN = timedelta(minutes=10)

EDITABLE_FIELDS: frozenset[str] = frozenset(
    {
        "kind",
        "name",
        "code",
        "barcode_format",
        "color",
        "notes",
        "points",
        "visibility",
        "shared_with",
        "zones",
        "favorite",
        "expiry",
        "currency",
        "initial_balance",
        "logo_domain",
        "logo_fit",
        "reloadable",
        "balance_corner",
        "balance_size",
        "shop_custom",
        "suggest_shop",
        # §15.3 / §15.5
        "short_name",
        "todo_entity",
        "points_expiry",
    }
)

SERVER_FIELDS: frozenset[str] = frozenset(
    {
        "id",
        "owner_id",
        "transactions",
        "balance",
        "use_count",
        "last_used",
        "created_at",
        "updated_at",
        "logo",
        "logo_previous",
        "locations",
        "usage",
        # §15.4 / §15.5
        "created_by",
        "transferred_by",
        "transferred_at",
        "points_history",
    }
)

PREFS_EDITABLE: frozenset[str] = frozenset(
    {
        "notify_service",
        "zone_notifications",
        "expiry_notifications",
        "language",
        "price_compare",
        "price_compare_sites",
        "nearby",
        "countries",
        # §15.3
        "grouping",
        "group_split",
        "group_links",
        "group_tabs",
        # §16.2
        "group_names",
        # §15.4
        "refuse_from_others",
        "inbox_notifications",
        # §15.5 (nfc_tags is server-only)
        "features_off",
        "default_share",
        "list_order",
        "manual_order",
        "low_balance_threshold",
        "cashier_high_contrast",
    }
)

TX_SPEND = "spend"
TX_TOPUP = "topup"
# §11.4: balance adjustment, signed amount, only via adjust_balance().
TX_ADJUST = "adjust"
TX_TYPES = (TX_SPEND, TX_TOPUP, TX_ADJUST)
# Types accepted by add_transaction.
ADD_TX_TYPES = (TX_SPEND, TX_TOPUP)

MAX_PRICE_SITES = 50
MAX_PRICE_SITE_NAME = 80

_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
_CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
_SERVICE_RE = re.compile(r"^[a-z0-9_]+$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex


def _err(msg: str) -> ValidationError:
    return ValidationError(msg, ERR_INVALID_FORMAT)


# ---------------------------------------------------------------- dataclasses


@dataclass
class Transaction:
    id: str
    date: str
    amount: float
    note: str = ""
    user_id: str = ""
    type: str = TX_SPEND

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Transaction:
        tx_type = data.get("type")
        return cls(
            id=str(data["id"]),
            date=str(data["date"]),
            amount=float(data["amount"]),
            note=str(data.get("note") or ""),
            user_id=str(data.get("user_id") or ""),
            type=tx_type if tx_type in TX_TYPES else TX_SPEND,
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_storage(self) -> dict[str, Any]:
        """Compact form for the Store (§12.1): default type/note/user_id omitted."""
        data: dict[str, Any] = {"id": self.id, "date": self.date, "amount": self.amount}
        if self.note:
            data["note"] = self.note
        if self.user_id:
            data["user_id"] = self.user_id
        if self.type != TX_SPEND:
            data["type"] = self.type
        return data


# §12.1: Card fields always written by to_storage(); the others only when they
# differ from these defaults. Changing a default later requires a migration.
CARD_STORAGE_ALWAYS = (
    "id",
    "owner_id",
    "name",
    "code",
    "kind",
    "barcode_format",
    "color",
    "visibility",
    "created_at",
    "updated_at",
    # §14.3: always saved, so a later change of HA's currency never alters cards.
    "currency",
)
CARD_STORAGE_DEFAULTS: dict[str, Any] = {
    "notes": "",
    "points": None,
    "shared_with": [],
    "zones": [],
    "favorite": False,
    "expiry": None,
    "initial_balance": None,
    "logo_domain": None,
    "logo_fit": DEFAULT_LOGO_FIT,
    "reloadable": False,
    "balance_corner": DEFAULT_BALANCE_CORNER,
    "balance_size": DEFAULT_BALANCE_SIZE,
    "shop_custom": False,
    "suggest_shop": True,
    "short_name": "",
    "todo_entity": None,
    "points_expiry": None,
    "created_by": None,
    "transferred_by": None,
    "transferred_at": None,
    "points_history": [],
    "logo": None,
    "logo_previous": None,
    "locations": [],
    "transactions": [],
    "use_count": 0,
    "last_used": None,
}
# §14.2: the previous logo has the shape of `logo` without `checked_at`;
# clients only get these keys of it.
_PREVIOUS_DROPPED_KEYS = frozenset({"checked_at"})
PREVIOUS_OUT_KEYS = ("source", "mime", "updated_at", "version")


@dataclass
class Card:
    id: str
    owner_id: str
    name: str
    code: str
    kind: str = KIND_CARD
    barcode_format: str = DEFAULT_FORMAT.value
    color: str = DEFAULT_COLOR
    notes: str = ""
    points: int | None = None
    visibility: str = VIS_PRIVATE
    shared_with: list[str] = field(default_factory=list)
    zones: list[str] = field(default_factory=list)
    favorite: bool = False
    expiry: str | None = None
    currency: str = FALLBACK_CURRENCY
    initial_balance: float | None = None
    logo_domain: str | None = None
    logo_fit: str = DEFAULT_LOGO_FIT
    reloadable: bool = False
    balance_corner: str = DEFAULT_BALANCE_CORNER
    balance_size: str = DEFAULT_BALANCE_SIZE
    # §14.3: shop name typed by hand / suggest a private card's shop to the household.
    shop_custom: bool = False
    suggest_shop: bool = True
    # §15.3: short tab name in a group (0-20 chars, common to everyone who sees the card).
    short_name: str = ""
    # §15.5 shopping_list: linked todo.* entity / points_expiry: YYYY-MM-DD.
    todo_entity: str | None = None
    points_expiry: str | None = None
    # §15.4, server-only: who created the card (if not the owner) / transferred it.
    created_by: str | None = None
    transferred_by: str | None = None
    transferred_at: str | None = None
    # §15.5, server-only: [{date: YYYY-MM-DD, points: int}], oldest first.
    points_history: list[dict[str, Any]] = field(default_factory=list)
    # Server-only: {source, mime, updated_at, version, domain, checked_at?} or None
    # (`checked_at`: last automatic refresh attempt, §14.2 cache).
    logo: dict[str, Any] | None = None
    # Server-only (§14.2): the previous logo, same shape as `logo` without checked_at.
    logo_previous: dict[str, Any] | None = None
    # Server-only: [{id, lat, lon}] store positions (§11.5).
    locations: list[dict[str, Any]] = field(default_factory=list)
    # Server-only: USAGE_LEN counters, weekday * 6 + hour // 4 (§11.6).
    usage: list[int] = field(default_factory=lambda: [0] * USAGE_LEN)
    transactions: list[Transaction] = field(default_factory=list)
    use_count: int = 0
    last_used: str | None = None
    created_at: str = ""
    updated_at: str = ""

    @property
    def balance(self) -> float | None:
        return compute_balance(
            self.initial_balance,
            self.transactions,
            reloadable=self.kind == KIND_VOUCHER and self.reloadable,
        )

    def to_dict(self) -> dict[str, Any]:
        """API format (complete). Includes computed `balance`; see to_storage()."""
        data = asdict(self)
        data["shared_with"] = list(self.shared_with)
        data["zones"] = list(self.zones)
        data["transactions"] = [t.to_dict() for t in self.transactions]
        data["logo"] = dict(self.logo) if self.logo else None
        data["logo_previous"] = (
            {k: self.logo_previous.get(k) for k in PREVIOUS_OUT_KEYS}
            if self.logo_previous
            else None
        )
        data["locations"] = [dict(loc) for loc in self.locations]
        data["points_history"] = [dict(e) for e in self.points_history]
        data["usage"] = list(self.usage)
        data["balance"] = self.balance
        return data

    def to_storage(self) -> dict[str, Any]:
        """Compact form for the Store (§12.1). `to_dict()` stays the API format."""
        data: dict[str, Any] = {key: getattr(self, key) for key in CARD_STORAGE_ALWAYS}
        for key, default in CARD_STORAGE_DEFAULTS.items():
            value = getattr(self, key)
            if key == "transactions":
                value = [t.to_storage() for t in self.transactions]
            elif key == "logo":
                value = dict(self.logo) if self.logo else None
            elif key == "logo_previous":
                value = (
                    _as_previous(self.logo_previous) if self.logo_previous else None
                )
            elif key in ("locations", "points_history"):
                value = [dict(item) for item in getattr(self, key)]
            elif isinstance(value, list):
                value = list(value)
            if value != default:
                data[key] = value
        usage = {str(i): n for i, n in enumerate(self.usage) if n > 0}
        if usage:
            data["usage"] = usage
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Card:
        """Load from storage (trusted data).

        Unknown keys are ignored; missing keys (e.g. v0.1 cards without
        logo_domain/logo_fit/logo) take their dataclass defaults.
        """
        known = {f.name for f in fields(cls)}
        kwargs = {k: v for k, v in data.items() if k in known}
        kwargs["transactions"] = [
            Transaction.from_dict(t) for t in data.get("transactions") or []
        ]
        kwargs["shared_with"] = list(data.get("shared_with") or [])
        kwargs["zones"] = list(data.get("zones") or [])
        kwargs["reloadable"] = bool(data.get("reloadable", False))
        kwargs["shop_custom"] = data.get("shop_custom") is True
        kwargs["suggest_shop"] = data.get("suggest_shop", True) is not False
        currency = data.get("currency")
        if not (isinstance(currency, str) and _CURRENCY_RE.match(currency)):
            kwargs["currency"] = FALLBACK_CURRENCY
        if kwargs.get("logo_fit") not in LOGO_FITS:
            kwargs["logo_fit"] = DEFAULT_LOGO_FIT
        logo = data.get("logo")
        kwargs["logo"] = dict(logo) if isinstance(logo, dict) else None
        previous = data.get("logo_previous")
        kwargs["logo_previous"] = dict(previous) if isinstance(previous, dict) else None
        if kwargs.get("balance_corner") not in BALANCE_CORNERS:
            kwargs["balance_corner"] = DEFAULT_BALANCE_CORNER
        if kwargs.get("balance_size") not in BALANCE_SIZES:
            kwargs["balance_size"] = DEFAULT_BALANCE_SIZE
        kwargs["locations"] = _load_locations(data.get("locations"))
        kwargs["points_history"] = _load_points_history(data.get("points_history"))
        kwargs["short_name"] = str(data.get("short_name") or "")[:MAX_SHORT_NAME]
        for key in ("todo_entity", "points_expiry", "created_by", "transferred_by", "transferred_at"):
            value = data.get(key)
            kwargs[key] = value if isinstance(value, str) and value else None
        kwargs["usage"] = _load_usage(data.get("usage"))
        return cls(**kwargs)

    def find_transaction(self, tx_id: str) -> Transaction:
        for tx in self.transactions:
            if tx.id == tx_id:
                return tx
        raise NotFoundError(f"Transaction {tx_id} not found")


@dataclass
class UserPrefs:
    user_id: str
    notify_service: str | None = None
    zone_notifications: bool = True
    expiry_notifications: bool = True
    language: str | None = None
    price_compare: bool = True
    # None = every site configured by the admin; otherwise the chosen site names.
    price_compare_sites: list[str] | None = None
    nearby: bool = True
    # Server-only: admin_access epoch whose notice the user accepted (§11.1).
    admin_notice_accepted: int | None = None
    # §14.3: shop list countries (max 2); None = the admin's default country.
    countries: list[str] | None = None
    # §15.3: groups of cards (the user's own view only).
    grouping: bool = True
    group_split: list[str] = field(default_factory=list)
    group_links: list[list[str]] = field(default_factory=list)
    group_tabs: dict[str, dict[str, Any]] = field(default_factory=dict)
    # §16.2: personal group names {group_key: name}.
    group_names: dict[str, str] = field(default_factory=dict)
    # §15.4
    refuse_from_others: bool = False
    inbox_notifications: bool = True
    # §15.5
    features_off: list[str] = field(default_factory=list)
    # Server-only: {tag_id: card_id}; never in the API output (see to_api()).
    nfc_tags: dict[str, str] = field(default_factory=dict)
    default_share: dict[str, Any] | None = None
    list_order: str = DEFAULT_LIST_ORDER
    manual_order: list[str] = field(default_factory=list)
    low_balance_threshold: float | None = None
    cashier_high_contrast: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Complete form (storage). asdict() deep-copies lists and dicts."""
        return asdict(self)

    def to_api(self) -> dict[str, Any]:
        """prefs/get, prefs/set output: without the server-only NFC links."""
        data = self.to_dict()
        data.pop("nfc_tags", None)
        return data

    def to_storage(self) -> dict[str, Any]:
        """Compact form for the Store (§12.1): defaults and user_id (the key) omitted."""
        defaults = UserPrefs(user_id=self.user_id).to_dict()
        return {
            key: value
            for key, value in self.to_dict().items()
            if key != "user_id" and value != defaults[key]
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> UserPrefs:
        return cls(
            user_id=str(data["user_id"]),
            notify_service=data.get("notify_service"),
            zone_notifications=bool(data.get("zone_notifications", True)),
            expiry_notifications=bool(data.get("expiry_notifications", True)),
            language=normalize_language(data.get("language")),
            price_compare=bool(data.get("price_compare", True)),
            price_compare_sites=_load_sites(data.get("price_compare_sites")),
            nearby=bool(data.get("nearby", True)),
            admin_notice_accepted=_load_int(data.get("admin_notice_accepted")),
            countries=load_countries(data.get("countries")),
            grouping=data.get("grouping", True) is not False,
            group_split=_lenient(
                [], _v_id_list, "group_split", data.get("group_split", []), MAX_GROUP_SPLIT
            ),
            group_links=_lenient([], _v_group_links, data.get("group_links", [])),
            group_tabs=_lenient({}, _v_group_tabs, data.get("group_tabs", {})),
            group_names=_lenient({}, _v_group_names, data.get("group_names", {})),
            refuse_from_others=data.get("refuse_from_others") is True,
            inbox_notifications=data.get("inbox_notifications", True) is not False,
            features_off=load_features_off(data.get("features_off")),
            nfc_tags=load_nfc_tags(data.get("nfc_tags")),
            default_share=_lenient(None, _v_default_share, data.get("default_share")),
            list_order=data.get("list_order")
            if data.get("list_order") in LIST_ORDERS
            else DEFAULT_LIST_ORDER,
            manual_order=_lenient(
                [], _v_id_list, "manual_order", data.get("manual_order", []), MAX_MANUAL_ORDER
            ),
            low_balance_threshold=_lenient(
                None, _v_threshold, data.get("low_balance_threshold")
            ),
            cashier_high_contrast=data.get("cashier_high_contrast") is True,
        )


def _lenient(fallback: Any, validator: Callable[..., Any], *args: Any) -> Any:
    """Load stored prefs with the API validator; invalid data -> the default."""
    try:
        return validator(*args)
    except ValidationError:
        return fallback


def _load_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _load_locations(value: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(value, list):
        return out
    for loc in value:
        try:
            lat, lon = float(loc["lat"]), float(loc["lon"])
            loc_id = str(loc["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180:
            out.append({"id": loc_id, "lat": lat, "lon": lon})
    return out[:MAX_LOCATIONS]


def _valid_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _load_usage(value: Any) -> list[int]:
    """Accept the 42-item list (v0.4) or the sparse {"slot": n} dict (§12.1)."""
    usage = [0] * USAGE_LEN
    if isinstance(value, dict):
        for key, count in value.items():
            if not isinstance(key, str) or not key.isdigit() or not _valid_count(count):
                continue
            slot = int(key)
            if 0 <= slot < USAGE_LEN and str(slot) == key:
                usage[slot] = count
        return usage
    if not isinstance(value, list) or len(value) != USAGE_LEN:
        return usage
    return [v if _valid_count(v) else 0 for v in value]


def _load_points_history(value: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not isinstance(value, list):
        return out
    for item in value:
        if not isinstance(item, dict):
            continue
        day, points = item.get("date"), item.get("points")
        if not isinstance(day, str) or isinstance(points, bool) or not isinstance(points, int):
            continue
        try:
            date.fromisoformat(day)
        except ValueError:
            continue
        out.append({"date": day, "points": points})
    return out[-MAX_POINTS_HISTORY:]


def _load_sites(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [v for v in value if isinstance(v, str)]


def compute_balance(
    initial_balance: float | None,
    transactions: list[Transaction],
    reloadable: bool = False,
) -> float | None:
    """initial - sum(spend) + sum(topup) + sum(adjust) (adjust amounts are signed).

    A null initial balance gives a null balance, except for reloadable vouchers
    or when there is at least one adjustment: then it counts as 0.
    """
    if initial_balance is None:
        if not reloadable and not any(t.type == TX_ADJUST for t in transactions):
            return None
        initial_balance = 0.0
    total = initial_balance
    for t in transactions:
        if t.type in (TX_TOPUP, TX_ADJUST):
            total += t.amount
        else:
            total -= t.amount
    return round(total, 2)


# ---------------------------------------------------------------- validators


def _v_str(key: str, value: Any, min_len: int, max_len: int, strip: bool = True) -> str:
    if not isinstance(value, str):
        raise _err(f"{key} must be a string")
    if strip:
        value = value.strip()
    if not min_len <= len(value) <= max_len:
        raise _err(f"{key} length must be between {min_len} and {max_len}")
    return value


def _v_bool(key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise _err(f"{key} must be a boolean")
    return value


def _v_number(key: str, value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _err(f"{key} must be a number")
    value = float(value)
    if not math.isfinite(value):
        raise _err(f"{key} must be finite")
    return value


def _v_str_list(key: str, value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > MAX_LIST_ITEMS:
        raise _err(f"{key} must be a list")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or len(item) > 255:
            raise _err(f"{key} items must be non-empty strings")
        if item not in out:
            out.append(item)
    return out


def parse_iso_date(value: Any) -> date:
    if not isinstance(value, str):
        raise _err("date must be a string YYYY-MM-DD")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise _err(f"invalid date: {value}") from exc


def parse_iso_datetime(value: Any) -> datetime:
    if not isinstance(value, str):
        raise _err("datetime must be an ISO string")
    try:
        dt = datetime.fromisoformat(value.strip())
    except ValueError as exc:
        raise _err(f"invalid datetime: {value}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _validate_field(key: str, value: Any) -> Any:
    if key == "kind":
        if value not in KINDS:
            raise _err("kind must be 'card' or 'voucher'")
        return value
    if key == "name":
        return _v_str(key, value, 1, MAX_NAME)
    if key == "code":
        return _v_str(key, value, 1, MAX_CODE)
    if key == "barcode_format":
        fmt = normalize_format(value)
        if fmt is None:
            raise _err(f"unknown barcode_format: {value!r}")
        return fmt.value
    if key == "color":
        if not isinstance(value, str) or not _COLOR_RE.match(value.strip()):
            raise _err("color must be #RRGGBB")
        return value.strip().upper()
    if key == "notes":
        if value is None:
            return ""
        return _v_str(key, value, 0, MAX_NOTES, strip=False)
    if key == "points":
        if value is None:
            return None
        if isinstance(value, bool):
            raise _err("points must be an integer")
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if not isinstance(value, int):
            raise _err("points must be an integer")
        return value
    if key == "visibility":
        if value not in VISIBILITIES:
            raise _err("visibility must be 'private' or 'shared'")
        return value
    if key == "shared_with":
        return _v_str_list(key, value)
    if key == "zones":
        zones = _v_str_list(key, value)
        for z in zones:
            if not z.startswith("zone."):
                raise _err("zones must be zone.* entity ids")
        return zones
    if key in ("favorite", "reloadable", "shop_custom", "suggest_shop"):
        return _v_bool(key, value)
    if key in ("expiry", "points_expiry"):
        if value is None or value == "":
            return None
        return parse_iso_date(value).isoformat()
    if key == "short_name":
        if value is None:
            return ""
        return _v_str(key, value, 0, MAX_SHORT_NAME)
    if key == "todo_entity":
        # Shape only here; the HA layer checks that the entity exists (§15.5).
        if value is None or value == "":
            return None
        if not isinstance(value, str) or not _TODO_ENTITY_RE.match(value.strip()):
            raise _err("todo_entity must be a todo.* entity id")
        return value.strip()
    if key == "currency":
        if not isinstance(value, str) or not _CURRENCY_RE.match(value.strip().upper()):
            raise _err("currency must be a 3-letter code")
        return value.strip().upper()
    if key == "initial_balance":
        if value is None:
            return None
        num = _v_number(key, value)
        if num < 0:
            raise _err("initial_balance must be >= 0")
        return round(num, 2)
    if key == "logo_domain":
        return validate_domain(value)
    if key == "logo_fit":
        if value not in LOGO_FITS:
            raise _err("logo_fit must be 'contain' or 'cover'")
        return value
    if key == "balance_corner":
        if value not in BALANCE_CORNERS:
            raise _err(f"balance_corner must be one of {', '.join(BALANCE_CORNERS)}")
        return value
    if key == "balance_size":
        if value not in BALANCE_SIZES:
            raise _err(f"balance_size must be one of {', '.join(BALANCE_SIZES)}")
        return value
    raise _err(f"unknown field: {key}")


def validate_editable(data: Any) -> dict[str, Any]:
    """Validate a dict of editable fields. Unknown keys -> invalid_format."""
    if not isinstance(data, dict):
        raise _err("card must be an object")
    unknown = set(data) - EDITABLE_FIELDS
    if unknown:
        raise _err(f"unknown or read-only fields: {', '.join(sorted(map(str, unknown)))}")
    return {key: _validate_field(key, value) for key, value in data.items()}


# ---------------------------------------------------------------- operations


def create_card(
    data: Any,
    owner_id: str,
    now: datetime | None = None,
    id_factory: Callable[[], str] = new_id,
    default_currency: str = FALLBACK_CURRENCY,
) -> Card:
    """`default_currency` (§14.3): HA's currency, used when the data has none."""
    clean = validate_editable(data)
    for required in ("name", "code"):
        if required not in clean:
            raise _err(f"{required} is required")
    clean.setdefault("currency", default_currency)
    ts = iso(now or utcnow())
    card = Card(id=id_factory(), owner_id=owner_id, created_at=ts, updated_at=ts, **clean)
    validate_code(card.code, BarcodeFormat(card.barcode_format))
    return card


def update_card(card: Card, changes: Any, now: datetime | None = None) -> Card:
    """Apply editable changes in place (after validation) and return the card."""
    clean = validate_editable(changes)
    if "name" in clean or "code" in clean or "barcode_format" in clean:
        validate_code(
            clean.get("code", card.code),
            BarcodeFormat(clean.get("barcode_format", card.barcode_format)),
        )
    for key, value in clean.items():
        setattr(card, key, value)
    card.updated_at = iso(now or utcnow())
    return card


def usage_slot(local_dt: datetime) -> int:
    """Index in Card.usage for a datetime already in HA's local time zone."""
    return local_dt.weekday() * USAGE_SLOTS_PER_DAY + local_dt.hour // 4


def mark_used(
    card: Card, now: datetime | None = None, local_now: datetime | None = None
) -> bool:
    """Count a use. Returns False (nothing changed) within MARK_USED_COOLDOWN.

    `local_now` is `now` in HA's time zone (for the weekday/slot); defaults to `now`.
    """
    now = now or utcnow()
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if card.last_used:
        try:
            last = parse_iso_datetime(card.last_used)
        except ValidationError:
            last = None
        if last is not None and timedelta(0) <= now - last < MARK_USED_COOLDOWN:
            return False
    if len(card.usage) != USAGE_LEN:
        card.usage = _load_usage(card.usage)
    card.usage[usage_slot(local_now or now)] += 1
    card.use_count += 1
    card.last_used = iso(now)
    return True


def add_transaction(
    card: Card,
    amount: Any,
    user_id: str,
    note: Any = None,
    tx_date: Any = None,
    now: datetime | None = None,
    id_factory: Callable[[], str] = new_id,
    tx_type: Any = None,
) -> Transaction:
    if card.kind != KIND_VOUCHER:
        raise _err("transactions are only allowed on vouchers")
    if tx_type in (None, ""):
        tx_type = TX_SPEND
    if tx_type not in ADD_TX_TYPES:
        # Adjustments only go through adjust_balance().
        raise _err("type must be 'spend' or 'topup'")
    if tx_type == TX_TOPUP and not card.reloadable:
        raise _err("top-ups are only allowed on reloadable vouchers")
    value = _v_number("amount", amount)
    if value <= 0:
        raise _err("amount must be > 0")
    note_s = "" if note is None else _v_str("note", note, 0, MAX_TX_NOTE)
    now = now or utcnow()
    when = iso(parse_iso_datetime(tx_date)) if tx_date not in (None, "") else iso(now)
    tx = Transaction(
        id=id_factory(),
        date=when,
        amount=round(value, 2),
        note=note_s,
        user_id=user_id,
        type=tx_type,
    )
    card.transactions.append(tx)
    card.transactions.sort(key=lambda t: t.date)
    card.updated_at = iso(now)
    return tx


def adjust_balance(
    card: Card,
    new_balance: Any,
    reason: Any,
    user_id: str,
    now: datetime | None = None,
    id_factory: Callable[[], str] = new_id,
) -> Transaction:
    """Record an `adjust` transaction so that the balance becomes new_balance."""
    if card.kind != KIND_VOUCHER:
        raise _err("balance adjustments are only allowed on vouchers")
    target = _v_number("new_balance", new_balance)
    if target < 0:
        raise _err("new_balance must be >= 0")
    note = _v_str("reason", reason, 1, MAX_TX_NOTE)
    # Balance as if a null initial balance were 0 (that is what it becomes after an adjust).
    current = compute_balance(
        card.initial_balance if card.initial_balance is not None else 0.0,
        card.transactions,
        reloadable=card.reloadable,
    ) or 0.0
    amount = round(round(target, 2) - current, 2)
    if amount == 0:
        raise _err("new_balance equals the current balance")
    now = now or utcnow()
    tx = Transaction(
        id=id_factory(),
        date=iso(now),
        amount=amount,
        note=note,
        user_id=user_id,
        type=TX_ADJUST,
    )
    card.transactions.append(tx)
    card.transactions.sort(key=lambda t: t.date)
    card.updated_at = iso(now)
    return tx


def remove_transaction(card: Card, tx_id: str, now: datetime | None = None) -> None:
    tx = card.find_transaction(tx_id)
    card.transactions.remove(tx)
    card.updated_at = iso(now or utcnow())


def _logo_versions(card: Card) -> dict[str, Any]:
    """Pseudo-previous for make_logo_info: the highest version seen on this card."""
    versions = [
        meta["version"]
        for meta in (card.logo, card.logo_previous)
        if isinstance(meta, dict) and isinstance(meta.get("version"), int)
    ]
    return {"version": max(versions, default=0)}


def _as_previous(logo: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in logo.items() if k not in _PREVIOUS_DROPPED_KEYS}


def set_logo(
    card: Card,
    source: str,
    mime: str,
    now: datetime | None = None,
    domain: str | None = None,
) -> Card:
    """The single write rule (§14.2), metadata side.

    The current logo (if any) becomes the previous one (the old previous is
    dropped); the new logo gets a new `version`. Without a current logo the
    previous one is kept. `domain` is the domain used by an online provider.
    """
    now = now or utcnow()
    ts = iso(now)
    new = make_logo_info(
        source, mime, ts, _logo_versions(card), int(now.timestamp() * 1000), domain=domain
    )
    if card.logo:
        card.logo_previous = _as_previous(card.logo)
    card.logo = new
    card.updated_at = ts
    return card


def clear_logo(card: Card, now: datetime | None = None) -> Card:
    """logo/delete (§14.2): the current logo becomes the previous one (undoable)."""
    if card.logo:
        card.logo_previous = _as_previous(card.logo)
    card.logo = None
    card.updated_at = iso(now or utcnow())
    return card


def revert_logo(card: Card, now: datetime | None = None) -> Card:
    """logo/revert (§14.2): swap the current and the previous logo.

    The logo that becomes current gets a new `version` (and `checked_at = now`,
    so that the logo cache does not replace it right away); the one that becomes
    previous keeps its metadata. Without a current logo the previous one comes
    back and `logo_previous` becomes None. No previous logo -> not_found.
    """
    if not card.logo_previous:
        raise NotFoundError("This card has no previous logo")
    now = now or utcnow()
    ts = iso(now)
    version = max(_logo_versions(card)["version"] + 1, int(now.timestamp() * 1000))
    restored = {**card.logo_previous, "version": version, "checked_at": ts}
    card.logo_previous = _as_previous(card.logo) if card.logo else None
    card.logo = restored
    card.updated_at = ts
    return card


def set_logo_checked(card: Card, checked_at: str) -> None:
    """Cache bookkeeping (§14.2): last automatic refresh attempt; no `updated_at` change."""
    if card.logo:
        card.logo = {**card.logo, "checked_at": checked_at}


# ---------------------------------------------------------------- locations (§11.5)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in meters."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def add_location(
    card: Card,
    latitude: Any,
    longitude: Any,
    now: datetime | None = None,
    id_factory: Callable[[], str] = new_id,
) -> bool:
    """Add a store position. Returns False if one already exists within 100 m."""
    lat = _v_number("latitude", latitude)
    lon = _v_number("longitude", longitude)
    if not -90 <= lat <= 90:
        raise _err("latitude must be between -90 and 90")
    if not -180 <= lon <= 180:
        raise _err("longitude must be between -180 and 180")
    lat, lon = round(lat, LOCATION_DECIMALS), round(lon, LOCATION_DECIMALS)
    for loc in card.locations:
        if distance_m(lat, lon, loc["lat"], loc["lon"]) <= LOCATION_MERGE_METERS:
            return False
    if len(card.locations) >= MAX_LOCATIONS:
        raise LimitReachedError(f"at most {MAX_LOCATIONS} locations per card")
    card.locations.append({"id": id_factory(), "lat": lat, "lon": lon})
    card.updated_at = iso(now or utcnow())
    return True


def remove_location(card: Card, location_id: str, now: datetime | None = None) -> None:
    for loc in card.locations:
        if loc["id"] == location_id:
            card.locations.remove(loc)
            card.updated_at = iso(now or utcnow())
            return
    raise NotFoundError(f"Location {location_id} not found")


def card_key(card: Card | dict[str, Any]) -> tuple[str, str]:
    """Dedup key (name, code) used by import."""
    if isinstance(card, Card):
        return card.name.strip().casefold(), card.code.strip()
    return str(card.get("name", "")).strip().casefold(), str(card.get("code", "")).strip()


# ---------------------------------------------------------------- prefs


def default_prefs(user_id: str) -> UserPrefs:
    return UserPrefs(user_id=user_id)


def update_prefs(prefs: UserPrefs, changes: Any) -> UserPrefs:
    if not isinstance(changes, dict):
        raise _err("prefs must be an object")
    unknown = set(changes) - PREFS_EDITABLE
    if unknown:
        raise _err(f"unknown prefs fields: {', '.join(sorted(map(str, unknown)))}")
    if "notify_service" in changes:
        svc = changes["notify_service"]
        if svc in (None, ""):
            prefs.notify_service = None
        else:
            if not isinstance(svc, str):
                raise _err("notify_service must be a string")
            svc = svc.strip()
            if svc.startswith("notify."):
                svc = svc[len("notify.") :]
            if not _SERVICE_RE.match(svc) or len(svc) > 255:
                raise _err("invalid notify_service")
            prefs.notify_service = svc
    if "language" in changes:
        lang = changes["language"]
        if lang in (None, ""):
            prefs.language = None
        else:
            norm = normalize_language(lang)
            if norm is None or len(str(lang)) > MAX_LANGUAGE_LEN:
                raise _err("invalid language tag")
            prefs.language = norm
    for key in ("zone_notifications", "expiry_notifications", "price_compare", "nearby"):
        if key in changes:
            setattr(prefs, key, _v_bool(key, changes[key]))
    if "price_compare_sites" in changes:
        prefs.price_compare_sites = _v_price_sites(changes["price_compare_sites"])
    if "countries" in changes:
        prefs.countries = validate_countries(changes["countries"])
    for key in ("grouping", "refuse_from_others", "inbox_notifications", "cashier_high_contrast"):
        if key in changes:
            setattr(prefs, key, _v_bool(key, changes[key]))
    if "group_split" in changes:
        prefs.group_split = _v_id_list("group_split", changes["group_split"], MAX_GROUP_SPLIT)
    if "group_links" in changes:
        prefs.group_links = _v_group_links(changes["group_links"])
    if "group_tabs" in changes:
        prefs.group_tabs = _v_group_tabs(changes["group_tabs"])
    if "group_names" in changes:
        prefs.group_names = _v_group_names(changes["group_names"])
    if "features_off" in changes:
        prefs.features_off = validate_features_off(changes["features_off"])
    if "default_share" in changes:
        prefs.default_share = _v_default_share(changes["default_share"])
    if "list_order" in changes:
        if changes["list_order"] not in LIST_ORDERS:
            raise _err("list_order must be 'habits' or 'manual'")
        prefs.list_order = changes["list_order"]
    if "manual_order" in changes:
        prefs.manual_order = _v_id_list("manual_order", changes["manual_order"], MAX_MANUAL_ORDER)
    if "low_balance_threshold" in changes:
        prefs.low_balance_threshold = _v_threshold(changes["low_balance_threshold"])
    return prefs


# ---------------------------------------------------------------- prefs validators (§15)


def _v_pref_id(key: str, value: Any, max_len: int = MAX_PREF_ID) -> str:
    if not isinstance(value, str) or not value or len(value) > max_len:
        raise _err(f"{key}: items must be strings of 1-{max_len} characters")
    return value


def _v_id_list(key: str, value: Any, max_items: int) -> list[str]:
    """A list of card ids (shape only, duplicates dropped)."""
    if not isinstance(value, list) or len(value) > max_items:
        raise _err(f"{key} must be a list of at most {max_items} ids")
    return list(dict.fromkeys(_v_pref_id(key, item) for item in value))


def _v_group_links(value: Any) -> list[list[str]]:
    if not isinstance(value, list) or len(value) > MAX_GROUP_LINKS:
        raise _err(f"group_links must be a list of at most {MAX_GROUP_LINKS} pairs")
    out: list[list[str]] = []
    seen: set[tuple[str, str]] = set()
    for pair in value:
        if not isinstance(pair, list) or len(pair) != 2:
            raise _err("group_links items must be [card_id, card_id]")
        a, b = (_v_pref_id("group_links", item) for item in pair)
        if a == b:
            raise _err("group_links: a card cannot be linked to itself")
        norm = (a, b) if a < b else (b, a)
        if norm not in seen:
            seen.add(norm)
            out.append([a, b])
    return out


def _v_group_tabs(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict) or len(value) > MAX_GROUP_TABS:
        raise _err(f"group_tabs must be an object with at most {MAX_GROUP_TABS} keys")
    out: dict[str, dict[str, Any]] = {}
    for group_key, tab in value.items():
        _v_pref_id("group_tabs", group_key, MAX_GROUP_KEY)
        if not isinstance(tab, dict) or set(tab) - {"mode", "order"}:
            raise _err("group_tabs values must be {mode, order}")
        mode = tab.get("mode", "auto")
        if mode not in TAB_MODES:
            raise _err("group_tabs mode must be 'auto' or 'manual'")
        order = _v_id_list("group_tabs order", tab.get("order", []), MAX_GROUP_TAB_ORDER)
        out[group_key] = {"mode": mode, "order": order}
    return out


def _v_group_names(value: Any) -> dict[str, str]:
    """§16.2: {group_key: name}; names stripped, empty names dropped (shape only)."""
    if not isinstance(value, dict) or len(value) > MAX_GROUP_TABS:
        raise _err(f"group_names must be an object with at most {MAX_GROUP_TABS} keys")
    out: dict[str, str] = {}
    for group_key, name in value.items():
        _v_pref_id("group_names", group_key, MAX_GROUP_KEY)
        if not isinstance(name, str):
            raise _err("group_names values must be strings")
        name = name.strip()
        if len(name) > MAX_GROUP_NAME or any(ord(ch) < 32 or ord(ch) == 127 for ch in name):
            raise _err(f"group_names: names must be at most {MAX_GROUP_NAME} printable characters")
        if name:
            out[group_key] = name
    return out


def _v_default_share(value: Any) -> dict[str, Any] | None:
    """{visibility, shared_with} validated like a card; None = no default."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - {"visibility", "shared_with"}:
        raise _err("default_share must be {visibility, shared_with} or null")
    visibility = _validate_field("visibility", value.get("visibility", VIS_PRIVATE))
    shared_with = _validate_field("shared_with", value.get("shared_with", []))
    return {"visibility": visibility, "shared_with": shared_with}


def _v_threshold(value: Any) -> float | None:
    if value is None:
        return None
    num = _v_number("low_balance_threshold", value)
    if num < 0:
        raise _err("low_balance_threshold must be >= 0")
    return round(num, 2)


def filter_default_share(
    default_share: dict[str, Any] | None, known_user_ids: Iterable[str]
) -> dict[str, Any] | None:
    """§15.5: users that no longer exist are dropped when reading (never stored)."""
    if not default_share:
        return default_share
    known = set(known_user_ids)
    return {
        "visibility": default_share.get("visibility", VIS_PRIVATE),
        "shared_with": [
            u for u in default_share.get("shared_with", []) if u == SHARE_ALL or u in known
        ],
    }


# ---------------------------------------------------------------- points history (§15.5)


def record_points_history(card: Card, today: date) -> bool:
    """Record today's points (same day -> replaced). `None` points are not recorded."""
    if card.points is None:
        return False
    day = today.isoformat()
    history = [dict(e) for e in card.points_history]
    if history and history[-1].get("date") == day:
        history[-1]["points"] = card.points
    else:
        history.append({"date": day, "points": card.points})
    card.points_history = history[-MAX_POINTS_HISTORY:]
    return True


def clear_points_history(card: Card, now: datetime | None = None) -> Card:
    card.points_history = []
    card.updated_at = iso(now or utcnow())
    return card


# ---------------------------------------------------------------- archive (§11.10)


def is_archived(card: Card, today: date) -> bool:
    """Non reloadable voucher with balance <= 0, or a card with a past expiry."""
    if card.kind == KIND_VOUCHER and not card.reloadable:
        bal = card.balance
        if bal is not None and bal <= 0:
            return True
    if card.expiry:
        try:
            return date.fromisoformat(card.expiry) < today
        except ValueError:
            return False
    return False


def _v_price_sites(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > MAX_PRICE_SITES:
        raise _err(f"price_compare_sites must be a list of at most {MAX_PRICE_SITES} names")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise _err("price_compare_sites items must be strings")
        item = item.strip()
        if not 1 <= len(item) <= MAX_PRICE_SITE_NAME:
            raise _err(f"price_compare_sites items must be 1-{MAX_PRICE_SITE_NAME} characters")
        if item not in out:
            out.append(item)
    return out
