"""WebSocket commands (ARCHITETTURA §5, §11.11, §12.4, §14.6, §15.6). Thin layer over core/."""

from __future__ import annotations

import base64
import copy
import functools
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    MAX_EVENT_CARD_IDS,
    SIGNAL_CARDS_CHANGED,
    SIGNAL_LOGO_REFRESH,
    SIGNAL_SETTINGS_CHANGED,
    SIGNAL_TRASH_CHANGED,
    SIGNAL_USER_EVENT,
)
from .core import card_transfer
from .core import features as feature_rules
from .core import inbox as inbox_rules
from .core import models
from .core import trash as trash_rules
from .core.errors import (
    ERR_INVALID_FORMAT,
    LoyaltyError,
    NotFoundError,
    UnauthorizedError,
    ValidationError,
)
from .core.features import F_NFC, F_POINTS_HISTORY
from .core.household import household_shops
from .core.logo_cache import MAX_CACHE_DAYS, MIN_CACHE_DAYS, RefreshProgress
from .core.logo_key import TEST_MISSING
from .core.models import Card
from .core.notify_logic import ZONE_HOME
from .core.permissions import (
    Actor,
    can_delete_transaction,
    can_edit,
    can_manage,
    can_use,
    can_view,
    is_admin_view,
)
from .core.logo_sources import PROVIDER_AUTO, PROVIDERS, validate_domain
from .core.logos import MIME_PNG, decode_logo_base64, validate_logo_bytes
from .core.transfer import (
    EXPORT_FORMATS,
    FORMAT_WALLET_ASSISTANT,
    FORMATS,
    MAX_IMPORT_BYTES,
    decode_base64,
    export_payload,
    import_bytes,
)
from .core.wallet_assistant import LOCAL_FILES as WA_LOCAL_FILES
from .logos import (
    async_delete_logo,
    async_import_logos,
    async_lookup_requested,
    async_revert_logo,
    async_store_logo,
    async_test_logo_dev_key,
)
from .storage import LoyaltyHubData
from .zone_watcher import async_check_low_balance

if TYPE_CHECKING:
    from .logo_maintenance import LogoMaintenance
    from .trash_notify import TrashManager

_LOGGER = logging.getLogger(__name__)

# cards/update fields reserved to the owner (can_manage, §11.1).
# shop_custom/suggest_shop decide what other users see in shops/household (§14.3): owner only.
MANAGE_FIELDS = frozenset({"visibility", "shared_with", "shop_custom", "suggest_shop"})

# logo/lookup and logo/preview: a provider or "auto" (§14.2).
LOOKUP_PROVIDERS = (PROVIDER_AUTO, *PROVIDERS)

Handler = Callable[[HomeAssistant, websocket_api.ActiveConnection, dict[str, Any]], Awaitable[None]]


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (
        ws_cards_list,
        ws_cards_get,
        ws_cards_create,
        ws_cards_update,
        ws_cards_delete,
        ws_cards_mark_used,
        ws_cards_add_location,
        ws_cards_remove_location,
        ws_cards_transfer,
        ws_cards_clear_points_history,
        ws_inbox_list,
        ws_inbox_dismiss,
        ws_features_set,
        ws_nfc_link_start,
        ws_nfc_list,
        ws_nfc_unlink,
        ws_voucher_add_transaction,
        ws_voucher_adjust_balance,
        ws_voucher_delete_transaction,
        ws_subscribe,
        ws_users,
        ws_zones,
        ws_notify_services,
        ws_prefs_get,
        ws_prefs_set,
        ws_admin_notice_accept,
        ws_settings,
        ws_import,
        ws_import_sources,
        ws_export,
        ws_logo_upload,
        ws_logo_lookup,
        ws_logo_delete,
        ws_logo_providers,
        ws_logo_test_key,
        ws_logo_preview,
        ws_logo_apply_preview,
        ws_logo_revert,
        ws_logo_refresh_all,
        ws_logo_cache_set,
        ws_shops_household,
        ws_trash_list,
        ws_trash_restore,
        ws_trash_purge,
        ws_trash_cancel_purge,
        ws_trash_request,
        ws_trash_respond,
    ):
        websocket_api.async_register_command(hass, handler)


# ---------------------------------------------------------------- helpers


def _data(hass: HomeAssistant) -> LoyaltyHubData:
    data: LoyaltyHubData | None = hass.data.get(DOMAIN)
    if data is None:
        raise NotFoundError("Loyalty Hub is not loaded")
    return data


def _handle_errors(func: Handler) -> Handler:
    """Translate core errors to websocket error messages."""

    @functools.wraps(func)
    async def wrapper(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
    ) -> None:
        if connection.user is None:
            connection.send_error(msg["id"], "unauthorized", "Authentication required")
            return
        try:
            await func(hass, connection, msg)
        except LoyaltyError as exc:
            connection.send_error(msg["id"], exc.code, exc.message)

    return wrapper


def _actor(data: LoyaltyHubData, connection: websocket_api.ActiveConnection) -> Actor:
    return data.actor(connection.user)


def _get_visible(data: LoyaltyHubData, card_id: str, actor: Actor) -> Card:
    """Return the card or raise not_found (invisible cards do not 'exist')."""
    card = data.store.cards.get(card_id)
    if card is None or not can_view(card, actor):
        raise NotFoundError(f"Card {card_id} not found")
    return card


def _get_editable(data: LoyaltyHubData, card_id: str, actor: Actor) -> Card:
    card = _get_visible(data, card_id, actor)
    if not can_edit(card, actor):
        raise UnauthorizedError("Only the owner or an administrator can modify this card")
    return card


def _get_usable(data: LoyaltyHubData, card_id: str, actor: Actor) -> Card:
    card = _get_visible(data, card_id, actor)
    if not can_use(card, actor):
        raise UnauthorizedError("Not allowed")
    return card


async def _user_names(hass: HomeAssistant) -> dict[str, str]:
    return {u.id: u.name or "" for u in await hass.auth.async_get_users()}


async def _active_user_ids(hass: HomeAssistant) -> list[str]:
    """Active, non-system users (the same list as `loyalty_hub/users`, self included)."""
    return [
        u.id for u in await hass.auth.async_get_users() if u.is_active and not u.system_generated
    ]


def _check_todo_entity(hass: HomeAssistant, changes: dict[str, Any]) -> None:
    """§15.5 shopping_list: `todo_entity` must be an existing todo.* entity when saved."""
    value = changes.get("todo_entity")
    if not value:
        return
    entity_id = models.validate_editable({"todo_entity": value})["todo_entity"]
    if entity_id is None or hass.states.get(entity_id) is None:
        raise ValidationError(f"{entity_id} does not exist", ERR_INVALID_FORMAT)


@callback
def _async_low_balance_later(hass: HomeAssistant, data: LoyaltyHubData, card: Card) -> None:
    """§15.5: low balance check after a voucher change (in background)."""
    if not data.feature_enabled(feature_rules.F_LOW_BALANCE):
        return
    data.entry.async_create_background_task(
        hass, async_check_low_balance(hass, data, [card]), "loyalty_hub low balance"
    )


def _card_out(card: Card, actor: Actor, names: dict[str, str]) -> dict[str, Any]:
    out = card.to_dict()
    out["can_edit"] = can_edit(card, actor)
    out["can_manage"] = can_manage(card, actor)
    out["admin_view"] = is_admin_view(card, actor)
    out["owner_name"] = names.get(card.owner_id, "")
    # §15.4: "Added by Alice" / "Transferred by Alice on ...".
    out["created_by_name"] = names.get(card.created_by or "", "")
    out["transferred_by_name"] = names.get(card.transferred_by or "", "")
    if out["admin_view"]:
        # Seen only through "admin sees everything": do not expose the owner's habits.
        out["usage"] = []
        out["last_used"] = None
    for tx in out["transactions"]:
        tx["user_name"] = names.get(tx.get("user_id") or "", "")
    return out


async def _single_card_result(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg_id: int, card: Card
) -> None:
    names = await _user_names(hass)
    actor = _actor(_data(hass), connection)
    connection.send_result(msg_id, {"card": _card_out(card, actor, names)})


async def _card_or_null_result(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg_id: int, card: Card
) -> None:
    """§15.6: `{card: null}` when the caller cannot see the card (made for / given to others)."""
    actor = _actor(_data(hass), connection)
    if not can_view(card, actor):
        connection.send_result(msg_id, {"card": None})
        return
    names = await _user_names(hass)
    connection.send_result(msg_id, {"card": _card_out(card, actor, names)})


# ---------------------------------------------------------------- cards


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/cards/list"})
@websocket_api.async_response
@_handle_errors
async def ws_cards_list(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    names = await _user_names(hass)
    cards = [
        _card_out(c, actor, names)
        for c in sorted(data.store.cards.values(), key=lambda c: c.name.casefold())
        if can_view(c, actor)
    ]
    connection.send_result(msg["id"], {"cards": cards})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/get",
        vol.Required("card_ids"): vol.All([str], vol.Length(min=1, max=200)),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_get(hass, connection, msg) -> None:
    """Targeted refresh (§12.5): invisible and unknown ids both go to `missing`."""
    data = _data(hass)
    actor = _actor(data, connection)
    names = await _user_names(hass)
    cards: list[dict[str, Any]] = []
    missing: list[str] = []
    for card_id in dict.fromkeys(msg["card_ids"]):
        card = data.store.cards.get(card_id)
        if card is not None and can_view(card, actor):
            cards.append(_card_out(card, actor, names))
        else:
            missing.append(card_id)
    connection.send_result(msg["id"], {"cards": cards, "missing": missing})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/create",
        vol.Required("card"): dict,
        # §15.4: a card for another user, with its logo in the same call.
        vol.Optional("for_user_id"): vol.Any(str, None),
        vol.Optional("share_with_me", default=True): bool,
        vol.Optional("logo_upload"): vol.Any(str, None),
        vol.Optional("logo_lookup", default=False): bool,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_create(hass, connection, msg) -> None:
    data = _data(hass)
    me = connection.user.id
    now = dt_util.utcnow()
    target = msg.get("for_user_id") or me
    _check_todo_entity(hass, msg["card"])
    upload: tuple[str, bytes] | None = None
    if msg.get("logo_upload"):
        # Same rules as logo/upload, checked before anything is created.
        blob = decode_logo_base64(msg["logo_upload"])
        upload = (validate_logo_bytes(blob, allow_svg=False), blob)
    if target == me:
        # §14.3: without a currency the card gets HA's one.
        card = models.create_card(msg["card"], me, now, default_currency=data.currency)
    else:
        names = await _user_names(hass)
        card_transfer.check_recipient(
            target,
            await _active_user_ids(hass),
            data.store.get_prefs(target),
            names.get(target, ""),
        )
        card = card_transfer.create_for_other(
            msg["card"], me, target, msg["share_with_me"], now, default_currency=data.currency
        )
    data.store.cards[card.id] = card
    data.store.async_cards_changed(card)
    if target != me and data.inbox_notifier is not None:
        data.inbox_notifier.async_add(target, [card.id], me, inbox_rules.KIND_CREATED)
    if upload is not None:
        try:
            # The creator may lack can_edit on a card made for someone else: no actor check.
            stored = await async_store_logo(hass, data, card.id, "upload", upload[0], upload[1])
        except LoyaltyError as exc:
            # The card exists already: keep it without a logo (best effort).
            _LOGGER.info("Logo of a new card not saved: %s", exc.code)
        else:
            card = stored or card
    elif msg["logo_lookup"] and card.logo_domain and data.logo_providers:
        data.entry.async_create_background_task(
            hass, _async_lookup_new_card(hass, data, card.id, card.logo_domain), "loyalty_hub logo"
        )
    await _card_or_null_result(hass, connection, msg["id"], card)


async def _async_lookup_new_card(
    hass: HomeAssistant, data: LoyaltyHubData, card_id: str, domain: str
) -> None:
    """§15.4 logo_lookup: "auto" search in background, best effort."""
    try:
        blob, mime, provider = await async_lookup_requested(hass, data, PROVIDER_AUTO, domain)
        current = data.store.cards.get(card_id)
        if current is None or current.logo:
            return
        await async_store_logo(hass, data, card_id, provider, mime, blob, domain=domain)
    except LoyaltyError as exc:
        _LOGGER.debug("Logo lookup for a new card failed: %s", exc.code)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/update",
        vol.Required("card_id"): str,
        vol.Required("changes"): dict,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_update(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_editable(data, msg["card_id"], actor)
    if not can_manage(card, actor) and MANAGE_FIELDS & set(msg["changes"]):
        # Admins may edit, but never narrow or widen the owner's sharing.
        raise UnauthorizedError("Only the owner can change the sharing of this card")
    before = copy.deepcopy(card)
    updated = copy.deepcopy(card)
    models.update_card(updated, msg["changes"], dt_util.utcnow())  # validates first
    _check_todo_entity(hass, msg["changes"])
    if (
        "points" in msg["changes"]
        and updated.points != before.points
        and data.feature_enabled(F_POINTS_HISTORY)
    ):
        # §15.5: today's entry (same day replaced); null is not recorded.
        models.record_points_history(updated, dt_util.now().date())
    data.store.cards[card.id] = updated
    data.store.async_cards_changed(before, updated)
    await _single_card_result(hass, connection, msg["id"], updated)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/transfer",
        vol.Required("card_id"): str,
        vol.Required("to_user_id"): str,
        vol.Optional("keep_shared_with_me", default=True): bool,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_transfer(hass, connection, msg) -> None:
    """§15.4: give the card to another user (owner only)."""
    data = _data(hass)
    actor = _actor(data, connection)
    me = connection.user.id
    card = _get_visible(data, msg["card_id"], actor)
    if not can_manage(card, actor):
        raise UnauthorizedError("Only the owner can transfer this card")
    target = msg["to_user_id"]
    if target == card.owner_id:
        raise ValidationError("the recipient already owns this card", ERR_INVALID_FORMAT)
    names = await _user_names(hass)
    card_transfer.check_recipient(
        target, await _active_user_ids(hass), data.store.get_prefs(target), names.get(target, "")
    )
    before = copy.deepcopy(card)
    updated = copy.deepcopy(card)
    card_transfer.transfer(updated, me, target, msg["keep_shared_with_me"], dt_util.utcnow())
    # The old owner's notify_log keys for this card go if he no longer sees it.
    card_transfer.drop_keys(
        data.store.notify_log,
        card_transfer.stale_notify_keys(data.store.notify_log, before.owner_id, updated),
    )
    data.store.cards[card.id] = updated
    data.store.async_cards_changed(before, updated)
    if data.inbox_notifier is not None:
        data.inbox_notifier.async_add(target, [card.id], me, inbox_rules.KIND_TRANSFERRED)
    await _card_or_null_result(hass, connection, msg["id"], updated)


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/cards/clear_points_history", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_clear_points_history(hass, connection, msg) -> None:
    data = _data(hass)
    data.require_feature(F_POINTS_HISTORY)
    card = _get_editable(data, msg["card_id"], _actor(data, connection))
    updated = copy.deepcopy(card)
    models.clear_points_history(updated, dt_util.utcnow())
    data.store.cards[card.id] = updated
    data.store.async_cards_changed(updated)
    await _single_card_result(hass, connection, msg["id"], updated)


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/cards/delete", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_delete(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_visible(data, msg["card_id"], actor)
    if not can_manage(card, actor):
        raise UnauthorizedError("Only the owner can delete this card")
    # §12.2: moved to the trash; the logo file stays on disk until the final deletion.
    trash_rules.move_to_trash(
        data.store.cards, data.store.trash, card.id, connection.user.id, dt_util.utcnow()
    )
    for key in trash_rules.notify_log_keys(data.store.notify_log, card.id):
        del data.store.notify_log[key]
    data.store.async_cards_changed(card)
    data.store.async_trash_changed(card.owner_id)
    connection.send_result(msg["id"], {})


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/cards/mark_used", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_mark_used(hass, connection, msg) -> None:
    data = _data(hass)
    card = _get_usable(data, msg["card_id"], _actor(data, connection))
    now = dt_util.utcnow()
    # Ignored (card unchanged) within 10 minutes of the last use (§11.6).
    if models.mark_used(card, now, dt_util.as_local(now)):
        data.store.async_cards_changed(card)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/add_location",
        vol.Required("card_id"): str,
        vol.Required("latitude"): vol.Any(int, float),
        vol.Required("longitude"): vol.Any(int, float),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_add_location(hass, connection, msg) -> None:
    data = _data(hass)
    card = _get_usable(data, msg["card_id"], _actor(data, connection))
    updated = copy.deepcopy(card)
    # False = an existing point within 100 m already covers this store.
    if models.add_location(updated, msg["latitude"], msg["longitude"], dt_util.utcnow()):
        data.store.cards[card.id] = updated
        data.store.async_cards_changed(updated)
    await _single_card_result(hass, connection, msg["id"], updated)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/cards/remove_location",
        vol.Required("card_id"): str,
        vol.Required("location_id"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_cards_remove_location(hass, connection, msg) -> None:
    data = _data(hass)
    card = _get_editable(data, msg["card_id"], _actor(data, connection))
    updated = copy.deepcopy(card)
    models.remove_location(updated, msg["location_id"], dt_util.utcnow())
    data.store.cards[card.id] = updated
    data.store.async_cards_changed(updated)
    await _single_card_result(hass, connection, msg["id"], updated)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/voucher/add_transaction",
        vol.Required("card_id"): str,
        vol.Required("amount"): vol.Any(int, float),
        vol.Optional("note"): vol.Any(str, None),
        vol.Optional("date"): vol.Any(str, None),
        # "type" is the websocket command name: the transaction type is "tx_type".
        vol.Optional("tx_type"): vol.Any(str, None),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_voucher_add_transaction(hass, connection, msg) -> None:
    data = _data(hass)
    user_id = connection.user.id
    card = _get_usable(data, msg["card_id"], _actor(data, connection))
    models.add_transaction(
        card,
        msg["amount"],
        user_id,
        note=msg.get("note"),
        tx_date=msg.get("date"),
        now=dt_util.utcnow(),
        tx_type=msg.get("tx_type"),
    )
    data.store.async_cards_changed(card)
    _async_low_balance_later(hass, data, card)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/voucher/delete_transaction",
        vol.Required("card_id"): str,
        vol.Required("transaction_id"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_voucher_delete_transaction(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_visible(data, msg["card_id"], actor)
    tx = card.find_transaction(msg["transaction_id"])
    if not can_delete_transaction(card, tx, actor):
        raise UnauthorizedError(
            "Only the transaction author, the owner or an administrator can delete it"
        )
    models.remove_transaction(card, tx.id, dt_util.utcnow())
    data.store.async_cards_changed(card)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/voucher/adjust_balance",
        vol.Required("card_id"): str,
        vol.Required("new_balance"): vol.Any(int, float),
        vol.Required("reason"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_voucher_adjust_balance(hass, connection, msg) -> None:
    data = _data(hass)
    card = _get_editable(data, msg["card_id"], _actor(data, connection))
    updated = copy.deepcopy(card)
    models.adjust_balance(
        updated, msg["new_balance"], msg["reason"], connection.user.id, dt_util.utcnow()
    )
    data.store.cards[card.id] = updated
    data.store.async_cards_changed(updated)
    _async_low_balance_later(hass, data, updated)
    await _single_card_result(hass, connection, msg["id"], updated)


# ---------------------------------------------------------------- subscribe


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/subscribe"})
@websocket_api.async_response
@_handle_errors
async def ws_subscribe(hass, connection, msg) -> None:
    _data(hass)
    msg_id = msg["id"]

    @callback
    def forward(cards: list[Card]) -> None:
        # The panel's own view (admin_all included), recomputed at every event so that
        # switching the admin option off takes effect without reopening the panel.
        current = hass.data.get(DOMAIN)
        if current is None:
            return
        actor = current.actor(connection.user)
        event: dict[str, Any] = {"event": "changed"}
        if cards:
            # Only users who could see a card before or after the change hear about it,
            # and only about those cards.
            ids = list(dict.fromkeys(c.id for c in cards if can_view(c, actor)))
            if not ids:
                return
            if len(ids) <= MAX_EVENT_CARD_IDS:
                event["card_ids"] = ids
        connection.send_message(websocket_api.event_message(msg_id, event))

    @callback
    def forward_trash(owner_id: str) -> None:
        user = connection.user
        if user is None or not (user.id == owner_id or user.is_admin):
            return
        connection.send_message(
            websocket_api.event_message(msg_id, {"event": "trash_changed"})
        )

    @callback
    def forward_logo_refresh(requester: str, event: dict[str, Any]) -> None:
        # §14.2: progress counts only, to the user who started the round.
        user = connection.user
        if user is None or user.id != requester:
            return
        connection.send_message(websocket_api.event_message(msg_id, dict(event)))

    @callback
    def forward_user_event(user_id: str, event: dict[str, Any]) -> None:
        # §15.4/§15.5: inbox_changed, nfc_linked: to the user concerned only.
        user = connection.user
        if user is None or user.id != user_id:
            return
        connection.send_message(websocket_api.event_message(msg_id, dict(event)))

    @callback
    def forward_settings() -> None:
        connection.send_message(
            websocket_api.event_message(msg_id, {"event": "settings_changed"})
        )

    unsubs = [
        async_dispatcher_connect(hass, SIGNAL_CARDS_CHANGED, forward),
        async_dispatcher_connect(hass, SIGNAL_TRASH_CHANGED, forward_trash),
        async_dispatcher_connect(hass, SIGNAL_LOGO_REFRESH, forward_logo_refresh),
        async_dispatcher_connect(hass, SIGNAL_USER_EVENT, forward_user_event),
        async_dispatcher_connect(hass, SIGNAL_SETTINGS_CHANGED, forward_settings),
    ]

    @callback
    def unsubscribe() -> None:
        for unsub in unsubs:
            unsub()

    # Removed by HA's built-in `unsubscribe_events` or on connection close.
    connection.subscriptions[msg_id] = unsubscribe
    connection.send_result(msg_id)


# ---------------------------------------------------------------- lookups


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/users"})
@websocket_api.async_response
@_handle_errors
async def ws_users(hass, connection, msg) -> None:
    me = connection.user.id
    users = [
        {"id": u.id, "name": u.name or ""}
        for u in await hass.auth.async_get_users()
        if u.is_active and not u.system_generated and u.id != me
    ]
    users.sort(key=lambda u: u["name"].casefold())
    connection.send_result(msg["id"], {"users": users})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/zones"})
@websocket_api.async_response
@_handle_errors
async def ws_zones(hass, connection, msg) -> None:
    zones = [
        {"entity_id": s.entity_id, "name": s.name}
        for s in hass.states.async_all("zone")
        if s.entity_id != ZONE_HOME
    ]
    zones.sort(key=lambda z: z["name"].casefold())
    connection.send_result(msg["id"], {"zones": zones})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/notify_services"})
@websocket_api.async_response
@_handle_errors
async def ws_notify_services(hass, connection, msg) -> None:
    services = sorted(
        s for s in hass.services.async_services_for_domain("notify") if s.startswith("mobile_app_")
    )
    connection.send_result(msg["id"], {"services": services})


# ---------------------------------------------------------------- prefs/settings


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/prefs/get"})
@websocket_api.async_response
@_handle_errors
async def ws_prefs_get(hass, connection, msg) -> None:
    prefs = _data(hass).store.get_prefs(connection.user.id)
    connection.send_result(msg["id"], {"prefs": await _prefs_out(hass, prefs)})


async def _prefs_out(hass: HomeAssistant, prefs: models.UserPrefs) -> dict[str, Any]:
    """API form: no NFC links (server-only); default_share without vanished users."""
    out = prefs.to_api()
    if prefs.default_share:
        out["default_share"] = models.filter_default_share(
            prefs.default_share, await _active_user_ids(hass)
        )
    return out


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/prefs/set", vol.Required("prefs"): dict}
)
@websocket_api.async_response
@_handle_errors
async def ws_prefs_set(hass, connection, msg) -> None:
    data = _data(hass)
    user_id = connection.user.id
    prefs = models.update_prefs(copy.deepcopy(data.store.get_prefs(user_id)), msg["prefs"])
    if prefs.notify_service and not hass.services.has_service("notify", prefs.notify_service):
        raise ValidationError(
            f"notify.{prefs.notify_service} does not exist", ERR_INVALID_FORMAT
        )
    data.store.prefs[user_id] = prefs
    data.store.async_schedule_save()
    connection.send_result(msg["id"], {"prefs": await _prefs_out(hass, prefs)})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/settings"})
@websocket_api.async_response
@_handle_errors
async def ws_settings(hass, connection, msg) -> None:
    data = _data(hass)
    logo_usage: dict[str, int] | None = None
    if connection.user.is_admin:
        files, total = await hass.async_add_executor_job(data.logos.usage)
        logo_usage = {
            "files": files,
            "bytes": total,
            "max_files": data.logo_max_files,
            "max_bytes": data.logo_max_bytes,
        }
    connection.send_result(
        msg["id"],
        {
            "price_compare": data.price_compare,
            "expiry_warning_days": data.expiry_warning_days,
            "admin_full_access": data.admin_full_access,
            "admin_notice_epoch": int(data.store.admin_access.get("epoch") or 0),
            "logo_usage": logo_usage,
            # §14.1: never a key, only its state.
            "logo_dev": {"state": data.logo_dev_state},
            # §14.2 / §14.3
            "logo_cache_days": data.logo_cache_days,
            "default_country": data.default_country,
            "currency": data.currency,
            # §15.5: every feature id, to everyone.
            "features": feature_rules.all_features(data.store.features),
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/features/set", vol.Required("features"): dict}
)
@websocket_api.async_response
@_handle_errors
async def ws_features_set(hass, connection, msg) -> None:
    """§15.5 (admin): switch features on/off; data stays when a feature is off."""
    _require_admin(connection)
    data = _data(hass)
    data.store.features = feature_rules.apply_changes(data.store.features, msg["features"])
    data.store.async_settings_changed()
    connection.send_result(
        msg["id"], {"features": feature_rules.all_features(data.store.features)}
    )


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/admin_notice/accept"})
@websocket_api.async_response
@_handle_errors
async def ws_admin_notice_accept(hass, connection, msg) -> None:
    data = _data(hass)
    user_id = connection.user.id
    prefs = copy.deepcopy(data.store.get_prefs(user_id))
    prefs.admin_notice_accepted = int(data.store.admin_access.get("epoch") or 0)
    data.store.prefs[user_id] = prefs
    data.store.async_schedule_save()
    connection.send_result(msg["id"], {"prefs": await _prefs_out(hass, prefs)})


# ---------------------------------------------------------------- inbox (§15.4)


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/inbox/list"})
@websocket_api.async_response
@_handle_errors
async def ws_inbox_list(hass, connection, msg) -> None:
    data = _data(hass)
    names = await _user_names(hass)
    items, changed = inbox_rules.list_items(
        data.store.inbox, connection.user.id, data.store.cards, names
    )
    if changed:
        data.store.async_schedule_save()
    connection.send_result(msg["id"], {"items": items})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/inbox/dismiss"})
@websocket_api.async_response
@_handle_errors
async def ws_inbox_dismiss(hass, connection, msg) -> None:
    data = _data(hass)
    user_id = connection.user.id
    if inbox_rules.dismiss(data.store.inbox, user_id):
        data.store.async_schedule_save()
        data.store.async_user_event(user_id, {"event": "inbox_changed"})
    connection.send_result(msg["id"], {})


# ---------------------------------------------------------------- nfc (§15.5)


def _nfc_tags_out(data: LoyaltyHubData, user_id: str) -> list[dict[str, str]]:
    names = data.nfc.tag_names() if data.nfc is not None else {}
    tags = data.store.get_prefs(user_id).nfc_tags
    return [
        {"tag_id": tag_id, "card_id": card_id, "tag_name": names.get(tag_id, "")}
        for tag_id, card_id in tags.items()
    ]


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/nfc/link_start", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_nfc_link_start(hass, connection, msg) -> None:
    data = _data(hass)
    data.require_feature(F_NFC)
    if data.nfc is None:
        raise NotFoundError("Loyalty Hub is not loaded")
    # Normal visibility: a tag opens the card only for users who really see it.
    card = _get_visible(data, msg["card_id"], _actor(data, connection).normal)
    expires_at = data.nfc.async_link_start(connection.user.id, card.id)
    connection.send_result(msg["id"], {"expires_at": expires_at})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/nfc/list"})
@websocket_api.async_response
@_handle_errors
async def ws_nfc_list(hass, connection, msg) -> None:
    data = _data(hass)
    data.require_feature(F_NFC)
    connection.send_result(msg["id"], {"tags": _nfc_tags_out(data, connection.user.id)})


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/nfc/unlink", vol.Required("tag_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_nfc_unlink(hass, connection, msg) -> None:
    data = _data(hass)
    data.require_feature(F_NFC)
    user_id = connection.user.id
    prefs = data.store.get_prefs(user_id)
    if msg["tag_id"] in prefs.nfc_tags:
        prefs = copy.deepcopy(prefs)
        prefs.nfc_tags = feature_rules.unlink_tag(prefs.nfc_tags, msg["tag_id"])
        data.store.prefs[user_id] = prefs
        data.store.async_schedule_save()
    connection.send_result(msg["id"], {"tags": _nfc_tags_out(data, user_id)})


# ---------------------------------------------------------------- import/export


def _read_wa_local(config_dir: str) -> bytes | None:
    """Blocking: the first existing Wallet-Assistant file in <config>, or None."""
    for name in WA_LOCAL_FILES:
        path = Path(config_dir) / name
        try:
            if not path.is_file():
                continue
            if path.stat().st_size > MAX_IMPORT_BYTES:
                raise ValidationError("file too large (max 5 MB)", ERR_INVALID_FORMAT)
            return path.read_bytes()
        except OSError:
            continue
    return None


def _wa_local_exists(config_dir: str) -> bool:
    return any((Path(config_dir) / name).is_file() for name in WA_LOCAL_FILES)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/import",
        vol.Required("format"): vol.In(FORMATS),
        vol.Optional("data_base64"): vol.Any(str, None),
        vol.Optional("from_local"): bool,
        vol.Optional("import_logos"): bool,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_import(hass, connection, msg) -> None:
    data = _data(hass)
    user_id = connection.user.id
    fmt = msg["format"]
    if msg.get("from_local"):
        if fmt != FORMAT_WALLET_ASSISTANT:
            raise ValidationError(
                "from_local is only supported for wallet_assistant", ERR_INVALID_FORMAT
            )
        raw = await hass.async_add_executor_job(_read_wa_local, hass.config.config_dir)
        if raw is None:
            raise NotFoundError("Wallet-Assistant file not found")
    elif msg.get("data_base64"):
        raw = decode_base64(msg["data_base64"])
    else:
        raise ValidationError("data_base64 or from_local is required", ERR_INVALID_FORMAT)
    users = await hass.auth.async_get_users()
    known_users = {u.id for u in users}
    # §15.4: an admin import creates cards only for active non-system users who accept
    # cards from others (as cards/create with for_user_id); the others are skipped.
    refusing = card_transfer.import_blocked_owners(
        [(u.id, u.is_active, u.system_generated) for u in users],
        user_id,
        lambda uid: data.store.get_prefs(uid).refuse_from_others,
    )
    existing = list(data.store.cards.values())
    now = dt_util.utcnow()
    result = await hass.async_add_executor_job(
        functools.partial(
            import_bytes,
            fmt,
            raw,
            user_id,
            existing=existing,
            now=now,
            tz=dt_util.get_default_time_zone(),
            known_user_ids=known_users,
            importer_is_admin=connection.user.is_admin,
            default_currency=data.currency,
            refusing_user_ids=refusing,
        )
    )
    blobs: dict[str, tuple[str, bytes]] = {
        cid: (MIME_PNG, blob) for cid, blob in result.logos.items()
    }
    extra: dict[str, tuple[str, bytes]] = {}
    if msg.get("import_logos") and result.cards:
        extra = await async_import_logos(hass, data, result.cards, result.logo_slugs, now)
        blobs.update(extra)
    skipped: set[str] = set()
    if blobs:
        skipped = await hass.async_add_executor_job(
            data.logos.write_many_checked, blobs, data.logo_max_files, data.logo_max_bytes
        )
        for card in result.cards:
            if card.id in skipped:
                card.logo = None  # over the storage limits: no file written
        result.logos_skipped_limit = len(skipped)
    if msg.get("import_logos"):
        result.logos_imported = len(set(extra) - skipped)
    for card in result.cards:
        data.store.cards[card.id] = card
    if result.cards:
        data.store.async_cards_changed(*result.cards)
    if data.inbox_notifier is not None:
        # §15.4: cards imported by an admin for other users reach their inbox.
        by_owner: dict[str, list[str]] = {}
        for card in result.cards:
            if card.created_by and card.owner_id != user_id:
                by_owner.setdefault(card.owner_id, []).append(card.id)
        for owner_id, ids in by_owner.items():
            data.inbox_notifier.async_add(owner_id, ids, user_id, inbox_rules.KIND_CREATED)
    connection.send_result(msg["id"], result.to_response())


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/import/sources"})
@websocket_api.async_response
@_handle_errors
async def ws_import_sources(hass, connection, msg) -> None:
    exists = await hass.async_add_executor_job(_wa_local_exists, hass.config.config_dir)
    connection.send_result(msg["id"], {"wallet_assistant_local": exists})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/export",
        vol.Required("format"): vol.In(EXPORT_FORMATS),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_export(hass, connection, msg) -> None:
    data = _data(hass)
    # Normal visibility only (§11.1): admin_all never exports others' private cards.
    actor = _actor(data, connection).normal
    cards = [copy.deepcopy(c) for c in data.store.cards.values() if can_view(c, actor)]
    icons: dict[str, bytes] = {}
    if msg["format"] == "catima":
        icons = await hass.async_add_executor_job(data.logos.read_png_many, cards)
    payload = await hass.async_add_executor_job(
        functools.partial(
            export_payload,
            msg["format"],
            cards,
            now=dt_util.utcnow(),
            tz=dt_util.get_default_time_zone(),
            icons=icons,
        )
    )
    connection.send_result(msg["id"], payload)


# ---------------------------------------------------------------- logos (§8)


def _require_domain(value: Any) -> str:
    domain = validate_domain(value)
    if not domain:
        raise ValidationError("domain is required", ERR_INVALID_FORMAT)
    return domain


def _maintenance(data: LoyaltyHubData) -> LogoMaintenance:
    if data.maintenance is None:
        raise NotFoundError("Loyalty Hub is not loaded")
    return data.maintenance


def _require_admin(connection: websocket_api.ActiveConnection) -> None:
    if not connection.user.is_admin:
        raise UnauthorizedError("Only an administrator can do this")


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/logo/upload",
        vol.Required("card_id"): str,
        vol.Required("data_base64"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_upload(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_editable(data, msg["card_id"], actor)
    blob = decode_logo_base64(msg["data_base64"])
    mime = validate_logo_bytes(blob, allow_svg=False)
    card = await async_store_logo(hass, data, card.id, "upload", mime, blob, actor=actor)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/logo/lookup",
        vol.Required("card_id"): str,
        vol.Required("provider"): vol.In(LOOKUP_PROVIDERS),
        vol.Required("domain"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_lookup(hass, connection, msg) -> None:
    """Download and save at once (§14.2 "auto": logo_dev -> website -> logoapi)."""
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_editable(data, msg["card_id"], actor)
    domain = _require_domain(msg["domain"])
    blob, mime, provider = await async_lookup_requested(hass, data, msg["provider"], domain)
    stored = await async_store_logo(
        hass, data, card.id, provider, mime, blob, domain=domain, actor=actor
    )
    names = await _user_names(hass)
    connection.send_result(
        msg["id"], {"card": _card_out(stored, _actor(data, connection), names), "provider": provider}
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/logo/preview",
        vol.Required("card_id"): str,
        vol.Required("provider"): vol.In(LOOKUP_PROVIDERS),
        vol.Required("domain"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_preview(hass, connection, msg) -> None:
    """Download and validate, never save: the candidate stays in memory for 10 min."""
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_editable(data, msg["card_id"], actor)
    domain = _require_domain(msg["domain"])
    blob, mime, provider = await async_lookup_requested(hass, data, msg["provider"], domain)
    current = data.store.cards.get(card.id)
    if current is None or not can_edit(current, actor):
        raise NotFoundError("Card was deleted")
    same = False
    if current.logo and current.logo.get("mime") == mime:
        existing = await hass.async_add_executor_job(data.logos.read, card.id, mime)
        same = existing == blob
    preview = data.previews.add(
        connection.user.id, card.id, provider, domain, mime, blob, dt_util.utcnow()
    )
    connection.send_result(
        msg["id"],
        {
            "preview_id": preview.preview_id,
            "provider": provider,
            "mime": mime,
            "data_base64": base64.b64encode(blob).decode("ascii"),
            "same": same,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/logo/apply_preview",
        vol.Required("card_id"): str,
        vol.Required("preview_id"): str,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_apply_preview(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card = _get_editable(data, msg["card_id"], actor)
    preview = data.previews.get(msg["preview_id"], connection.user.id, card.id, dt_util.utcnow())
    if preview is None:
        raise NotFoundError("Preview expired or not found")
    stored = await async_store_logo(
        hass,
        data,
        card.id,
        preview.provider,
        preview.mime,
        preview.blob,
        domain=preview.domain,
        actor=actor,
    )
    data.previews.discard(preview.preview_id)
    await _single_card_result(hass, connection, msg["id"], stored)


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/logo/delete", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_delete(hass, connection, msg) -> None:
    """§14.2: the current logo becomes the previous one (undoable with logo/revert)."""
    data = _data(hass)
    actor = _actor(data, connection)
    card_id = _get_editable(data, msg["card_id"], actor).id
    card = await async_delete_logo(hass, data, card_id, actor)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/logo/revert", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_revert(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    card_id = _get_editable(data, msg["card_id"], actor).id
    card = await async_revert_logo(hass, data, card_id, actor)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/logo/providers"})
@websocket_api.async_response
@_handle_errors
async def ws_logo_providers(hass, connection, msg) -> None:
    # Never includes the logo.dev token.
    data = _data(hass)
    connection.send_result(
        msg["id"], {"providers": data.logo_providers, "logo_dev": data.logo_dev_state}
    )


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/logo/test_key"})
@websocket_api.async_response
@_handle_errors
async def ws_logo_test_key(hass, connection, msg) -> None:
    """§14.1: test the saved Logo.dev key (admin only). The key never leaves the server."""
    _require_admin(connection)
    key = _data(hass).logo_dev_token
    result = await async_test_logo_dev_key(hass, key) if key else TEST_MISSING
    connection.send_result(msg["id"], {"result": result})


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/logo/refresh_all"})
@websocket_api.async_response
@_handle_errors
async def ws_logo_refresh_all(hass, connection, msg) -> None:
    """§14.2: own cards (admin: every card); progress via `subscribe`, counts only."""
    data = _data(hass)
    maintenance = _maintenance(data)
    user = connection.user
    total = maintenance.async_start_refresh_all(user.id, user.is_admin)
    connection.send_result(msg["id"], {"total": total})
    if total == 0:
        maintenance.async_send_progress(user.id, RefreshProgress(total=0, running=False))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/logo/cache_set",
        vol.Required("days"): vol.Any(
            None, vol.All(int, vol.Range(min=MIN_CACHE_DAYS, max=MAX_CACHE_DAYS))
        ),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_logo_cache_set(hass, connection, msg) -> None:
    """§14.2: keep online logos forever (null) or refresh them after `days` (admin)."""
    _require_admin(connection)
    days = msg["days"]
    if isinstance(days, bool):
        raise ValidationError("days must be an integer", ERR_INVALID_FORMAT)
    data = _data(hass)
    data.store.logo_cache = {"days": days}
    data.store.async_schedule_save()
    if data.maintenance is not None:
        data.maintenance.async_check_cache()
    connection.send_result(msg["id"], {"days": days})


# ---------------------------------------------------------------- shops (§14.3)


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/shops/household"})
@websocket_api.async_response
@_handle_errors
async def ws_shops_household(hass, connection, msg) -> None:
    """Shops typed by hand in the household: name, domain and color only."""
    data = _data(hass)
    connection.send_result(
        msg["id"], {"shops": household_shops(list(data.store.cards.values()))}
    )


# ---------------------------------------------------------------- trash (§12.2, §12.4)


def _trash_manager(data: LoyaltyHubData) -> TrashManager:
    if data.trash is None:
        raise NotFoundError("Loyalty Hub is not loaded")
    return data.trash


async def _trash_items_result(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg_id: int
) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    names = await _user_names(hass)
    entries = trash_rules.visible_entries(data.store.trash, actor)
    connection.send_result(msg_id, {"items": trash_rules.trash_items(entries, actor, names)})


def _own_targets(
    data: LoyaltyHubData, actor: Actor, card_id: str | None
) -> list[trash_rules.TrashEntry]:
    """One own entry (card_id given) or all of them."""
    if card_id is None:
        return trash_rules.own_entries(data.store.trash, actor)
    return [trash_rules.get_own_entry(data.store.trash, card_id, actor)]


@websocket_api.websocket_command({vol.Required("type"): "loyalty_hub/trash/list"})
@websocket_api.async_response
@_handle_errors
async def ws_trash_list(hass, connection, msg) -> None:
    await _trash_items_result(hass, connection, msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/trash/restore", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_trash_restore(hass, connection, msg) -> None:
    data = _data(hass)
    manager = _trash_manager(data)
    store = data.store
    entry = trash_rules.get_own_entry(store.trash, msg["card_id"], _actor(data, connection))
    card = trash_rules.restore(store.cards, store.trash, entry.card_id, dt_util.utcnow())
    if entry.has_pending_request:
        manager.async_clear_notification(entry)
    store.async_cards_changed(card)
    store.async_trash_changed(entry.owner_id)
    await _single_card_result(hass, connection, msg["id"], card)


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/trash/purge", vol.Optional("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_trash_purge(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    now = dt_util.utcnow()
    targets = _own_targets(data, actor, msg.get("card_id"))
    changed = [trash_rules.request_purge(e, now) for e in targets]
    if any(changed):
        data.store.async_trash_changed(connection.user.id)
    await _trash_items_result(hass, connection, msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/trash/cancel_purge", vol.Optional("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_trash_cancel_purge(hass, connection, msg) -> None:
    data = _data(hass)
    actor = _actor(data, connection)
    changed = [trash_rules.cancel_purge(e) for e in _own_targets(data, actor, msg.get("card_id"))]
    if any(changed):
        data.store.async_trash_changed(connection.user.id)
    await _trash_items_result(hass, connection, msg["id"])


@websocket_api.websocket_command(
    {vol.Required("type"): "loyalty_hub/trash/request", vol.Required("card_id"): str}
)
@websocket_api.async_response
@_handle_errors
async def ws_trash_request(hass, connection, msg) -> None:
    data = _data(hass)
    manager = _trash_manager(data)
    actor = _actor(data, connection)
    entry = trash_rules.get_entry(data.store.trash, msg["card_id"], actor)
    token = trash_rules.send_request(entry, actor, dt_util.utcnow())
    data.store.async_trash_changed(entry.owner_id)
    names = await _user_names(hass)
    notified = await manager.async_send_request(entry, names.get(connection.user.id, ""), token)
    connection.send_result(
        msg["id"],
        {"item": trash_rules.trash_item(entry, actor, names), "notified": notified},
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "loyalty_hub/trash/respond",
        vol.Required("card_id"): str,
        vol.Required("response"): vol.In(trash_rules.RESPONSES),
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_trash_respond(hass, connection, msg) -> None:
    data = _data(hass)
    manager = _trash_manager(data)
    actor = _actor(data, connection)
    entry = trash_rules.get_own_entry(data.store.trash, msg["card_id"], actor)
    card = manager.async_respond(entry, msg["response"])
    if card is not None:
        await _single_card_result(hass, connection, msg["id"], card)
        return
    names = await _user_names(hass)
    connection.send_result(msg["id"], {"item": trash_rules.trash_item(entry, actor, names)})
