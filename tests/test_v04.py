"""v0.4 (ARCHITETTURA §11): admin permissions and notice, WA admin import, logo limits,
balance adjustments, store locations, usage counters, balance pill fields."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from core.admin_access import RENOTICE_AFTER, default_state, load_state, transition
from core.errors import ERR_LIMIT_REACHED, LimitReachedError, LoyaltyError
from core.logos import check_logo_limits, fits_logo_limits
from core.models import (
    MAX_LOCATIONS,
    USAGE_LEN,
    Card,
    Transaction,
    UserPrefs,
    add_location,
    add_transaction,
    adjust_balance,
    compute_balance,
    create_card,
    default_prefs,
    distance_m,
    mark_used,
    remove_location,
    update_card,
    update_prefs,
    usage_slot,
)
from core.notify_logic import cards_for_zone
from core.permissions import (
    Actor,
    can_delete_transaction,
    can_edit,
    can_manage,
    can_use,
    can_view,
    is_admin_view,
)
from core.settings import sanitize_logo_max_files, sanitize_logo_max_mb
from core.transfer import import_bytes

NOW = datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc)  # a Monday
ALICE = "a" * 32  # regular user, owner
BOB = "b" * 32  # regular user
CAROL = "c" * 32  # administrator

ALICE_A = Actor(ALICE)
BOB_A = Actor(BOB)
CAROL_ADMIN = Actor(CAROL, is_admin=True)
CAROL_ALL = Actor(CAROL, is_admin=True, admin_all=True)


def _card(owner=ALICE, **kw):
    return create_card({"name": "Shop", "code": "123", **kw}, owner, NOW)


def _voucher(**kw):
    return _card(kind="voucher", **kw)


# ---------------------------------------------------------------- 11.1 admin access state


def test_transition_first_enable_and_no_change():
    s0 = default_state()
    assert transition(s0, False, NOW) == s0  # no change
    s1 = transition(s0, True, NOW)
    assert s1 == {"enabled": True, "changed_at": "2026-11-16T10:00:00+00:00", "epoch": 1}
    assert transition(s1, True, NOW + timedelta(days=3)) == s1  # restart, still on


def test_transition_eight_hour_rule():
    on = transition(default_state(), True, NOW)
    off = transition(on, False, NOW + timedelta(hours=1))
    assert off["enabled"] is False and off["epoch"] == 1
    assert off["changed_at"] == "2026-11-16T11:00:00+00:00"
    # back on before 8 h: same epoch (no new notice)
    quick = transition(off, True, NOW + timedelta(hours=1) + RENOTICE_AFTER - timedelta(seconds=1))
    assert quick["enabled"] is True and quick["epoch"] == 1
    # back on after exactly 8 h: new epoch
    late = transition(off, True, NOW + timedelta(hours=1) + RENOTICE_AFTER)
    assert late["epoch"] == 2
    # unknown changed_at with epoch > 0: safer to notify again
    assert transition({"enabled": False, "changed_at": None, "epoch": 3}, True, NOW)["epoch"] == 4


def test_admin_access_load_state_sanitizes():
    assert load_state(None) == default_state()
    assert load_state({"enabled": "yes", "epoch": -1, "changed_at": "nope"}) == default_state()
    assert load_state({"enabled": True, "epoch": 2, "changed_at": "2026-11-16T10:00:00"})[
        "changed_at"
    ] == "2026-11-16T10:00:00+00:00"


def test_admin_notice_prefs_server_only():
    p = default_prefs(ALICE)
    assert p.admin_notice_accepted is None and p.nearby is True
    with pytest.raises(LoyaltyError):
        update_prefs(p, {"admin_notice_accepted": 1})
    update_prefs(p, {"nearby": False})
    assert p.nearby is False
    with pytest.raises(LoyaltyError):
        update_prefs(p, {"nearby": "no"})
    p.admin_notice_accepted = 2
    again = UserPrefs.from_dict(p.to_dict())
    assert again == p
    old = UserPrefs.from_dict({"user_id": ALICE, "admin_notice_accepted": True})
    assert old.admin_notice_accepted is None and old.nearby is True


# ---------------------------------------------------------------- 11.1 permissions


def test_owner_permissions():
    c = _card()
    for check in (can_view, can_edit, can_manage, can_use):
        assert check(c, ALICE_A)
    assert not is_admin_view(c, ALICE_A)
    # a plain user id still works (non-admin)
    assert can_manage(c, ALICE) and not can_view(c, BOB)
    assert not can_view(c, Actor(None)) and not can_view(c, Actor(""))


def test_shared_card_permissions():
    c = _card(visibility="shared", shared_with=[BOB])
    assert can_view(c, BOB_A) and can_use(c, BOB_A)
    assert not can_edit(c, BOB_A) and not can_manage(c, BOB_A)
    assert not is_admin_view(c, BOB_A)


def test_admin_without_admin_all():
    private = _card()
    assert not can_view(private, CAROL_ADMIN)
    assert not can_edit(private, CAROL_ADMIN)
    shared = _card(visibility="shared", shared_with=[CAROL])
    assert can_view(shared, CAROL_ADMIN) and can_edit(shared, CAROL_ADMIN)
    assert not can_manage(shared, CAROL_ADMIN)
    assert not is_admin_view(shared, CAROL_ADMIN)


def test_admin_with_admin_all():
    private = _card()
    assert can_view(private, CAROL_ALL) and can_use(private, CAROL_ALL)
    assert can_edit(private, CAROL_ALL)
    assert not can_manage(private, CAROL_ALL)
    assert is_admin_view(private, CAROL_ALL)
    # normal visibility drops the override
    assert not can_view(private, CAROL_ALL.normal)
    # admin_all without is_admin grants nothing
    assert not can_view(private, Actor(BOB, is_admin=False, admin_all=True))
    # admin's own cards: can manage
    own = _card(owner=CAROL)
    assert can_manage(own, CAROL_ALL) and not is_admin_view(own, CAROL_ALL)


def test_delete_transaction_with_admin_and_adjust():
    v = _voucher(initial_balance=50, visibility="shared", shared_with=[BOB])
    tx_bob = add_transaction(v, 5, BOB, now=NOW)
    tx_alice = add_transaction(v, 5, ALICE, now=NOW)
    adj = adjust_balance(v, 10, "counted at the till", ALICE, NOW)
    assert can_delete_transaction(v, tx_bob, BOB_A)
    assert not can_delete_transaction(v, tx_alice, BOB_A)
    assert can_delete_transaction(v, tx_alice, ALICE_A)
    # adjustments: can_edit only (not the plain author/user)
    adj_bob = adjust_balance(v, 12, "fix", BOB, NOW)
    assert not can_delete_transaction(v, adj_bob, BOB_A)
    assert can_delete_transaction(v, adj, ALICE_A)
    # admin with admin_all can edit -> may delete any transaction
    assert can_delete_transaction(v, tx_bob, CAROL_ALL)
    assert can_delete_transaction(v, adj, CAROL_ALL)
    assert not can_delete_transaction(v, tx_bob, CAROL_ADMIN)  # cannot even see it


def test_notifications_ignore_admin_all():
    c = _card(zones=["zone.shop"])
    assert cards_for_zone([c], CAROL, "zone.shop") == []
    assert cards_for_zone([c], ALICE, "zone.shop") == [c]


# ---------------------------------------------------------------- 11.2 WA import by admin


def _wa(items):
    return json.dumps({"items": items}).encode()


WA_ITEMS = [
    {"item_id": "1", "name": "Mine", "code": "1", "user_id": CAROL, "item_type": "loyalty"},
    {
        "item_id": "2",
        "name": "Alice gift",
        "code": "2",
        "user_id": ALICE,
        "item_type": "voucher",
        "initial_value": 20,
        "spending": [{"id": "s", "amount": 5, "spent_on": "2026-10-01", "note": ""}],
    },
    {"item_id": "3", "name": "Bob card", "code": "3", "user_id": BOB, "item_type": "loyalty"},
    {"item_id": "4", "name": "Stranger", "code": "4", "user_id": "d" * 32},
]


def test_wa_import_by_admin_keeps_original_owner():
    known = {ALICE, BOB, CAROL}
    res = import_bytes("wallet_assistant", _wa(WA_ITEMS), CAROL, now=NOW, known_user_ids=known, importer_is_admin=True)
    assert res.imported == 4 and res.imported_for_others == 2
    assert res.skipped_other_users == 0
    by_name = {c.name: c for c in res.cards}
    for name, owner in (("Alice gift", ALICE), ("Bob card", BOB)):
        card = by_name[name]
        assert card.owner_id == owner
        assert card.visibility == "shared" and card.shared_with == [CAROL]
        assert can_view(card, Actor(owner)) and can_view(card, CAROL_ADMIN)
        assert not can_view(card, Actor(ALICE if owner == BOB else BOB))
    assert by_name["Alice gift"].balance == 15
    assert all(t.user_id == ALICE for t in by_name["Alice gift"].transactions)
    for name in ("Mine", "Stranger"):
        assert by_name[name].owner_id == CAROL and by_name[name].visibility == "private"
    resp = res.to_response()
    assert resp["imported_for_others"] == 2 and resp["imported"] == 4
    # duplicates are checked on the original owner's cards
    alice_existing = _card(owner=ALICE, name="Bob card", code="3")  # same key, other owner
    again = import_bytes(
        "wallet_assistant", _wa(WA_ITEMS), CAROL, existing=res.cards + [alice_existing],
        now=NOW, known_user_ids=known, importer_is_admin=True,
    )
    assert again.imported == 0 and again.imported_for_others == 0


def test_wa_import_non_admin_unchanged():
    res = import_bytes("wallet_assistant", _wa(WA_ITEMS), CAROL, now=NOW, known_user_ids={ALICE, BOB, CAROL})
    assert res.imported == 2 and res.skipped_other_users == 2
    assert res.imported_for_others is None
    assert "imported_for_others" not in res.to_response()
    assert all(c.owner_id == CAROL and c.visibility == "private" for c in res.cards)


# ---------------------------------------------------------------- 11.3 logo limits


def test_logo_limit_checks():
    mb = 1024 * 1024
    check_logo_limits(0, 0, 1000, 1000, 200 * mb)
    check_logo_limits(999, 0, 1000, 1000, 200 * mb)  # becomes exactly 1000
    with pytest.raises(LimitReachedError) as err:
        check_logo_limits(1000, 0, 1000, 1000, 200 * mb)
    assert err.value.code == ERR_LIMIT_REACHED == "limit_reached"
    check_logo_limits(5, 200 * mb - 10, 10, 1000, 200 * mb)
    with pytest.raises(LimitReachedError):
        check_logo_limits(5, 200 * mb - 10, 11, 1000, 200 * mb)
    assert fits_logo_limits(0, 0, 1, 1, 1) and not fits_logo_limits(1, 0, 1, 1, 10)


def test_logo_limit_options():
    assert sanitize_logo_max_files(None) == 1000
    assert sanitize_logo_max_files(0) == 1 and sanitize_logo_max_files(5000) == 2000
    assert sanitize_logo_max_files(1500.0) == 1500 and sanitize_logo_max_files(True) == 1000
    assert sanitize_logo_max_mb(None) == 200
    assert sanitize_logo_max_mb(0) == 1 and sanitize_logo_max_mb(999) == 300
    assert sanitize_logo_max_mb("50") == 50


# ---------------------------------------------------------------- 11.4 adjustments


def test_adjust_balance_and_compute():
    v = _voucher(initial_balance=50)
    add_transaction(v, 20, ALICE, now=NOW)
    tx = adjust_balance(v, 25.5, "  receipt shows 25.50 ", BOB, NOW)
    assert tx.type == "adjust" and tx.amount == -4.5 and tx.note == "receipt shows 25.50"
    assert tx.user_id == BOB and tx.date == "2026-11-16T10:00:00+00:00"
    assert v.balance == 25.5
    up = adjust_balance(v, 30, "found more", ALICE, NOW)
    assert up.amount == 4.5 and v.balance == 30
    again = Card.from_dict(v.to_dict())
    assert again.balance == 30 and again.transactions[-1].type == "adjust"


def test_adjust_balance_without_initial_balance_counts_spending():
    v = _voucher(initial_balance=None)
    add_transaction(v, 10, ALICE, now=NOW)
    assert v.balance is None
    adjust_balance(v, 50, "card says 50", ALICE, NOW)
    assert v.balance == 50


def test_adjust_balance_validation():
    v = _voucher(initial_balance=10)
    for bad_balance in (-1, True, "5", float("nan")):
        with pytest.raises(LoyaltyError):
            adjust_balance(v, bad_balance, "x", ALICE, NOW)
    for bad_reason in ("", "   ", "x" * 201, None, 3):
        with pytest.raises(LoyaltyError):
            adjust_balance(v, 5, bad_reason, ALICE, NOW)
    with pytest.raises(LoyaltyError):
        adjust_balance(v, 10, "same", ALICE, NOW)  # amount 0
    with pytest.raises(LoyaltyError):
        adjust_balance(v, 10.001, "rounds to same", ALICE, NOW)
    with pytest.raises(LoyaltyError):
        adjust_balance(_card(), 5, "not a voucher", ALICE, NOW)
    with pytest.raises(LoyaltyError):
        add_transaction(v, 5, ALICE, now=NOW, tx_type="adjust")


def test_adjust_with_null_initial_balance():
    v = _voucher()
    assert v.balance is None
    adjust_balance(v, 12, "start", ALICE, NOW)
    assert v.balance == 12
    assert compute_balance(None, [Transaction("1", "d", 3, type="adjust")]) == 3
    assert compute_balance(None, [Transaction("1", "d", 3)]) is None
    assert compute_balance(10, [Transaction("1", "d", -4, type="adjust"), Transaction("2", "d", 1)]) == 5


# ---------------------------------------------------------------- 11.5 locations


def test_add_location_merge_and_rounding():
    c = _card()
    ids = iter(f"loc{i}" for i in range(100))
    assert add_location(c, 45.4642035, 9.189982, NOW, id_factory=lambda: next(ids))
    assert c.locations == [{"id": "loc0", "lat": 45.4642, "lon": 9.18998}]
    # ~55 m north: merged (not added)
    assert not add_location(c, 45.4647, 9.18998, NOW)
    assert len(c.locations) == 1
    # ~300 m north: new point
    assert add_location(c, 45.4669, 9.18998, NOW, id_factory=lambda: next(ids))
    assert len(c.locations) == 2
    assert 90 < distance_m(45.0, 9.0, 45.0009, 9.0) < 110


def test_location_limit_range_and_remove():
    c = _card()
    for i in range(MAX_LOCATIONS):
        assert add_location(c, 10 + i * 0.01, 10, NOW)  # ~1.1 km apart
    with pytest.raises(LimitReachedError):
        add_location(c, 50, 50, NOW)
    # a point within 100 m of an existing one is still merged at the limit
    assert not add_location(c, 10, 10, NOW)
    for lat, lon in ((91, 0), (-90.1, 0), (0, 180.5), (0, -181), (True, 0), ("1", 0), (float("inf"), 0)):
        with pytest.raises(LoyaltyError):
            add_location(_card(), lat, lon, NOW)
    first = c.locations[0]["id"]
    remove_location(c, first, NOW)
    assert len(c.locations) == MAX_LOCATIONS - 1
    with pytest.raises(LoyaltyError):
        remove_location(c, first, NOW)


def test_locations_and_usage_server_only_and_compat():
    c = _card()
    for key in ("locations", "usage"):
        with pytest.raises(LoyaltyError):
            update_card(c, {key: []}, NOW)
    old = {k: v for k, v in c.to_dict().items() if k not in ("locations", "usage", "balance_corner", "balance_size")}
    loaded = Card.from_dict(old)
    assert loaded.locations == [] and loaded.usage == [0] * USAGE_LEN
    assert loaded.balance_corner == "bottom_right" and loaded.balance_size == "s"
    broken = Card.from_dict({**old, "locations": [{"id": "x"}, {"id": "y", "lat": 1, "lon": 2}], "usage": [1, 2]})
    assert broken.locations == [{"id": "y", "lat": 1.0, "lon": 2.0}]
    assert broken.usage == [0] * USAGE_LEN


# ---------------------------------------------------------------- 11.6 usage


def test_usage_slot():
    monday_early = datetime(2026, 11, 16, 3, 59)
    assert usage_slot(monday_early) == 0
    assert usage_slot(datetime(2026, 11, 16, 4, 0)) == 1
    assert usage_slot(datetime(2026, 11, 22, 23, 59)) == 41  # Sunday, last slot


def test_mark_used_usage_and_cooldown():
    c = _card()
    # local time differs from UTC: the slot uses local time
    local = datetime(2026, 11, 17, 1, 30)  # Tuesday 01:30 local
    assert mark_used(c, NOW, local)
    assert c.usage[1 * 6 + 0] == 1 and sum(c.usage) == 1
    assert c.use_count == 1 and c.last_used == "2026-11-16T10:00:00+00:00"
    # within 10 minutes: ignored, nothing changes
    assert not mark_used(c, NOW + timedelta(minutes=9, seconds=59), local)
    assert c.use_count == 1 and sum(c.usage) == 1
    assert c.last_used == "2026-11-16T10:00:00+00:00"
    # after 10 minutes: counted (no local time -> uses now)
    later = NOW + timedelta(minutes=10)
    assert mark_used(c, later)
    assert c.use_count == 2 and c.usage[usage_slot(later)] == 1
    assert Card.from_dict(c.to_dict()).usage == c.usage


# ---------------------------------------------------------------- 11.10 balance pill


def test_balance_corner_and_size():
    v = _voucher()
    assert v.balance_corner == "bottom_right" and v.balance_size == "s"
    update_card(v, {"balance_corner": "top_left", "balance_size": "off"}, NOW)
    assert v.balance_corner == "top_left" and v.balance_size == "off"
    for bad in ({"balance_corner": "top_right"}, {"balance_corner": None}, {"balance_size": "xl"}, {"balance_size": 1}):
        with pytest.raises(LoyaltyError):
            update_card(v, bad, NOW)
    created = create_card({"name": "V", "code": "1", "balance_corner": "bottom_left", "balance_size": "l"}, ALICE, NOW)
    assert created.balance_corner == "bottom_left" and created.balance_size == "l"
    assert Card.from_dict({**v.to_dict(), "balance_corner": "nope", "balance_size": "nope"}).balance_size == "s"
