"""v0.4.1 (ARCHITETTURA §12): compact Store format and trash rules."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from core.errors import ERR_LIMIT_REACHED, ERR_NOT_FOUND, ERR_UNAUTHORIZED, LoyaltyError
from core.i18n import Translator, load_catalogs
from core.models import (
    USAGE_LEN,
    Card,
    Transaction,
    UserPrefs,
    add_transaction,
    adjust_balance,
    create_card,
    mark_used,
    set_logo,
)
from core.permissions import Actor
from core import trash as tr
from core.trash import (
    MAX_REJECTIONS,
    MAX_SENDS,
    PURGE_DELAY,
    TRASH_RETENTION,
    TrashEntry,
)

NOW = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)
ALICE = Actor("alice")
BOB_ADMIN = Actor("bob", is_admin=True)
CAROL_ADMIN = Actor("carol", is_admin=True)
DAVE = Actor("dave")
NAMES = {"alice": "Alice", "bob": "Bob", "carol": "Carol"}
I18N_DIR = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub" / "i18n"


def _card(**extra) -> Card:
    data = {"name": "Super Shop", "code": "123456"}
    data.update(extra)
    return create_card(data, "alice", NOW, id_factory=lambda: "c1")


def _voucher() -> Card:
    card = create_card(
        {"name": "Gift", "code": "999", "kind": "voucher", "initial_balance": 50},
        "alice",
        NOW,
        id_factory=lambda: "v1",
    )
    add_transaction(card, 10, "alice", now=NOW, id_factory=lambda: "t1")
    adjust_balance(card, 45, "fix", "bob", now=NOW, id_factory=lambda: "t2")
    return card


# ---------------------------------------------------------------- §12.1 compact storage


def test_card_to_storage_minimal():
    stored = _card().to_storage()
    assert set(stored) == {
        "id",
        "owner_id",
        "name",
        "code",
        "kind",
        "barcode_format",
        "color",
        "visibility",
        "created_at",
        "updated_at",
        "currency",  # §14.3: always saved
    }
    assert "balance" not in stored and "usage" not in stored


def test_card_to_storage_keeps_non_defaults_and_round_trips():
    card = _card(notes="hi", favorite=True, zones=["zone.shop"], points=0, expiry="2027-01-01")
    card.locations = [{"id": "l1", "lat": 45.1, "lon": 9.2}]
    stored = card.to_storage()
    assert stored["notes"] == "hi" and stored["favorite"] is True
    assert stored["points"] == 0  # 0 differs from the default None
    assert stored["zones"] == ["zone.shop"]
    assert Card.from_dict(stored).to_dict() == card.to_dict()


def test_to_dict_api_format_unchanged():
    out = _card().to_dict()
    assert out["usage"] == [0] * USAGE_LEN
    assert out["balance"] is None
    assert out["transactions"] == [] and out["notes"] == ""


def test_usage_sparse_round_trip():
    card = _card()
    mark_used(card, NOW, NOW)  # Sunday 10:00 -> slot 6*6 + 2
    stored = card.to_storage()
    assert stored["usage"] == {"38": 1}
    assert stored["use_count"] == 1 and stored["last_used"]
    loaded = Card.from_dict(stored)
    assert loaded.usage[38] == 1 and sum(loaded.usage) == 1


def test_usage_accepts_list_and_dict():
    base = _card().to_storage()
    as_list = [0] * USAGE_LEN
    as_list[3] = 4
    assert Card.from_dict({**base, "usage": as_list}).usage[3] == 4
    loaded = Card.from_dict(
        {**base, "usage": {"3": 4, "41": 1, "42": 9, "-1": 2, "x": 1, "5": -1, "6": True, "07": 3}}
    )
    expected = [0] * USAGE_LEN
    expected[3], expected[41] = 4, 1
    assert loaded.usage == expected
    assert Card.from_dict({**base, "usage": [1, 2]}).usage == [0] * USAGE_LEN


def test_old_full_format_loads_and_compacts():
    card = _voucher()
    set_logo(card, "upload", "image/png", NOW)
    old = card.to_dict()  # v0.4 stored the API format
    old["logo"]["checked_at"] = "2026-01-01T00:00:00+00:00"
    loaded = Card.from_dict(old)
    stored = loaded.to_storage()
    # §14.2: checked_at is the cache bookkeeping again, so it is kept.
    assert stored["logo"]["checked_at"] == "2026-01-01T00:00:00+00:00"
    assert "balance" not in stored
    assert Card.from_dict(stored).balance == card.balance == 45.0
    assert Card.from_dict(stored).transactions == card.transactions


def test_transaction_to_storage():
    spend = Transaction(id="t", date="2026-11-15T10:00:00+00:00", amount=5.0)
    assert spend.to_storage() == {"id": "t", "date": spend.date, "amount": 5.0}
    topup = Transaction(id="u", date=spend.date, amount=2.0, note="n", user_id="bob", type="topup")
    stored = topup.to_storage()
    assert stored["type"] == "topup" and stored["note"] == "n" and stored["user_id"] == "bob"
    assert Transaction.from_dict(stored) == topup
    assert Transaction.from_dict(spend.to_storage()) == spend


def test_prefs_to_storage():
    assert UserPrefs(user_id="alice").to_storage() == {}
    prefs = UserPrefs(user_id="alice", notify_service="mobile_app_x", nearby=False,
                      price_compare_sites=[], admin_notice_accepted=2)
    stored = prefs.to_storage()
    assert "user_id" not in stored
    assert stored == {
        "notify_service": "mobile_app_x",
        "nearby": False,
        "price_compare_sites": [],
        "admin_notice_accepted": 2,
    }
    assert UserPrefs.from_dict({**stored, "user_id": "alice"}) == prefs


# ---------------------------------------------------------------- §12.2 trash


def _trashed(now=NOW):
    cards = {"c1": _card(notes="secret note")}
    trash: dict[str, TrashEntry] = {}
    entry = tr.move_to_trash(cards, trash, "c1", "alice", now)
    return cards, trash, entry


def _code(exc_info) -> str:
    return exc_info.value.code


def test_move_and_restore():
    cards, trash, entry = _trashed()
    assert cards == {} and trash["c1"] is entry
    assert entry.deleted_at == NOW.isoformat() and entry.deleted_by == "alice"
    later = NOW + timedelta(days=1)
    tr.request_purge(entry, later)
    card = tr.restore(cards, trash, "c1", later)
    assert trash == {} and cards["c1"] is card and card.updated_at == later.isoformat()


def test_entry_storage_round_trip():
    _, trash, entry = _trashed()
    tr.send_request(entry, BOB_ADMIN, NOW, token_factory=lambda: "Zq9secretXy", id_factory=lambda: "r1")
    stored = entry.to_storage()
    assert "Zq9secretXy" not in str(stored)
    assert stored["request"]["token_hash"] == tr.hash_token("Zq9secretXy")
    assert TrashEntry.from_dict(stored) == entry


def test_visibility_and_owner_only():
    _, trash, entry = _trashed()
    assert tr.get_entry(trash, "c1", ALICE) is entry
    assert tr.get_entry(trash, "c1", BOB_ADMIN) is entry
    with pytest.raises(LoyaltyError) as e:
        tr.get_entry(trash, "c1", DAVE)
    assert _code(e) == ERR_NOT_FOUND
    with pytest.raises(LoyaltyError) as e:
        tr.get_entry(trash, "nope", ALICE)
    assert _code(e) == ERR_NOT_FOUND
    with pytest.raises(LoyaltyError) as e:
        tr.get_own_entry(trash, "c1", BOB_ADMIN)
    assert _code(e) == ERR_UNAUTHORIZED
    assert tr.visible_entries(trash, DAVE) == []
    assert tr.visible_entries(trash, BOB_ADMIN) == [entry]
    assert tr.own_entries(trash, BOB_ADMIN) == []


def test_retention_and_purge_due():
    _, trash, entry = _trashed()
    assert not tr.is_due(entry, NOW + TRASH_RETENTION - timedelta(seconds=1))
    assert tr.is_due(entry, NOW + TRASH_RETENTION)
    later = NOW + timedelta(days=2)
    assert tr.request_purge(entry, later)
    assert entry.purge_at == (later + PURGE_DELAY).isoformat()
    assert not tr.request_purge(entry, later + timedelta(minutes=5))  # countdown kept
    assert tr.due_ids(trash, later + PURGE_DELAY - timedelta(seconds=1)) == []
    assert tr.due_ids(trash, later + PURGE_DELAY) == ["c1"]
    assert tr.cancel_purge(entry) and entry.purge_at is None
    assert not tr.cancel_purge(entry)
    assert tr.due_ids(trash, later + PURGE_DELAY) == []


def test_notify_log_keys():
    log = {"alice:c1": "x", "exp:alice:c1:2027-01-01": "y", "alice:c2": "z", "exp:bob:c11:d": "w"}
    assert sorted(tr.notify_log_keys(log, "c1")) == ["alice:c1", "exp:alice:c1:2027-01-01"]


def test_request_rules_and_token():
    _, trash, entry = _trashed()
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, ALICE, NOW)  # owner
    assert _code(e) == ERR_UNAUTHORIZED
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, DAVE, NOW)  # not an admin
    assert _code(e) == ERR_UNAUTHORIZED
    token = tr.send_request(entry, BOB_ADMIN, NOW, id_factory=lambda: "r1")
    assert len(token) >= 32
    req = entry.request
    assert req.id == "r1" and req.status == "pending" and req.sends == 1
    assert req.token_hash == tr.hash_token(token) and req.created_at == NOW.isoformat()
    assert tr.find_by_token(trash, token) is entry
    assert tr.find_by_token(trash, "wrong") is None
    assert tr.find_by_token(trash, "") is None
    # Another admin cannot take over a pending request.
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, CAROL_ADMIN, NOW)
    assert _code(e) == ERR_UNAUTHORIZED
    # Re-sending invalidates the previous token, same request id.
    later = NOW + timedelta(minutes=1)
    token2 = tr.send_request(entry, BOB_ADMIN, later)
    assert token2 != token and req.id == "r1" and req.sends == 2
    assert req.last_sent_at == later.isoformat()
    assert tr.find_by_token(trash, token) is None
    assert tr.find_by_token(trash, token2) is entry


def test_request_refused_during_purge():
    _, _, entry = _trashed()
    tr.request_purge(entry, NOW)
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert _code(e) == ERR_UNAUTHORIZED


def test_max_sends():
    _, _, entry = _trashed()
    for _ in range(MAX_SENDS):
        tr.send_request(entry, BOB_ADMIN, NOW)
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert _code(e) == ERR_LIMIT_REACHED
    assert entry.request.sends == MAX_SENDS


def test_sends_count_across_rejections():
    _, _, entry = _trashed()
    for _ in range(MAX_SENDS - 1):
        tr.send_request(entry, BOB_ADMIN, NOW)
    tr.respond(entry, "reject")
    tr.send_request(entry, CAROL_ADMIN, NOW)  # a rejected request can be resumed by anyone
    assert entry.request.admin_id == "carol" and entry.request.sends == MAX_SENDS
    tr.respond(entry, "reject")
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert _code(e) == ERR_LIMIT_REACHED


def test_three_rejections_block():
    _, trash, entry = _trashed()
    for i in range(MAX_REJECTIONS):
        token = tr.send_request(entry, BOB_ADMIN, NOW)
        assert tr.respond(entry, "reject") is False
        assert entry.request.status == "rejected" and entry.request.token_hash is None
        assert tr.find_by_token(trash, token) is None
        assert entry.rejections == i + 1
    assert entry.blocked
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert _code(e) == ERR_LIMIT_REACHED


def test_ignored_requests_do_not_count():
    _, _, entry = _trashed()
    for _ in range(5):
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert entry.rejections == 0 and not entry.blocked


def test_block_immediately_and_after_reject():
    _, _, entry = _trashed()
    tr.send_request(entry, BOB_ADMIN, NOW)
    tr.respond(entry, "block")
    assert entry.blocked and entry.rejections == 1 and entry.request.status == "rejected"
    with pytest.raises(LoyaltyError) as e:
        tr.send_request(entry, BOB_ADMIN, NOW)
    assert _code(e) == ERR_LIMIT_REACHED

    _, _, other = _trashed()
    tr.send_request(other, BOB_ADMIN, NOW)
    tr.respond(other, "reject")
    tr.respond(other, "block")  # allowed on a rejected request, not counted twice
    assert other.blocked and other.rejections == 1


def test_respond_without_suitable_request():
    _, _, entry = _trashed()
    for response in ("accept", "reject", "block"):
        with pytest.raises(LoyaltyError) as e:
            tr.respond(entry, response)
        assert _code(e) == ERR_NOT_FOUND
    tr.send_request(entry, BOB_ADMIN, NOW)
    tr.respond(entry, "reject")
    for response in ("accept", "reject"):
        with pytest.raises(LoyaltyError) as e:
            tr.respond(entry, response)
        assert _code(e) == ERR_NOT_FOUND


def test_accept_returns_true():
    cards, trash, entry = _trashed()
    tr.send_request(entry, BOB_ADMIN, NOW)
    assert tr.respond(entry, "accept") is True
    tr.restore(cards, trash, "c1", NOW)
    assert "c1" in cards and trash == {}


def test_parse_action():
    assert tr.parse_action("LOYALTY_HUB_TRASH_ACCEPT_abc") == ("accept", "abc")
    assert tr.parse_action("LOYALTY_HUB_TRASH_REJECT_x-y_z") == ("reject", "x-y_z")
    assert tr.parse_action("LOYALTY_HUB_TRASH_ACCEPT_") is None
    assert tr.parse_action("URI") is None
    assert tr.parse_action(None) is None


def test_trash_item_owner_view():
    _, _, entry = _trashed()
    set_logo(entry.card, "upload", "image/png", NOW)
    entry.card.logo_fit = "cover"
    item = tr.trash_item(entry, ALICE, NAMES)
    assert item["is_own"] and item["can_restore"] and not item["can_request"]
    assert item["owner_name"] == "Alice" and item["name"] == "Super Shop"
    assert item["logo"] == {"version": entry.card.logo["version"], "mime": "image/png"}
    assert item["logo_fit"] == "cover"
    assert item["expires_at"] == (NOW + TRASH_RETENTION).isoformat()
    assert item["request"] is None and item["purge_at"] is None


def test_trash_item_admin_view_has_no_code():
    _, _, entry = _trashed()
    set_logo(entry.card, "upload", "image/png", NOW)
    entry.card.transactions.append(Transaction(id="t", date=NOW.isoformat(), amount=1.0))
    entry.card.locations.append({"id": "l", "lat": 1.0, "lon": 2.0})
    item = tr.trash_item(entry, BOB_ADMIN, NAMES)
    assert not item["is_own"] and not item["can_restore"] and item["can_request"]
    assert item["logo"] is None and item["logo_fit"] == "contain"
    text = str(item)
    for secret in ("123456", "secret note", "transactions", "locations", "code"):
        assert secret not in text
    assert set(item) == {
        "card_id", "name", "kind", "color", "owner_id", "owner_name", "is_own",
        "deleted_at", "expires_at", "purge_at", "logo", "logo_fit", "request",
        "rejections", "blocked", "can_restore", "can_request",
    }
    tr.send_request(entry, BOB_ADMIN, NOW)
    item = tr.trash_item(entry, BOB_ADMIN, NAMES)
    assert item["request"] == {
        "status": "pending",
        "admin_name": "Bob",
        "sends": 1,
        "max_sends": MAX_SENDS,
        "last_sent_at": NOW.isoformat(),
    }
    assert item["can_request"]  # "send again"
    assert not tr.trash_item(entry, CAROL_ADMIN, NAMES)["can_request"]
    assert "token" not in str(tr.trash_item(entry, ALICE, NAMES))


def test_admin_own_entry_restores_directly():
    cards = {"b1": create_card({"name": "B", "code": "1"}, "bob", NOW, id_factory=lambda: "b1")}
    trash: dict[str, TrashEntry] = {}
    entry = tr.move_to_trash(cards, trash, "b1", "bob", NOW)
    item = tr.trash_item(entry, BOB_ADMIN, NAMES)
    assert item["is_own"] and item["can_restore"] and not item["can_request"]
    assert tr.get_own_entry(trash, "b1", BOB_ADMIN) is entry


# ---------------------------------------------------------------- §12.3 notification


@pytest.mark.parametrize("lang", ["en", "it"])
def test_request_notification(lang):
    _, _, entry = _trashed()
    t = Translator(load_catalogs(I18N_DIR), lang)
    n = tr.build_request_notification(entry, "Bob", "TOK", t)
    assert n.title == "Loyalty Hub"
    assert "Bob" in n.message and '"Super Shop"' in n.message
    assert "123456" not in str(n.service_data())
    data = n.data
    assert data["tag"] == "loyalty_hub_trash_c1" and data["group"] == "loyalty_hub"
    assert data["url"] == data["clickAction"] == "/loyalty-hub?trash=c1"
    actions = data["actions"]
    assert [a["action"] for a in actions] == [
        "LOYALTY_HUB_TRASH_ACCEPT_TOK",
        "LOYALTY_HUB_TRASH_REJECT_TOK",
        "URI",
    ]
    assert actions[2]["uri"] == "/loyalty-hub?trash=c1&block=1"
    assert all(a["title"] and not a["title"].startswith("trash.") for a in actions)


def test_request_notification_italian_text():
    _, _, entry = _trashed()
    t = Translator(load_catalogs(I18N_DIR), "it")
    n = tr.build_request_notification(entry, "Bob", "TOK", t)
    assert n.message == 'Bob chiede di recuperare "Super Shop" dal cestino'
    assert [a["title"] for a in n.data["actions"]] == [
        "Accetta",
        "Rifiuta",
        "Rifiuta e non chiedere più",
    ]


def test_clear_notification_data():
    assert tr.clear_notification_data("c1") == {
        "message": "clear_notification",
        "data": {"tag": "loyalty_hub_trash_c1"},
    }
