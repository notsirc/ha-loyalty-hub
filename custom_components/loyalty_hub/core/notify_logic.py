"""Notification decisions (ARCHITETTURA §6, §15.5): zone enter, expiry, points expiry,
low balance, unused-card reminder."""

from __future__ import annotations

import hashlib
import hmac
from collections.abc import Iterable, Mapping, MutableMapping
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .i18n import Translator
from .models import KIND_VOUCHER, SHARE_ALL, VIS_SHARED, Card, is_archived, iso
from .permissions import Actor, can_view

ZONE_COOLDOWN = timedelta(hours=4)
ZONE_HOME = "zone.home"
DEFAULT_EXPIRY_WARNING_DAYS = 7
PANEL_PATH = "/loyalty-hub"
NOTIFY_GROUP = "loyalty_hub"
# Zone log entries older than this are pruned.
_ZONE_LOG_RETENTION = timedelta(days=2)


def zone_log_key(user_id: str, card_id: str) -> str:
    return f"{user_id}:{card_id}"


def expiry_log_key(user_id: str, card_id: str, expiry: str) -> str:
    return f"exp:{user_id}:{card_id}:{expiry}"


def points_expiry_log_key(user_id: str, card_id: str, day: str) -> str:
    return f"pexp:{user_id}:{card_id}:{day}"


def low_balance_log_key(user_id: str, card_id: str) -> str:
    return f"low:{user_id}:{card_id}"


def unused_log_key(user_id: str, zone_entity_id: str) -> str:
    return f"unused:{user_id}:{zone_entity_id}"


# §15.5: unused-card reminder.
UNUSED_DELAY = timedelta(minutes=10)
UNUSED_COOLDOWN = timedelta(hours=4)
UNUSED_TOKEN_TTL = timedelta(hours=2)
USED_ACTION_PREFIX = "LOYALTY_HUB_USED_"


def _parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def entered_persons(old_persons: Iterable[str] | None, new_persons: Iterable[str] | None) -> list[str]:
    """Persons present in the new zone state but not in the old one."""
    old = set(old_persons or [])
    return [p for p in (new_persons or []) if p not in old]


def _sort_for_display(cards: list[Card]) -> list[Card]:
    return sorted(cards, key=lambda c: (not c.favorite, -c.use_count, c.name.casefold()))


def cards_for_zone(cards: Iterable[Card], user_id: str, zone_entity_id: str) -> list[Card]:
    """Cards visible to user_id that are linked to the zone (zone.home ignored).

    Always the normal visibility (§11.1): admin_all never applies here, so an
    admin is not notified about other users' private cards.
    """
    if zone_entity_id == ZONE_HOME:
        return []
    actor = Actor(user_id)
    return _sort_for_display(
        [c for c in cards if zone_entity_id in c.zones and can_view(c, actor)]
    )


def filter_cooldown(
    cards: Iterable[Card],
    user_id: str,
    notify_log: Mapping[str, str],
    now: datetime,
    cooldown: timedelta = ZONE_COOLDOWN,
) -> list[Card]:
    """Drop cards already notified to this user within the cooldown."""
    out = []
    for card in cards:
        last = _parse_dt(notify_log.get(zone_log_key(user_id, card.id)))
        if last is None or now - last >= cooldown:
            out.append(card)
    return out


def record_zone_notified(
    notify_log: MutableMapping[str, str], user_id: str, cards: Iterable[Card], now: datetime
) -> None:
    ts = iso(now)
    for card in cards:
        notify_log[zone_log_key(user_id, card.id)] = ts


@dataclass
class Notification:
    title: str
    message: str
    data: dict[str, Any] = field(default_factory=dict)

    def service_data(self) -> dict[str, Any]:
        return {"title": self.title, "message": self.message, "data": self.data}


def build_zone_notification(
    zone_entity_id: str,
    zone_name: str,
    cards: list[Card],
    t: Translator,
    todo_counts: Mapping[str, int] | None = None,
) -> Notification:
    """Message per §6; the link opens the first (favorite / most used) card.

    `todo_counts` (§15.5 shopping_list): {card_id: items to do} of the cards with a
    linked todo list; a line "Conad: 5 items on the list" per card with count > 0.
    """
    message = t("zone.message", count=len(cards), name=cards[0].name)
    lines = [
        t("zone.todo_line", count=n, name=c.name)
        for c in cards
        if (n := (todo_counts or {}).get(c.id, 0)) > 0
    ]
    if lines:
        message = "\n".join([message, *lines])
    url = f"{PANEL_PATH}?card={cards[0].id}"
    zone_slug = zone_entity_id.split(".", 1)[-1]
    return Notification(
        title=zone_name,
        message=message,
        data={
            "url": url,
            "clickAction": url,
            "tag": f"loyalty_hub_{zone_slug}",
            "group": NOTIFY_GROUP,
        },
    )


def _is_spent(card: Card) -> bool:
    bal = card.balance
    return card.kind == KIND_VOUCHER and bal is not None and bal <= 0


def expiring_cards(
    cards: Iterable[Card], today: date, warning_days: int = DEFAULT_EXPIRY_WARNING_DAYS
) -> list[Card]:
    """Cards/vouchers whose expiry is in [today, today + warning_days].

    Fully spent vouchers (balance <= 0) are excluded.
    """
    limit = today + timedelta(days=max(0, warning_days))
    out = []
    for card in cards:
        if not card.expiry or _is_spent(card):
            continue
        try:
            exp = date.fromisoformat(card.expiry)
        except ValueError:
            continue
        if today <= exp <= limit:
            out.append(card)
    return sorted(out, key=lambda c: (c.expiry or "", c.name.casefold()))


def count_expiring_vouchers(
    cards: Iterable[Card], today: date, warning_days: int = DEFAULT_EXPIRY_WARNING_DAYS
) -> int:
    return sum(1 for c in expiring_cards(cards, today, warning_days) if c.kind == KIND_VOUCHER)


def expiry_due(
    cards: Iterable[Card],
    today: date,
    warning_days: int,
    notify_log: Mapping[str, str],
) -> list[Card]:
    """Expiring cards whose owner has not been notified yet for that expiry."""
    return [
        c
        for c in expiring_cards(cards, today, warning_days)
        if expiry_log_key(c.owner_id, c.id, c.expiry or "") not in notify_log
    ]


def record_expiry_notified(notify_log: MutableMapping[str, str], card: Card, now: datetime) -> None:
    notify_log[expiry_log_key(card.owner_id, card.id, card.expiry or "")] = iso(now)


def format_amount(value: float, t: Translator) -> str:
    return f"{value:.2f}".replace(".", t("format.decimal_separator"))


def build_expiry_notification(card: Card, today: date, t: Translator) -> Notification:
    exp = date.fromisoformat(card.expiry or today.isoformat())
    days = (exp - today).days
    kind = "voucher" if card.kind == KIND_VOUCHER else "card"
    if days <= 0:
        message = t(f"expiry.{kind}_today", name=card.name)
    elif days == 1:
        message = t(f"expiry.{kind}_tomorrow", name=card.name)
    else:
        message = t(
            f"expiry.{kind}_in_days",
            count=days,
            name=card.name,
            date=exp.strftime(t("format.date")),
        )
    bal = card.balance
    if card.kind == KIND_VOUCHER and bal is not None:
        message = t(
            "expiry.with_balance",
            message=message,
            balance=format_amount(bal, t),
            currency=card.currency,
        )
    url = f"{PANEL_PATH}?card={card.id}"
    return Notification(
        title=t("expiry.title"),
        message=message,
        data={
            "url": url,
            "clickAction": url,
            "tag": f"loyalty_hub_exp_{card.id}",
            "group": NOTIFY_GROUP,
        },
    )


def prune_notify_log(
    notify_log: MutableMapping[str, str], now: datetime, today: date
) -> int:
    """Remove stale entries: zone/unused entries past retention, (points) expiry
    entries for past dates. Low balance entries stay until the balance rises again."""
    removed = 0
    for key in list(notify_log):
        if key.startswith("low:"):
            continue
        if key.startswith(("exp:", "pexp:")):
            exp_s = key.rsplit(":", 1)[-1]
            try:
                stale = date.fromisoformat(exp_s) < today
            except ValueError:
                stale = True
        else:
            last = _parse_dt(notify_log[key])
            stale = last is None or now - last > _ZONE_LOG_RETENTION
        if stale:
            del notify_log[key]
            removed += 1
    return removed


# ---------------------------------------------------------------- shopping list (§15.5)


def todo_count(state_value: Any) -> int:
    """Items to do of a todo entity: its numeric state (anything else -> 0)."""
    try:
        n = int(float(state_value))
    except (TypeError, ValueError):
        return 0
    return max(n, 0)


# ---------------------------------------------------------------- points expiry (§15.5)


def points_expiring_cards(
    cards: Iterable[Card], today: date, warning_days: int = DEFAULT_EXPIRY_WARNING_DAYS
) -> list[Card]:
    """Cards whose `points_expiry` is in [today, today + warning_days] (spent vouchers excluded)."""
    limit = today + timedelta(days=max(0, warning_days))
    out = []
    for card in cards:
        if not card.points_expiry or _is_spent(card):
            continue
        try:
            day = date.fromisoformat(card.points_expiry)
        except ValueError:
            continue
        if today <= day <= limit:
            out.append(card)
    return sorted(out, key=lambda c: (c.points_expiry or "", c.name.casefold()))


def points_expiry_due(
    cards: Iterable[Card], today: date, warning_days: int, notify_log: Mapping[str, str]
) -> list[Card]:
    """Owner only (as §6), once per date (`pexp:<user>:<card>:<date>`)."""
    return [
        c
        for c in points_expiring_cards(cards, today, warning_days)
        if points_expiry_log_key(c.owner_id, c.id, c.points_expiry or "") not in notify_log
    ]


def record_points_expiry_notified(
    notify_log: MutableMapping[str, str], card: Card, now: datetime
) -> None:
    notify_log[points_expiry_log_key(card.owner_id, card.id, card.points_expiry or "")] = iso(now)


def build_points_expiry_notification(card: Card, today: date, t: Translator) -> Notification:
    day = date.fromisoformat(card.points_expiry or today.isoformat())
    url = f"{PANEL_PATH}?card={card.id}"
    return Notification(
        title=t("expiry.title"),
        message=t("points_expiry.message", name=card.name, date=day.strftime(t("format.date"))),
        data={
            "url": url,
            "clickAction": url,
            "tag": f"loyalty_hub_pexp_{card.id}",
            "group": NOTIFY_GROUP,
        },
    )


# ---------------------------------------------------------------- low balance (§15.5)


def viewer_ids(card: Card, user_ids: Iterable[str]) -> list[str]:
    """Users who see the card with the normal visibility (never admin_all)."""
    if card.visibility == VIS_SHARED and SHARE_ALL in card.shared_with:
        candidates = list(dict.fromkeys([card.owner_id, *user_ids]))
    else:
        candidates = list(dict.fromkeys([card.owner_id, *card.shared_with]))
    return [u for u in candidates if u != SHARE_ALL and can_view(card, Actor(u))]


@dataclass
class LowBalanceDecision:
    notify: list[str] = field(default_factory=list)  # user ids to notify now
    clear: list[str] = field(default_factory=list)  # notify_log keys to delete


def low_balance_decision(
    card: Card,
    thresholds: Mapping[str, float | None],
    notify_log: Mapping[str, str],
    today: date,
) -> LowBalanceDecision:
    """`thresholds`: {viewer user id: low_balance_threshold}. Once per low period:
    the log key is deleted when the balance rises above the threshold."""
    out = LowBalanceDecision()
    bal = card.balance
    if card.kind != KIND_VOUCHER or bal is None or is_archived(card, today):
        return out
    for user_id, threshold in thresholds.items():
        key = low_balance_log_key(user_id, card.id)
        if threshold is None:
            continue
        if bal > threshold:
            if key in notify_log:
                out.clear.append(key)
        elif bal > 0 and key not in notify_log:
            out.notify.append(user_id)
    return out


def build_low_balance_notification(card: Card, t: Translator) -> Notification:
    url = f"{PANEL_PATH}?card={card.id}"
    return Notification(
        title=t("low_balance.title"),
        message=t(
            "low_balance.message",
            name=card.name,
            balance=format_amount(card.balance or 0.0, t),
            currency=card.currency,
        ),
        data={
            "url": url,
            "clickAction": url,
            "tag": f"loyalty_hub_low_{card.id}",
            "group": NOTIFY_GROUP,
        },
    )


# ---------------------------------------------------------------- unused reminder (§15.5)


def unused_cooldown_ok(
    notify_log: Mapping[str, str], user_id: str, zone_entity_id: str, now: datetime
) -> bool:
    last = _parse_dt(notify_log.get(unused_log_key(user_id, zone_entity_id)))
    return last is None or now - last >= UNUSED_COOLDOWN


def unused_since(cards: Iterable[Card], entered_at: datetime) -> list[Card]:
    """The cards, if none of them was used after entering the zone; else []."""
    cards = list(cards)
    for card in cards:
        last = _parse_dt(card.last_used)
        if last is not None and last >= entered_at:
            return []
    return cards


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def parse_used_action(action: Any) -> str | None:
    """Token of a `LOYALTY_HUB_USED_<token>` notification action, else None."""
    if not isinstance(action, str) or not action.startswith(USED_ACTION_PREFIX):
        return None
    token = action[len(USED_ACTION_PREFIX) :]
    return token or None


def token_matches(token: str, token_hash: str) -> bool:
    return hmac.compare_digest(hash_token(token), token_hash)


def build_unused_notification(
    zone_entity_id: str,
    zone_name: str,
    cards: list[Card],
    t: Translator,
    token: str | None = None,
) -> Notification:
    """One card: "Did you use the card X?" + action "Mark as used" (token given).
    More cards: "Did you use a card from <zone>?". Always a link to the first card."""
    url = f"{PANEL_PATH}?card={cards[0].id}"
    zone_slug = zone_entity_id.split(".", 1)[-1]
    data: dict[str, Any] = {
        "url": url,
        "clickAction": url,
        "tag": f"loyalty_hub_unused_{zone_slug}",
        "group": NOTIFY_GROUP,
    }
    if len(cards) == 1:
        message = t("unused.message_card", name=cards[0].name)
        if token:
            data["actions"] = [
                {"action": f"{USED_ACTION_PREFIX}{token}", "title": t("unused.action_used")}
            ]
    else:
        message = t("unused.message_zone", zone=zone_name)
    return Notification(title=t("unused.title"), message=message, data=data)

