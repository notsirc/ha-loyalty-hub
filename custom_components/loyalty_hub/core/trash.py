"""Trash rules (ARCHITETTURA §12.2). Pure Python, no Home Assistant imports.

Deleted cards stay here for TRASH_RETENTION. The owner sees, restores and
purges their entries; administrators see every entry with minimal data and
may only *ask* the owner to restore someone else's card.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from collections.abc import Callable, Iterable, Mapping, MutableMapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from .errors import LimitReachedError, NotFoundError, UnauthorizedError, ValidationError
from .i18n import Translator
from .logos import DEFAULT_LOGO_FIT
from .models import Card, iso, new_id, parse_iso_datetime
from .notify_logic import NOTIFY_GROUP, PANEL_PATH, Notification
from .permissions import Actor

TRASH_RETENTION = timedelta(days=15)
PURGE_DELAY = timedelta(minutes=15)
MAX_SENDS = 20
MAX_REJECTIONS = 3

REQ_PENDING = "pending"
REQ_REJECTED = "rejected"
REQ_STATUSES = (REQ_PENDING, REQ_REJECTED)

RESP_ACCEPT = "accept"
RESP_REJECT = "reject"
RESP_BLOCK = "block"
RESPONSES = (RESP_ACCEPT, RESP_REJECT, RESP_BLOCK)

# Notification action ids: prefix + one-time token (§12.3).
ACTION_ACCEPT_PREFIX = "LOYALTY_HUB_TRASH_ACCEPT_"
ACTION_REJECT_PREFIX = "LOYALTY_HUB_TRASH_REJECT_"
TOKEN_BYTES = 24


def hash_token(token: str) -> str:
    """Hex sha256 of a token (tokens are never stored in clear)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def _parse(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return parse_iso_datetime(value)
    except ValidationError:
        return None


def _int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return default
    return value


# ---------------------------------------------------------------- model


@dataclass
class TrashRequest:
    """An administrator's request to restore someone else's card."""

    id: str
    admin_id: str
    status: str = REQ_PENDING
    sends: int = 0
    created_at: str = ""
    last_sent_at: str = ""
    token_hash: str | None = None

    @property
    def pending(self) -> bool:
        return self.status == REQ_PENDING

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "admin_id": self.admin_id,
            "status": self.status,
            "sends": self.sends,
            "created_at": self.created_at,
            "last_sent_at": self.last_sent_at,
            "token_hash": self.token_hash,
        }

    @classmethod
    def from_dict(cls, data: Any) -> TrashRequest | None:
        if not isinstance(data, dict) or not data.get("id") or not data.get("admin_id"):
            return None
        status = data.get("status")
        token_hash = data.get("token_hash")
        return cls(
            id=str(data["id"]),
            admin_id=str(data["admin_id"]),
            status=status if status in REQ_STATUSES else REQ_REJECTED,
            sends=_int(data.get("sends")),
            created_at=str(data.get("created_at") or ""),
            last_sent_at=str(data.get("last_sent_at") or ""),
            token_hash=token_hash if isinstance(token_hash, str) and token_hash else None,
        )


@dataclass
class TrashEntry:
    card: Card
    deleted_at: str
    deleted_by: str
    purge_at: str | None = None
    request: TrashRequest | None = None
    rejections: int = 0
    blocked: bool = False

    @property
    def card_id(self) -> str:
        return self.card.id

    @property
    def owner_id(self) -> str:
        return self.card.owner_id

    @property
    def has_pending_request(self) -> bool:
        return self.request is not None and self.request.pending

    def expires_at(self) -> datetime | None:
        deleted = _parse(self.deleted_at)
        return deleted + TRASH_RETENTION if deleted else None

    def to_storage(self) -> dict[str, Any]:
        return {
            "card": self.card.to_storage(),
            "deleted_at": self.deleted_at,
            "deleted_by": self.deleted_by,
            "purge_at": self.purge_at,
            "request": self.request.to_dict() if self.request else None,
            "rejections": self.rejections,
            "blocked": self.blocked,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> TrashEntry:
        """Load from storage (trusted data). Raises KeyError/TypeError/ValueError."""
        card = Card.from_dict(data["card"])
        rejections = _int(data.get("rejections"))
        purge_at = data.get("purge_at")
        return cls(
            card=card,
            deleted_at=str(data["deleted_at"]),
            deleted_by=str(data.get("deleted_by") or card.owner_id),
            purge_at=str(purge_at) if purge_at else None,
            request=TrashRequest.from_dict(data.get("request")),
            rejections=rejections,
            blocked=bool(data.get("blocked")) or rejections >= MAX_REJECTIONS,
        )


Trash = MutableMapping[str, TrashEntry]


# ---------------------------------------------------------------- visibility


def can_see(entry: TrashEntry, actor: Actor) -> bool:
    """Owner, or any administrator (with minimal data, see trash_item)."""
    if not actor.user_id:
        return False
    return entry.owner_id == actor.user_id or actor.is_admin


def is_own(entry: TrashEntry, actor: Actor) -> bool:
    return bool(actor.user_id) and entry.owner_id == actor.user_id


def get_entry(trash: Mapping[str, TrashEntry], card_id: str, actor: Actor) -> TrashEntry:
    """The entry, or not_found if it does not exist or the actor cannot see it."""
    entry = trash.get(card_id)
    if entry is None or not can_see(entry, actor):
        raise NotFoundError(f"Trash item {card_id} not found")
    return entry


def get_own_entry(trash: Mapping[str, TrashEntry], card_id: str, actor: Actor) -> TrashEntry:
    """Entry the actor owns: not_found if invisible, unauthorized for an admin's view."""
    entry = get_entry(trash, card_id, actor)
    if not is_own(entry, actor):
        raise UnauthorizedError("Only the owner can do this")
    return entry


def visible_entries(trash: Mapping[str, TrashEntry], actor: Actor) -> list[TrashEntry]:
    entries = [e for e in trash.values() if can_see(e, actor)]
    entries.sort(key=lambda e: e.deleted_at, reverse=True)
    return entries


def own_entries(trash: Mapping[str, TrashEntry], actor: Actor) -> list[TrashEntry]:
    return [e for e in trash.values() if is_own(e, actor)]


# ---------------------------------------------------------------- moves


def move_to_trash(
    cards: MutableMapping[str, Card], trash: Trash, card_id: str, user_id: str, now: datetime
) -> TrashEntry:
    """cards/delete: move the card (permission checked by the caller: can_manage)."""
    card = cards.pop(card_id)
    entry = TrashEntry(card=card, deleted_at=iso(now), deleted_by=user_id)
    trash[card_id] = entry
    return entry


def restore(
    cards: MutableMapping[str, Card], trash: Trash, card_id: str, now: datetime
) -> Card:
    """Put the card back (permission checked by the caller). Works with purge_at set."""
    entry = trash.pop(card_id)
    card = entry.card
    card.updated_at = iso(now)
    cards[card.id] = card
    return card


def is_due(entry: TrashEntry, now: datetime) -> bool:
    """Permanent deletion: retention elapsed or the owner's purge countdown ended."""
    expires = entry.expires_at()
    if expires is None or now >= expires:
        return True
    purge = _parse(entry.purge_at)
    return purge is not None and now >= purge


def due_ids(trash: Mapping[str, TrashEntry], now: datetime) -> list[str]:
    return [cid for cid, entry in trash.items() if is_due(entry, now)]


def notify_log_keys(notify_log: Mapping[str, Any], card_id: str) -> list[str]:
    """notify_log keys that mention a card (`<user>:<card>`, `exp:<user>:<card>:<date>`)."""
    return [k for k in notify_log if card_id in k.split(":")]


# ---------------------------------------------------------------- purge (owner)


def request_purge(entry: TrashEntry, now: datetime) -> bool:
    """Start the PURGE_DELAY countdown. An already running countdown is kept."""
    if entry.purge_at:
        return False
    entry.purge_at = iso(now + PURGE_DELAY)
    return True


def cancel_purge(entry: TrashEntry) -> bool:
    if not entry.purge_at:
        return False
    entry.purge_at = None
    return True


# ---------------------------------------------------------------- restore requests


def request_block_reason(
    entry: TrashEntry, actor: Actor
) -> LimitReachedError | UnauthorizedError | None:
    """Why `actor` may not send a restore request now (None = allowed)."""
    if not actor.is_admin or is_own(entry, actor):
        return UnauthorizedError("Only an administrator can ask to restore someone else's card")
    if entry.blocked or entry.rejections >= MAX_REJECTIONS:
        return LimitReachedError("The owner does not want further requests for this card")
    if entry.request is not None and entry.request.sends >= MAX_SENDS:
        return LimitReachedError(f"At most {MAX_SENDS} requests for this card")
    if entry.purge_at:
        return UnauthorizedError("The owner is emptying this card from the trash")
    req = entry.request
    if req is not None and req.pending and req.admin_id != actor.user_id:
        return UnauthorizedError("Another administrator already has a pending request")
    return None


def send_request(
    entry: TrashEntry,
    actor: Actor,
    now: datetime,
    token_factory: Callable[[], str] = new_token,
    id_factory: Callable[[], str] = new_id,
) -> str:
    """Create or resume the request; returns the new one-time token (clear text).

    The previous token is invalidated. Raises limit_reached / unauthorized.
    """
    if (reason := request_block_reason(entry, actor)) is not None:
        raise reason
    ts = iso(now)
    token = token_factory()
    req = entry.request
    if req is None:
        req = TrashRequest(id=id_factory(), admin_id=str(actor.user_id), created_at=ts)
        entry.request = req
    req.status = REQ_PENDING
    req.admin_id = str(actor.user_id)
    req.sends += 1
    req.last_sent_at = ts
    req.token_hash = hash_token(token)
    return token


def respond(entry: TrashEntry, response: str) -> bool:
    """Owner's answer (permission checked by the caller).

    Returns True for `accept` (the caller restores the card). reject/block update
    the counters. Raises not_found if there is no suitable request.
    """
    if response not in RESPONSES:
        raise ValidationError("response must be accept, reject or block")
    req = entry.request
    if req is None:
        raise NotFoundError("No restore request for this card")
    if response == RESP_ACCEPT:
        if not req.pending:
            raise NotFoundError("No pending restore request for this card")
        return True
    if response == RESP_REJECT and not req.pending:
        raise NotFoundError("No pending restore request for this card")
    if req.pending:
        # A rejected request was already counted: blocking it later adds no rejection.
        entry.rejections += 1
    req.status = REQ_REJECTED
    req.token_hash = None
    entry.blocked = (
        entry.blocked or response == RESP_BLOCK or entry.rejections >= MAX_REJECTIONS
    )
    return False


def find_by_token(trash: Mapping[str, TrashEntry], token: str) -> TrashEntry | None:
    """Entry whose *pending* request has this token (constant-time hash compare)."""
    if not token:
        return None
    wanted = hash_token(token)
    found: TrashEntry | None = None
    for entry in trash.values():
        req = entry.request
        if req is None or not req.pending or not req.token_hash:
            continue
        if hmac.compare_digest(req.token_hash, wanted):
            found = entry
    return found


def parse_action(action: Any) -> tuple[str, str] | None:
    """(response, token) for a notification action id of ours, else None."""
    if not isinstance(action, str):
        return None
    for prefix, response in (
        (ACTION_ACCEPT_PREFIX, RESP_ACCEPT),
        (ACTION_REJECT_PREFIX, RESP_REJECT),
    ):
        if action.startswith(prefix):
            token = action[len(prefix) :]
            return (response, token) if token else None
    return None


# ---------------------------------------------------------------- output


def trash_item(entry: TrashEntry, actor: Actor, names: Mapping[str, str]) -> dict[str, Any]:
    """TrashItem as seen by `actor` (§12.4).

    Administrators get someone else's entry WITHOUT code, notes, transactions,
    locations or logo: only what is needed to recognize it and ask the owner.
    """
    card = entry.card
    own = is_own(entry, actor)
    expires = entry.expires_at()
    req = entry.request
    logo = None
    if own and card.logo:
        logo = {"version": card.logo.get("version"), "mime": card.logo.get("mime")}
    return {
        "card_id": card.id,
        "name": card.name,
        "kind": card.kind,
        "color": card.color,
        "owner_id": card.owner_id,
        "owner_name": names.get(card.owner_id, ""),
        "is_own": own,
        "deleted_at": entry.deleted_at,
        "expires_at": iso(expires) if expires else entry.deleted_at,
        "purge_at": entry.purge_at,
        "logo": logo,
        "logo_fit": card.logo_fit if own else DEFAULT_LOGO_FIT,
        "request": (
            {
                "status": req.status,
                "admin_name": names.get(req.admin_id, ""),
                "sends": req.sends,
                "max_sends": MAX_SENDS,
                "last_sent_at": req.last_sent_at,
            }
            if req is not None
            else None
        ),
        "rejections": entry.rejections,
        "blocked": entry.blocked,
        "can_restore": own,
        "can_request": request_block_reason(entry, actor) is None,
    }


def trash_items(
    entries: Iterable[TrashEntry], actor: Actor, names: Mapping[str, str]
) -> list[dict[str, Any]]:
    return [trash_item(e, actor, names) for e in entries]


# ---------------------------------------------------------------- notification (§12.3)


def notification_tag(card_id: str) -> str:
    return f"loyalty_hub_trash_{card_id}"


def build_request_notification(
    entry: TrashEntry, admin_name: str, token: str, t: Translator
) -> Notification:
    """Actionable notification to the owner, in the owner's language."""
    card_id = entry.card_id
    url = f"{PANEL_PATH}?trash={card_id}"
    return Notification(
        title=t("trash.title"),
        message=t("trash.request_message", admin=admin_name, name=entry.card.name),
        data={
            "tag": notification_tag(card_id),
            "group": NOTIFY_GROUP,
            "url": url,
            "clickAction": url,
            "actions": [
                {"action": f"{ACTION_ACCEPT_PREFIX}{token}", "title": t("trash.action_accept")},
                {"action": f"{ACTION_REJECT_PREFIX}{token}", "title": t("trash.action_reject")},
                {
                    "action": "URI",
                    "title": t("trash.action_block"),
                    "uri": f"{url}&block=1",
                },
            ],
        },
    )


def clear_notification_data(card_id: str) -> dict[str, Any]:
    """notify service data that removes the request notification (best effort)."""
    return {"message": "clear_notification", "data": {"tag": notification_tag(card_id)}}
