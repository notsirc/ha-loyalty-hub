import json
import re
from pathlib import Path

import pytest

from core.i18n import (
    Translator,
    compare_keys,
    language_chain,
    load_catalogs,
    normalize_language,
    resolve_language,
)

INTEGRATION = Path(__file__).resolve().parent.parent / "custom_components" / "loyalty_hub"
I18N_DIR = INTEGRATION / "i18n"
TRANSLATIONS_DIR = INTEGRATION / "translations"


def _flatten(d, prefix=""):
    out = set()
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out |= _flatten(v, key + ".")
        else:
            out.add(key)
    return out


def test_all_backend_languages_have_same_keys_as_en():
    catalogs = load_catalogs(I18N_DIR)
    assert "en" in catalogs and "it" in catalogs
    assert compare_keys(catalogs) == {}


def test_ha_translations_match_strings_json():
    ref = _flatten(json.loads((INTEGRATION / "strings.json").read_text(encoding="utf-8")))
    files = list(TRANSLATIONS_DIR.glob("*.json"))
    assert files
    for path in files:
        keys = _flatten(json.loads(path.read_text(encoding="utf-8")))
        assert keys == ref, path.name


def test_placeholders_consistent():
    catalogs = load_catalogs(I18N_DIR)
    ph = re.compile(r"\{(\w+)\}")
    for lang, cat in catalogs.items():
        for key, text in cat.items():
            assert set(ph.findall(text)) == set(ph.findall(catalogs["en"][key])), (lang, key)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("it", "it"),
        ("pt_br", "pt-BR"),
        ("PT-br", "pt-BR"),
        ("zh-hant", "zh-Hant"),
        ("en-US", "en-US"),
        ("", None),
        ("x", None),
        ("toolong-" + "a" * 20, None),
        ("it;rm -rf", None),
        (None, None),
        (5, None),
    ],
)
def test_normalize_language(raw, expected):
    assert normalize_language(raw) == expected


CATS = {
    "en": {"a": "Hello {name}", "n_one": "{count} card", "n_other": "{count} cards", "only_en": "E"},
    "pt": {"a": "Olá {name}", "n_one": "{count} cartão", "n_other": "{count} cartões"},
    "pt-BR": {"a": "Oi {name}"},
}


def test_fallback_chain():
    assert language_chain(CATS, "pt-br") == ["pt-BR", "pt", "en"]
    assert language_chain(CATS, "pt-PT") == ["pt", "en"]
    assert language_chain(CATS, "de") == ["en"]
    t = Translator(CATS, "pt-BR")
    assert t("a", name="Ana") == "Oi Ana"
    assert t("n", count=1) == "1 cartão"
    assert t("n", count=3) == "3 cartões"
    assert t("only_en") == "E"
    assert t("missing.key") == "missing.key"
    assert t("a") == "Oi {name}"  # missing param left as-is
    assert Translator(CATS, "de")("n", count=0) == "0 cards"


def test_resolve_language():
    assert resolve_language(CATS, [None, "pt-PT"]) == "pt"
    assert resolve_language(CATS, ["de", "pt-BR"]) == "pt-BR"
    assert resolve_language(CATS, ["de", None]) == "en"


def test_norwegian_alias():
    from core.i18n import language_chain

    catalogs = {"en": {"a": "A"}, "nb": {"a": "B"}}
    assert language_chain(catalogs, "no")[0] == "nb"
    assert language_chain(catalogs, "nn-NO")[0] == "nb"
