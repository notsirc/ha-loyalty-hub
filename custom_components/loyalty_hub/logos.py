"""Safe online lookup, the single write rule and the authenticated image view (§8, §14.2).

File operations live in core/logo_files.py (LogoFiles, re-exported here).
"""

from __future__ import annotations

import asyncio
import copy
import logging
import socket
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urljoin

from aiohttp import ClientError, ClientSession, ClientTimeout, TCPConnector, ThreadedResolver, web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.helpers.http import KEY_HASS
from homeassistant.util import dt as dt_util

from .const import DOMAIN, LOGO_VIEW_URL
from .core import models
from .core.errors import (
    ERR_INVALID_FORMAT,
    LoyaltyError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
)
from .core.logo_key import TEST_UNREACHABLE, classify_test_status, key_test_url
from .core.logo_sources import (
    MAX_HTML_BYTES,
    MAX_REDIRECTS,
    MAX_WEBSITE_CANDIDATES,
    PROVIDER_ORDER,
    PROVIDER_WEBSITE,
    REDIRECT_STATUSES,
    TIMEOUT_SECONDS,
    check_url,
    extract_icon_candidates,
    is_public_ip,
    provider_order,
    provider_url,
)
from .core.logos import (
    EXT_BY_MIME,
    MAX_DOWNLOAD_BYTES,
    MAX_LOGO_BYTES,
    MIME_SVG,
    SVG_CSP,
    validate_logo_bytes,
)
from .core.logo_files import LogoFiles  # noqa: F401  (re-exported)
from .core.models import Card, set_logo
from .core.permissions import Actor, can_edit, can_view
from .core.wallet_assistant import LOGO_CACHE_DIR as WA_LOGO_CACHE_DIR
from .core.wallet_assistant import logo_cache_filenames

if TYPE_CHECKING:
    from .storage import LoyaltyHubData

_LOGGER = logging.getLogger(__name__)

MAX_IMPORT_DOWNLOADS = 50

# Sentinel: async_store_logo without a version check.
_ANY_VERSION: Any = object()


# ---------------------------------------------------------------- fetching


async def _async_check_host(hass: HomeAssistant, url: str) -> None:
    """Anti-SSRF: https + public hostname that resolves only to global addresses."""
    host = check_url(url)
    try:
        infos = await hass.loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise NotFoundError(f"cannot resolve {host}") from exc
    addresses = {info[4][0] for info in infos}
    if not addresses or not all(is_public_ip(str(a)) for a in addresses):
        raise ValidationError(f"{host} resolves to a non-public address", ERR_INVALID_FORMAT)


class _PublicOnlyResolver(ThreadedResolver):
    """DNS resolver used for the actual connection: drops non-public addresses.

    The pre-check in _async_check_host gives a clear error message; this resolver
    closes the DNS-rebinding gap (aiohttp resolves again when connecting, and only
    the addresses returned here can ever be connected to).
    """

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list:
        infos = await super().resolve(host, port, family)
        public = [info for info in infos if is_public_ip(str(info["host"]))]
        if not public:
            raise OSError(f"{host} resolves to a non-public address")
        return public


async def _async_get(
    hass: HomeAssistant, url: str, max_bytes: int
) -> tuple[int, bytes, str, str]:
    """GET with manual, re-checked redirects.

    Returns (status, body, final_url, content_type); the body is read only for
    status 200. Network errors and timeouts raise NotFoundError.
    """
    connector = TCPConnector(resolver=_PublicOnlyResolver(), use_dns_cache=False, limit=2)
    session = ClientSession(connector=connector, trust_env=False)
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            for _hop in range(MAX_REDIRECTS + 1):
                await _async_check_host(hass, url)
                async with session.get(
                    url,
                    allow_redirects=False,
                    timeout=ClientTimeout(total=TIMEOUT_SECONDS),
                    headers={"Accept": "image/*,text/html;q=0.9,*/*;q=0.5"},
                ) as resp:
                    if resp.status in REDIRECT_STATUSES:
                        location = resp.headers.get("Location")
                        if not location:
                            raise NotFoundError("redirect without location")
                        url = urljoin(url, location)
                        continue
                    ctype = resp.headers.get("Content-Type", "")
                    if resp.status != 200:
                        return resp.status, b"", url, ctype
                    if resp.content_length and resp.content_length > max_bytes:
                        raise ValidationError("response too large", ERR_INVALID_FORMAT)
                    body = bytearray()
                    async for chunk in resp.content.iter_chunked(65536):
                        body += chunk
                        if len(body) > max_bytes:
                            raise ValidationError("response too large", ERR_INVALID_FORMAT)
                    return 200, bytes(body), url, ctype
            raise NotFoundError("too many redirects")
    except (ClientError, TimeoutError) as exc:
        # No URL in the log: it would contain the shop domain (§14.2 privacy).
        _LOGGER.debug("Logo fetch failed: %s", type(exc).__name__)
        raise NotFoundError("download failed") from exc
    finally:
        await session.close()


async def async_fetch(hass: HomeAssistant, url: str, max_bytes: int) -> tuple[bytes, str, str]:
    """GET (200 only). Returns (body, final_url, content_type)."""
    status, body, final_url, ctype = await _async_get(hass, url, max_bytes)
    if status != 200:
        raise NotFoundError(f"HTTP {status}")
    return body, final_url, ctype


async def async_test_logo_dev_key(hass: HomeAssistant, key: str) -> str:
    """§14.1: "ok" | "rejected" | "rate_limited" | "unreachable".

    One GET of Logo.dev's own logo with the same protections as async_fetch.
    The key and the full URL are never logged.
    """
    try:
        status, _, _, _ = await _async_get(hass, key_test_url(key), MAX_DOWNLOAD_BYTES)
    except LoyaltyError as exc:
        _LOGGER.debug("Logo.dev key test failed: %s", exc.code)
        return TEST_UNREACHABLE
    except Exception as exc:  # noqa: BLE001 - any other failure: unreachable
        _LOGGER.debug("Logo.dev key test failed: %s", type(exc).__name__)
        return TEST_UNREACHABLE
    return classify_test_status(status)


def _decode_html(body: bytes, content_type: str) -> str:
    charset = "utf-8"
    for part in content_type.split(";"):
        part = part.strip().lower()
        if part.startswith("charset="):
            charset = part.split("=", 1)[1].strip("\"' ") or "utf-8"
    try:
        return body.decode(charset, errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


async def async_lookup_logo(
    hass: HomeAssistant,
    enabled: list[str],
    token: str | None,
    provider: str,
    domain: str,
) -> tuple[bytes, str]:
    """Download a logo from an enabled provider. Returns (bytes, sniffed mime)."""
    if provider not in enabled:
        raise UnauthorizedError(f"provider {provider} is not enabled")
    url = provider_url(provider, domain, token)
    if provider != PROVIDER_WEBSITE:
        body, _, _ = await async_fetch(hass, url, MAX_DOWNLOAD_BYTES)
        return body, validate_logo_bytes(body, allow_svg=True)

    html, final_url, ctype = await async_fetch(hass, url, MAX_HTML_BYTES)
    candidates = extract_icon_candidates(_decode_html(html, ctype), final_url)
    for candidate in candidates[:MAX_WEBSITE_CANDIDATES]:
        try:
            body, _, _ = await async_fetch(hass, candidate, MAX_DOWNLOAD_BYTES)
            return body, validate_logo_bytes(body, allow_svg=True)
        except (NotFoundError, ValidationError) as exc:
            _LOGGER.debug("Logo candidate rejected: %s", exc.code)
    raise NotFoundError("no usable logo found on the website")


async def async_lookup_in_order(
    hass: HomeAssistant, data: LoyaltyHubData, providers: Iterable[str], domain: str
) -> tuple[bytes, str, str]:
    """Try the providers in order; the first that works wins. Returns (bytes, mime, provider).

    All failed (or none available) -> not_found.
    """
    for provider in providers:
        try:
            blob, mime = await async_lookup_logo(
                hass, data.logo_providers, data.logo_dev_token, provider, domain
            )
        except LoyaltyError as exc:
            _LOGGER.debug("Logo lookup failed (%s): %s", provider, exc.code)
            continue
        return blob, mime, provider
    raise NotFoundError("no logo found")


async def async_lookup_requested(
    hass: HomeAssistant, data: LoyaltyHubData, requested: str, domain: str
) -> tuple[bytes, str, str]:
    """logo/lookup and logo/preview: an explicit provider, or "auto" (§14.2)."""
    order = provider_order(requested, data.logo_providers)
    if len(order) == 1 and order[0] == requested:
        # Explicit provider: keep its own error (unauthorized if not enabled, ...).
        blob, mime = await async_lookup_logo(
            hass, data.logo_providers, data.logo_dev_token, requested, domain
        )
        return blob, mime, requested
    return await async_lookup_in_order(hass, data, order, domain)


# ---------------------------------------------------------------- single write rule (§14.2)


def _logo_version(card: Card) -> int | None:
    version = (card.logo or {}).get("version")
    return version if isinstance(version, int) else None


async def async_store_logo(
    hass: HomeAssistant,
    data: LoyaltyHubData,
    card_id: str,
    source: str,
    mime: str,
    blob: bytes,
    domain: str | None = None,
    actor: Actor | None = None,
    expected_version: Any = _ANY_VERSION,
) -> Card | None:
    """Save a logo with the single write rule (upload, lookup, preview, refreshes).

    `actor`: re-checks can_edit on the current card. `expected_version`: store
    only if the card's logo version is still this one (background refreshes),
    otherwise return None. Raises limit_reached before writing anything.
    """
    async with data.logo_lock(card_id):
        card = data.store.cards.get(card_id)
        if card is None or (actor is not None and not can_edit(card, actor)):
            raise NotFoundError("Card was deleted")
        if expected_version is not _ANY_VERSION and _logo_version(card) != expected_version:
            return None
        await hass.async_add_executor_job(
            data.logos.store,
            card_id,
            mime,
            blob,
            (card.logo or {}).get("mime"),
            (card.logo_previous or {}).get("mime"),
            data.logo_max_files,
            data.logo_max_bytes,
        )
        now = dt_util.utcnow()
        current = data.store.cards.get(card_id)
        if current is None:
            if (entry := data.store.trash.get(card_id)) is not None:
                # Moved to the trash meanwhile: keep its metadata in line with the files.
                set_logo(entry.card, source, mime, now, domain=domain)
                data.store.async_trash_changed(entry.owner_id)
            else:
                await hass.async_add_executor_job(data.logos.delete, card_id)
            raise NotFoundError("Card was deleted")
        updated = copy.deepcopy(current)
        if domain and expected_version is None:
            # Remember the domain that worked (never from a background round: the user may
            # have changed the card's domain meanwhile).
            updated.logo_domain = domain
        set_logo(updated, source, mime, now, domain=domain)
        data.store.cards[card_id] = updated
        data.store.async_cards_changed(updated)
        return updated


async def async_delete_logo(
    hass: HomeAssistant, data: LoyaltyHubData, card_id: str, actor: Actor
) -> Card:
    """logo/delete (§14.2): the current logo becomes the previous one."""
    async with data.logo_lock(card_id):
        card = data.store.cards.get(card_id)
        if card is None or not can_edit(card, actor):
            raise NotFoundError("Card was deleted")
        if card.logo is None:
            return card
        await hass.async_add_executor_job(data.logos.demote, card_id, card.logo.get("mime"))
        return _async_apply_meta(data, card_id, models.clear_logo)


async def async_revert_logo(
    hass: HomeAssistant, data: LoyaltyHubData, card_id: str, actor: Actor
) -> Card:
    """logo/revert (§14.2): swap the current and the previous logo."""
    async with data.logo_lock(card_id):
        card = data.store.cards.get(card_id)
        if card is None or not can_edit(card, actor):
            raise NotFoundError("Card was deleted")
        previous = card.logo_previous
        if not previous or previous.get("mime") not in EXT_BY_MIME:
            raise NotFoundError("This card has no previous logo")
        await hass.async_add_executor_job(
            data.logos.revert, card_id, (card.logo or {}).get("mime"), previous["mime"]
        )
        return _async_apply_meta(data, card_id, models.revert_logo)


def _async_apply_meta(data: LoyaltyHubData, card_id: str, change) -> Card:
    """Apply a metadata change after a file operation (also if trashed meanwhile)."""
    now = dt_util.utcnow()
    current = data.store.cards.get(card_id)
    if current is None:
        if (entry := data.store.trash.get(card_id)) is not None:
            change(entry.card, now)
            data.store.async_trash_changed(entry.owner_id)
        raise NotFoundError("Card was deleted")
    updated = copy.deepcopy(current)
    change(updated, now)
    data.store.cards[card_id] = updated
    data.store.async_cards_changed(updated)
    return updated


# ---------------------------------------------------------------- view


class LogoView(HomeAssistantView):
    """GET /api/loyalty_hub/logo/{card_id}[?prev=1] (auth or signed path)."""

    url = LOGO_VIEW_URL
    name = "api:loyalty_hub:logo"
    requires_auth = True

    async def get(self, request: web.Request, card_id: str) -> web.Response:
        hass = request.app[KEY_HASS]
        data = hass.data.get(DOMAIN)
        user = request.get("hass_user")
        if data is None or user is None:
            return web.Response(status=404)
        previous = request.query.get("prev") == "1"
        card = data.store.cards.get(card_id)
        if card is not None:
            if not can_view(card, data.actor(user)):
                return web.Response(status=404)
        elif (
            not previous
            and (entry := data.store.trash.get(card_id)) is not None
            and entry.owner_id == user.id
        ):
            card = entry.card  # §12.4: a trashed card's current logo, to its owner only
        meta = (card.logo_previous if previous else card.logo) if card is not None else None
        if not meta:
            return web.Response(status=404)
        mime = meta.get("mime", "")
        if mime not in EXT_BY_MIME:
            return web.Response(status=404)
        body = await hass.async_add_executor_job(data.logos.read, card.id, mime, previous)
        if body is None:
            return web.Response(status=404)
        headers = {
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        }
        if mime == MIME_SVG:
            headers["Content-Security-Policy"] = SVG_CSP
        return web.Response(body=body, content_type=mime, headers=headers)


# ---------------------------------------------------------------- import (§10.3)


def _read_wa_cache(directory: Path, names_by_card: dict[str, list[str]]) -> dict[str, tuple[str, bytes]]:
    """Blocking: first valid Wallet-Assistant cached logo for each card."""
    out: dict[str, tuple[str, bytes]] = {}
    if not directory.is_dir():
        return out
    for card_id, names in names_by_card.items():
        for name in names:
            path = directory / name
            try:
                if not path.is_file() or path.stat().st_size > MAX_LOGO_BYTES:
                    continue
                blob = path.read_bytes()
                mime = validate_logo_bytes(blob, allow_svg=False)
            except (OSError, ValidationError):
                continue
            out[card_id] = (mime, blob)
            break
    return out


async def async_import_logos(
    hass: HomeAssistant,
    data: LoyaltyHubData,
    cards: list[Card],
    slugs: dict[str, str],
    now: datetime,
) -> dict[str, tuple[str, bytes]]:
    """Logos for freshly imported cards (not yet in the store; set_logo is applied).

    1) Wallet-Assistant local cache, 2) enabled online providers (best effort,
    at most MAX_IMPORT_DOWNLOADS attempts). Returns card_id -> (mime, bytes).
    New cards: no previous logo.
    """
    pending = [c for c in cards if not c.logo and (c.id in slugs or c.logo_domain)]
    names = {
        c.id: logo_cache_filenames(slugs.get(c.id) or c.logo_domain or "") for c in pending
    }
    found = await hass.async_add_executor_job(
        _read_wa_cache, Path(hass.config.path(WA_LOGO_CACHE_DIR)), names
    )
    for card in pending:
        if card.id in found:
            set_logo(card, "import", found[card.id][0], now)

    # §15.1: the single provider order (data.logo_providers is already in it).
    providers = [p for p in PROVIDER_ORDER if p in data.logo_providers]
    online = [c for c in pending if c.id not in found and c.logo_domain]
    if providers and online:
        budget = [MAX_IMPORT_DOWNLOADS]
        sem = asyncio.Semaphore(4)

        async def _one(card: Card) -> None:
            for provider in providers:
                if budget[0] <= 0:
                    return
                budget[0] -= 1
                try:
                    async with sem:
                        blob, mime = await async_lookup_logo(
                            hass, data.logo_providers, data.logo_dev_token, provider,
                            card.logo_domain,
                        )
                except Exception as exc:  # noqa: BLE001 - best effort
                    _LOGGER.debug(
                        "Import logo lookup failed (%s, %s): %s",
                        provider, card.logo_domain, type(exc).__name__,
                    )
                    continue
                set_logo(card, provider, mime, now, domain=card.logo_domain)
                found[card.id] = (mime, blob)
                return

        await asyncio.gather(*(_one(c) for c in online))
    return found
