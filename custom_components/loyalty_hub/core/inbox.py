"""Cumulative notice of cards created for / transferred to a user (ARCHITETTURA §15.4).

Store root `inbox: {user_id: [{card_id, by, at, kind}]}`, at most MAX_INBOX
entries per user (the oldest are dropped). Pure Python.
"""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from datetime import timedelta
from typing import Any

from .i18n import Translator
from .models import Card
from .notify_logic import NOTIFY_GROUP, PANEL_PATH, Notification

KIND_CREATED = "created"
KIND_TRANSFERRED = "transferred"
KINDS = (KIND_CREATED, KIND_TRANSFERRED)
MAX_INBOX = 100
# The grouped phone notification goes out this long after the last arrival.
NOTIFY_DELAY = timedelta(minutes=2)
NOTIFY_TAG = "loyalty_hub_inbox"

Inbox = MutableMapping[str, list[dict[str, str]]]


def _valid_entry(value: Any) -> bool:
    return (
        isinstance(value, Mapping)
        and all(isinstance(value.get(k), str) and value.get(k) for k in ("card_id", "by", "at"))
        and value.get("kind") in KINDS
    )


def load_inbox(value: Any) -> dict[str, list[dict[str, str]]]:
    if not isinstance(value, Mapping):
        return {}
    out: dict[str, list[dict[str, str]]] = {}
    for user_id, entries in value.items():
        if not isinstance(user_id, str) or not isinstance(entries, list):
            continue
        clean = [
            {k: str(e[k]) for k in ("card_id", "by", "at", "kind")}
            for e in entries
            if _valid_entry(e)
        ][-MAX_INBOX:]
        if clean:
            out[user_id] = clean
    return out


def add_entry(inbox: Inbox, user_id: str, card_id: str, by: str, at: str, kind: str) -> None:
    entries = [e for e in inbox.get(user_id, []) if e["card_id"] != card_id]
    entries.append({"card_id": card_id, "by": by, "at": at, "kind": kind})
    inbox[user_id] = entries[-MAX_INBOX:]


def valid_entries(
    inbox: Inbox, user_id: str, cards: Mapping[str, Card]
) -> tuple[list[dict[str, str]], bool]:
    """Entries whose card exists and still belongs to the user; drops the others.

    Returns (entries, changed).
    """
    entries = inbox.get(user_id, [])
    keep = [
        e for e in entries if (c := cards.get(e["card_id"])) is not None and c.owner_id == user_id
    ]
    changed = len(keep) != len(entries)
    if changed:
        if keep:
            inbox[user_id] = keep
        else:
            inbox.pop(user_id, None)
    return keep, changed


def list_items(
    inbox: Inbox, user_id: str, cards: Mapping[str, Card], names: Mapping[str, str]
) -> tuple[list[dict[str, str]], bool]:
    """inbox/list: [{card_id, card_name, by_name, at, kind}] (only the user's own cards)."""
    entries, changed = valid_entries(inbox, user_id, cards)
    items = [
        {
            "card_id": e["card_id"],
            "card_name": cards[e["card_id"]].name,
            "by_name": names.get(e["by"], ""),
            "at": e["at"],
            "kind": e["kind"],
        }
        for e in entries
    ]
    return items, changed


def dismiss(inbox: Inbox, user_id: str) -> bool:
    return inbox.pop(user_id, None) is not None


def build_notification(
    entries: list[dict[str, str]], names: Mapping[str, str], t: Translator
) -> Notification | None:
    """One grouped notification: a line per sender and kind ("Alice added 3 cards for you")."""
    if not entries:
        return None
    counts: dict[tuple[str, str], int] = {}
    for e in entries:
        counts[(e["by"], e["kind"])] = counts.get((e["by"], e["kind"]), 0) + 1
    lines = [
        t(f"inbox.{kind}", count=n, by=names.get(by, "") or t("inbox.someone"))
        for (by, kind), n in counts.items()
    ]
    return Notification(
        title=t("inbox.title"),
        message="\n".join(lines),
        data={
            "url": PANEL_PATH,
            "clickAction": PANEL_PATH,
            "tag": NOTIFY_TAG,
            "group": NOTIFY_GROUP,
        },
    )
