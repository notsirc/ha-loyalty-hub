"""v0.6.0 (ARCHITETTURA §15): provider order, groups prefs, cards for others and
transfers, inbox, admin features, points history/expiry, low balance, reminders."""

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from core import features as F
from core.card_transfer import (
    check_recipient,
    create_for_other,
    drop_keys,
    import_blocked_owners,
    stale_notify_keys,
    transfer,
)
from core.errors import (
    ERR_FEATURE_DISABLED,
    ERR_INVALID_FORMAT,
    ERR_LIMIT_REACHED,
    ERR_RECIPIENT_REFUSES,
    LoyaltyError,
)
from core.i18n import Translator, load_catalogs
from core.inbox import (
    KIND_CREATED,
    KIND_TRANSFERRED,
    MAX_INBOX,
    NOTIFY_TAG,
    add_entry,
    build_notification,
    dismiss,
    list_items,
    load_inbox,
)
from core.logo_sources import (
    AUTO_ORDER,
    PROVIDER_AUTO,
    PROVIDER_ORDER,
    PROVIDERS,
    provider_order,
)
from core.models import (
    MAX_POINTS_HISTORY,
    Card,
    UserPrefs,
    add_transaction,
    clear_points_history,
    create_card,
    default_prefs,
    filter_default_share,
    is_archived,
    record_points_history,
    update_card,
    update_prefs,
)
from core.notify_logic import (
    build_low_balance_notification,
    build_points_expiry_notification,
    build_unused_notification,
    build_zone_notification,
    hash_token,
    low_balance_decision,
    low_balance_log_key,
    parse_used_action,
    points_expiry_due,
    prune_notify_log,
    record_points_expiry_notified,
    todo_count,
    token_matches,
    unused_cooldown_ok,
    unused_log_key,
    unused_since,
    viewer_ids,
)
from core.permissions import Actor, can_edit, can_manage, can_view
from core.transfer import import_bytes

ALICE, BOB, CAROL = "a" * 32, "b" * 32, "c" * 32
NOW = datetime(2026, 11, 22, 10, 0, tzinfo=timezone.utc)
TODAY = date(2026, 11, 22)
I18N = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub" / "i18n"
CATALOGS = load_catalogs(I18N)
EN = Translator(CATALOGS, "en")
IT = Translator(CATALOGS, "it")


def _card(owner=ALICE, **kw):
    data = {"name": "Conad", "code": "123", **kw}
    return create_card(data, owner, NOW)


def _err_code(fn, *args, **kw):
    with pytest.raises(LoyaltyError) as exc:
        fn(*args, **kw)
    return exc.value.code


# ---------------------------------------------------------------- 15.1 provider order


def test_single_provider_order():
    assert PROVIDER_ORDER == ("logo_dev", "website", "logoapi")
    assert PROVIDERS == PROVIDER_ORDER and AUTO_ORDER == PROVIDER_ORDER
    assert provider_order(PROVIDER_AUTO, ["logoapi", "logo_dev"]) == ["logo_dev", "logoapi"]


def test_logos_module_has_no_import_order():
    src = (I18N.parent / "logos.py").read_text(encoding="utf-8")
    assert "IMPORT_PROVIDER_ORDER" not in src


def test_config_texts_explain_logo_dev():
    for name, marker in (("strings.json", "Why Logo.dev"), ("translations/en.json", "Why Logo.dev"),
                         ("translations/it.json", "Perché Logo.dev")):
        data = json.loads((I18N.parent / name).read_text(encoding="utf-8"))
        for step in (data["config"]["step"]["user"], data["options"]["step"]["init"]):
            desc = step["description"]
            assert marker in desc
            assert desc.index(marker) < desc.index("1. ")


# ---------------------------------------------------------------- 15.3 short_name, prefs


def test_short_name_and_new_fields():
    card = _card(short_name="  Mia  ")
    assert card.short_name == "Mia"
    assert _err_code(_card, short_name="x" * 21) == ERR_INVALID_FORMAT
    update_card(card, {"short_name": None}, NOW)
    assert card.short_name == ""
    # server-only fields are refused from the client
    for key in ("created_by", "transferred_by", "transferred_at", "points_history"):
        assert _err_code(update_card, card, {key: None}, NOW) == ERR_INVALID_FORMAT


def test_new_fields_storage_and_roundtrip():
    card = _card()
    stored = card.to_storage()
    for key in ("short_name", "todo_entity", "points_expiry", "created_by",
                "transferred_by", "transferred_at", "points_history"):
        assert key not in stored
    card.short_name = "Bob"
    card.created_by = BOB
    card.points_history = [{"date": "2026-11-01", "points": 10}]
    update_card(card, {"todo_entity": "todo.spesa", "points_expiry": "2026-12-01"}, NOW)
    again = Card.from_dict(card.to_storage())
    assert again.to_dict() == card.to_dict()
    out = card.to_dict()
    assert out["points_history"] == [{"date": "2026-11-01", "points": 10}]


def test_todo_entity_shape():
    card = _card()
    for bad in ("sensor.x", "todo.", "todo.Bad Name", 5):
        assert _err_code(update_card, card, {"todo_entity": bad}, NOW) == ERR_INVALID_FORMAT
    update_card(card, {"todo_entity": ""}, NOW)
    assert card.todo_entity is None
    assert _err_code(update_card, card, {"points_expiry": "2026-13-01"}, NOW) == ERR_INVALID_FORMAT


def test_group_prefs_validation():
    p = default_prefs(ALICE)
    update_prefs(p, {
        "grouping": False,
        "group_split": ["c1", "c1", "c2"],
        "group_links": [["c1", "c2"], ["c2", "c1"], ["c3", "c4"]],
        "group_tabs": {"d:conad.it": {"mode": "manual", "order": ["c1", "c2"]}, "n:coop": {}},
    })
    assert p.grouping is False
    assert p.group_split == ["c1", "c2"]
    assert p.group_links == [["c1", "c2"], ["c3", "c4"]]
    assert p.group_tabs == {
        "d:conad.it": {"mode": "manual", "order": ["c1", "c2"]},
        "n:coop": {"mode": "auto", "order": []},
    }
    bad_values = [
        {"group_split": ["x" * 65]},
        {"group_split": ["a"] * 501},
        {"group_split": "c1"},
        {"group_links": [["c1"]]},
        {"group_links": [["c1", "c1"]]},
        {"group_links": [["a", "b"]] * 501},
        {"group_tabs": {"k": {"mode": "other"}}},
        {"group_tabs": {"k": {"order": ["a"] * 51}}},
        {"group_tabs": {"k": {"mode": "auto", "extra": 1}}},
        {"group_tabs": {f"k{i}": {} for i in range(201)}},
        {"grouping": "yes"},
    ]
    for bad in bad_values:
        assert _err_code(update_prefs, default_prefs(ALICE), bad) == ERR_INVALID_FORMAT


def test_other_prefs_validation():
    p = default_prefs(ALICE)
    update_prefs(p, {
        "refuse_from_others": True,
        "inbox_notifications": False,
        "features_off": ["nfc", "nfc", "find_by_code"],
        "default_share": {"visibility": "shared", "shared_with": [BOB, "*"]},
        "list_order": "manual",
        "manual_order": ["c2", "c1"],
        "low_balance_threshold": 5.504,
        "cashier_high_contrast": True,
    })
    assert p.refuse_from_others and not p.inbox_notifications and p.cashier_high_contrast
    assert p.features_off == ["nfc", "find_by_code"]
    assert p.default_share == {"visibility": "shared", "shared_with": [BOB, "*"]}
    assert p.list_order == "manual" and p.manual_order == ["c2", "c1"]
    assert p.low_balance_threshold == 5.5
    update_prefs(p, {"default_share": None, "low_balance_threshold": None})
    assert p.default_share is None and p.low_balance_threshold is None
    for bad in (
        {"features_off": ["low_balance"]},  # not a per-user feature
        {"features_off": ["nope"]},
        {"default_share": {"visibility": "public"}},
        {"default_share": {"visibility": "shared", "extra": 1}},
        {"list_order": "alpha"},
        {"manual_order": ["a"] * 2001},
        {"low_balance_threshold": -1},
        {"low_balance_threshold": True},
        {"nfc_tags": {}},  # server-only
    ):
        assert _err_code(update_prefs, default_prefs(ALICE), bad) == ERR_INVALID_FORMAT


def test_prefs_storage_api_and_lenient_load():
    p = default_prefs(ALICE)
    assert p.to_storage() == {}
    p.nfc_tags = {"tag-1": "c1"}
    update_prefs(p, {"grouping": False, "list_order": "manual"})
    assert p.to_storage() == {"grouping": False, "list_order": "manual", "nfc_tags": {"tag-1": "c1"}}
    assert "nfc_tags" not in p.to_api()
    assert UserPrefs.from_dict({**p.to_storage(), "user_id": ALICE}) == p
    broken = UserPrefs.from_dict({
        "user_id": ALICE, "group_split": "x", "group_tabs": [], "default_share": 3,
        "low_balance_threshold": -2, "list_order": "x", "features_off": ["nfc", "bad"],
        "nfc_tags": {"t": 5, "u": "c"},
    })
    assert broken.group_split == [] and broken.group_tabs == {} and broken.default_share is None
    assert broken.low_balance_threshold is None and broken.list_order == "habits"
    assert broken.features_off == ["nfc"] and broken.nfc_tags == {"u": "c"}


def test_filter_default_share():
    share = {"visibility": "shared", "shared_with": [BOB, "*", "gone"]}
    assert filter_default_share(share, [ALICE, BOB]) == {
        "visibility": "shared", "shared_with": [BOB, "*"]}
    assert filter_default_share(None, [ALICE]) is None


# ---------------------------------------------------------------- 15.4 cards for others


def test_check_recipient():
    active = [ALICE, BOB]
    assert check_recipient(BOB, active, default_prefs(BOB)) == BOB
    assert _err_code(check_recipient, CAROL, active, None) == ERR_INVALID_FORMAT
    refusing = default_prefs(BOB)
    refusing.refuse_from_others = True
    with pytest.raises(LoyaltyError) as exc:
        check_recipient(BOB, active, refusing, "Bob")
    assert exc.value.code == ERR_RECIPIENT_REFUSES and "Bob" in exc.value.message


def test_import_blocked_owners():
    """Admin import: like for_user_id, only active non-system users who accept cards."""
    dave, system = "d" * 32, "e" * 32
    users = [
        (ALICE, True, False),  # the importing admin: never blocked
        (BOB, True, False),
        (CAROL, False, False),  # inactive
        (system, True, True),  # system user
        (dave, True, False),  # refuses cards from others
    ]
    blocked = import_blocked_owners(users, ALICE, lambda uid: uid == dave)
    assert blocked == {CAROL, system, dave}


def test_create_for_other():
    card = create_for_other({"name": "Coop", "code": "9"}, ALICE, BOB, True, NOW)
    assert card.owner_id == BOB and card.created_by == ALICE
    assert card.visibility == "shared" and card.shared_with == [ALICE]
    assert can_view(card, Actor(ALICE))
    # the creator never gets can_edit / can_manage on someone else's card
    assert not can_edit(card, Actor(ALICE)) and not can_manage(card, Actor(ALICE))
    private = create_for_other({"name": "Coop", "code": "9"}, ALICE, BOB, False, NOW)
    assert private.visibility == "private" and private.shared_with == []
    assert not can_view(private, Actor(ALICE))
    for bad in ({"name": "x", "code": "1", "visibility": "private"},
                {"name": "x", "code": "1", "shared_with": [CAROL]}):
        assert _err_code(create_for_other, bad, ALICE, BOB) == ERR_INVALID_FORMAT


def test_transfer_private_keep_shared():
    card = _card(owner=ALICE)
    card.created_by = BOB
    transfer(card, ALICE, BOB, True, NOW)
    assert card.owner_id == BOB and card.transferred_by == ALICE
    assert card.transferred_at == "2026-11-22T10:00:00+00:00"
    assert card.visibility == "shared" and card.shared_with == [ALICE]
    assert card.created_by is None  # the creator is now the owner


def test_transfer_shared_variants():
    card = _card(owner=ALICE, visibility="shared", shared_with=[BOB, CAROL])
    transfer(card, ALICE, BOB, True, NOW)
    assert card.shared_with == [CAROL, ALICE]
    everyone = _card(owner=ALICE, visibility="shared", shared_with=["*"])
    transfer(everyone, ALICE, BOB, True, NOW)
    assert everyone.shared_with == ["*"]
    dropped = _card(owner=ALICE, visibility="shared", shared_with=[BOB])
    transfer(dropped, ALICE, BOB, False, NOW)
    assert dropped.visibility == "private" and dropped.shared_with == []
    assert _err_code(transfer, dropped, BOB, BOB) == ERR_INVALID_FORMAT


def test_transfer_keeps_data_and_stale_keys():
    card = _card(owner=ALICE, kind="voucher", initial_balance=20, zones=["zone.conad"])
    add_transaction(card, 5, ALICE, now=NOW)
    card.usage[3] = 2
    log = {f"{ALICE}:{card.id}": "x", f"exp:{ALICE}:{card.id}:2026-12-01": "x",
           f"low:{ALICE}:{card.id}": "x", f"{BOB}:{card.id}": "x", f"{ALICE}:other": "x"}
    transfer(card, ALICE, BOB, False, NOW)
    assert card.balance == 15 and card.usage[3] == 2 and card.zones == ["zone.conad"]
    keys = stale_notify_keys(log, ALICE, card)
    assert sorted(keys) == sorted([f"{ALICE}:{card.id}", f"exp:{ALICE}:{card.id}:2026-12-01",
                                   f"low:{ALICE}:{card.id}"])
    drop_keys(log, keys)
    assert set(log) == {f"{BOB}:{card.id}", f"{ALICE}:other"}
    shared = _card(owner=ALICE)
    transfer(shared, ALICE, BOB, True, NOW)
    assert stale_notify_keys({f"{ALICE}:{shared.id}": "x"}, ALICE, shared) == []


def test_admin_import_created_by_and_refused():
    items = [
        {"item_id": "1", "name": "Mine", "code": "1", "user_id": CAROL, "item_type": "loyalty"},
        {"item_id": "2", "name": "Alice card", "code": "2", "user_id": ALICE, "item_type": "loyalty"},
        {"item_id": "3", "name": "Bob card", "code": "3", "user_id": BOB, "item_type": "loyalty"},
    ]
    raw = json.dumps({"items": items}).encode()
    res = import_bytes("wallet_assistant", raw, CAROL, now=NOW, known_user_ids={ALICE, BOB, CAROL},
                       importer_is_admin=True, refusing_user_ids={BOB})
    by_name = {c.name: c for c in res.cards}
    assert set(by_name) == {"Mine", "Alice card"}
    assert by_name["Alice card"].created_by == CAROL and by_name["Mine"].created_by is None
    resp = res.to_response()
    assert resp["skipped_refused"] == 1 and resp["imported_for_others"] == 1
    plain = import_bytes("wallet_assistant", raw, CAROL, now=NOW, known_user_ids={ALICE, BOB, CAROL})
    assert "skipped_refused" not in plain.to_response()


# ---------------------------------------------------------------- 15.4 inbox


def test_inbox_add_list_dismiss():
    inbox = {}
    a = _card(owner=BOB, name="Conad")
    b = _card(owner=BOB, name="Coop")
    gone = _card(owner=CAROL, name="Gone")  # no longer Bob's
    cards = {c.id: c for c in (a, b, gone)}
    add_entry(inbox, BOB, a.id, ALICE, "t1", KIND_CREATED)
    add_entry(inbox, BOB, b.id, ALICE, "t2", KIND_TRANSFERRED)
    add_entry(inbox, BOB, gone.id, ALICE, "t3", KIND_CREATED)
    add_entry(inbox, BOB, a.id, ALICE, "t4", KIND_CREATED)  # same card: replaced
    items, changed = list_items(inbox, BOB, cards, {ALICE: "Alice"})
    assert changed
    assert [(i["card_name"], i["by_name"], i["kind"], i["at"]) for i in items] == [
        ("Coop", "Alice", "transferred", "t2"), ("Conad", "Alice", "created", "t4")]
    assert list_items(inbox, ALICE, cards, {})[0] == []
    assert dismiss(inbox, BOB) and BOB not in inbox and not dismiss(inbox, BOB)


def test_inbox_limit_and_load():
    inbox = {}
    for i in range(MAX_INBOX + 5):
        add_entry(inbox, BOB, f"c{i}", ALICE, "t", KIND_CREATED)
    assert len(inbox[BOB]) == MAX_INBOX and inbox[BOB][0]["card_id"] == "c5"
    loaded = load_inbox({BOB: [{"card_id": "c", "by": ALICE, "at": "t", "kind": "created"},
                               {"card_id": "d", "by": ALICE, "at": "t", "kind": "other"}, 5],
                         CAROL: "x"})
    assert loaded == {BOB: [{"card_id": "c", "by": ALICE, "at": "t", "kind": "created"}]}


def test_inbox_notification():
    entries = [
        {"card_id": "1", "by": ALICE, "at": "t", "kind": "created"},
        {"card_id": "2", "by": ALICE, "at": "t", "kind": "created"},
        {"card_id": "3", "by": ALICE, "at": "t", "kind": "created"},
        {"card_id": "4", "by": CAROL, "at": "t", "kind": "transferred"},
    ]
    n = build_notification(entries, {ALICE: "Alice", CAROL: "Carol"}, IT)
    assert n.message.split("\n") == ["Alice ha aggiunto 3 tessere per te",
                                     "Carol ti ha trasferito 1 tessera"]
    assert n.data["tag"] == NOTIFY_TAG and n.data["url"] == "/loyalty-hub"
    assert build_notification(entries[:1], {}, EN).message == "Someone added 1 card for you"
    assert build_notification([], {}, EN) is None


# ---------------------------------------------------------------- 15.5 features


def test_features_default_off_and_set():
    state = F.load_features({"nfc": True, "bogus": True, "low_balance": "yes"})
    assert state == {"nfc": True}
    full = F.all_features({})
    assert set(full) == set(F.FEATURE_IDS) and not any(full.values())
    state = F.apply_changes(state, {"low_balance": True, "nfc": False})
    assert state == {"nfc": False, "low_balance": True}
    assert _err_code(F.apply_changes, state, {"bogus": True}) == ERR_INVALID_FORMAT
    assert _err_code(F.apply_changes, state, {"nfc": 1}) == ERR_INVALID_FORMAT
    assert _err_code(F.require, state, "nfc") == ERR_FEATURE_DISABLED
    F.require(state, "low_balance")


def test_features_per_user():
    state = {"nfc": True, "low_balance": True}
    assert F.enabled_for(state, [], "nfc")
    assert not F.enabled_for(state, ["nfc"], "nfc")
    assert F.enabled_for(state, ["low_balance"], "low_balance")  # not per-user
    assert not F.enabled_for(state, [], "shopping_list")
    assert "high_contrast_cashier" in F.FEATURE_IDS
    assert F.PER_USER_FEATURES == {"nfc", "shopping_list", "unused_reminder",
                                   "points_history", "points_expiry", "find_by_code"}


def test_nfc_tags():
    tags = F.link_tag({}, "tag-1", "c1")
    tags = F.link_tag(tags, "tag-1", "c2")  # re-link replaces
    assert tags == {"tag-1": "c2"}
    full = {f"t{i}": "c" for i in range(F.MAX_NFC_TAGS)}
    assert _err_code(F.link_tag, full, "new", "c") == ERR_LIMIT_REACHED
    assert F.link_tag(full, "t0", "x")["t0"] == "x"
    assert _err_code(F.link_tag, {}, "", "c") == ERR_INVALID_FORMAT
    assert F.unlink_tag(tags, "tag-1") == {}
    assert "tag-1" not in F.redact_tag("tag-1234")


# ---------------------------------------------------------------- 15.5 points history / expiry


def test_points_history():
    card = _card(points=10)
    assert record_points_history(card, TODAY)
    card.points = 12
    record_points_history(card, TODAY)  # same day: replaced
    card.points = 15
    record_points_history(card, TODAY + timedelta(days=1))
    assert card.points_history == [{"date": "2026-11-22", "points": 12},
                                   {"date": "2026-11-23", "points": 15}]
    card.points = None
    assert not record_points_history(card, TODAY + timedelta(days=2))
    card.points = 1
    for i in range(MAX_POINTS_HISTORY + 10):
        record_points_history(card, TODAY + timedelta(days=10 + i))
    assert len(card.points_history) == MAX_POINTS_HISTORY
    clear_points_history(card, NOW)
    assert card.points_history == []


def test_points_expiry_due_and_prune():
    soon = _card(points_expiry="2026-11-25")
    later = _card(points_expiry="2027-01-01")
    past = _card(points_expiry="2026-11-01")
    log = {}
    due = points_expiry_due([soon, later, past], TODAY, 7, log)
    assert due == [soon]
    record_points_expiry_notified(log, soon, NOW)
    assert points_expiry_due([soon], TODAY, 7, log) == []
    n = build_points_expiry_notification(soon, TODAY, IT)
    assert n.message == "I punti di Conad scadono il 25/11/2026"
    log[low_balance_log_key(ALICE, "v")] = "2020-01-01T00:00:00+00:00"
    prune_notify_log(log, NOW + timedelta(days=10), TODAY + timedelta(days=10))
    # past points expiry pruned, low balance entries kept until the balance rises
    assert list(log) == [low_balance_log_key(ALICE, "v")]


# ---------------------------------------------------------------- 15.5 low balance


def test_viewer_ids():
    private = _card(owner=ALICE)
    assert viewer_ids(private, [ALICE, BOB, CAROL]) == [ALICE]
    shared = _card(owner=ALICE, visibility="shared", shared_with=[BOB])
    assert viewer_ids(shared, [ALICE, BOB, CAROL]) == [ALICE, BOB]
    everyone = _card(owner=ALICE, visibility="shared", shared_with=["*"])
    assert viewer_ids(everyone, [BOB, CAROL]) == [ALICE, BOB, CAROL]


def test_low_balance_decision():
    v = _card(kind="voucher", initial_balance=20)
    add_transaction(v, 16, ALICE, now=NOW)  # balance 4
    log = {}
    d = low_balance_decision(v, {ALICE: 5, BOB: 3, CAROL: None}, log, TODAY)
    assert d.notify == [ALICE] and d.clear == []
    log[low_balance_log_key(ALICE, v.id)] = "x"
    assert low_balance_decision(v, {ALICE: 5}, log, TODAY).notify == []  # once
    v.transactions.clear()  # balance back to 20
    d = low_balance_decision(v, {ALICE: 5}, log, TODAY)
    assert d.notify == [] and d.clear == [low_balance_log_key(ALICE, v.id)]
    add_transaction(v, 20, ALICE, now=NOW)  # balance 0: archived, never notified
    assert is_archived(v, TODAY)
    assert low_balance_decision(v, {ALICE: 5}, {}, TODAY).notify == []
    card = _card()
    assert low_balance_decision(card, {ALICE: 5}, {}, TODAY).notify == []
    reload = _card(kind="voucher", reloadable=True)
    assert low_balance_decision(reload, {ALICE: 5}, {}, TODAY).notify == []  # balance 0
    n = build_low_balance_notification(_voucher_with_balance(4.5), IT)
    assert n.message == "Saldo basso: Conad ha 4,50 EUR"


def _voucher_with_balance(balance):
    return _card(kind="voucher", initial_balance=balance)


def test_is_archived_expiry():
    assert is_archived(_card(expiry="2026-11-21"), TODAY)
    assert not is_archived(_card(expiry="2026-11-22"), TODAY)


# ---------------------------------------------------------------- 15.5 shopping list / reminder


def test_zone_notification_with_todo_lines():
    a, b = _card(name="Conad"), _card(name="Coop")
    n = build_zone_notification("zone.x", "Z", [a, b], IT, {a.id: 5, b.id: 0})
    assert n.message == "2 tessere per questo negozio\nConad: 5 cose in lista"
    assert build_zone_notification("zone.x", "Z", [a], EN, {a.id: 1}).message == (
        "Conad card ready\nConad: 1 item on the list")
    assert build_zone_notification("zone.x", "Z", [a], EN).message == "Conad card ready"
    assert todo_count("3") == 3 and todo_count("unknown") == 0 and todo_count(None) == 0


def test_unused_reminder_helpers():
    entered = NOW
    a, b = _card(name="Conad"), _card(name="Coop")
    assert unused_since([a, b], entered) == [a, b]
    b.last_used = (NOW + timedelta(minutes=3)).isoformat()
    assert unused_since([a, b], entered) == []
    log = {unused_log_key(ALICE, "zone.x"): NOW.isoformat()}
    assert not unused_cooldown_ok(log, ALICE, "zone.x", NOW + timedelta(hours=3))
    assert unused_cooldown_ok(log, ALICE, "zone.x", NOW + timedelta(hours=4))
    one = build_unused_notification("zone.conad", "Conad", [a], IT, "tok")
    assert one.message == "Hai usato la tessera Conad?"
    assert one.data["actions"] == [{"action": "LOYALTY_HUB_USED_tok", "title": "Segna come usata"}]
    assert one.data["tag"] == "loyalty_hub_unused_conad"
    assert one.data["url"] == f"/loyalty-hub?card={a.id}"
    many = build_unused_notification("zone.conad", "Conad", [a, b], EN, None)
    assert many.message == "Did you use a card at Conad?" and "actions" not in many.data
    assert parse_used_action("LOYALTY_HUB_USED_tok") == "tok"
    assert parse_used_action("LOYALTY_HUB_USED_") is None
    assert parse_used_action("LOYALTY_HUB_TRASH_ACCEPT_x") is None
    assert token_matches("tok", hash_token("tok")) and not token_matches("x", hash_token("tok"))


def test_new_i18n_keys_in_en_and_it():
    new = [k for k in CATALOGS["en"] if k.split(".")[0] in
           ("points_expiry", "low_balance", "unused", "inbox", "nfc")
           or k.startswith("zone.todo_line")]
    assert len(new) == 17
    for key in new:
        assert key in CATALOGS["it"]
