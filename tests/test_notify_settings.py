from datetime import date, datetime, timedelta, timezone

from pathlib import Path

from core.i18n import Translator, load_catalogs
from core.models import add_transaction, create_card
from core.notify_logic import (
    build_expiry_notification,
    build_zone_notification,
    cards_for_zone,
    count_expiring_vouchers,
    entered_persons,
    expiring_cards,
    expiry_due,
    filter_cooldown,
    prune_notify_log,
    record_expiry_notified,
    record_zone_notified,
)
from core.settings import (
    DEFAULT_PRICE_COMPARE,
    format_price_sites,
    parse_price_sites,
    sanitize_expiry_days,
    sanitize_price_sites,
)

I18N_DIR = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub" / "i18n"
CATALOGS = load_catalogs(I18N_DIR)
IT = Translator(CATALOGS, "it")
EN = Translator(CATALOGS, "en")
NOW = datetime(2026, 11, 14, 10, 0, tzinfo=timezone.utc)
TODAY = date(2026, 11, 14)


def card(owner="u1", **kw):
    return create_card({"name": kw.pop("name", "Shop"), "code": "1", **kw}, owner, NOW)


def test_entered_persons():
    assert entered_persons(["person.a"], ["person.a", "person.b"]) == ["person.b"]
    assert entered_persons(None, ["person.a"]) == ["person.a"]
    assert entered_persons(["person.a"], []) == []


def test_cards_for_zone_visibility_and_home():
    mine = card(name="Mine", zones=["zone.esselunga"])
    other_private = card(owner="u2", name="Private", zones=["zone.esselunga"])
    other_shared = card(owner="u2", name="Shared", zones=["zone.esselunga"],
                        visibility="shared", shared_with=["u1"], favorite=True)
    elsewhere = card(name="Else", zones=["zone.coop"])
    cards = [mine, other_private, other_shared, elsewhere]
    result = cards_for_zone(cards, "u1", "zone.esselunga")
    assert [c.name for c in result] == ["Shared", "Mine"]  # favorite first
    assert cards_for_zone([card(zones=["zone.home"])], "u1", "zone.home") == []


def test_cooldown():
    c = card(zones=["zone.x"])
    log = {}
    assert filter_cooldown([c], "u1", log, NOW) == [c]
    record_zone_notified(log, "u1", [c], NOW)
    assert log == {f"u1:{c.id}": "2026-11-14T10:00:00+00:00"}
    assert filter_cooldown([c], "u1", log, NOW + timedelta(hours=3, minutes=59)) == []
    assert filter_cooldown([c], "u1", log, NOW + timedelta(hours=4)) == [c]
    # cooldown is per user
    assert filter_cooldown([c], "u2", log, NOW) == [c]


def test_zone_notification_messages():
    a, b = card(name="Esselunga"), card(name="Fidaty")
    n1 = build_zone_notification("zone.esselunga", "Esselunga Via Roma", [a], IT)
    assert n1.title == "Esselunga Via Roma"
    assert n1.message == "Tessera Esselunga pronta"
    assert n1.data == {
        "url": f"/loyalty-hub?card={a.id}",
        "clickAction": f"/loyalty-hub?card={a.id}",
        "tag": "loyalty_hub_esselunga",
        "group": "loyalty_hub",
    }
    n2 = build_zone_notification("zone.esselunga", "Z", [a, b], IT)
    assert n2.message == "2 tessere per questo negozio"
    assert n2.service_data()["data"]["url"].endswith(a.id)
    assert build_zone_notification("zone.x", "Z", [a], EN).message == "Esselunga card ready"
    assert build_zone_notification("zone.x", "Z", [a, b], EN).message == "2 cards for this store"


def test_expiring_selection():
    today_v = card(name="Today", kind="voucher", expiry="2026-11-14", initial_balance=5)
    edge = card(name="Edge", kind="voucher", expiry="2026-11-21")
    late = card(name="Late", kind="voucher", expiry="2026-11-22")
    past = card(name="Past", kind="voucher", expiry="2026-11-13")
    tessera = card(name="Tessera", expiry="2026-11-20")
    spent = card(name="Spent", kind="voucher", expiry="2026-11-15", initial_balance=10)
    add_transaction(spent, 10, "u1", now=NOW)
    none = card(name="None")
    cards = [today_v, edge, late, past, tessera, spent, none]
    assert [c.name for c in expiring_cards(cards, TODAY, 7)] == ["Today", "Tessera", "Edge"]
    assert count_expiring_vouchers(cards, TODAY, 7) == 2
    assert count_expiring_vouchers(cards, TODAY, 8) == 3


def test_expiry_due_once_per_expiry():
    v = card(kind="voucher", expiry="2026-11-16")
    log = {}
    assert expiry_due([v], TODAY, 7, log) == [v]
    record_expiry_notified(log, v, NOW)
    assert f"exp:u1:{v.id}:2026-11-16" in log
    assert expiry_due([v], TODAY, 7, log) == []
    v.expiry = "2026-11-18"  # expiry changed -> notify again
    assert expiry_due([v], TODAY, 7, log) == [v]


def test_expiry_notification_text():
    v = card(name="Buono", kind="voucher", expiry="2026-11-15", initial_balance=12)
    n = build_expiry_notification(v, TODAY, IT)
    assert n.message == "Buono Buono scade domani - saldo 12,00 EUR"
    assert n.title == "Loyalty Hub"
    assert n.data["url"] == f"/loyalty-hub?card={v.id}"
    t = card(name="Coop", expiry="2026-11-20")
    assert build_expiry_notification(t, TODAY, IT).message == "Tessera Coop scade tra 6 giorni (20/11/2026)"
    assert build_expiry_notification(t, TODAY, EN).message == "Card Coop expires in 6 days (2026-11-20)"
    assert build_expiry_notification(v, TODAY, EN).message == "Voucher Buono expires tomorrow - balance 12.00 EUR"
    today = card(name="X", expiry="2026-11-14")
    ja = Translator(CATALOGS, "ja-JP")
    assert build_expiry_notification(today, TODAY, ja).message == "Card X expires today"


def test_prune_log():
    log = {
        "u1:a": (NOW - timedelta(days=3)).isoformat(),
        "u1:b": (NOW - timedelta(hours=1)).isoformat(),
        "exp:u1:c:2026-11-10": "x",
        "exp:u1:d:2026-11-20": "x",
    }
    assert prune_notify_log(log, NOW, TODAY) == 2
    assert set(log) == {"u1:b", "exp:u1:d:2026-11-20"}


def test_price_sites():
    text = format_price_sites(DEFAULT_PRICE_COMPARE)
    sites, invalid = parse_price_sites(text + "\n\nbroken line\nNo query|https://x.it\nFtp|ftp://x?{query}")
    assert sites == DEFAULT_PRICE_COMPARE
    assert len(invalid) == 3
    assert sanitize_price_sites(None) == DEFAULT_PRICE_COMPARE
    assert sanitize_price_sites([{"name": "A", "url": "https://a?q={query}"}, {"bad": 1}]) == [
        {"name": "A", "url": "https://a?q={query}"}
    ]
    assert sanitize_expiry_days("10") == 10
    assert sanitize_expiry_days(None) == 7
    assert sanitize_expiry_days(9999) == 365
