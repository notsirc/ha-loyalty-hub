import base64
import io
import zipfile
from datetime import datetime, timedelta, timezone

import pytest

from core.catima import parse_catima
from core.csv_io import CSV_COLUMNS, parse_csv
from core.errors import LoyaltyError
from core.models import add_transaction, create_card
from core.transfer import export_payload, import_payload

NOW = datetime(2026, 11, 14, 10, 0, tzinfo=timezone.utc)
ROME = timezone(timedelta(hours=1))  # CET (no DST in November)

# Expiry 2026-12-31 local midnight in CET = 2026-12-30T23:00Z
EXP_MS = int(datetime(2026, 12, 31, tzinfo=ROME).timestamp() * 1000)

CATIMA_CSV = (
    "2\r\n"
    "\r\n"
    "_id\r\n"
    "Spesa\r\n"
    "Benzina\r\n"
    "\r\n"
    "_id,store,note,validfrom,expiry,balance,balancetype,cardid,barcodeid,barcodetype,"
    "headercolor,starstatus,lastused,archive,zoomlevel\r\n"
    '1,Esselunga,"Fidaty, carta\r\ndi Alice",,,0,,0412345678901,,CODE_128,-16753883,1,1731580000,0,100\r\n'
    f"2,Buono Amazon,,,{EXP_MS},25.50,EUR,GIFT-XYZ,,QR_CODE,-65536,0,,0,100\r\n"
    "3,Coop,,,,120,,2500000000004,,EAN_13,-1,0,,0,100\r\n"
    "4,Decathlon,,,,0,,ABC123,9999,,-12345,0,,1,100\r\n"
    "5,,missing store,,,0,,123,,CODE_128,-1,0,,0,100\r\n"
    "\r\n"
    "cardId,groupId\r\n"
    "1,Spesa\r\n"
)


def zip_bytes(text, name="catima.csv"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, text)
    return buf.getvalue()


def b64(data):
    return base64.b64encode(data).decode()


def test_parse_catima_zip():
    rows, errors = parse_catima(zip_bytes(CATIMA_CSV), ROME)
    assert len(rows) == 4
    assert len(errors) == 1 and "row" in errors[0]
    esselunga, amazon, coop, decathlon = rows
    assert esselunga["name"] == "Esselunga"
    assert esselunga["code"] == "0412345678901"
    assert esselunga["notes"] == "Fidaty, carta\r\ndi Alice"
    assert esselunga["favorite"] is True
    assert esselunga["color"] == f"#{-16753883 & 0xFFFFFF:06X}"
    assert "points" not in esselunga
    assert amazon["kind"] == "voucher"
    assert amazon["initial_balance"] == 25.5
    assert amazon["currency"] == "EUR"
    assert amazon["expiry"] == "2026-12-31"
    assert amazon["barcode_format"] == "QR_CODE"
    assert amazon["color"] == "#FF0000"
    assert coop["points"] == 120 and coop["barcode_format"] == "EAN_13"
    assert coop["color"] == "#FFFFFF"
    # barcodeid overrides cardid; empty barcodetype -> default format
    assert decathlon["code"] == "9999" and "barcode_format" not in decathlon


def test_parse_catima_raw_csv_and_bad_input():
    rows, _ = parse_catima(CATIMA_CSV.encode(), ROME)
    assert len(rows) == 4
    with pytest.raises(LoyaltyError):
        parse_catima(b"name,code\nx,y\n")
    with pytest.raises(LoyaltyError):
        parse_catima(zip_bytes("x", name="other.txt"))


def test_import_payload_catima():
    res = import_payload("catima", b64(zip_bytes(CATIMA_CSV)), "u1", now=NOW, tz=ROME)
    assert res.imported == 4
    assert res.skipped == 1
    assert all(c.owner_id == "u1" and c.visibility == "private" for c in res.cards)
    resp = res.to_response()
    assert resp["imported"] == 4 and resp["skipped"] == 1 and len(resp["errors"]) == 1
    # re-import: duplicates skipped
    again = import_payload("catima", b64(zip_bytes(CATIMA_CSV)), "u1", existing=res.cards, now=NOW, tz=ROME)
    assert again.imported == 0 and again.skipped == 5


def test_catima_export_roundtrip():
    c1 = create_card(
        {"name": "Esselunga", "code": "0412345678901", "color": "#00A825", "favorite": True,
         "notes": "linea1\nlinea2, con virgola", "points": 340},
        "u1", NOW,
    )
    v = create_card(
        {"name": "Buono", "code": "GIFT-1", "kind": "voucher", "initial_balance": 50,
         "currency": "EUR", "expiry": "2026-12-31", "barcode_format": "QR_CODE"},
        "u1", NOW,
    )
    add_transaction(v, 20, "u1", now=NOW)
    out = export_payload("catima", [c1, v], now=NOW, tz=ROME)
    assert out["mime"] == "application/zip" and out["filename"].endswith(".zip")
    raw = base64.b64decode(out["data_base64"])
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        text = zf.read("catima.csv").decode()
    lines = text.split("\r\n")
    assert lines[0] == "2" and lines[1] == "" and lines[2] == "_id"
    assert "cardId,groupId" in text
    res = import_payload("catima", out["data_base64"], "u2", now=NOW, tz=ROME)
    assert res.errors == []
    by_name = {c.name: c for c in res.cards}
    e = by_name["Esselunga"]
    assert (e.code, e.color, e.favorite, e.points, e.notes) == (
        "0412345678901", "#00A825", True, 340, "linea1\nlinea2, con virgola")
    b = by_name["Buono"]
    assert (b.kind, b.initial_balance, b.currency, b.expiry, b.barcode_format) == (
        "voucher", 30.0, "EUR", "2026-12-31", "QR_CODE")


def test_csv_semicolon_italian_headers():
    data = (
        "﻿Nome;Codice;Formato;Colore;Note;Punti;Scadenza;Tipo;Saldo iniziale;Valuta\r\n"
        "Conad;8001234567890;ean13;ff0000;carta famiglia;1.250;;tessera;;\r\n"
        "Buono Zara;ZARA-1;qr;#00ff00;;;31/12/2026;buono;25,50;eur\r\n"
        ";senza nome;;;;;;;;\r\n"
        "Rotto;X;;;;;99/99/2026;;;\r\n"
    ).encode("utf-8")
    rows, errors = parse_csv(data)
    assert len(rows) == 3 and len(errors) == 1
    conad, zara, _ = rows
    assert conad == {"name": "Conad", "code": "8001234567890", "barcode_format": "ean13",
                     "color": "#ff0000", "notes": "carta famiglia", "points": 1250, "kind": "card"}
    assert zara["expiry"] == "2026-12-31" and zara["initial_balance"] == 25.5
    assert zara["kind"] == "voucher" and zara["currency"] == "EUR"
    res = import_payload("csv", b64(data), "u1", now=NOW)
    assert res.imported == 2 and res.skipped == 2
    assert res.cards[0].barcode_format == "EAN_13" and res.cards[0].color == "#FF0000"


def test_csv_invalid_code_falls_back_to_code128():
    data = b"name,code,barcode_format\nShop,123,EAN_13\n"
    res = import_payload("csv", b64(data), "u1", now=NOW)
    assert res.imported == 1 and res.cards[0].barcode_format == "CODE_128"


def test_csv_export_roundtrip():
    c = create_card({"name": "Coop", "code": "123", "points": 5, "notes": "a;b,c"}, "u1", NOW)
    v = create_card({"name": "Gift", "code": "G1", "kind": "voucher", "initial_balance": 10,
                     "expiry": "2027-01-01"}, "u1", NOW)
    out = export_payload("csv", [c, v], now=NOW)
    raw = base64.b64decode(out["data_base64"]).decode()
    assert raw.splitlines()[0] == ",".join(CSV_COLUMNS)
    res = import_payload("csv", out["data_base64"], "u2", now=NOW)
    assert res.imported == 2 and res.errors == []
    names = {x.name: x for x in res.cards}
    assert names["Coop"].notes == "a;b,c" and names["Coop"].points == 5
    assert names["Gift"].initial_balance == 10 and names["Gift"].kind == "voucher"


def test_csv_missing_columns_and_limits():
    with pytest.raises(LoyaltyError):
        import_payload("csv", b64(b"foo,bar\n1,2\n"), "u1")
    with pytest.raises(LoyaltyError):
        import_payload("csv", "!!!notbase64", "u1")
    with pytest.raises(LoyaltyError):
        import_payload("xml", b64(b"x"), "u1")
    big = "name,code\n" + "".join(f"S{i},{i}\n" for i in range(1005))
    res = import_payload("csv", b64(big.encode()), "u1", now=NOW)
    assert res.imported == 1000 and res.skipped == 5
