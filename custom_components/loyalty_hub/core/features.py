"""Administrator features (ARCHITETTURA §15.5). Pure Python.

Store root `features: {<id>: bool}`; a missing id means *off* (a new install
starts with every feature off). When a feature is on, users may switch the
per-user ones off for themselves (`UserPrefs.features_off`).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .errors import ERR_INVALID_FORMAT, FeatureDisabledError, LimitReachedError, ValidationError

F_NFC = "nfc"
F_SHOPPING_LIST = "shopping_list"
F_UNUSED_REMINDER = "unused_reminder"
F_POINTS_HISTORY = "points_history"
F_POINTS_EXPIRY = "points_expiry"
F_DEFAULT_SHARING = "default_sharing"
F_MANUAL_ORDER = "manual_order"
F_LOW_BALANCE = "low_balance"
F_FIND_BY_CODE = "find_by_code"
F_HIGH_CONTRAST_CASHIER = "high_contrast_cashier"

FEATURE_IDS: tuple[str, ...] = (
    F_NFC,
    F_SHOPPING_LIST,
    F_UNUSED_REMINDER,
    F_POINTS_HISTORY,
    F_POINTS_EXPIRY,
    F_DEFAULT_SHARING,
    F_MANUAL_ORDER,
    F_LOW_BALANCE,
    F_FIND_BY_CODE,
    F_HIGH_CONTRAST_CASHIER,
)
# Features a user may switch off for himself (column "per utente" = yes).
PER_USER_FEATURES: frozenset[str] = frozenset(
    {F_NFC, F_SHOPPING_LIST, F_UNUSED_REMINDER, F_POINTS_HISTORY, F_POINTS_EXPIRY, F_FIND_BY_CODE}
)

# NFC (§15.5): links per user, tag ids are opaque strings.
MAX_NFC_TAGS = 50
MAX_TAG_ID = 255


def _err(msg: str) -> ValidationError:
    return ValidationError(msg, ERR_INVALID_FORMAT)


# ---------------------------------------------------------------- state


def load_features(value: Any) -> dict[str, bool]:
    """Stored state, keeping only known ids with a boolean value."""
    if not isinstance(value, Mapping):
        return {}
    return {k: v for k, v in value.items() if k in FEATURE_IDS and isinstance(v, bool)}


def all_features(state: Mapping[str, bool]) -> dict[str, bool]:
    """Every feature id with its state (missing = off), for `settings`."""
    return {fid: state.get(fid) is True for fid in FEATURE_IDS}


def apply_changes(state: Mapping[str, bool], changes: Any) -> dict[str, bool]:
    """features/set: validate {<id>: bool} and return the new state."""
    if not isinstance(changes, Mapping):
        raise _err("features must be an object")
    out = dict(load_features(state))
    for key, value in changes.items():
        if key not in FEATURE_IDS:
            raise _err(f"unknown feature: {key}")
        if not isinstance(value, bool):
            raise _err(f"feature {key} must be a boolean")
        out[key] = value
    return out


def is_enabled(state: Mapping[str, bool], feature: str) -> bool:
    return state.get(feature) is True


def enabled_for(state: Mapping[str, bool], features_off: Iterable[str], feature: str) -> bool:
    """On for this user: enabled by the admin and (if per-user) not switched off by him."""
    if not is_enabled(state, feature):
        return False
    return feature not in PER_USER_FEATURES or feature not in set(features_off or ())


def require(state: Mapping[str, bool], feature: str) -> None:
    if not is_enabled(state, feature):
        raise FeatureDisabledError(f"The feature {feature} is disabled by the administrator")


def validate_features_off(value: Any) -> list[str]:
    """UserPrefs.features_off: only per-user feature ids, no duplicates."""
    if not isinstance(value, list):
        raise _err("features_off must be a list")
    out: list[str] = []
    for item in value:
        if item not in PER_USER_FEATURES:
            raise _err(f"features_off: {item!r} is not a per-user feature")
        if item not in out:
            out.append(item)
    return out


def load_features_off(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(v for v in value if v in PER_USER_FEATURES))


# ---------------------------------------------------------------- nfc tags


def load_nfc_tags(value: Any) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    out: dict[str, str] = {}
    for tag_id, card_id in value.items():
        if isinstance(tag_id, str) and tag_id and isinstance(card_id, str) and card_id:
            out[tag_id[:MAX_TAG_ID]] = card_id
        if len(out) >= MAX_NFC_TAGS:
            break
    return out


def link_tag(tags: dict[str, str], tag_id: Any, card_id: str) -> dict[str, str]:
    """Link (or re-link) a tag to a card. Beyond MAX_NFC_TAGS new tags -> limit_reached."""
    if not isinstance(tag_id, str) or not tag_id or len(tag_id) > MAX_TAG_ID:
        raise _err("invalid tag id")
    if tag_id not in tags and len(tags) >= MAX_NFC_TAGS:
        raise LimitReachedError(f"at most {MAX_NFC_TAGS} NFC tags per user")
    out = dict(tags)
    out[tag_id] = card_id
    return out


def unlink_tag(tags: dict[str, str], tag_id: str) -> dict[str, str]:
    return {k: v for k, v in tags.items() if k != tag_id}


def redact_tag(tag_id: str) -> str:
    """Tag id safe for logs (never the full id)."""
    return f"{tag_id[:4]}…" if len(tag_id) > 4 else "…"
