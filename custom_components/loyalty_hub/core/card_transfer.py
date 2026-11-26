"""Cards created for other users and card transfers (ARCHITETTURA §15.4). Pure Python."""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, MutableMapping
from datetime import datetime
from typing import Any, Callable

from .errors import ERR_INVALID_FORMAT, RecipientRefusesError, ValidationError
from .models import (
    FALLBACK_CURRENCY,
    SHARE_ALL,
    VIS_PRIVATE,
    VIS_SHARED,
    Card,
    UserPrefs,
    create_card,
    iso,
    new_id,
    utcnow,
)
from .permissions import Actor, can_view

# The creator never chooses the sharing of a card made for someone else.
CREATOR_FORBIDDEN_FIELDS = frozenset({"visibility", "shared_with"})


def _err(msg: str) -> ValidationError:
    return ValidationError(msg, ERR_INVALID_FORMAT)


def check_recipient(
    recipient_id: Any,
    active_user_ids: Collection[str],
    prefs: UserPrefs | None,
    recipient_name: str = "",
) -> str:
    """Recipient must be an active non-system user (as `loyalty_hub/users`) accepting cards."""
    if not isinstance(recipient_id, str) or recipient_id not in active_user_ids:
        raise _err("unknown recipient")
    if prefs is not None and prefs.refuse_from_others:
        raise RecipientRefusesError(
            f"{recipient_name or 'This user'} does not accept cards from other users"
        )
    return recipient_id


def import_blocked_owners(
    users: Iterable[tuple[str, bool, bool]],
    importer_id: str,
    refuses: Callable[[str], bool],
) -> set[str]:
    """Admin import (§11.2, §15.4): owners whose items are skipped.

    `users`: (id, is_active, system_generated) of every HA user. Like `for_user_id`,
    cards are created only for active non-system users who accept cards from others.
    """
    out: set[str] = set()
    for uid, active, system in users:
        if uid == importer_id:
            continue
        if not active or system or refuses(uid):
            out.add(uid)
    return out


def create_for_other(
    data: Any,
    creator_id: str,
    owner_id: str,
    share_with_me: bool = True,
    now: datetime | None = None,
    id_factory: Callable[[], str] = new_id,
    default_currency: str = FALLBACK_CURRENCY,
) -> Card:
    """cards/create with for_user_id (caller checked the recipient).

    `owner_id = for_user_id`, `created_by = creator`; shared with the creator only
    when `share_with_me`, otherwise private.
    """
    if not isinstance(data, dict):
        raise _err("card must be an object")
    if CREATOR_FORBIDDEN_FIELDS & set(data):
        raise _err("visibility and shared_with cannot be set on a card for someone else")
    row = dict(data)
    if share_with_me:
        row.update(visibility=VIS_SHARED, shared_with=[creator_id])
    else:
        row.update(visibility=VIS_PRIVATE, shared_with=[])
    card = create_card(row, owner_id, now, id_factory, default_currency)
    card.created_by = creator_id
    return card


def transfer(
    card: Card,
    by_user_id: str,
    to_user_id: str,
    keep_shared_with_me: bool = True,
    now: datetime | None = None,
) -> Card:
    """cards/transfer (caller checked can_manage and the recipient). In place.

    Code, logos, transactions, locations, usage, zones and sharing stay. The
    recipient leaves `shared_with`; with `keep_shared_with_me` the old owner enters
    it (private -> shared with [me]; with "*" nothing to do).
    """
    if to_user_id == card.owner_id:
        raise _err("the recipient already owns this card")
    old_owner = card.owner_id
    shared = [u for u in card.shared_with if u != to_user_id]
    visibility = card.visibility
    if keep_shared_with_me:
        if visibility != VIS_SHARED:
            visibility, shared = VIS_SHARED, [old_owner]
        elif SHARE_ALL not in shared and old_owner not in shared:
            shared.append(old_owner)
    else:
        shared = [u for u in shared if u != old_owner]
    if visibility == VIS_SHARED and not shared:
        visibility = VIS_PRIVATE
    card.owner_id = to_user_id
    card.visibility = visibility
    card.shared_with = shared
    card.transferred_by = by_user_id
    card.transferred_at = iso(now or utcnow())
    if card.created_by == to_user_id:
        card.created_by = None  # only kept when it differs from the owner
    card.updated_at = card.transferred_at
    return card


def stale_notify_keys(
    notify_log: Mapping[str, Any], user_id: str, card: Card
) -> list[str]:
    """notify_log keys of `user_id` for this card, if he no longer sees it (normal view)."""
    if can_view(card, Actor(user_id)):
        return []
    out = []
    for key in notify_log:
        parts = key.split(":")
        if card.id in parts and user_id in parts:
            out.append(key)
    return out


def drop_keys(notify_log: MutableMapping[str, Any], keys: list[str]) -> None:
    for key in keys:
        notify_log.pop(key, None)
