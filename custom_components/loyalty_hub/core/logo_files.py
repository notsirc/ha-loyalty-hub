"""Logo files on disk: current `<id>.<ext>` and previous `<id>.prev.<ext>` (§8.1, §14.2).

Pure Python (blocking file I/O, no homeassistant imports): the HA layer calls
these methods through hass.async_add_executor_job.
"""

from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

from .errors import NotFoundError, ValidationError
from .logos import (
    EXT_BY_MIME,
    MIME_PNG,
    check_logo_limits,
    fits_logo_limits,
    logo_filename,
)
from .models import Card


class LogoFiles:
    """Blocking file operations: always call through hass.async_add_executor_job.

    Per card: current `<id>.<ext>` and previous `<id>.prev.<ext>` (§14.2).
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def _path(self, card_id: str, mime: str, previous: bool = False) -> Path:
        return self.directory / logo_filename(card_id, mime, previous)

    def _remove_all(self, card_id: str, keep: str | None = None, previous: bool = False) -> None:
        """Remove the current (or the previous) files of a card, in every extension."""
        middle = ".prev" if previous else ""
        for ext in set(EXT_BY_MIME.values()):
            path = self.directory / f"{card_id}{middle}.{ext}"
            if path.name != keep:
                path.unlink(missing_ok=True)

    def _write_current(self, card_id: str, mime: str, data: bytes) -> None:
        name = logo_filename(card_id, mime)
        self.directory.mkdir(parents=True, exist_ok=True)
        tmp = self.directory / f"{name}.tmp"
        tmp.write_bytes(data)
        os.replace(tmp, self.directory / name)
        self._remove_all(card_id, keep=name)

    def write(self, card_id: str, mime: str, data: bytes) -> None:
        """Current logo of a NEW card (import): no previous logo is involved."""
        self._write_current(card_id, mime, data)

    def write_many(self, items: dict[str, tuple[str, bytes]]) -> None:
        for card_id, (mime, data) in items.items():
            self.write(card_id, mime, data)

    def _card_files(self, card_id: str) -> set[str]:
        exts = set(EXT_BY_MIME.values())
        return {f"{card_id}.{ext}" for ext in exts} | {f"{card_id}.prev.{ext}" for ext in exts}

    def _size(self, card_id: str, mime: str | None, previous: bool = False) -> int | None:
        """Size of a card's file, None if missing."""
        if not mime or mime not in EXT_BY_MIME:
            return None
        try:
            return self._path(card_id, mime, previous).stat().st_size
        except (OSError, ValidationError):
            return None

    def usage(self, exclude_card_id: str | None = None) -> tuple[int, int]:
        """(files, bytes) of the logo folder, without the files of exclude_card_id."""
        excluded = self._card_files(exclude_card_id) if exclude_card_id else set()
        files = total = 0
        exts = {f".{ext}" for ext in EXT_BY_MIME.values()}
        try:
            entries = list(os.scandir(self.directory))
        except OSError:
            return 0, 0
        for entry in entries:
            name = entry.name
            if name in excluded or os.path.splitext(name)[1] not in exts:
                continue
            try:
                if entry.is_file():
                    files += 1
                    total += entry.stat().st_size
            except OSError:
                continue
        return files, total

    def store(
        self,
        card_id: str,
        mime: str,
        data: bytes,
        current_mime: str | None,
        previous_mime: str | None,
        max_files: int,
        max_bytes: int,
    ) -> None:
        """The single write rule (§14.2), file side.

        The current file (if any) becomes the previous one (the old previous is
        deleted); the new file becomes current. Without a current file the
        previous one stays. Limits: folder usage without the card's files + the
        new file + the file that stays as previous, else limit_reached.
        """
        current_size = self._size(card_id, current_mime)
        kept_size = (
            current_size
            if current_size is not None
            else self._size(card_id, previous_mime, previous=True)
        )
        files, total = self.usage(exclude_card_id=card_id)
        check_logo_limits(
            files,
            total,
            len(data) + (kept_size or 0),
            max_files,
            max_bytes,
            new_files=2 if kept_size is not None else 1,
        )
        self.directory.mkdir(parents=True, exist_ok=True)
        if current_size is not None and current_mime:
            self._remove_all(card_id, previous=True)
            os.replace(
                self._path(card_id, current_mime),
                self._path(card_id, current_mime, previous=True),
            )
        self._write_current(card_id, mime, data)

    def demote(self, card_id: str, current_mime: str | None) -> None:
        """logo/delete (§14.2): the current file becomes the previous one."""
        if not current_mime or self._size(card_id, current_mime) is None:
            self._remove_all(card_id)
            return
        self._remove_all(card_id, previous=True)
        os.replace(
            self._path(card_id, current_mime), self._path(card_id, current_mime, previous=True)
        )
        self._remove_all(card_id)

    def revert(self, card_id: str, current_mime: str | None, previous_mime: str) -> None:
        """logo/revert (§14.2): swap the current and the previous file."""
        prev_path = self._path(card_id, previous_mime, previous=True)
        if not prev_path.is_file():
            raise NotFoundError("The previous logo file is missing")
        swap = self.directory / f"{card_id}.swap"
        has_current = bool(current_mime) and self._size(card_id, current_mime) is not None
        if has_current:
            os.replace(self._path(card_id, current_mime), swap)
        os.replace(prev_path, self._path(card_id, previous_mime))
        self._remove_all(card_id, keep=logo_filename(card_id, previous_mime))
        self._remove_all(card_id, previous=True)
        if has_current:
            os.replace(swap, self._path(card_id, current_mime, previous=True))

    def write_many_checked(
        self, items: dict[str, tuple[str, bytes]], max_files: int, max_bytes: int
    ) -> set[str]:
        """Write logos of new cards while they fit the limits. Returns skipped card ids."""
        files, total = self.usage()
        skipped: set[str] = set()
        for card_id, (mime, data) in items.items():
            if not fits_logo_limits(files, total, len(data), max_files, max_bytes):
                skipped.add(card_id)
                continue
            self.write(card_id, mime, data)
            files += 1
            total += len(data)
        return skipped

    def read(self, card_id: str, mime: str, previous: bool = False) -> bytes | None:
        try:
            return self._path(card_id, mime, previous).read_bytes()
        except (OSError, ValidationError):
            return None

    def read_png_many(self, cards: Iterable[Card]) -> dict[str, bytes]:
        """PNG logos for a Catima export (Catima only understands PNG icons)."""
        out: dict[str, bytes] = {}
        for card in cards:
            if card.logo and card.logo.get("mime") == MIME_PNG:
                if (blob := self.read(card.id, MIME_PNG)) is not None:
                    out[card.id] = blob
        return out

    def delete(self, card_id: str) -> None:
        """Final deletion: the current and the previous files."""
        try:
            logo_filename(card_id, MIME_PNG)  # validates the id
        except ValidationError:
            return
        self._remove_all(card_id)
        self._remove_all(card_id, previous=True)
        (self.directory / f"{card_id}.swap").unlink(missing_ok=True)
