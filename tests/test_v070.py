"""v0.7.0 (ARCHITETTURA §16): personal group names."""

import pytest

from core.errors import ERR_INVALID_FORMAT, LoyaltyError
from core.models import UserPrefs, default_prefs, update_prefs

ALICE = "a" * 32


def _err_code(fn, *args):
    with pytest.raises(LoyaltyError) as exc:
        fn(*args)
    return exc.value.code


def test_group_names_validation_and_storage():
    p = default_prefs(ALICE)
    assert p.group_names == {}
    assert "group_names" not in p.to_storage()
    update_prefs(p, {"group_names": {"d:conad.it": "  Spesa  ", "n:coop": "", "c:x": "   "}})
    assert p.group_names == {"d:conad.it": "Spesa"}
    assert p.to_api()["group_names"] == {"d:conad.it": "Spesa"}
    stored = p.to_storage()
    assert stored["group_names"] == {"d:conad.it": "Spesa"}
    again = UserPrefs.from_dict({"user_id": ALICE, **stored})
    assert again.group_names == {"d:conad.it": "Spesa"}
    update_prefs(p, {"group_names": {}})
    assert p.group_names == {}


@pytest.mark.parametrize(
    "bad",
    [
        "Spesa",
        {"k": 1},
        {"k": "x" * 31},
        {"k": "a\nb"},
        {"": "Spesa"},
        {"k" * 301: "Spesa"},
        {f"k{i}": "n" for i in range(201)},
    ],
)
def test_group_names_rejected(bad):
    assert _err_code(update_prefs, default_prefs(ALICE), {"group_names": bad}) == ERR_INVALID_FORMAT


def test_group_names_lenient_on_load():
    p = UserPrefs.from_dict({"user_id": ALICE, "group_names": "broken"})
    assert p.group_names == {}
