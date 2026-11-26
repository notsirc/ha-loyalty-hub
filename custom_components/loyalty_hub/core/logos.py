"""Logo images: magic-byte sniffing, size limits, metadata (ARCHITETTURA §8.1)."""

from __future__ import annotations

import base64
import binascii
import re
from typing import Any

from .errors import ERR_INVALID_FORMAT, LimitReachedError, ValidationError

MAX_LOGO_BYTES = 512 * 1024  # on disk
MAX_DOWNLOAD_BYTES = 1024 * 1024  # read from network

LOGO_SOURCES = ("upload", "logo_dev", "logoapi", "website", "import")
LOGO_FITS = ("contain", "cover")
DEFAULT_LOGO_FIT = "contain"

MIME_PNG = "image/png"
MIME_JPEG = "image/jpeg"
MIME_WEBP = "image/webp"
MIME_GIF = "image/gif"
MIME_ICO = "image/x-icon"
MIME_SVG = "image/svg+xml"

EXT_BY_MIME = {
    MIME_PNG: "png",
    MIME_JPEG: "jpg",
    MIME_WEBP: "webp",
    MIME_GIF: "gif",
    MIME_ICO: "ico",
    MIME_SVG: "svg",
}

SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"

_SVG_START_RE = re.compile(
    rb"^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--.*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--.*?-->\s*)*<svg[\s>]",
    re.IGNORECASE | re.DOTALL,
)
_SVG_FORBIDDEN_RE = re.compile(rb"<\s*script|<\s*foreignObject|javascript:", re.IGNORECASE)


def _err(msg: str) -> ValidationError:
    return ValidationError(msg, ERR_INVALID_FORMAT)


def sniff_image(data: bytes, allow_svg: bool = False) -> str:
    """Return the mime type detected from magic bytes; raise invalid_format otherwise."""
    if not data:
        raise _err("empty image")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return MIME_PNG
    if data.startswith(b"\xff\xd8\xff"):
        return MIME_JPEG
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return MIME_GIF
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return MIME_WEBP
    if data[:4] == b"\x00\x00\x01\x00" and len(data) >= 6:
        return MIME_ICO
    head = data[:4096].lstrip(b"\xef\xbb\xbf")
    if _SVG_START_RE.match(head):
        if not allow_svg:
            raise _err("SVG images are only accepted from online providers")
        if _SVG_FORBIDDEN_RE.search(data):
            raise _err("SVG contains active content")
        return MIME_SVG
    raise _err("unsupported image format (PNG, JPEG, WEBP, GIF, ICO only)")


def validate_logo_bytes(data: bytes, allow_svg: bool = False) -> str:
    """Sniff and enforce the on-disk size limit. Returns the mime."""
    if len(data) > MAX_LOGO_BYTES:
        raise _err("image too large (max 512 KB)")
    return sniff_image(data, allow_svg=allow_svg)


def decode_logo_base64(data_base64: Any) -> bytes:
    if not isinstance(data_base64, str):
        raise _err("data_base64 must be a string")
    payload = data_base64.strip()
    if payload.startswith("data:") and "," in payload:
        payload = payload.split(",", 1)[1]
    if len(payload) > (MAX_LOGO_BYTES * 4) // 3 + 8:
        raise _err("image too large (max 512 KB)")
    try:
        return base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise _err("invalid base64 data") from exc


def logo_filename(card_id: str, mime: str, previous: bool = False) -> str:
    """`<card_id>.<ext>` (current) or `<card_id>.prev.<ext>` (previous, §14.2)."""
    if not re.fullmatch(r"[0-9a-f]{32}", card_id):
        raise _err("invalid card id")
    if mime not in EXT_BY_MIME:
        raise _err(f"unknown mime {mime!r}")
    middle = ".prev" if previous else ""
    return f"{card_id}{middle}.{EXT_BY_MIME[mime]}"


def make_logo_info(
    source: str,
    mime: str,
    updated_at: str,
    previous: dict | None,
    now_ms: int = 0,
    domain: str | None = None,
) -> dict:
    """Build logo metadata.

    `version` is used as a cache buster (`?v=`) for a privately cached URL, so it
    must never repeat for a card, even after delete + re-upload: it is the
    larger of previous+1 and the current epoch millis.
    """
    if source not in LOGO_SOURCES:
        raise _err(f"unknown logo source {source!r}")
    if mime not in EXT_BY_MIME:
        raise _err(f"unknown mime {mime!r}")
    version = max(int((previous or {}).get("version") or 0) + 1, now_ms)
    return {
        "source": source,
        "mime": mime,
        "updated_at": updated_at,
        "version": version,
        # Domain used by an online provider (None for upload/import).
        "domain": domain,
    }


# ---------------------------------------------------------------- storage limits (§11.3)


def check_logo_limits(
    files: int,
    total_bytes: int,
    new_bytes: int,
    max_files: int,
    max_bytes: int,
    new_files: int = 1,
) -> None:
    """Raise limit_reached if writing `new_files` files of new_bytes would exceed a limit.

    `files`/`total_bytes`: current usage of the logo folder, EXCLUDING the
    file(s) of the card. With the single write rule (§14.2) the card keeps two
    files (new + previous): `new_files = 2` and `new_bytes` = both sizes.
    """
    if files + new_files > max_files:
        raise LimitReachedError(
            f"logo limit reached: at most {max_files} logo files (ask an administrator)"
        )
    if total_bytes + new_bytes > max_bytes:
        raise LimitReachedError(
            f"logo limit reached: at most {max_bytes // (1024 * 1024)} MB of logos "
            "(ask an administrator)"
        )


def fits_logo_limits(
    files: int, total_bytes: int, new_bytes: int, max_files: int, max_bytes: int
) -> bool:
    try:
        check_logo_limits(files, total_bytes, new_bytes, max_files, max_bytes)
    except LimitReachedError:
        return False
    return True
