// Mirrors docs/ARCHITETTURA.md §2 (Card JSON) and §5 (WebSocket payloads).

export const BARCODE_FORMATS = [
  "CODE_128", "CODE_39", "CODE_93", "CODABAR", "EAN_13", "EAN_8", "UPC_A", "UPC_E",
  "ITF", "QR_CODE", "AZTEC", "DATA_MATRIX", "PDF_417",
] as const;
export type BarcodeFormat = (typeof BARCODE_FORMATS)[number];

export type CardKind = "card" | "voucher";
export type Visibility = "private" | "shared";

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  note: string;
  user_id: string;
  /** §10.1: absent = "spend". §11.4: "adjust" has a signed amount. */
  type?: TransactionType;
  /** §11.4: name of the HA user who made it ("" if unknown). */
  user_name?: string;
}
export type TransactionType = "spend" | "topup" | "adjust";

/** Fields the client may send in create/update. */
export interface EditableCard {
  kind: CardKind;
  name: string;
  code: string;
  barcode_format: BarcodeFormat;
  color: string;
  notes: string;
  points: number | null;
  visibility: Visibility;
  shared_with: string[];
  zones: string[];
  favorite: boolean;
  expiry: string | null;
  currency: string;
  initial_balance: number | null;
  /** Shop domain for online logo lookup (§8.1). */
  logo_domain: string | null;
  logo_fit: LogoFit;
  /** §10.1: voucher can be topped up (only meaningful for kind == "voucher"). */
  reloadable: boolean;
  /** §11.10: corner of the balance pill on voucher tiles. */
  balance_corner: BalanceCorner;
  /** §11.10: size of the balance pill ("off" = hidden). */
  balance_size: BalanceSize;
  /** §14.3: shop name written by hand (not from the shop list) → may become a household shop. */
  shop_custom: boolean;
  /** §14.3: private cards only: suggest this hand-written shop to the household (default true). */
  suggest_shop: boolean;
  /** §15.3: short name shown as the group tab label (0–20 chars, shared). */
  short_name: string;
  /** §15.5 shopping_list: linked HA to-do entity (todo.*). */
  todo_entity: string | null;
  /** §15.5 points_expiry: ISO date. */
  points_expiry: string | null;
}

export type BalanceCorner = "top_left" | "bottom_left" | "bottom_right";
export type BalanceSize = "off" | "s" | "m" | "l";

/** §11.5: a shop position saved with "I'm in this shop now" (no timestamp, no user). */
export interface CardLocation { id: string; lat: number; lon: number }

export type LogoFit = "contain" | "cover";
export type LogoProvider = "logoapi" | "logo_dev" | "website";
/** §14.2: "auto" = Logo.dev (if ready) → shop website → logoapi.sh, first that works. */
export type LogoLookupProvider = LogoProvider | "auto";
export interface LogoInfo {
  source: "upload" | "logo_dev" | "logoapi" | "website" | "import";
  mime: string;
  updated_at: string;
  version: number;
  /** Domain used by the online provider (§10.4), null for upload/import. */
  domain?: string | null;
}

export interface Card extends EditableCard {
  id: string;
  owner_id: string;
  transactions: Transaction[];
  balance: number | null;
  use_count: number;
  last_used: string | null;
  created_at: string;
  updated_at: string;
  /** Server-only logo metadata (§8.1). */
  logo?: LogoInfo | null;
  /** §14.2: server-only, the one previous logo kept ("Back to the previous logo"). */
  logo_previous?: Pick<LogoInfo, "source" | "mime" | "updated_at" | "version"> | null;
  /** §11.5: server-only shop positions. */
  locations?: CardLocation[];
  /** §11.6: server-only usage counters, 42 = 7 days (Mon=0) x 6 slots of 4 h. */
  usage?: number[];
  /** Extra fields added by cards/list. */
  can_edit?: boolean;
  /** §11.1: owner only: delete, change visibility/shared_with. */
  can_manage?: boolean;
  /** §11.1: visible only thanks to the admin "see everything" option. */
  admin_view?: boolean;
  owner_name?: string;
  /** §15.5 points_history (server-only). */
  points_history?: PointsEntry[];
  /** §15.4 (server-only): creator if different from the owner, transfer info. */
  created_by?: string | null;
  created_by_name?: string;
  transferred_by_name?: string;
  transferred_at?: string | null;
}

export interface PointsEntry { date: string; points: number }

export interface UserPrefs {
  user_id: string;
  notify_service: string | null;
  zone_notifications: boolean;
  expiry_notifications: boolean;
  /** UI language tag, used by the server for notification texts (§9). */
  language?: string | null;
  /** §10.2: show price compare links (default true). */
  price_compare?: boolean;
  /** §10.2: chosen site names; null/absent = all sites configured by the admin. */
  price_compare_sites?: string[] | null;
  /** §11.5: look for nearby cards when the panel opens (default true). */
  nearby?: boolean;
  /** §11.1: admin notice epoch accepted by this user (server-only). */
  admin_notice_accepted?: number | null;
  /** §14.3: up to 2 country codes (lowercase, or "other"); null/absent = admin default. */
  countries?: string[] | null;
  // ---- §15.3 groups (per user view) ----
  grouping?: boolean;
  group_split?: string[];
  group_links?: [string, string][];
  group_tabs?: Record<string, GroupTabs>;
  /** §16.2: personal group names {group_key: name}. */
  group_names?: Record<string, string>;
  // ---- §15.4 ----
  refuse_from_others?: boolean;
  inbox_notifications?: boolean;
  // ---- §15.5 ----
  features_off?: FeatureId[];
  default_share?: DefaultShare | null;
  list_order?: ListOrder;
  manual_order?: string[];
  low_balance_threshold?: number | null;
  cashier_high_contrast?: boolean;
}

export type TabMode = "auto" | "manual";
export interface GroupTabs { mode: TabMode; order: string[] }
export type ListOrder = "habits" | "manual";
export interface DefaultShare { visibility: Visibility; shared_with: string[] }

/** §15.5: admin features (all off on a new installation). */
export const FEATURE_IDS = [
  "nfc", "shopping_list", "unused_reminder", "points_history", "points_expiry",
  "default_sharing", "manual_order", "low_balance", "find_by_code", "high_contrast_cashier",
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];
/** Features each user can turn off for themselves (UserPrefs.features_off). */
export const USER_FEATURE_IDS: readonly FeatureId[] = [
  "nfc", "shopping_list", "unused_reminder", "points_history", "points_expiry", "find_by_code",
];
export type Features = Record<FeatureId, boolean>;

/** §15.5: feature on for this user (admin switch on and not turned off by the user). */
export function featureOn(
  id: FeatureId, settings: LoyaltySettings | null | undefined, prefs: UserPrefs | null | undefined,
): boolean {
  if (!settings?.features?.[id]) return false;
  return !(USER_FEATURE_IDS.includes(id) && prefs?.features_off?.includes(id));
}

/** §15.4: inbox item (cards created for / transferred to the user). */
export interface InboxItem { card_id: string; card_name: string; by_name: string; at: string; kind: "created" | "transferred" }
/** §15.5 nfc */
export interface NfcTag { tag_id: string; card_id: string; tag_name: string }

export interface HaUser { id: string; name: string }
export interface HaZone { entity_id: string; name: string }
export interface PriceCompareSite { name: string; url: string }
export interface LogoUsage { files: number; bytes: number; max_files: number; max_bytes: number }
export interface LoyaltySettings {
  price_compare: PriceCompareSite[];
  expiry_warning_days: number;
  /** §11.1 */
  admin_full_access?: boolean;
  admin_notice_epoch?: number;
  /** §11.3: only for admins, null otherwise. */
  logo_usage?: LogoUsage | null;
  /** §14.1: Logo.dev key status (never the key itself). */
  logo_dev?: { state: LogoDevState };
  /** §14.2: online logos re-downloaded after this many days; null = kept forever. */
  logo_cache_days?: number | null;
  /** §14.3: admin's default country (lowercase code or "other"). */
  default_country?: string;
  /** §14.3: HA currency, proposed for new vouchers. */
  currency?: string;
  /** §15.5: admin feature switches (missing = off). */
  features?: Partial<Features>;
}
/** §14.1: "disabled" = provider turned off in the integration options. */
export type LogoDevState = "ready" | "no_key" | "disabled";
export const LOGO_DEV_URL = "https://www.logo.dev/";
export const LOGO_CACHE_MAX_DAYS = 365;

/** §14.1: result of logo/test_key. */
export type LogoKeyTestResult = "ok" | "rejected" | "rate_limited" | "unreachable" | "missing";

/** §14.2: logo/preview (nothing saved until apply_preview). */
export interface LogoPreview {
  preview_id: string;
  provider: LogoProvider;
  mime: string;
  data_base64: string;
  /** Same bytes as the current logo. */
  same: boolean;
}

/** §14.2: progress of logo/refresh_all (counts only). */
export interface LogoRefreshProgress { done: number; total: number; updated: number; failed: number; running: boolean }

// ---- §14.3 shops ----
export const SHOP_CATEGORIES = [
  "grocery", "discount", "pharmacy", "beauty", "fashion", "sport", "electronics", "home", "diy", "pet",
  "books", "toys", "fuel", "travel", "restaurant", "department", "optician", "other",
] as const;
export type ShopCategory = (typeof SHOP_CATEGORIES)[number];
export interface Shop {
  name: string;
  domain: string;
  color: string;
  category: ShopCategory;
  aliases?: string[];
}
/** A shop of the merged list, with the country it comes from. */
export interface CountryShop extends Shop { cc: string }
/** §14.3: hand-written shop of another card of the household (never owner, code or ids). */
export interface HouseholdShop { name: string; domain: string | null; color: string }
/** Country without a shop list. */
export const COUNTRY_OTHER = "other";
export const MAX_USER_COUNTRIES = 2;

export interface ImportResult {
  imported: number; skipped: number; errors: string[];
  /** §10.3 (wallet_assistant): items of other HA users, not imported for privacy. */
  skipped_other_users?: number;
  logos_imported?: number;
  /** §11.2: cards imported by an admin on behalf of other users (included in `imported`). */
  imported_for_others?: number;
  /** §11.3: logos not saved because the storage limit was reached. */
  logos_skipped_limit?: number;
}
export interface ExportResult { filename: string; mime: string; data_base64: string }
export type IoFormat = "catima" | "csv";
export type ImportFormat = IoFormat | "wallet_assistant";
export interface ImportSources { wallet_assistant_local: boolean }

// ---- v0.4.1 (§12) ----
/** §12.5: subscribe events. `card_ids` absent → reload everything. */
export type ChangeEvent =
  | { event: "changed"; card_ids?: string[] }
  | { event: "trash_changed" }
  | ({ event: "logo_refresh" } & LogoRefreshProgress)
  | { event: "inbox_changed" }
  | { event: "settings_changed" }
  | { event: "nfc_linked"; card_id: string };

/** §12.4: result of cards/get. */
export interface CardsGetResult { cards: Card[]; missing: string[] }

export type TrashRequestStatus = "pending" | "rejected";
export type TrashResponse = "accept" | "reject" | "block";

export interface TrashRequestInfo {
  status: TrashRequestStatus;
  admin_name: string;
  sends: number;
  max_sends: number;
  last_sent_at: string;
}

/** §12.4: a trash entry as seen by the current user (others' entries: minimal data for admins). */
export interface TrashItem {
  card_id: string;
  name: string;
  kind: CardKind;
  color: string;
  owner_id: string;
  owner_name: string;
  is_own: boolean;
  deleted_at: string;
  /** deleted_at + 15 days: final deletion. */
  expires_at: string;
  /** Owner asked to empty: final deletion at this time (15 min countdown). */
  purge_at: string | null;
  /** Only for own entries. */
  logo: Pick<LogoInfo, "version" | "mime"> | null;
  logo_fit: LogoFit;
  request: TrashRequestInfo | null;
  rejections: number;
  blocked: boolean;
  can_restore: boolean;
  can_request: boolean;
}

export const TRASH_MAX_REJECTIONS = 3;
/** §12.8: seconds before "Reject and don't ask again" can be confirmed. */
export const TRASH_BLOCK_CONFIRM_S = 10;

// ---- Minimal Home Assistant frontend types ----
export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}

export interface HassConnection {
  sendMessagePromise<T>(msg: Record<string, unknown>): Promise<T>;
  subscribeMessage<T>(
    cb: (msg: T) => void,
    msg: Record<string, unknown>,
  ): Promise<() => Promise<void> | void>;
}

export interface HomeAssistant {
  connection: HassConnection;
  user?: { id: string; name: string; is_admin?: boolean };
  language?: string;
  locale?: { language?: string };
  states: Record<string, HassEntity>;
  callWS?<T>(msg: Record<string, unknown>): Promise<T>;
}

export const DEFAULT_COLOR = "#185FA5";

/** `currency`: §14.3, the HA currency from settings. */
export function emptyCard(currency = "EUR"): EditableCard {
  return {
    kind: "card", name: "", code: "", barcode_format: "CODE_128", color: DEFAULT_COLOR, notes: "",
    points: null, visibility: "private", shared_with: [], zones: [], favorite: false, expiry: null,
    currency, initial_balance: null, logo_domain: null, logo_fit: "contain", reloadable: false,
    balance_corner: "bottom_right", balance_size: "s", shop_custom: false, suggest_shop: true,
    short_name: "", todo_entity: null, points_expiry: null,
  };
}

export function toEditable(c: Card): EditableCard {
  return {
    kind: c.kind, name: c.name, code: c.code, barcode_format: c.barcode_format, color: c.color,
    notes: c.notes ?? "", points: c.points, visibility: c.visibility,
    shared_with: [...(c.shared_with ?? [])], zones: [...(c.zones ?? [])], favorite: c.favorite,
    expiry: c.expiry, currency: c.currency || "EUR", initial_balance: c.initial_balance,
    logo_domain: c.logo_domain ?? null, logo_fit: c.logo_fit === "cover" ? "cover" : "contain",
    reloadable: !!c.reloadable,
    balance_corner: c.balance_corner ?? "bottom_right", balance_size: c.balance_size ?? "s",
    shop_custom: !!c.shop_custom, suggest_shop: c.suggest_shop !== false,
    short_name: c.short_name ?? "", todo_entity: c.todo_entity ?? null, points_expiry: c.points_expiry ?? null,
  };
}

/** Favorites first, then by use_count (desc), then name. */
export function sortCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) =>
    Number(b.favorite) - Number(a.favorite)
    || (b.use_count ?? 0) - (a.use_count ?? 0)
    || a.name.localeCompare(b.name));
}
