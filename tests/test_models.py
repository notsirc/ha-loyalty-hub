from datetime import datetime, timezone

import pytest

from core.errors import LoyaltyError
from core.models import (
    Card,
    UserPrefs,
    add_transaction,
    create_card,
    default_prefs,
    mark_used,
    remove_transaction,
    update_card,
    update_prefs,
    validate_editable,
)

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=timezone.utc)


def make(**kw):
    data = {"name": "Super Rossi", "code": "1234567890"}
    data.update(kw)
    return create_card(data, "owner1", NOW)


def test_create_defaults_and_server_fields():
    card = make()
    d = card.to_dict()
    assert len(d["id"]) == 32
    assert d["owner_id"] == "owner1"
    assert d["kind"] == "card"
    assert d["barcode_format"] == "CODE_128"
    assert d["color"] == "#185FA5"
    assert d["visibility"] == "private"
    assert d["currency"] == "EUR"
    assert d["balance"] is None
    assert d["use_count"] == 0
    assert d["created_at"] == d["updated_at"] == "2026-11-14T10:00:00+00:00"


@pytest.mark.parametrize(
    "key", ["owner_id", "id", "transactions", "balance", "use_count", "created_at", "bogus"]
)
def test_server_or_unknown_fields_rejected(key):
    with pytest.raises(LoyaltyError) as exc:
        make(**{key: "x"})
    assert exc.value.code == "invalid_format"


def test_required_and_lengths():
    with pytest.raises(LoyaltyError):
        create_card({"name": "x"}, "o", NOW)
    with pytest.raises(LoyaltyError):
        make(name="")
    with pytest.raises(LoyaltyError):
        make(name="a" * 81)
    with pytest.raises(LoyaltyError):
        make(code="1" * 513)
    with pytest.raises(LoyaltyError):
        make(notes="n" * 1001)


@pytest.mark.parametrize(
    "kw",
    [
        {"color": "red"},
        {"color": "#12345"},
        {"visibility": "public"},
        {"kind": "coupon"},
        {"points": "12"},
        {"points": True},
        {"favorite": "yes"},
        {"expiry": "2026-13-01"},
        {"zones": ["home"]},
        {"shared_with": "user"},
        {"initial_balance": -1},
        {"currency": "EURO"},
        {"barcode_format": "nope"},
    ],
)
def test_invalid_values(kw):
    with pytest.raises(LoyaltyError) as exc:
        make(**kw)
    assert exc.value.code == "invalid_format"


def test_normalizations():
    card = make(color="#abcdef", barcode_format="qr", currency="usd", points=12.0)
    assert card.color == "#ABCDEF"
    assert card.barcode_format == "QR_CODE"
    assert card.currency == "USD"
    assert card.points == 12


def test_invalid_code_for_format():
    with pytest.raises(LoyaltyError) as exc:
        make(barcode_format="EAN_13", code="123")
    assert exc.value.code == "invalid_code"
    card = make(barcode_format="ean13", code="8001234567890")
    with pytest.raises(LoyaltyError) as exc:
        update_card(card, {"code": "abc"}, NOW)
    assert exc.value.code == "invalid_code"


def test_update_card():
    card = make()
    later = datetime(2026, 11, 15, tzinfo=timezone.utc)
    update_card(card, {"name": "Nuovo", "favorite": True}, later)
    assert card.name == "Nuovo" and card.favorite
    assert card.updated_at.startswith("2026-11-15")
    with pytest.raises(LoyaltyError):
        update_card(card, {"owner_id": "hacker"}, later)
    assert card.owner_id == "owner1"


def test_voucher_balance_and_transactions():
    v = make(kind="voucher", initial_balance=50)
    ids = iter(["t1", "t2"])
    add_transaction(v, 12.5, "u1", note="spesa", now=NOW, id_factory=lambda: next(ids))
    add_transaction(v, 7.25, "u2", tx_date="2026-11-10T12:00:00", now=NOW, id_factory=lambda: next(ids))
    assert v.to_dict()["balance"] == 30.25
    assert [t.id for t in v.transactions] == ["t2", "t1"]  # sorted by date
    remove_transaction(v, "t1", NOW)
    assert v.balance == 42.75
    with pytest.raises(LoyaltyError) as exc:
        remove_transaction(v, "missing", NOW)
    assert exc.value.code == "not_found"


@pytest.mark.parametrize("amount", [0, -5, "10", None, float("nan")])
def test_transaction_invalid_amount(amount):
    v = make(kind="voucher", initial_balance=10)
    with pytest.raises(LoyaltyError):
        add_transaction(v, amount, "u1", now=NOW)


def test_transaction_only_on_voucher():
    with pytest.raises(LoyaltyError):
        add_transaction(make(), 5, "u1", now=NOW)


def test_mark_used():
    card = make()
    assert mark_used(card, NOW) is True
    # v0.4: a second use within 10 minutes is ignored (§11.6)
    assert mark_used(card, NOW) is False
    assert card.use_count == 1 and card.last_used == "2026-11-14T10:00:00+00:00"


def test_roundtrip_dict():
    v = make(kind="voucher", initial_balance=20, zones=["zone.esselunga"])
    add_transaction(v, 5, "u1", now=NOW)
    again = Card.from_dict(v.to_dict())
    assert again.to_dict() == v.to_dict()


def test_validate_editable_not_dict():
    with pytest.raises(LoyaltyError):
        validate_editable(["name"])


def test_prefs():
    p = default_prefs("u1")
    assert p.to_dict() == {
        "user_id": "u1",
        "notify_service": None,
        "zone_notifications": True,
        "expiry_notifications": True,
        "language": None,
        "price_compare": True,
        "price_compare_sites": None,
        "nearby": True,
        "admin_notice_accepted": None,
        "countries": None,
        # v0.6.0 (§15.3-§15.5)
        "grouping": True,
        "group_split": [],
        "group_links": [],
        "group_tabs": {},
        "group_names": {},
        "refuse_from_others": False,
        "inbox_notifications": True,
        "features_off": [],
        "nfc_tags": {},
        "default_share": None,
        "list_order": "habits",
        "manual_order": [],
        "low_balance_threshold": None,
        "cashier_high_contrast": False,
    }
    update_prefs(p, {"language": "pt_br"})
    assert p.language == "pt-BR"
    for bad in ("x", "it;drop", "a" * 21, 3):
        with pytest.raises(LoyaltyError):
            update_prefs(p, {"language": bad})
    update_prefs(p, {"language": None})
    assert p.language is None
    assert UserPrefs.from_dict({"user_id": "old"}).language is None  # v0.1 prefs
    update_prefs(p, {"notify_service": "notify.mobile_app_phone", "zone_notifications": False})
    assert p.notify_service == "mobile_app_phone" and p.zone_notifications is False
    update_prefs(p, {"notify_service": None})
    assert p.notify_service is None
    with pytest.raises(LoyaltyError):
        update_prefs(p, {"user_id": "other"})
    with pytest.raises(LoyaltyError):
        update_prefs(p, {"notify_service": "bad service!"})
    assert UserPrefs.from_dict(p.to_dict()) == p
