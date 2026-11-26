"""v0.3 (ARCHITETTURA §10): reloadable vouchers, price prefs, Wallet-Assistant import (logo refresh removed in v0.4)."""

import base64
import hashlib
import json
from datetime import datetime, timezone

import pytest

from core.csv_io import parse_csv
from core.errors import LoyaltyError
from core.models import (
    Card,
    Transaction,
    UserPrefs,
    add_transaction,
    compute_balance,
    create_card,
    default_prefs,
    update_card,
    update_prefs,
)
from core.transfer import export_payload, import_bytes, import_payload
from core.wallet_assistant import logo_cache_filenames, map_format, parse_wallet_assistant

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)
ME = "a" * 32
OTHER = "b" * 32


def _voucher(**kw):
    return create_card({"name": "Gift", "code": "G1", "kind": "voucher", **kw}, ME, NOW)


# ---------------------------------------------------------------- 10.1


def test_balance_with_topups():
    v = _voucher(initial_balance=20, reloadable=True)
    add_transaction(v, 5, ME, now=NOW)
    add_transaction(v, 10, ME, now=NOW, tx_type="topup")
    add_transaction(v, 2.5, ME, now=NOW, tx_type="spend")
    assert v.balance == 22.5
    assert [t.type for t in v.transactions] == ["spend", "topup", "spend"]


def test_reloadable_null_initial_counts_as_zero():
    v = _voucher(reloadable=True)
    assert v.balance == 0
    add_transaction(v, 30, ME, now=NOW, tx_type="topup")
    add_transaction(v, 12, ME, now=NOW)
    assert v.balance == 18
    plain = _voucher()
    add_transaction(plain, 1, ME, now=NOW)
    assert plain.balance is None
    # reloadable is meaningful only for vouchers
    card = create_card({"name": "C", "code": "1", "reloadable": True}, ME, NOW)
    assert card.balance is None


def test_topup_rejected_on_non_reloadable_and_bad_type():
    v = _voucher(initial_balance=10)
    with pytest.raises(LoyaltyError) as exc:
        add_transaction(v, 5, ME, now=NOW, tx_type="topup")
    assert exc.value.code == "invalid_format"
    with pytest.raises(LoyaltyError):
        add_transaction(v, 5, ME, now=NOW, tx_type="refund")
    update_card(v, {"reloadable": True}, NOW)
    add_transaction(v, 5, ME, now=NOW, tx_type="topup")
    assert v.balance == 15
    with pytest.raises(LoyaltyError):
        update_card(v, {"reloadable": "yes"}, NOW)


def test_compute_balance_and_legacy_transactions():
    txs = [Transaction("1", "2026-01-01", 4), Transaction("2", "2026-01-02", 1, type="topup")]
    assert compute_balance(10, txs) == 7
    assert compute_balance(None, txs) is None
    assert compute_balance(None, txs, reloadable=True) == -3
    old = Transaction.from_dict({"id": "x", "date": "d", "amount": 2})
    assert old.type == "spend"
    assert Transaction.from_dict({"id": "x", "date": "d", "amount": 2, "type": "?"}).type == "spend"
    legacy = {k: v for k, v in _voucher().to_dict().items() if k != "reloadable"}
    assert Card.from_dict(legacy).reloadable is False


def test_csv_reloadable_roundtrip():
    v = _voucher(initial_balance=10, reloadable=True)
    out = export_payload("csv", [v], NOW)
    raw = base64.b64decode(out["data_base64"])
    assert raw.splitlines()[0].decode().endswith(",reloadable")
    res = import_payload("csv", out["data_base64"], OTHER, now=NOW)
    assert res.cards[0].reloadable is True
    rows, errors = parse_csv(b"name;code;ricaricabile\nA;1;si\nB;2;no\nC;3;forse\n")
    assert [r.get("reloadable") for r in rows] == [True, False]
    assert len(errors) == 1


# ---------------------------------------------------------------- 10.2


def test_price_prefs_defaults_and_validation():
    p = default_prefs("u")
    assert p.price_compare is True and p.price_compare_sites is None
    update_prefs(p, {"price_compare": False, "price_compare_sites": [" Amazon ", "Idealo", "Amazon"]})
    assert p.price_compare is False
    assert p.price_compare_sites == ["Amazon", "Idealo"]
    update_prefs(p, {"price_compare_sites": None})
    assert p.price_compare_sites is None
    for bad in (
        {"price_compare": "no"},
        {"price_compare_sites": "Amazon"},
        {"price_compare_sites": [1]},
        {"price_compare_sites": [""]},
        {"price_compare_sites": ["x" * 81]},
        {"price_compare_sites": [f"s{i}" for i in range(51)]},
    ):
        with pytest.raises(LoyaltyError):
            update_prefs(default_prefs("u"), bad)
    loaded = UserPrefs.from_dict({"user_id": "u"})
    assert loaded.price_compare is True and loaded.price_compare_sites is None
    loaded = UserPrefs.from_dict({"user_id": "u", "price_compare_sites": ["A", 3]})
    assert loaded.price_compare_sites == ["A"]


# ---------------------------------------------------------------- 10.3


def _wa(items):
    return json.dumps(items).encode()


WA_ITEMS = [
    {
        "item_id": "1",
        "name": "Esselunga",
        "code": "0412345678901",
        "owner": "Me",
        "user_id": ME,
        "item_type": "loyalty",
        "format": "CODE128",
        "default_view": "barcode",
        "logo_slug": "esselunga.it",
        "expires_on": "2027-01-31",
        "notes": "Fidaty",
        "promo_url": "https://example.org/promo",
        "currency": "EUR",
    },
    {
        "item_id": "2",
        "name": "Amazon",
        "code": "GIFT-1",
        "user_id": ME,
        "item_type": "voucher",
        "format": "CODE39",
        "default_view": "qr",
        "initial_value": 50,
        "currency": "EUR",
        "spending": [
            {"id": "s1", "amount": 12.5, "spent_on": "2026-10-01", "note": "libro"},
            {"id": "s2", "amount": 7.5, "spent_on": "2026-10-05", "note": ""},
        ],
        "remaining_balance": 30,
    },
    {"item_id": "3", "name": "Altrui", "code": "X", "user_id": OTHER, "item_type": "loyalty"},
    {"item_id": "4", "name": "Promo", "code": "P", "user_id": ME, "item_type": "promotion"},
    {"item_id": "5", "name": "Foreign", "code": "F", "user_id": "c" * 32, "format": "EAN13"},
]


def test_wa_parser_mapping_and_privacy():
    parsed = parse_wallet_assistant(_wa(WA_ITEMS), ME, {ME, OTHER})
    assert parsed.skipped_other_users == 1
    assert parsed.skipped_promotions == 1
    names = [i.row["name"] for i in parsed.items]
    assert names == ["Esselunga", "Amazon", "Foreign"]
    first = parsed.items[0].row
    assert first["kind"] == "card"
    assert first["barcode_format"] == "CODE_128"
    assert first["logo_domain"] == "esselunga.it"
    assert first["expiry"] == "2027-01-31"
    assert first["notes"] == "Fidaty\nLink: https://example.org/promo"
    voucher = parsed.items[1]
    assert voucher.row["kind"] == "voucher"
    assert voucher.row["barcode_format"] == "QR_CODE"
    assert voucher.row["initial_balance"] == 50
    assert voucher.spending[0] == {
        "amount": 12.5,
        "date": "2026-10-01T12:00:00+00:00",
        "note": "libro",
    }


def test_wa_import_creates_private_cards_with_spend_transactions():
    res = import_bytes("wallet_assistant", _wa({"items": WA_ITEMS}), ME, now=NOW, known_user_ids={ME, OTHER})
    assert res.imported == 3
    assert res.skipped_other_users == 1
    assert res.skipped == 2  # other user + promotion
    resp = res.to_response()
    assert resp["skipped_other_users"] == 1 and "logos_imported" not in resp
    amazon = next(c for c in res.cards if c.name == "Amazon")
    assert amazon.balance == 30
    assert [t.type for t in amazon.transactions] == ["spend", "spend"]
    assert all(t.user_id == ME for t in amazon.transactions)
    assert amazon.transactions[0].date == "2026-10-01T12:00:00+00:00"
    assert all(c.owner_id == ME and c.visibility == "private" for c in res.cards)
    # invalid EAN13 code falls back to CODE_128
    assert next(c for c in res.cards if c.name == "Foreign").barcode_format == "CODE_128"
    assert res.logo_slugs[res.cards[0].id] == "esselunga.it"
    # duplicates skipped on re-import
    again = import_bytes("wallet_assistant", _wa(WA_ITEMS), ME, existing=res.cards, now=NOW, known_user_ids={ME, OTHER})
    assert again.imported == 0 and again.skipped == 5


def test_wa_legacy_cardwallet_keys():
    legacy = {
        "cards": [
            {
                "card_id": "x",
                "name": "Coop",
                "code": "123",
                "type": "card",
                "user_id": ME,
                "format": "codabar",
                "logo_slug": "coop",
                "expiry_date": "2027-05-01",
                "url": "https://coop.example/x",
            }
        ]
    }
    parsed = parse_wallet_assistant(_wa(legacy), ME, {ME})
    item = parsed.items[0]
    assert item.row["kind"] == "card"
    assert item.row["barcode_format"] == "CODABAR"
    assert item.row["expiry"] == "2027-05-01"
    assert "logo_domain" not in item.row  # "coop" is not a domain
    assert item.logo_slug == "coop"
    assert item.row["notes"] == "Link: https://coop.example/x"


def test_wa_format_map_and_bad_input():
    assert map_format("EAN8") == "EAN_8"
    assert map_format("UPC") == "UPC_A"
    assert map_format("ITF14") == "ITF"
    assert map_format("pharmacode") == "CODE_128"
    assert map_format(None) == "CODE_128"
    assert map_format("EAN13", "qr") == "QR_CODE"
    with pytest.raises(LoyaltyError):
        parse_wallet_assistant(b"{not json", ME, set())
    with pytest.raises(LoyaltyError):
        parse_wallet_assistant(b'{"foo": 1}', ME, set())
    assert parse_wallet_assistant(b"[1]", ME, set()).errors


def test_wa_logo_cache_filenames():
    names = logo_cache_filenames("esselunga.it")
    assert len(names) == 4
    assert names[0] == hashlib.sha256(b"esselunga.it|256").hexdigest()[:32] + ".webp"
    assert names[-1] == hashlib.sha256(b"esselunga.it|32").hexdigest()[:32] + ".webp"


def test_wa_not_exportable():
    with pytest.raises(LoyaltyError):
        export_payload("wallet_assistant", [], NOW)
