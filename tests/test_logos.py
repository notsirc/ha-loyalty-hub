import base64
import io
import zipfile
from datetime import datetime, timezone

import pytest

from core.catima import parse_catima_full
from core.errors import LoyaltyError
from core.logo_sources import (
    check_url,
    extract_icon_candidates,
    is_public_ip,
    provider_url,
    redact_url,
    validate_domain,
)
from core.logos import (
    MAX_LOGO_BYTES,
    decode_logo_base64,
    logo_filename,
    sniff_image,
    validate_logo_bytes,
)
from core.models import Card, clear_logo, create_card, set_logo, update_card
from core.transfer import export_payload, import_payload

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=timezone.utc)
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 20
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 20
GIF = b"GIF89a" + b"\x00" * 10
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 10
ICO = b"\x00\x00\x01\x00\x01\x00" + b"\x00" * 10
SVG = b'<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'


@pytest.mark.parametrize(
    "data,mime",
    [
        (PNG, "image/png"),
        (JPEG, "image/jpeg"),
        (GIF, "image/gif"),
        (WEBP, "image/webp"),
        (ICO, "image/x-icon"),
    ],
)
def test_sniff_raster(data, mime):
    assert sniff_image(data) == mime


def test_sniff_svg_rules():
    with pytest.raises(LoyaltyError):
        sniff_image(SVG)  # uploads: no SVG
    assert sniff_image(SVG, allow_svg=True) == "image/svg+xml"
    assert sniff_image(b"\xef\xbb\xbf  <svg viewBox='0 0 1 1'/>", allow_svg=True) == "image/svg+xml"
    with pytest.raises(LoyaltyError):
        sniff_image(b"<svg><script>alert(1)</script></svg>", allow_svg=True)
    with pytest.raises(LoyaltyError):
        sniff_image(b"<html><body>hi</body></html>", allow_svg=True)
    with pytest.raises(LoyaltyError):
        sniff_image(b"")
    # declared type is irrelevant: a PNG renamed .svg is still PNG
    assert sniff_image(PNG, allow_svg=True) == "image/png"


def test_size_limit_and_base64():
    with pytest.raises(LoyaltyError):
        validate_logo_bytes(PNG + b"\x00" * MAX_LOGO_BYTES)
    assert validate_logo_bytes(PNG) == "image/png"
    assert decode_logo_base64(base64.b64encode(PNG).decode()) == PNG
    assert decode_logo_base64("data:image/png;base64," + base64.b64encode(PNG).decode()) == PNG
    with pytest.raises(LoyaltyError):
        decode_logo_base64("not base64!!")
    with pytest.raises(LoyaltyError):
        decode_logo_base64("A" * (MAX_LOGO_BYTES * 2))


def test_logo_filename():
    assert logo_filename("a" * 32, "image/png") == "a" * 32 + ".png"
    assert logo_filename("a" * 32, "image/svg+xml").endswith(".svg")
    with pytest.raises(LoyaltyError):
        logo_filename("../etc/passwd", "image/png")


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("coop.it", "coop.it"),
        ("  WWW.Esselunga.IT ", "www.esselunga.it"),
        ("https://coop.it/", "coop.it"),
        ("caffè.it", "xn--caff-8oa.it"),
        ("", None),
        (None, None),
    ],
)
def test_validate_domain_ok(raw, expected):
    assert validate_domain(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "192.168.1.1",
        "10.0.0.1",
        "[::1]",
        "coop.it:8443",
        "coop.it/path",
        "localhost",
        "nas.local",
        "router.lan",
        "x.internal",
        "single",
        "-bad.it",
        "a..it",
        "user@coop.it",
        "coop.123",
        "ha.home.arpa",
        42,
    ],
)
def test_validate_domain_rejects(raw):
    with pytest.raises(LoyaltyError):
        validate_domain(raw)


@pytest.mark.parametrize(
    "ip,public",
    [
        ("8.8.8.8", True),
        ("2a00:1450:4002::64", True),
        ("127.0.0.1", False),
        ("10.1.2.3", False),
        ("172.16.0.1", False),
        ("192.168.0.10", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("0.0.0.0", False),
        ("224.0.0.1", False),
        ("::1", False),
        ("fe80::1", False),
        ("fd00::1", False),
        ("::ffff:127.0.0.1", False),
        ("::ffff:8.8.8.8", True),
        ("2002:c0a8:0101::1", False),
        ("240.0.0.1", False),
        ("bogus", False),
    ],
)
def test_is_public_ip(ip, public):
    assert is_public_ip(ip) is public


def test_check_url():
    assert check_url("https://www.coop.it/logo.png") == "www.coop.it"
    assert check_url("https://coop.it:443/x") == "coop.it"
    for bad in [
        "http://coop.it/",
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://coop.it:8080/",
        "https://u:p@coop.it/",
        "ftp://coop.it/",
        "https://localhost/",
        "https:///x",
    ]:
        with pytest.raises(LoyaltyError):
            check_url(bad)


def test_provider_urls():
    assert provider_url("logoapi", "coop.it") == "https://logoapi.sh/coop.it.svg?fallback=404"
    assert provider_url("logo_dev", "coop.it", "pk_a&b") == (
        "https://img.logo.dev/coop.it?token=pk_a%26b&size=256&format=png&fallback=404"
    )
    assert provider_url("website", "coop.it") == "https://coop.it/"
    with pytest.raises(LoyaltyError):
        provider_url("logo_dev", "coop.it", None)
    with pytest.raises(LoyaltyError):
        provider_url("other", "coop.it")
    with pytest.raises(LoyaltyError):
        provider_url("logoapi", "10.0.0.1")
    assert "secret" not in redact_url(provider_url("logo_dev", "coop.it", "secret"))


def test_extract_icon_candidates():
    html = """
    <html><head>
      <link rel="icon" href="/fav-32.png" sizes="32x32">
      <link rel="icon" type="image/png" href="//cdn.coop.it/fav-192.png" sizes="192x192">
      <link rel="stylesheet" href="/s.css">
      <link rel="apple-touch-icon" href="apple-180.png" sizes="180x180">
      <LINK REL="Shortcut Icon" HREF="http://coop.it/old.ico">
      <meta property="og:image" content="https://coop.it/og.jpg">
      <link rel="icon" href="data:image/png;base64,xxx">
      <link rel="icon" href="javascript:alert(1)">
    </head><body><p>unclosed
    """
    out = extract_icon_candidates(html, "https://www.coop.it/home/")
    assert out == [
        "https://www.coop.it/home/apple-180.png",
        "https://cdn.coop.it/fav-192.png",
        "https://www.coop.it/fav-32.png",
        "https://coop.it/old.ico",
        "https://coop.it/og.jpg",
        "https://www.coop.it/favicon.ico",
    ]


def test_extract_icons_base_and_empty():
    html = '<base href="https://static.coop.it/a/"><link rel="icon" href="i.png">'
    assert extract_icon_candidates(html, "https://coop.it/")[0] == "https://static.coop.it/a/i.png"
    assert extract_icon_candidates("", "https://coop.it/") == ["https://coop.it/favicon.ico"]


def test_card_logo_fields_and_backward_compat():
    c = create_card(
        {"name": "Coop", "code": "1", "logo_domain": "Coop.it", "logo_fit": "cover"}, "u", NOW
    )
    assert c.logo_domain == "coop.it" and c.logo_fit == "cover" and c.logo is None
    with pytest.raises(LoyaltyError):
        update_card(c, {"logo_fit": "stretch"}, NOW)
    with pytest.raises(LoyaltyError):
        update_card(c, {"logo": {"source": "upload"}}, NOW)  # server-only
    with pytest.raises(LoyaltyError):
        update_card(c, {"logo_domain": "192.168.1.1"}, NOW)
    update_card(c, {"logo_domain": None}, NOW)
    assert c.logo_domain is None
    old = {k: v for k, v in c.to_dict().items() if k not in ("logo_domain", "logo_fit", "logo")}
    loaded = Card.from_dict(old)
    assert loaded.logo_domain is None and loaded.logo_fit == "contain" and loaded.logo is None


def test_set_and_clear_logo_versions_never_repeat():
    c = create_card({"name": "Coop", "code": "1"}, "u", NOW)
    set_logo(c, "upload", "image/png", NOW)
    v1 = c.logo["version"]
    assert c.logo == {
        "source": "upload",
        "mime": "image/png",
        "updated_at": "2026-11-14T10:00:00+00:00",
        "version": v1,
        "domain": None,
    }
    set_logo(c, "logoapi", "image/svg+xml", NOW)
    assert c.logo["version"] == v1 + 1
    clear_logo(c, NOW)
    assert c.logo is None and c.to_dict()["logo"] is None
    set_logo(c, "upload", "image/png", datetime(2026, 11, 14, 10, 1, tzinfo=timezone.utc))
    assert c.logo["version"] > v1 + 1
    with pytest.raises(LoyaltyError):
        set_logo(c, "evil", "image/png", NOW)
    assert Card.from_dict(c.to_dict()).logo == c.logo


def test_catima_icon_import_export_roundtrip():
    a = create_card({"name": "Coop", "code": "111"}, "u1", NOW)
    b = create_card({"name": "Zara", "code": "222"}, "u1", NOW)
    set_logo(a, "upload", "image/png", NOW)
    set_logo(b, "upload", "image/jpeg", NOW)
    out = export_payload("catima", [a, b], now=NOW, icons={a.id: PNG, b.id: JPEG})
    raw = base64.b64decode(out["data_base64"])
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        names = set(zf.namelist())
    assert names == {"catima.csv", "card_1_icon.png"}  # JPEG skipped: Catima wants PNG
    parsed = parse_catima_full(raw)
    assert parsed.icons == [PNG, None]
    res = import_payload("catima", out["data_base64"], "u2", now=NOW)
    coop = next(c for c in res.cards if c.name == "Coop")
    zara = next(c for c in res.cards if c.name == "Zara")
    assert coop.logo["source"] == "import" and coop.logo["mime"] == "image/png"
    assert res.logos == {coop.id: PNG}
    assert zara.logo is None


def test_catima_icon_not_png_ignored():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("catima.csv", "2\r\n\r\n_id\r\n\r\n_id,store,cardid\r\n7,Shop,123\r\n")
        zf.writestr("card_7_icon.png", JPEG)
    assert parse_catima_full(buf.getvalue()).icons == [None]
