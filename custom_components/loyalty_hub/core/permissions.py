"""Permission checks (ARCHITETTURA §4, §11.1).

Every check receives an `Actor`. A plain user id (str) is accepted too and is
treated as a non-admin actor: callers that must use the *normal* visibility
(notifications, sensor, zone event, export) simply never grant admin rights.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from .models import SHARE_ALL, TX_ADJUST, VIS_SHARED, Card, Transaction


@dataclass(frozen=True)
class Actor:
    """Who is acting.

    `is_admin`: HA administrator. `admin_all`: the "admin sees and edits
    everything" option is enabled AND the user is an admin.
    """

    user_id: str | None
    is_admin: bool = False
    admin_all: bool = False

    @property
    def normal(self) -> Actor:
        """Same user without the admin_all override (normal visibility)."""
        return Actor(self.user_id, self.is_admin, False)


ActorLike = Actor | str | None


def as_actor(actor: ActorLike) -> Actor:
    if isinstance(actor, Actor):
        return actor
    return Actor(actor or None)


def _normal_view(card: Card, user_id: str | None) -> bool:
    if not user_id:
        return False
    if card.owner_id == user_id:
        return True
    if card.visibility != VIS_SHARED:
        return False
    return SHARE_ALL in card.shared_with or user_id in card.shared_with


def can_view(card: Card, actor: ActorLike) -> bool:
    """Owner, shared with the user, or admin with admin_all."""
    a = as_actor(actor)
    if not a.user_id:
        return False
    return _normal_view(card, a.user_id) or (a.admin_all and a.is_admin)


def is_admin_view(card: Card, actor: ActorLike) -> bool:
    """True if the card is visible only thanks to admin_all."""
    a = as_actor(actor)
    return can_view(card, a) and not _normal_view(card, a.user_id)


def can_edit(card: Card, actor: ActorLike) -> bool:
    """Fields, logo, balance adjustment: owner, or an admin who can see the card."""
    a = as_actor(actor)
    if not a.user_id:
        return False
    if card.owner_id == a.user_id:
        return True
    return a.is_admin and can_view(card, a)


def can_manage(card: Card, actor: ActorLike) -> bool:
    """Delete the card, change visibility/shared_with: owner only."""
    a = as_actor(actor)
    return bool(a.user_id) and card.owner_id == a.user_id


def can_use(card: Card, actor: ActorLike) -> bool:
    return can_view(card, actor)


def can_delete_transaction(card: Card, tx: Transaction, actor: ActorLike) -> bool:
    """Owner, transaction author, or admin with can_edit. Adjustments: can_edit only."""
    a = as_actor(actor)
    if tx.type == TX_ADJUST:
        return can_edit(card, a)
    if not can_use(card, a):
        return False
    return can_edit(card, a) or (bool(a.user_id) and tx.user_id == a.user_id)


def visible_cards(cards: Iterable[Card], actor: ActorLike) -> list[Card]:
    return [c for c in cards if can_view(c, actor)]
