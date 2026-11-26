"""In-memory logo previews (ARCHITETTURA §14.2 "Prima/Dopo"). Pure Python.

A preview is a downloaded, validated candidate that is NOT saved: it is bound to
the user and the card, expires after 10 minutes, and each user keeps at most 5
(the oldest is dropped). Nothing is persisted.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

PREVIEW_TTL = timedelta(minutes=10)
MAX_PREVIEWS_PER_USER = 5


def new_preview_id() -> str:
    return secrets.token_urlsafe(16)


@dataclass(frozen=True)
class Preview:
    preview_id: str
    user_id: str
    card_id: str
    provider: str
    domain: str
    mime: str
    blob: bytes
    created_at: datetime


class PreviewStore:
    def __init__(self, id_factory: Callable[[], str] = new_preview_id) -> None:
        self._items: dict[str, Preview] = {}
        self._id_factory = id_factory

    def __len__(self) -> int:
        return len(self._items)

    def prune(self, now: datetime) -> None:
        for pid in [p for p, item in self._items.items() if now - item.created_at >= PREVIEW_TTL]:
            del self._items[pid]

    def add(
        self,
        user_id: str,
        card_id: str,
        provider: str,
        domain: str,
        mime: str,
        blob: bytes,
        now: datetime,
    ) -> Preview:
        self.prune(now)
        mine = sorted(
            (item for item in self._items.values() if item.user_id == user_id),
            key=lambda item: item.created_at,
        )
        for item in mine[: max(0, len(mine) - MAX_PREVIEWS_PER_USER + 1)]:
            del self._items[item.preview_id]
        preview = Preview(
            self._id_factory(), user_id, card_id, provider, domain, mime, blob, now
        )
        self._items[preview.preview_id] = preview
        return preview

    def get(self, preview_id: str, user_id: str, card_id: str, now: datetime) -> Preview | None:
        """The preview if it exists, is not expired and belongs to this user and card."""
        self.prune(now)
        item = self._items.get(preview_id)
        if item is None or item.user_id != user_id or item.card_id != card_id:
            return None
        return item

    def discard(self, preview_id: str) -> None:
        self._items.pop(preview_id, None)
