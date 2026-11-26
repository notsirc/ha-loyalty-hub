// Typed wrappers for every WebSocket command in docs/ARCHITETTURA.md §5.
import type {
  Card, CardsGetResult, ChangeEvent, EditableCard, ExportResult, HaUser, HaZone, HomeAssistant, ImportFormat, ImportResult,
  HouseholdShop, ImportSources, IoFormat, LogoDevState, LogoKeyTestResult, LogoLookupProvider, LogoPreview, LogoProvider,
  Features, InboxItem, LogoRefreshProgress, LoyaltySettings, NfcTag, TransactionType, TrashItem, TrashResponse, UserPrefs,
} from "./types";

const D = "loyalty_hub";

function send<T>(hass: HomeAssistant, type: string, payload: Record<string, unknown> = {}): Promise<T> {
  return hass.connection.sendMessagePromise<T>({ type: `${D}/${type}`, ...payload });
}

export const listCards = async (hass: HomeAssistant) =>
  (await send<{ cards: Card[] }>(hass, "cards/list")).cards ?? [];

/** Own card. §15.4: `logoUpload` (base64) or `logoLookup` save a logo in the same call. */
export interface LogoOnCreate { logoUpload?: string; logoLookup?: boolean }
function logoPayload(payload: Record<string, unknown>, opts: LogoOnCreate) {
  if (opts.logoUpload) payload.logo_upload = opts.logoUpload;
  if (opts.logoLookup) payload.logo_lookup = true;
  return payload;
}
export const createCard = async (hass: HomeAssistant, card: EditableCard, opts: LogoOnCreate = {}) =>
  (await send<{ card: Card }>(hass, "cards/create", logoPayload({ card }, opts))).card;

/**
 * §15.4: card for another user. Sharing is decided only by `shareWithMe` (visibility/shared_with
 * are not sent). Result null = I do not see the card (not shared with me).
 */
export const createCardFor = async (
  hass: HomeAssistant, card: EditableCard, forUserId: string, shareWithMe = true, opts: LogoOnCreate = {},
) => {
  const { visibility: _v, shared_with: _s, ...rest } = card;
  const payload = logoPayload({ card: rest, for_user_id: forUserId, share_with_me: shareWithMe }, opts);
  return (await send<{ card: Card | null }>(hass, "cards/create", payload)).card;
};

/** §15.4: owner only. Result null = I no longer see the card. */
export const transferCard = async (hass: HomeAssistant, cardId: string, toUserId: string, keepSharedWithMe = true) =>
  (await send<{ card: Card | null }>(hass, "cards/transfer", {
    card_id: cardId, to_user_id: toUserId, keep_shared_with_me: keepSharedWithMe,
  })).card;

/** §15.5 points_history */
export const clearPointsHistory = async (hass: HomeAssistant, cardId: string) =>
  (await send<{ card: Card }>(hass, "cards/clear_points_history", { card_id: cardId })).card;

export const updateCard = async (hass: HomeAssistant, cardId: string, changes: Partial<EditableCard>) =>
  (await send<{ card: Card }>(hass, "cards/update", { card_id: cardId, changes })).card;

export const deleteCard = (hass: HomeAssistant, cardId: string) =>
  send<Record<string, never>>(hass, "cards/delete", { card_id: cardId });

export const markUsed = async (hass: HomeAssistant, cardId: string) =>
  (await send<{ card: Card }>(hass, "cards/mark_used", { card_id: cardId })).card;

export const addTransaction = async (
  hass: HomeAssistant, cardId: string, amount: number, note?: string, date?: string,
  type: TransactionType = "spend",
) => {
  const payload: Record<string, unknown> = { card_id: cardId, amount };
  // §10.1: `type` is the WS command name, the transaction type travels as `tx_type`.
  if (type !== "spend") payload.tx_type = type;
  if (note) payload.note = note;
  if (date) payload.date = date;
  return (await send<{ card: Card }>(hass, "voucher/add_transaction", payload)).card;
};

export const deleteTransaction = async (hass: HomeAssistant, cardId: string, transactionId: string) =>
  (await send<{ card: Card }>(hass, "voucher/delete_transaction", {
    card_id: cardId, transaction_id: transactionId,
  })).card;

/**
 * Subscribes to change events; resolves to the unsubscribe function.
 * §12.5: `cb` receives the changed card ids, or null when everything must be reloaded.
 * `onTrash` (optional) is called on `trash_changed`.
 * `onLogoRefresh` (optional, §14.2) receives the progress of this user's logo/refresh_all.
 * `extra` (optional, §15): inbox, settings (features) and NFC link events.
 */
export interface ExtraEvents {
  onInbox?: () => void;
  onSettings?: () => void;
  onNfcLinked?: (cardId: string) => void;
}
export const subscribeChanges = (
  hass: HomeAssistant, cb: (cardIds: string[] | null) => void, onTrash?: () => void,
  onLogoRefresh?: (p: LogoRefreshProgress) => void, extra?: ExtraEvents,
) =>
  hass.connection.subscribeMessage<Partial<ChangeEvent> & { event?: string; card_ids?: unknown }>((msg) => {
    if (msg?.event === "changed") {
      const ids = Array.isArray(msg.card_ids) && msg.card_ids.every((x) => typeof x === "string")
        ? (msg.card_ids as string[]) : null;
      cb(ids && ids.length ? ids : null);
    } else if (msg?.event === "trash_changed") {
      onTrash?.();
    } else if (msg?.event === "logo_refresh") {
      const m = msg as Partial<LogoRefreshProgress>;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      onLogoRefresh?.({ done: n(m.done), total: n(m.total), updated: n(m.updated), failed: n(m.failed), running: !!m.running });
    } else if (msg?.event === "inbox_changed") {
      extra?.onInbox?.();
    } else if (msg?.event === "settings_changed") {
      extra?.onSettings?.();
    } else if (msg?.event === "nfc_linked") {
      const id = (msg as { card_id?: unknown }).card_id;
      if (typeof id === "string") extra?.onNfcLinked?.(id);
    }
  }, { type: `${D}/subscribe` });

/** §12.4: only the given cards (visible ones in `cards`, the others in `missing`). */
export const getCards = (hass: HomeAssistant, cardIds: string[]) =>
  send<CardsGetResult>(hass, "cards/get", { card_ids: cardIds });

/**
 * §12.5: debounced (250 ms) application of change events to a card list.
 * `apply(cards)` receives the new full list. Falls back to `listCards` when ids are unknown
 * or `cards/get` fails. `full` is true when the whole list was reloaded.
 */
export class ChangeBatcher {
  private _ids = new Set<string>();
  private _all = false;
  private _timer?: number;
  constructor(
    private readonly _hass: () => HomeAssistant,
    private readonly _current: () => Card[],
    private readonly _apply: (cards: Card[], full: boolean) => void,
    private readonly _onError: (err: unknown) => void = () => undefined,
    private readonly _delay = 250,
  ) {}

  /** null = reload everything. */
  push(cardIds: string[] | null): void {
    if (cardIds === null) this._all = true;
    else cardIds.forEach((id) => this._ids.add(id));
    clearTimeout(this._timer);
    this._timer = window.setTimeout(() => this._flush(), this._delay);
  }

  cancel(): void {
    clearTimeout(this._timer);
    this._ids.clear();
    this._all = false;
  }

  private async _flush() {
    const all = this._all;
    const ids = [...this._ids];
    this._ids.clear();
    this._all = false;
    const hass = this._hass();
    if (!hass) return;
    try {
      if (all || ids.length > 200) {
        this._apply(await listCards(hass), true);
        return;
      }
      if (!ids.length) return;
      let res: CardsGetResult;
      try {
        res = await getCards(hass, ids);
      } catch {
        this._apply(await listCards(hass), true);
        return;
      }
      const gone = new Set([...res.missing, ...ids.filter((id) => !res.cards.some((c) => c.id === id))]);
      const byId = new Map(res.cards.map((c) => [c.id, c]));
      const next = this._current().filter((c) => !gone.has(c.id) || byId.has(c.id)).map((c) => byId.get(c.id) ?? c);
      for (const c of res.cards) if (!next.some((x) => x.id === c.id)) next.push(c);
      next.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      this._apply(next, false);
    } catch (err) {
      this._onError(err);
    }
  }
}

// ---- Trash (§12.2–12.4) ----
export const listTrash = async (hass: HomeAssistant) =>
  (await send<{ items: TrashItem[] }>(hass, "trash/list")).items ?? [];

export const restoreFromTrash = async (hass: HomeAssistant, cardId: string) =>
  (await send<{ card: Card }>(hass, "trash/restore", { card_id: cardId })).card;

/** Without cardId: all own entries. Starts the 15 min countdown. */
export const purgeTrash = async (hass: HomeAssistant, cardId?: string) =>
  (await send<{ items: TrashItem[] }>(hass, "trash/purge", cardId ? { card_id: cardId } : {})).items ?? [];

export const cancelPurgeTrash = async (hass: HomeAssistant, cardId?: string) =>
  (await send<{ items: TrashItem[] }>(hass, "trash/cancel_purge", cardId ? { card_id: cardId } : {})).items ?? [];

/** Admin: ask the owner to restore their card. */
export const requestTrashRestore = (hass: HomeAssistant, cardId: string) =>
  send<{ item: TrashItem; notified: boolean }>(hass, "trash/request", { card_id: cardId });

/** Owner: answer an admin's request. "accept" returns {card}, the others {item}. */
export const respondTrashRequest = (hass: HomeAssistant, cardId: string, response: TrashResponse) =>
  send<{ card?: Card; item?: TrashItem }>(hass, "trash/respond", { card_id: cardId, response });

export const listUsers = async (hass: HomeAssistant) =>
  (await send<{ users: HaUser[] }>(hass, "users")).users ?? [];

export const listZones = async (hass: HomeAssistant) =>
  (await send<{ zones: HaZone[] }>(hass, "zones")).zones ?? [];

export const listNotifyServices = async (hass: HomeAssistant) =>
  (await send<{ services: string[] }>(hass, "notify_services")).services ?? [];

export const getPrefs = async (hass: HomeAssistant) =>
  (await send<{ prefs: UserPrefs }>(hass, "prefs/get")).prefs;

export type PrefsChanges = Partial<Pick<UserPrefs,
  "notify_service" | "zone_notifications" | "expiry_notifications" | "language" | "price_compare"
  | "price_compare_sites" | "nearby" | "countries"
  // §15.3–15.5
  | "grouping" | "group_split" | "group_links" | "group_tabs" | "group_names" | "refuse_from_others" | "inbox_notifications"
  | "features_off" | "default_share" | "list_order" | "manual_order" | "low_balance_threshold"
  | "cashier_high_contrast">>;

export const setPrefs = async (hass: HomeAssistant, prefs: PrefsChanges) =>
  (await send<{ prefs: UserPrefs }>(hass, "prefs/set", { prefs })).prefs;

// ---- v0.4 (§11) ----
export const addLocation = async (hass: HomeAssistant, cardId: string, latitude: number, longitude: number) =>
  (await send<{ card: Card }>(hass, "cards/add_location", { card_id: cardId, latitude, longitude })).card;

export const removeLocation = async (hass: HomeAssistant, cardId: string, locationId: string) =>
  (await send<{ card: Card }>(hass, "cards/remove_location", { card_id: cardId, location_id: locationId })).card;

/** §11.4: the server records an "adjust" transaction = newBalance − current balance. */
export const adjustBalance = async (hass: HomeAssistant, cardId: string, newBalance: number, reason: string) =>
  (await send<{ card: Card }>(hass, "voucher/adjust_balance", {
    card_id: cardId, new_balance: newBalance, reason,
  })).card;

export const acceptAdminNotice = async (hass: HomeAssistant) =>
  (await send<{ prefs: UserPrefs }>(hass, "admin_notice/accept")).prefs;

export const getSettings = (hass: HomeAssistant) => send<LoyaltySettings>(hass, "settings");

export interface ImportOptions { dataBase64?: string; fromLocal?: boolean; importLogos?: boolean }

export const importCards = (hass: HomeAssistant, format: ImportFormat, opts: ImportOptions) => {
  const payload: Record<string, unknown> = { format };
  if (opts.dataBase64 !== undefined) payload.data_base64 = opts.dataBase64;
  if (opts.fromLocal) payload.from_local = true;
  if (opts.importLogos !== undefined) payload.import_logos = opts.importLogos;
  return send<ImportResult>(hass, "import", payload);
};

/** §10.3: which local import sources exist on this HA instance. */
export const getImportSources = (hass: HomeAssistant) => send<ImportSources>(hass, "import/sources");

export const exportCards = (hass: HomeAssistant, format: IoFormat) =>
  send<ExportResult>(hass, "export", { format });

// ---- Logos (§8) ----
export const uploadLogo = async (hass: HomeAssistant, cardId: string, dataBase64: string) =>
  (await send<{ card: Card }>(hass, "logo/upload", { card_id: cardId, data_base64: dataBase64 })).card;

/** §14.2: saves at once (current logo becomes the previous one). Provider "auto" = first that works. */
export const lookupLogo = async (hass: HomeAssistant, cardId: string, provider: LogoLookupProvider, domain: string) =>
  (await send<{ card: Card }>(hass, "logo/lookup", { card_id: cardId, provider, domain })).card;

/** §14.2: the current logo becomes the previous one (so a delete can be undone with revertLogo). */
export const deleteLogo = async (hass: HomeAssistant, cardId: string) =>
  (await send<{ card: Card }>(hass, "logo/delete", { card_id: cardId })).card;

/** §14.1: enabled providers (logo_dev only when "ready") and the Logo.dev state. */
export const getLogoProviders = async (hass: HomeAssistant) => {
  const res = await send<{ providers?: LogoProvider[]; logo_dev?: LogoDevState }>(hass, "logo/providers");
  return { providers: res.providers ?? [], logo_dev: res.logo_dev ?? "no_key" as LogoDevState };
};
export const listLogoProviders = async (hass: HomeAssistant) => (await getLogoProviders(hass)).providers;

/** §14.2: download without saving; keep `preview_id` for applyLogoPreview (valid 10 min). */
export const previewLogo = (hass: HomeAssistant, cardId: string, provider: LogoLookupProvider, domain: string) =>
  send<LogoPreview>(hass, "logo/preview", { card_id: cardId, provider, domain });

export const applyLogoPreview = async (hass: HomeAssistant, cardId: string, previewId: string) =>
  (await send<{ card: Card }>(hass, "logo/apply_preview", { card_id: cardId, preview_id: previewId })).card;

/** §14.2: swap current ↔ previous logo. */
export const revertLogo = async (hass: HomeAssistant, cardId: string) =>
  (await send<{ card: Card }>(hass, "logo/revert", { card_id: cardId })).card;

/** §14.2: background refresh (own cards; admin: every card). Progress via subscribeChanges. */
export const refreshAllLogos = (hass: HomeAssistant) => send<{ total: number }>(hass, "logo/refresh_all");

/** §14.2 (admin): null = keep forever, otherwise 1–365 days. */
export const setLogoCache = async (hass: HomeAssistant, days: number | null) =>
  (await send<{ days: number | null }>(hass, "logo/cache_set", { days })).days;

/** §14.1 (admin): one test request with the saved Logo.dev key. */
export const testLogoKey = async (hass: HomeAssistant) =>
  (await send<{ result: LogoKeyTestResult }>(hass, "logo/test_key")).result;

// ---- Shops (§14.3) ----
export const listHouseholdShops = async (hass: HomeAssistant) =>
  (await send<{ shops: HouseholdShop[] }>(hass, "shops/household")).shops ?? [];

// ---- §15.4 inbox ----
export const listInbox = async (hass: HomeAssistant) =>
  (await send<{ items: InboxItem[] }>(hass, "inbox/list")).items ?? [];
export const dismissInbox = (hass: HomeAssistant) => send<Record<string, never>>(hass, "inbox/dismiss");

// ---- §15.5 features (admin) ----
export const setFeatures = async (hass: HomeAssistant, features: Partial<Features>) =>
  (await send<{ features: Partial<Features> }>(hass, "features/set", { features })).features;

// ---- §15.5 nfc ----
export const nfcLinkStart = (hass: HomeAssistant, cardId: string) =>
  send<{ expires_at: string }>(hass, "nfc/link_start", { card_id: cardId });
export const nfcList = async (hass: HomeAssistant) =>
  (await send<{ tags: NfcTag[] }>(hass, "nfc/list")).tags ?? [];
export const nfcUnlink = async (hass: HomeAssistant, tagId: string) =>
  (await send<{ tags: NfcTag[] }>(hass, "nfc/unlink", { tag_id: tagId })).tags ?? [];

// ---- §15.5 shopping_list: HA core to-do API (read only) ----
export interface TodoItem { uid: string; summary: string; status: "needs_action" | "completed" }
export const todoItems = async (hass: HomeAssistant, entityId: string) =>
  (await hass.connection.sendMessagePromise<{ items: TodoItem[] }>({ type: "todo/item/list", entity_id: entityId })).items ?? [];

/** HA core `auth/sign_path`: returns a short-lived signed path usable in <img src>. */
export async function signPath(hass: HomeAssistant, path: string, expires = 86400): Promise<string> {
  const msg = { type: "auth/sign_path", path, expires };
  const res = hass.callWS
    ? await hass.callWS<{ path: string }>(msg)
    : await hass.connection.sendMessagePromise<{ path: string }>(msg);
  return res.path;
}

/** Extracts a human readable message from a WS error ({code, message}) or Error. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.code === "string") return e.code;
  }
  return String(err);
}
