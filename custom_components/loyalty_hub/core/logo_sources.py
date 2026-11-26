"""Pure helpers for online logo lookup (ARCHITETTURA §8.3).

Hostname validation, IP classification (anti-SSRF), provider URL building,
HTML icon candidate extraction and ranking. No network IO here.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit

from .errors import ERR_INVALID_FORMAT, ValidationError

PROVIDER_LOGOAPI = "logoapi"
PROVIDER_LOGO_DEV = "logo_dev"
PROVIDER_WEBSITE = "website"
# §15.1: the single provider order (Logo.dev -> shop website -> logoapi.sh), used
# everywhere: "auto" lookups, imports, logo/providers and the options selector.
PROVIDER_ORDER = (PROVIDER_LOGO_DEV, PROVIDER_WEBSITE, PROVIDER_LOGOAPI)
PROVIDERS = PROVIDER_ORDER
# §14.2: "one tap" order; logo_dev only counts when its key is ready.
PROVIDER_AUTO = "auto"
AUTO_ORDER = PROVIDER_ORDER

MAX_REDIRECTS = 3
TIMEOUT_SECONDS = 10
MAX_HTML_BYTES = 1024 * 1024
MAX_WEBSITE_CANDIDATES = 5
REDIRECT_STATUSES = (301, 302, 303, 307, 308)

_LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_TLD_RE = re.compile(r"^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$")
_BLOCKED_SUFFIXES = (
    "localhost",
    "local",
    "localdomain",
    "internal",
    "intranet",
    "lan",
    "home",
    "corp",
    "home.arpa",
    "arpa",
    "invalid",
    "test",
    "example",
    "onion",
)


def _err(msg: str) -> ValidationError:
    return ValidationError(msg, ERR_INVALID_FORMAT)


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


def validate_domain(value: object) -> str | None:
    """Normalize and validate a public hostname (no IP, port, path). '' / None -> None.

    Tolerates a leading http(s):// and a trailing '/'.
    """
    if value is None:
        return None
    if not isinstance(value, str):
        raise _err("logo_domain must be a string")
    host = value.strip().lower()
    if not host:
        return None
    host = re.sub(r"^https?://", "", host).rstrip("/").rstrip(".")
    if any(ch in host for ch in "/:?#@[]\\ ") or _is_ip_literal(host):
        raise _err("logo_domain must be a plain hostname (no IP, port or path)")
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError as exc:
        raise _err("invalid logo_domain") from exc
    labels = host.split(".")
    if (
        len(host) > 253
        or len(labels) < 2
        or not all(_LABEL_RE.match(lbl) for lbl in labels)
        or not _TLD_RE.match(labels[-1])
    ):
        raise _err("invalid logo_domain")
    for suffix in _BLOCKED_SUFFIXES:
        if host == suffix or host.endswith("." + suffix):
            raise _err("logo_domain must be a public hostname")
    return host


def is_public_ip(address: str) -> bool:
    """True only for globally routable unicast addresses."""
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None:
            ip = mapped
    return (
        ip.is_global
        and not ip.is_multicast
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_reserved
        and not ip.is_unspecified
    )


def check_url(url: str) -> str:
    """Validate a URL to fetch: https only, public hostname, default port. Returns host."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise _err("invalid URL") from exc
    if parts.scheme != "https":
        raise _err("only https URLs are allowed")
    if parts.username or parts.password:
        raise _err("credentials in URL are not allowed")
    if port not in (None, 443):
        raise _err("non-standard ports are not allowed")
    host = parts.hostname or ""
    if not host or _is_ip_literal(host):
        raise _err("IP addresses are not allowed")
    validate_domain(host)
    return host


def provider_url(provider: str, domain: str, token: str | None = None) -> str:
    domain = validate_domain(domain) or ""
    if not domain:
        raise _err("domain is required")
    if provider == PROVIDER_LOGOAPI:
        return f"https://logoapi.sh/{domain}.svg?fallback=404"
    if provider == PROVIDER_LOGO_DEV:
        if not token:
            raise _err("logo.dev token not configured")
        return (
            f"https://img.logo.dev/{domain}?token={quote(token, safe='')}"
            "&size=256&format=png&fallback=404"
        )
    if provider == PROVIDER_WEBSITE:
        return f"https://{domain}/"
    raise _err(f"unknown provider {provider!r}")


def provider_order(requested: str, available: list[str] | tuple[str, ...]) -> list[str]:
    """Providers to try for a lookup/preview.

    "auto": AUTO_ORDER restricted to the available providers (enabled, and
    logo_dev only with a ready key). An explicit provider is tried alone (the
    caller refuses it if it is not available).
    """
    if requested == PROVIDER_AUTO:
        return [p for p in AUTO_ORDER if p in available]
    return [requested]


def redact_url(url: str) -> str:
    """URL safe for logs (drops the query string, which may hold a token)."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


# ---------------------------------------------------------------- HTML icons


@dataclass
class IconCandidate:
    href: str
    kind: str  # "apple-touch-icon" | "icon" | "og:image" | "favicon"
    size: int = 0  # largest side from `sizes`; "any" (SVG) counts as large


_KIND_PRIORITY = {"apple-touch-icon": 0, "icon": 1, "og:image": 2, "favicon": 3}


def _parse_sizes(sizes: str | None) -> int:
    best = 0
    for token in (sizes or "").lower().split():
        if token == "any":
            best = max(best, 1024)
            continue
        m = re.fullmatch(r"(\d+)x(\d+)", token)
        if m:
            best = max(best, int(m.group(1)), int(m.group(2)))
    return best


class _IconParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.candidates: list[IconCandidate] = []
        self.base_href: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "base" and a.get("href") and self.base_href is None:
            self.base_href = a["href"].strip()
        elif tag == "link" and a.get("href"):
            rels = set(a.get("rel", "").lower().split())
            if rels & {"apple-touch-icon", "apple-touch-icon-precomposed"}:
                kind = "apple-touch-icon"
            elif "icon" in rels:
                kind = "icon"
            else:
                return
            self.candidates.append(
                IconCandidate(a["href"].strip(), kind, _parse_sizes(a.get("sizes")))
            )
        elif tag == "meta":
            prop = (a.get("property") or a.get("name") or "").lower()
            if prop in ("og:image", "og:image:url", "og:image:secure_url") and a.get("content"):
                self.candidates.append(IconCandidate(a["content"].strip(), "og:image"))


def extract_icon_candidates(html: str, page_url: str) -> list[str]:
    """Ranked absolute https URLs of icon candidates, ending with /favicon.ico."""
    parser = _IconParser()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 - malformed HTML: use what we got
        pass
    base = urljoin(page_url, parser.base_href) if parser.base_href else page_url
    ranked = sorted(
        enumerate(parser.candidates),
        key=lambda ic: (_KIND_PRIORITY[ic[1].kind], -ic[1].size, ic[0]),
    )
    out: list[str] = []
    for _, cand in ranked:
        if cand.href.lower().startswith("data:"):
            continue
        url = urljoin(base, cand.href)
        if url.startswith("http://"):
            url = "https://" + url[len("http://") :]
        if url.startswith("https://") and url not in out:
            out.append(url)
    favicon = urljoin(page_url, "/favicon.ico")
    if favicon not in out:
        out.append(favicon)
    return out
