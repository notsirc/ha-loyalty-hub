"""v0.5.0 (ARCHITETTURA §14): Logo.dev key without trial, logo versions, countries, shops."""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core.countries import (
    OTHER,
    country_choices,
    load_countries,
    normalize_country,
    resolve_country,
    validate_countries,
)
from core.errors import LoyaltyError
from core.household import MAX_HOUSEHOLD_SHOPS, household_shops, normalize_shop_name
from core.logo_cache import (
    RefreshProgress,
    checked_after_failure,
    expired_jobs,
    is_expired,
    load_cache_state,
    refresh_all_jobs,
)
from core.logo_files import LogoFiles
from core.logo_key import (
    ERR_CANNOT_CONNECT,
    ERR_INVALID_KEY,
    ERR_KEY_RATE_LIMITED,
    ERR_KEY_REJECTED,
    ERR_SECRET_KEY,
    STATE_DISABLED,
    STATE_NO_KEY,
    STATE_READY,
    TEST_OK,
    TEST_RATE_LIMITED,
    TEST_REJECTED,
    TEST_UNREACHABLE,
    LogoKeyError,
    classify_test_status,
    key_test_error,
    key_test_url,
    logo_dev_state,
    validate_user_key,
)
from core.logo_preview import MAX_PREVIEWS_PER_USER, PREVIEW_TTL, PreviewStore
from core.logo_sources import PROVIDER_AUTO, provider_order
from core.logos import check_logo_limits, logo_filename
from core.models import (
    PREFS_EDITABLE,
    Card,
    UserPrefs,
    clear_logo,
    create_card,
    revert_logo,
    set_logo,
    update_card,
    update_prefs,
)
from core.price_sites import SUGGESTED_PRICE_SITES, default_price_sites, suggested_price_sites
from core.settings import DEFAULT_PRICE_COMPARE, parse_price_sites, sanitize_currency
from core.shop_countries import SHOP_COUNTRIES
from core.transfer import import_payload

T0 = datetime(2026, 11, 21, 10, 0, tzinfo=timezone.utc)
USER_KEY = "pk_FakeUserKey456789"
BASE = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub"
ALICE, BOB, CAROL = "alice", "bob", "carol"


def card(owner=ALICE, **kw):
    data = {"name": "Coop", "code": "1"}
    data.update(kw)
    return create_card(data, owner, T0)


# ---------------------------------------------------------------- §14.1 key


def test_user_key_ok_and_stripped():
    assert validate_user_key(f"  {USER_KEY} ") == USER_KEY


@pytest.mark.parametrize(
    ("value", "reason"),
    [
        ("sk_secretsecret123", ERR_SECRET_KEY),
        ("SK_secretsecret123", ERR_SECRET_KEY),
        ("pk_short", ERR_INVALID_KEY),
        ("hello world", ERR_INVALID_KEY),
        ("pk_with space inside", ERR_INVALID_KEY),
        (123, ERR_INVALID_KEY),
        (None, ERR_INVALID_KEY),
    ],
)
def test_user_key_refused(value, reason):
    with pytest.raises(LogoKeyError) as exc:
        validate_user_key(value)
    assert exc.value.reason == reason


def test_logo_dev_state():
    assert logo_dev_state(True, USER_KEY) == STATE_READY
    assert logo_dev_state(True, None) == STATE_NO_KEY
    assert logo_dev_state(False, USER_KEY) == STATE_DISABLED
    assert logo_dev_state(False, None) == STATE_DISABLED


@pytest.mark.parametrize(
    ("status", "result"),
    [
        (200, TEST_OK),
        (204, TEST_OK),
        (404, TEST_OK),  # valid key, logo missing
        (401, TEST_REJECTED),
        (403, TEST_REJECTED),
        (429, TEST_RATE_LIMITED),
        (500, TEST_UNREACHABLE),
        (302, TEST_UNREACHABLE),
        (None, TEST_UNREACHABLE),
    ],
)
def test_classify_key_test(status, result):
    assert classify_test_status(status) == result


def test_key_test_errors_and_url():
    assert key_test_error(TEST_OK) is None
    assert key_test_error(TEST_REJECTED) == ERR_KEY_REJECTED
    assert key_test_error(TEST_RATE_LIMITED) == ERR_KEY_RATE_LIMITED
    assert key_test_error(TEST_UNREACHABLE) == ERR_CANNOT_CONNECT
    url = key_test_url(USER_KEY)
    assert url.startswith("https://img.logo.dev/logo.dev?token=pk_")
    assert "size=64" in url and "format=png" in url and "fallback=404" in url


def _load(name):
    return json.loads((BASE / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", ["strings.json", "translations/en.json", "translations/it.json"])
def test_flow_translations(name):
    d = _load(name)
    errors = {ERR_SECRET_KEY, ERR_INVALID_KEY, ERR_KEY_REJECTED, ERR_KEY_RATE_LIMITED, ERR_CANNOT_CONNECT}
    for section in ("config", "options"):
        assert set(d[section]["error"]) >= errors
        assert "default_key_not_allowed" not in d[section]["error"]
    assert "issues" not in d  # the trial repair issue is gone
    user = d["config"]["step"]["user"]
    init = d["options"]["step"]["init"]
    for step in (user, init):
        text = step["description"]
        assert "{signup_url}" in text and "pk_" in text and "sk_" in text
        assert all(f"\n{i}. " in text for i in range(1, 7))  # the 6-step guide
        assert "trial" not in text.lower() and "{trial_days}" not in text
        assert {"logo_dev_token", "test_logo_dev_key", "default_country"} <= set(step["data"])
    assert "{suggested_sites}" in init["description"]
    countries = d["selector"]["default_country"]["options"]
    assert set(countries) == set(SHOP_COUNTRIES) | {OTHER}


def test_flow_translations_same_keys():
    def keys(obj, prefix=""):
        out = set()
        for k, v in obj.items():
            out |= keys(v, f"{prefix}{k}.") if isinstance(v, dict) else {prefix + k}
        return out

    en = keys(_load("translations/en.json"))
    assert keys(_load("strings.json")) == en == keys(_load("translations/it.json"))


def test_no_default_key_import():
    for path in BASE.rglob("*.py"):
        if path.name == "default_key.py":
            continue
        text = path.read_text(encoding="utf-8")
        assert "default_key" not in text and "DEFAULT_LOGO_DEV_KEY" not in text, path


# ---------------------------------------------------------------- §14.2 logo metadata


def test_set_logo_moves_current_to_previous():
    c = card()
    set_logo(c, "upload", "image/png", T0)
    first = dict(c.logo)
    assert c.logo_previous is None
    set_logo(c, "logo_dev", "image/png", T0, domain="coop.it")
    assert c.logo_previous == first
    assert c.logo["version"] > first["version"]
    second = dict(c.logo)
    set_logo(c, "website", "image/x-icon", T0)
    assert c.logo_previous == second  # the old previous is dropped


def test_clear_logo_keeps_it_as_previous_and_revert_restores():
    c = card()
    set_logo(c, "upload", "image/png", T0)
    old = dict(c.logo)
    clear_logo(c, T0)
    assert c.logo is None and c.logo_previous == old
    # A new logo without a current one keeps the previous one.
    set_logo(c, "logoapi", "image/svg+xml", T0)
    assert c.logo_previous == old
    clear_logo(c, T0)
    assert c.logo_previous["source"] == "logoapi"
    revert_logo(c, T0 + timedelta(seconds=1))
    assert c.logo["source"] == "logoapi" and c.logo_previous is None


def test_revert_swaps_and_gives_new_version():
    c = card()
    set_logo(c, "upload", "image/png", T0)
    a = dict(c.logo)
    set_logo(c, "logo_dev", "image/png", T0, domain="coop.it")
    b = dict(c.logo)
    later = T0 + timedelta(minutes=1)
    revert_logo(c, later)
    assert c.logo["source"] == "upload" and c.logo["updated_at"] == a["updated_at"]
    assert c.logo["version"] > max(a["version"], b["version"])
    assert c.logo["checked_at"] == "2026-11-21T10:01:00+00:00"
    assert c.logo_previous == b  # keeps its own metadata
    with pytest.raises(LoyaltyError) as exc:
        revert_logo(card(), T0)
    assert exc.value.code == "not_found"


def test_versions_never_repeat_across_previous():
    c = card()
    seen = set()
    for i in range(4):
        set_logo(c, "upload", "image/png", T0)
        seen.add(c.logo["version"])
        clear_logo(c, T0)
        revert_logo(c, T0)
        seen.add(c.logo["version"])
    assert len(seen) == 8


def test_logo_previous_output_and_storage():
    c = card()
    set_logo(c, "logo_dev", "image/png", T0, domain="coop.it")
    c.logo["checked_at"] = "2026-11-21T09:00:00+00:00"
    set_logo(c, "website", "image/png", T0, domain="coop.it")
    out = c.to_dict()["logo_previous"]
    assert set(out) == {"source", "mime", "updated_at", "version"}
    stored = c.to_storage()
    assert "checked_at" not in stored["logo_previous"]
    assert stored["logo_previous"]["domain"] == "coop.it"
    loaded = Card.from_dict(stored)
    assert loaded.logo_previous == stored["logo_previous"] and loaded.logo == c.logo
    assert "logo_previous" not in card().to_storage()
    with pytest.raises(LoyaltyError):
        update_card(c, {"logo_previous": None}, T0)


def test_logo_filename_previous():
    cid = "a" * 32
    assert logo_filename(cid, "image/png", previous=True) == cid + ".prev.png"
    assert logo_filename(cid, "image/webp") == cid + ".webp"


def test_check_logo_limits_two_files():
    check_logo_limits(998, 0, 10, 1000, 100, new_files=2)
    with pytest.raises(LoyaltyError) as exc:
        check_logo_limits(999, 0, 10, 1000, 100, new_files=2)
    assert exc.value.code == "limit_reached"


# ---------------------------------------------------------------- §14.2 files


CID = "b" * 32
PNG1 = b"\x89PNG\r\n\x1a\n" + b"1" * 10
PNG2 = b"\x89PNG\r\n\x1a\n" + b"2" * 20
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"3" * 30


def files_in(d):
    return sorted(p.name for p in d.iterdir())


def test_files_store_rule(tmp_path):
    lf = LogoFiles(tmp_path)
    lf.store(CID, "image/png", PNG1, None, None, 10, 10_000)
    assert files_in(tmp_path) == [f"{CID}.png"]
    lf.store(CID, "image/webp", WEBP, "image/png", None, 10, 10_000)
    assert files_in(tmp_path) == [f"{CID}.prev.png", f"{CID}.webp"]
    assert lf.read(CID, "image/png", previous=True) == PNG1
    lf.store(CID, "image/png", PNG2, "image/webp", "image/png", 10, 10_000)
    assert files_in(tmp_path) == [f"{CID}.png", f"{CID}.prev.webp"]  # old previous deleted
    assert lf.read(CID, "image/png") == PNG2
    assert lf.usage() == (2, len(PNG2) + len(WEBP))


def test_files_store_limits(tmp_path):
    lf = LogoFiles(tmp_path)
    other = "c" * 32
    lf.write(other, "image/png", PNG1)
    lf.store(CID, "image/png", PNG1, None, None, 3, 10_000)
    # 1 other + new + current kept as previous = 3 files: ok with max 3.
    lf.store(CID, "image/png", PNG2, "image/png", None, 3, 10_000)
    with pytest.raises(LoyaltyError) as exc:
        lf.store(CID, "image/png", PNG1, "image/png", "image/png", 2, 10_000)
    assert exc.value.code == "limit_reached"
    # Bytes: other + new + current.
    limit = len(PNG1) + len(PNG1) + len(PNG2)
    lf.store(CID, "image/png", PNG1, "image/png", "image/png", 10, limit)
    # Now current PNG1, previous PNG2: other + PNG2 + PNG1 still fits exactly...
    lf.store(CID, "image/png", PNG2, "image/png", "image/png", 10, limit)
    # ...a bigger new logo does not.
    with pytest.raises(LoyaltyError):
        lf.store(CID, "image/webp", WEBP, "image/png", "image/png", 10, limit)
    assert lf.read(CID, "image/png") == PNG2  # nothing written on refusal
    assert lf.read(CID, "image/png", previous=True) == PNG1


def test_files_demote_revert_delete(tmp_path):
    lf = LogoFiles(tmp_path)
    lf.store(CID, "image/png", PNG1, None, None, 10, 10_000)
    lf.store(CID, "image/webp", WEBP, "image/png", None, 10, 10_000)
    lf.revert(CID, "image/webp", "image/png")
    assert files_in(tmp_path) == [f"{CID}.png", f"{CID}.prev.webp"]
    assert lf.read(CID, "image/png") == PNG1 and lf.read(CID, "image/webp", True) == WEBP
    lf.demote(CID, "image/png")
    assert files_in(tmp_path) == [f"{CID}.prev.png"]
    lf.revert(CID, None, "image/png")
    assert files_in(tmp_path) == [f"{CID}.png"]
    with pytest.raises(LoyaltyError):
        lf.revert(CID, "image/png", "image/webp")
    lf.store(CID, "image/webp", WEBP, "image/png", None, 10, 10_000)
    lf.delete(CID)
    assert files_in(tmp_path) == []


# ---------------------------------------------------------------- §14.2 auto, preview


def test_provider_order_auto():
    assert provider_order(PROVIDER_AUTO, ["logoapi", "logo_dev", "website"]) == [
        "logo_dev",
        "website",
        "logoapi",
    ]
    assert provider_order(PROVIDER_AUTO, ["logoapi"]) == ["logoapi"]
    assert provider_order(PROVIDER_AUTO, []) == []
    assert provider_order("website", ["logoapi"]) == ["website"]


def test_preview_store_rules():
    ids = iter(f"p{i}" for i in range(100))
    store = PreviewStore(id_factory=lambda: next(ids))
    first = store.add(ALICE, CID, "logo_dev", "coop.it", "image/png", PNG1, T0)
    assert store.get(first.preview_id, ALICE, CID, T0) is first
    assert store.get(first.preview_id, BOB, CID, T0) is None  # another user
    assert store.get(first.preview_id, ALICE, "c" * 32, T0) is None  # another card
    assert store.get(first.preview_id, ALICE, CID, T0 + PREVIEW_TTL) is None  # expired
    made = [
        store.add(ALICE, CID, "logoapi", "coop.it", "image/png", PNG1, T0 + timedelta(seconds=i))
        for i in range(MAX_PREVIEWS_PER_USER + 1)
    ]
    now = T0 + timedelta(seconds=10)
    assert store.get(made[0].preview_id, ALICE, CID, now) is None  # oldest dropped
    assert all(store.get(p.preview_id, ALICE, CID, now) for p in made[1:])
    store.add(BOB, CID, "logoapi", "coop.it", "image/png", PNG1, now)
    assert all(store.get(p.preview_id, ALICE, CID, now) for p in made[1:])
    store.discard(made[1].preview_id)
    assert store.get(made[1].preview_id, ALICE, CID, now) is None


def test_default_preview_ids_are_random():
    store = PreviewStore()
    a = store.add(ALICE, CID, "logoapi", "coop.it", "image/png", PNG1, T0)
    b = store.add(ALICE, CID, "logoapi", "coop.it", "image/png", PNG1, T0)
    assert a.preview_id != b.preview_id and len(a.preview_id) >= 20


# ---------------------------------------------------------------- §14.2 refresh and cache


def _logo_card(owner, source, domain="coop.it", updated=T0, logo_domain=None):
    c = card(owner, logo_domain=logo_domain)
    set_logo(c, source, "image/png", updated, domain=domain if source != "upload" else None)
    return c


def test_refresh_all_jobs():
    online = _logo_card(ALICE, "logoapi")
    upload = _logo_card(ALICE, "upload", logo_domain="coop.it")
    imported = _logo_card(ALICE, "import", logo_domain="coop.it")
    no_logo = card(ALICE, logo_domain="esselunga.it")
    no_domain = card(ALICE)
    bobs = _logo_card(BOB, "website")
    cards = [online, upload, imported, no_logo, no_domain, bobs]
    available = ["logoapi", "logo_dev", "website"]
    jobs = {j.card_id: j for j in refresh_all_jobs(cards, available, ALICE)}
    assert set(jobs) == {online.id, no_logo.id}
    assert jobs[online.id].providers == ("logoapi", "logo_dev", "website")
    assert jobs[online.id].version == online.logo["version"]
    assert jobs[no_logo.id].providers == ("logo_dev", "website", "logoapi")
    assert jobs[no_logo.id].domain == "esselunga.it" and jobs[no_logo.id].version is None
    admin = {j.card_id for j in refresh_all_jobs(cards, available, None)}
    assert admin == {online.id, no_logo.id, bobs.id}
    assert refresh_all_jobs(cards, [], None) == []
    # Provider no longer available: the auto order only.
    only_web = {j.card_id: j for j in refresh_all_jobs([online], ["website"], None)}
    assert only_web[online.id].providers == ("website",)


def test_refresh_uses_card_domain_first():
    # Review v0.5.0: the user changed the card domain after the logo was downloaded.
    changed = _logo_card(ALICE, "logo_dev", domain="esselunga.it", logo_domain="esselunga.com")
    job = refresh_all_jobs([changed], ["logo_dev"], ALICE)[0]
    assert job.domain == "esselunga.com"


def test_cache_expiry():
    days = 30
    logo = _logo_card(ALICE, "logoapi").logo
    assert not is_expired(logo, T0 + timedelta(days=29), days)
    assert is_expired(logo, T0 + timedelta(days=30), days)
    assert not is_expired(logo, T0 + timedelta(days=999), None)  # forever
    logo["checked_at"] = (T0 + timedelta(days=20)).isoformat()
    assert not is_expired(logo, T0 + timedelta(days=30), days)
    assert not is_expired(_logo_card(ALICE, "upload").logo, T0 + timedelta(days=999), 1)
    assert not is_expired(None, T0, 1)


def test_cache_jobs_and_failure_retry():
    days = 10
    a = _logo_card(ALICE, "logoapi")
    b = _logo_card(BOB, "logo_dev")
    fresh = _logo_card(CAROL, "website", updated=T0 + timedelta(days=9))
    up = _logo_card(CAROL, "upload")
    now = T0 + timedelta(days=10)
    jobs = expired_jobs([a, b, fresh, up], ["logoapi", "website"], now, days)
    assert [(j.card_id, j.providers) for j in jobs] == [(a.id, ("logoapi",))]  # b: no provider
    assert expired_jobs([a], ["logoapi"], now, None) == []
    retry = checked_after_failure(now, days)
    a.logo["checked_at"] = retry
    assert not is_expired(a.logo, now + timedelta(hours=23), days)
    assert is_expired(a.logo, now + timedelta(days=1), days)


def test_cache_state_and_progress():
    assert load_cache_state(None) == {"days": None}
    assert load_cache_state({"days": 30}) == {"days": 30}
    for bad in (0, 366, True, "5", 2.5):
        assert load_cache_state({"days": bad}) == {"days": None}
    event = RefreshProgress(total=3, done=1, updated=1).event()
    assert event == {
        "event": "logo_refresh",
        "done": 1,
        "total": 3,
        "updated": 1,
        "failed": 0,
        "running": True,
    }


# ---------------------------------------------------------------- §14.3 countries


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("IT", "it"), (" de ", "de"), ("sm", "it"), ("VA", "it"), ("other", "other"),
     ("OTHER", "other"), ("ita", None), ("i", None), ("1t", None), (None, None), (3, None)],
)
def test_normalize_country(raw, expected):
    assert normalize_country(raw) == expected


def test_resolve_country_and_choices():
    assert resolve_country("IT") == "it"
    assert resolve_country("SM") == "it"
    assert resolve_country("zz") == OTHER
    assert resolve_country(None) == OTHER
    assert country_choices()[-1] == OTHER and len(country_choices()) == len(SHOP_COUNTRIES) + 1


def test_validate_countries():
    assert validate_countries(None) is None
    assert validate_countries([]) is None
    assert validate_countries(["IT", "fr"]) == ["it", "fr"]
    assert validate_countries(["other"]) == ["other"]
    for bad in (["it", "fr", "de"], ["it", "sm"], ["zz"], ["ita"], "it", [1]):
        with pytest.raises(LoyaltyError) as exc:
            validate_countries(bad)
        assert exc.value.code == "invalid_format"
    assert load_countries(["it", "zz"]) is None


def test_prefs_countries():
    assert "countries" in PREFS_EDITABLE
    p = UserPrefs(user_id=ALICE)
    update_prefs(p, {"countries": ["it", "DE"]})
    assert p.countries == ["it", "de"] and p.to_dict()["countries"] == ["it", "de"]
    assert p.to_storage() == {"countries": ["it", "de"]}
    assert UserPrefs.from_dict({"user_id": ALICE, **p.to_storage()}).countries == ["it", "de"]
    update_prefs(p, {"countries": None})
    assert p.countries is None and p.to_storage() == {}
    with pytest.raises(LoyaltyError):
        update_prefs(p, {"countries": ["it", "it"]})


def test_currency_default_and_storage():
    assert sanitize_currency("chf") == "CHF"
    assert sanitize_currency(None) == "EUR" and sanitize_currency("EURO") == "EUR"
    c = create_card({"name": "Migros", "code": "1"}, ALICE, T0, default_currency="CHF")
    assert c.currency == "CHF"
    explicit = create_card({"name": "M", "code": "1", "currency": "usd"}, ALICE, T0, default_currency="CHF")
    assert explicit.currency == "USD"
    eur = create_card({"name": "Coop", "code": "1"}, ALICE, T0)
    assert eur.to_storage()["currency"] == "EUR"  # always saved, also when EUR
    assert Card.from_dict(eur.to_storage()).currency == "EUR"


def test_import_uses_default_currency():
    import base64

    csv = "name,code\nMigros,123\n".encode()
    res = import_payload("csv", base64.b64encode(csv).decode(), ALICE, now=T0, default_currency="CHF")
    assert res.cards[0].currency == "CHF"
    assert res.cards[0].logo_previous is None


def test_price_sites():
    for cc, sites in SUGGESTED_PRICE_SITES.items():
        assert cc in SHOP_COUNTRIES
        parsed, invalid = parse_price_sites("\n".join(f"{s['name']}|{s['url']}" for s in sites))
        assert not invalid and len(parsed) == len(sites) and all("{query}" in s["url"] for s in sites)
    assert default_price_sites("de") == SUGGESTED_PRICE_SITES["de"]
    assert default_price_sites(OTHER) == DEFAULT_PRICE_COMPARE
    assert default_price_sites("zz") == DEFAULT_PRICE_COMPARE
    assert suggested_price_sites("zz") is None
    copy = default_price_sites("it")
    copy[0]["name"] = "x"
    assert SUGGESTED_PRICE_SITES["it"][0]["name"] != "x"


# ---------------------------------------------------------------- §14.3 household shops


def test_shop_fields():
    c = card()
    assert c.shop_custom is False and c.suggest_shop is True
    stored = c.to_storage()
    assert "shop_custom" not in stored and "suggest_shop" not in stored
    update_card(c, {"shop_custom": True, "suggest_shop": False}, T0)
    stored = c.to_storage()
    assert stored["shop_custom"] is True and stored["suggest_shop"] is False
    loaded = Card.from_dict(stored)
    assert loaded.shop_custom is True and loaded.suggest_shop is False
    with pytest.raises(LoyaltyError):
        update_card(c, {"shop_custom": "yes"}, T0)


def test_household_shops_rules():
    def shop(owner, name, vis="private", custom=True, suggest=True, domain=None, color="#112233"):
        return card(
            owner, name=name, visibility=vis, shop_custom=custom, suggest_shop=suggest,
            logo_domain=domain, color=color, notes="secret note", code="999",
        )

    cards = [
        shop(ALICE, "Bottega Rossi", domain="rossi.it"),
        shop(BOB, "bottega  rossi", domain="rossi.it", color="#445566"),  # duplicate
        shop(BOB, "Bottega Rossi", domain="rossi-shop.it"),  # same name, other domain
        shop(CAROL, "Café Nero"),
        shop(CAROL, "Private no", suggest=False),
        shop(CAROL, "Shared no suggest", vis="shared", suggest=False),
        shop(ALICE, "Coop", custom=False),
    ]
    shops = household_shops(cards)
    names = [(s["name"], s["domain"]) for s in shops]
    assert ("Private no", None) not in names and ("Coop", None) not in names
    assert ("Shared no suggest", None) in names  # shared cards are always suggested
    assert names.count(("Bottega Rossi", "rossi.it")) + names.count(("bottega  rossi", "rossi.it")) == 1
    assert ("Bottega Rossi", "rossi-shop.it") in names
    assert all(set(s) == {"name", "domain", "color"} for s in shops)
    assert names == sorted(names, key=lambda n: (normalize_shop_name(n[0]), n[1] or ""))
    assert normalize_shop_name("  Café   NERO ") == "cafe nero"
    many = [shop(ALICE, f"Shop {i:04d}") for i in range(MAX_HOUSEHOLD_SHOPS + 5)]
    assert len(household_shops(many)) == MAX_HOUSEHOLD_SHOPS
