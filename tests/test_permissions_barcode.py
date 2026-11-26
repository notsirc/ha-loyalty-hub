from datetime import datetime, timezone

import pytest

from core.barcode import BarcodeFormat, normalize_format, validate_code
from core.errors import LoyaltyError
from core.models import add_transaction, create_card
from core.permissions import (
    can_delete_transaction,
    can_edit,
    can_use,
    can_view,
    visible_cards,
)

NOW = datetime(2026, 11, 14, tzinfo=timezone.utc)


def card(**kw):
    return create_card({"name": "X", "code": "1", **kw}, "owner", NOW)


def test_private_only_owner_even_admin():
    c = card()
    assert can_view(c, "owner") and can_edit(c, "owner")
    # "admin" is just another user id for permissions: no special rights.
    assert not can_view(c, "admin")
    assert not can_edit(c, "admin")
    assert not can_use(c, "admin")
    # shared_with is ignored while private
    c2 = card(shared_with=["admin"])
    assert not can_view(c2, "admin")


def test_shared_specific_and_all():
    c = card(visibility="shared", shared_with=["carol"])
    assert can_view(c, "carol") and can_use(c, "carol")
    assert not can_edit(c, "carol")
    assert not can_view(c, "bob")
    c_all = card(visibility="shared", shared_with=["*"])
    assert can_view(c_all, "bob") and not can_edit(c_all, "bob")
    assert not can_view(c_all, None) and not can_view(c_all, "")


def test_visible_cards():
    cards = [card(), card(visibility="shared", shared_with=["*"]), card(visibility="shared")]
    assert len(visible_cards(cards, "owner")) == 3
    assert len(visible_cards(cards, "bob")) == 1


def test_delete_transaction_rules():
    v = card(kind="voucher", initial_balance=10, visibility="shared", shared_with=["*"])
    tx_carol = add_transaction(v, 1, "carol", now=NOW)
    tx_owner = add_transaction(v, 1, "owner", now=NOW)
    assert can_delete_transaction(v, tx_carol, "carol")
    assert can_delete_transaction(v, tx_carol, "owner")
    assert not can_delete_transaction(v, tx_owner, "carol")
    assert not can_delete_transaction(v, tx_carol, "bob")
    v.visibility = "private"
    assert not can_delete_transaction(v, tx_carol, "carol")


@pytest.mark.parametrize(
    "alias,expected",
    [
        ("code128", "CODE_128"),
        ("CODE128", "CODE_128"),
        ("code_128", "CODE_128"),
        ("CODE_128", "CODE_128"),
        ("ean13", "EAN_13"),
        ("ean_13", "EAN_13"),
        ("ean_8", "EAN_8"),
        ("qr", "QR_CODE"),
        ("qrcode", "QR_CODE"),
        ("qr_code", "QR_CODE"),
        ("pdf417", "PDF_417"),
        ("PDF_417", "PDF_417"),
        ("datamatrix", "DATA_MATRIX"),
        ("data_matrix", "DATA_MATRIX"),
        ("itf14", "ITF"),
        ("itf", "ITF"),
        ("aztec", "AZTEC"),
        ("codabar", "CODABAR"),
        ("upc_a", "UPC_A"),
        ("upc_e", "UPC_E"),
        ("code_39", "CODE_39"),
        ("code_93", "CODE_93"),
    ],
)
def test_normalize_aliases(alias, expected):
    assert normalize_format(alias) == BarcodeFormat(expected)


@pytest.mark.parametrize("bad", ["", "foo", None, 12, "unknown"])
def test_normalize_unknown(bad):
    assert normalize_format(bad) is None


@pytest.mark.parametrize(
    "fmt,code,ok",
    [
        ("EAN_13", "8001234567890", True),
        ("EAN_13", "800123456789", False),
        ("EAN_8", "12345670", True),
        ("EAN_8", "1234567a", False),
        ("UPC_A", "123456789012", True),
        ("UPC_E", "0123456", True),
        ("UPC_E", "12345", False),
        ("ITF", "1234", True),
        ("ITF", "123", False),
        ("CODE_128", "ABC-123 xyz", True),
        ("QR_CODE", "https://example.com", True),
    ],
)
def test_validate_code(fmt, code, ok):
    if ok:
        validate_code(code, BarcodeFormat(fmt))
    else:
        with pytest.raises(LoyaltyError) as exc:
            validate_code(code, BarcodeFormat(fmt))
        assert exc.value.code == "invalid_code"
