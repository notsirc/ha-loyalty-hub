"""Backend translations for notification texts (ARCHITETTURA §9).

Catalogs: `custom_components/loyalty_hub/i18n/<lang>.json`, flat {key: text}.
Fallback chain: full tag (pt-BR) -> base language (pt) -> en.
Placeholders `{name}`; plurals via `<key>_one` / `<key>_other`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

DEFAULT_LANGUAGE = "en"
LANGUAGE_ALIASES = {"no": "nb", "nn": "nb"}
MAX_LANGUAGE_LEN = 20
_LANG_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$")
_PLACEHOLDER_RE = re.compile(r"\{(\w+)\}")

Catalogs = Mapping[str, Mapping[str, str]]


def normalize_language(value: object) -> str | None:
    """Return a normalized BCP-47-ish tag (`pt-BR`, `it`), or None if invalid."""
    if not isinstance(value, str):
        return None
    tag = value.strip().replace("_", "-")
    if not tag or len(tag) > MAX_LANGUAGE_LEN or not _LANG_RE.match(tag):
        return None
    parts = tag.split("-")
    out = [parts[0].lower()]
    for part in parts[1:]:
        if len(part) == 2:
            out.append(part.upper())
        elif len(part) == 4 and part.isalpha():
            out.append(part.title())
        else:
            out.append(part.lower())
    return "-".join(out)


def load_catalogs(directory: Path | str) -> dict[str, dict[str, str]]:
    """Read every <lang>.json in directory (blocking IO: call from an executor)."""
    catalogs: dict[str, dict[str, str]] = {}
    for path in sorted(Path(directory).glob("*.json")):
        lang = normalize_language(path.stem)
        if lang is None:
            continue
        with path.open(encoding="utf-8") as fh:
            data = json.load(fh)
        catalogs[lang] = {str(k): str(v) for k, v in data.items()}
    return catalogs


def _lookup_key(catalogs: Catalogs, tag: str) -> str | None:
    lower = {k.lower(): k for k in catalogs}
    return lower.get(tag.lower())


def language_chain(catalogs: Catalogs, language: str | None) -> list[str]:
    """Catalog names to try in order: full tag, base language, en."""
    chain: list[str] = []
    tag = normalize_language(language) if language else None
    if tag:
        base = tag.split("-", 1)[0]
        # Norwegian: HA uses "nb"; "no"/"nn" fall back to it (§14.5).
        for candidate in (tag, base, LANGUAGE_ALIASES.get(base, base)):
            key = _lookup_key(catalogs, candidate)
            if key and key not in chain:
                chain.append(key)
    if DEFAULT_LANGUAGE in catalogs and DEFAULT_LANGUAGE not in chain:
        chain.append(DEFAULT_LANGUAGE)
    return chain


def resolve_language(catalogs: Catalogs, candidates: Iterable[str | None]) -> str:
    """First candidate with an available catalog (full or base), else en."""
    for candidate in candidates:
        tag = normalize_language(candidate)
        if not tag:
            continue
        for option in (tag, tag.split("-", 1)[0]):
            if key := _lookup_key(catalogs, option):
                return key
    return DEFAULT_LANGUAGE


def _format(text: str, params: Mapping[str, Any]) -> str:
    return _PLACEHOLDER_RE.sub(
        lambda m: str(params[m.group(1)]) if m.group(1) in params else m.group(0), text
    )


class Translator:
    """Translate keys for one language with fallback."""

    def __init__(self, catalogs: Catalogs, language: str | None) -> None:
        self._catalogs = catalogs
        self._chain = language_chain(catalogs, language)
        self.language = self._chain[0] if self._chain else DEFAULT_LANGUAGE

    def _raw(self, key: str) -> str | None:
        for lang in self._chain:
            text = self._catalogs[lang].get(key)
            if text is not None:
                return text
        return None

    def t(self, key: str, count: int | None = None, **params: Any) -> str:
        if count is not None:
            params.setdefault("count", count)
            text = self._raw(f"{key}_one" if count == 1 else f"{key}_other")
            if text is None:
                text = self._raw(key)
        else:
            text = self._raw(key)
        if text is None:
            return key
        return _format(text, params)

    __call__ = t


def compare_keys(catalogs: Catalogs, reference: str = DEFAULT_LANGUAGE) -> dict[str, dict[str, list[str]]]:
    """{lang: {missing: [...], extra: [...]}} for languages differing from reference."""
    ref = set(catalogs[reference])
    out: dict[str, dict[str, list[str]]] = {}
    for lang, cat in catalogs.items():
        keys = set(cat)
        if keys != ref:
            out[lang] = {"missing": sorted(ref - keys), "extra": sorted(keys - ref)}
    return out
