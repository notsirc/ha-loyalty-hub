"""State of the "admin sees and edits everything" option (ARCHITETTURA §11.1). Pure.

Stored at the Store root as `admin_access: {enabled, changed_at, epoch}`.
Users accept the notice for one `epoch`; a new epoch (new notice) starts only
when the option is turned on for the first time, or turned on again after
being off for at least RENOTICE_AFTER.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

RENOTICE_AFTER = timedelta(hours=8)


def default_state() -> dict[str, Any]:
    return {"enabled": False, "changed_at": None, "epoch": 0}


def _parse(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def load_state(value: Any) -> dict[str, Any]:
    """Sanitize the stored state (missing/corrupted -> defaults)."""
    state = default_state()
    if not isinstance(value, dict):
        return state
    state["enabled"] = value.get("enabled") is True
    changed = _parse(value.get("changed_at"))
    state["changed_at"] = changed.isoformat(timespec="seconds") if changed else None
    epoch = value.get("epoch")
    if isinstance(epoch, int) and not isinstance(epoch, bool) and epoch >= 0:
        state["epoch"] = epoch
    return state


def transition(state: Any, option_enabled: bool, now: datetime) -> dict[str, Any]:
    """New state after (re)loading the entry with the option set to option_enabled.

    - no change -> state unchanged
    - off -> on with epoch 0 -> epoch 1
    - off -> on after >= 8 h off (or unknown time) -> epoch + 1
    - off -> on before 8 h -> epoch unchanged
    - every change updates enabled and changed_at
    """
    current = load_state(state)
    option_enabled = bool(option_enabled)
    if current["enabled"] == option_enabled:
        return current
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    new = dict(current)
    if option_enabled:
        last = _parse(current["changed_at"])
        if current["epoch"] == 0:
            new["epoch"] = 1
        elif last is None or now - last >= RENOTICE_AFTER:
            # Unknown time off: show the notice again (safer for privacy).
            new["epoch"] = current["epoch"] + 1
    new["enabled"] = option_enabled
    new["changed_at"] = now.astimezone(timezone.utc).isoformat(timespec="seconds")
    return new
