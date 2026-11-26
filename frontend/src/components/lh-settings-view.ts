import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  errorMessage, exportCards, getImportSources, getPrefs, getSettings, importCards, listNotifyServices, listUsers, setPrefs,
  type PrefsChanges,
} from "../api";
import { countryName, countryOptions, normalizeCountry } from "../countries";
import { buildFavoritesSheet } from "../favorites_sheet";
import { formatNumber, type Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type {
  Card, DefaultShare, FeatureId, HaUser, HomeAssistant, ImportFormat, ImportResult, IoFormat, ListOrder, LogoDevState,
  LogoRefreshProgress, LoyaltySettings, PriceCompareSite, UserPrefs,
} from "../types";
import { COUNTRY_OTHER, MAX_USER_COUNTRIES, USER_FEATURE_IDS, featureOn } from "../types";
import { base64ToBlob, defineElement, downloadBlob, fileToBase64, fireEvent, todayIso } from "../util";
import "./lh-admin-section";
import { FEATURE_LABELS, featureErrorText } from "./lh-features-section";
import { colorCandidates } from "./lh-logo-colors-dialog";
import "./lh-logo-colors-dialog";
import "./lh-refresh-all-dialog";

/** Fields accepted by prefs/set (api.ts PrefsChanges, §15 fields included). */
type AnyPrefsChanges = PrefsChanges;

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MB = 1024 * 1024;

/** WS error text; `limit_reached` (§11.3) gets a dedicated, clearer message. */
function wsError(t: Translate, err: unknown): string {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code === "limit_reached") return t("error_limit_reached", { msg: errorMessage(err) });
  return featureErrorText(t, err);
}

/**
 * Notification, nearby and price compare preferences, offline codes, logo storage, import/export.
 * §15: merged cards, cards from others, the user's "Features" and their preferences, "Color from logos".
 * Fires `show-toast` {message}, `prefs-changed` {prefs}, `cards-imported`, `open-trash` (§12.8),
 * `card-updated` {card} (from "Color from logos");
 * `settings-changed` {settings} and `logo-refresh-started` {progress} bubble up from the children (§14).
 */
export class LhSettingsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  /** Visible cards (for "Save favorite codes"). */
  @property({ attribute: false }) cards: Card[] = [];
  /** §12.8: entries in the trash visible to the user (null = unknown). */
  @property({ attribute: false }) trashCount: number | null = null;
  /** §14.2: progress of this user's "Update all logos" (from the panel subscription). */
  @property({ attribute: false }) logoRefresh: LogoRefreshProgress | null = null;
  /** §15.5: settings kept up to date by the panel (`settings_changed`); replaces the loaded ones. */
  @property({ attribute: false }) liveSettings?: LoyaltySettings;
  @state() private _refreshOpen = false;
  @state() private _colorsOpen = false;
  @state() private _users: HaUser[] = [];
  /** §15.5 default_sharing: edited value (saved only when valid). */
  @state() private _share: DefaultShare | null = null;
  @state() private _thresholdError = false;
  @state() private _settings: LoyaltySettings | null = null;
  @state() private _sheetBusy = false;
  @state() private _prefs: UserPrefs | null = null;
  @state() private _services: string[] = [];
  @state() private _error = "";
  @property() language = "en";
  @state() private _importFormat: ImportFormat = "catima";
  @state() private _sites: PriceCompareSite[] = [];
  @state() private _waLocal = false;
  @state() private _importLogos = true;
  @state() private _importResult: ImportResult | null = null;
  @state() private _importError = "";
  @state() private _busy = false;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .errors { margin: 8px 0 0; padding-left: 20px; max-height: 200px; overflow: auto; font-size: 0.9em; }
    input[type="file"] { display: none; }
    .sites { display: flex; flex-direction: column; margin: 4px 0 0 30px; }
    .sites[aria-disabled="true"] { opacity: 0.5; }
    .wa { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; margin-bottom: 8px; }
    .wa .btn { padding: 8px 18px; line-height: 1.25; text-align: center; border-radius: 22px; }
    .result {
      margin-top: 12px; padding: 12px; border-radius: 8px; border: 1px solid var(--divider-color);
      background: var(--secondary-background-color, transparent);
    }
    .result p { margin: 4px 0; }
    .result ha-icon { --mdc-icon-size: 18px; vertical-align: -3px; }
    .section > .hint { display: block; margin: 4px 0 8px; line-height: 1.4; }
    .check + .hint { margin: -4px 0 8px 30px; }
    meter { width: 100%; height: 10px; }
    .usage p { margin: 4px 0 8px; }
    h3 { font-size: 1em; font-weight: 500; margin: 16px 0 6px; }
    .feats > .check + .hint { display: block; margin: -6px 0 6px 30px; }
    .threshold { max-width: 220px; }
    .result .btn { margin-top: 8px; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    this._load();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("liveSettings") && this.liveSettings) {
      this._settings = this.liveSettings;
      this._sites = this.liveSettings.price_compare ?? [];
    }
  }

  private async _load() {
    try {
      const [prefs, services] = await Promise.all([getPrefs(this.hass), listNotifyServices(this.hass)]);
      this._prefs = prefs;
      this._share = prefs?.default_share ?? null;
      this._services = services;
      this._error = "";
    } catch (err) {
      this._error = this.t("error_generic", { msg: errorMessage(err) });
    }
    // Optional parts: older backends may not know these commands.
    getSettings(this.hass).then((st) => {
      this._settings = st;
      this._sites = st.price_compare ?? [];
    }).catch(() => undefined);
    getImportSources(this.hass).then((src) => { this._waLocal = !!src?.wallet_assistant_local; })
      .catch(() => { this._waLocal = false; });
    listUsers(this.hass).then((u) => { this._users = u; }).catch(() => undefined);
  }

  private _toggleSite(name: string, on: boolean) {
    const all = this._sites.map((s) => s.name);
    const cur = this._prefs?.price_compare_sites;
    const base = Array.isArray(cur) ? cur.filter((n) => all.includes(n)) : all;
    const next = on ? [...new Set([...base, name])] : base.filter((n) => n !== name);
    // All selected → null (= all, also future sites added by the admin).
    this._save({ price_compare_sites: all.every((n) => next.includes(n)) ? null : next });
  }

  private async _runImport(format: ImportFormat, opts: Parameters<typeof importCards>[2]) {
    this._importResult = null;
    this._importError = "";
    this._busy = true;
    try {
      this._importResult = await importCards(this.hass, format, opts);
      if (this._importResult.imported) fireEvent(this, "cards-imported");
    } catch (err) {
      this._importError = wsError(this.t, err);
    } finally {
      this._busy = false;
    }
  }

  /** §11.7: one PNG with the barcodes of the favorites, generated in the browser. */
  private async _saveFavorites() {
    this._sheetBusy = true;
    try {
      const blob = await buildFavoritesSheet(this.cards.filter((c) => c.favorite && !c.admin_view));
      downloadBlob(blob, `loyalty_hub_favorites_${todayIso()}.png`);
    } catch (err) {
      fireEvent(this, "show-toast", { message: this.t("error_generic", { msg: errorMessage(err) }) });
    } finally {
      this._sheetBusy = false;
    }
  }

  private async _save(changes: AnyPrefsChanges) {
    try {
      this._prefs = await setPrefs(this.hass, changes);
      if ("default_share" in changes) this._share = this._prefs?.default_share ?? null;
      fireEvent(this, "prefs-changed", { prefs: this._prefs });
      fireEvent(this, "show-toast", { message: this.t("saved") });
    } catch (err) {
      fireEvent(this, "show-toast", { message: featureErrorText(this.t, err) });
      this._load();
    }
  }

  private _on(id: FeatureId): boolean {
    return featureOn(id, this._settings, this._prefs);
  }

  /** §15.3: merged cards switch. */
  private _renderGrouping() {
    const t = this.t;
    const p = this._prefs;
    if (!p) return nothing;
    return html`<div class="section">
      <h2>${t("grouping_title")}</h2>
      <label class="check"><input type="checkbox" .checked=${p.grouping !== false}
        @change=${(e: Event) => this._save({ grouping: (e.target as HTMLInputElement).checked })} />
        ${t("grouping_toggle")}</label>
      <span class="hint">${t("grouping_hint")}</span>
    </div>`;
  }

  /** §15.4: cards created for me / transferred to me. */
  private _renderFromOthers() {
    const t = this.t;
    const p = this._prefs;
    if (!p) return nothing;
    return html`<div class="section">
      <h2>${t("from_others_title")}</h2>
      <label class="check"><input type="checkbox" .checked=${!!p.refuse_from_others}
        @change=${(e: Event) => this._save({ refuse_from_others: (e.target as HTMLInputElement).checked })} />
        ${t("refuse_from_others")}</label>
      <span class="hint">${t("refuse_from_others_hint")}</span>
      <label class="check"><input type="checkbox" .checked=${p.inbox_notifications !== false}
        ?disabled=${!!p.refuse_from_others}
        @change=${(e: Event) => this._save({ inbox_notifications: (e.target as HTMLInputElement).checked })} />
        ${t("inbox_notifications")}</label>
      <span class="hint">${p.notify_service ? t("inbox_notifications_hint") : t("inbox_notifications_no_service")}</span>
    </div>`;
  }

  private _toggleFeatureOff(id: FeatureId, on: boolean) {
    const cur = new Set(this._prefs?.features_off ?? []);
    if (on) cur.delete(id);
    else cur.add(id);
    this._save({ features_off: [...cur] });
  }

  private _saveThreshold(raw: string) {
    const v = raw.trim().replace(",", ".");
    if (!v) {
      this._thresholdError = false;
      this._save({ low_balance_threshold: null });
      return;
    }
    const n = Number(v);
    this._thresholdError = !(Number.isFinite(n) && n >= 0);
    if (!this._thresholdError && n !== this._prefs?.low_balance_threshold) {
      this._save({ low_balance_threshold: Math.round(n * 100) / 100 });
    }
  }

  /** Saves the default sharing when valid ("shared" needs at least one person). */
  private _setShare(next: DefaultShare | null) {
    this._share = next;
    if (next && next.visibility === "shared" && !next.shared_with.length) return;
    this._save({ default_share: next && next.visibility === "shared" ? next : null });
  }

  private _renderDefaultShare() {
    const t = this.t;
    const sh = this._share;
    const shared = sh?.visibility === "shared";
    const list = sh?.shared_with ?? [];
    const everyone = list.includes("*");
    const known = new Set(this._users.map((u) => u.id));
    const toggle = (id: string, on: boolean) => {
      const base = list.filter((x) => x !== "*" && (known.has(x) || x === id));
      this._setShare({ visibility: "shared", shared_with: on ? [...new Set([...base, id])] : base.filter((x) => x !== id) });
    };
    return html`<h3>${t("default_share_title")}</h3>
      <span class="hint">${t("default_share_hint")}</span>
      <label class="check"><input type="radio" name="dshare" .checked=${!shared}
        @change=${() => this._setShare(null)} />${t("visibility_private")}</label>
      <label class="check"><input type="radio" name="dshare" .checked=${shared}
        @change=${() => this._setShare({ visibility: "shared", shared_with: [] })} />${t("visibility_shared")}</label>
      ${shared ? html`<div class="sites">
        <label class="check"><input type="checkbox" .checked=${everyone}
          @change=${(e: Event) => this._setShare({ visibility: "shared", shared_with: (e.target as HTMLInputElement).checked ? ["*"] : [] })} />
          <strong>${t("share_everyone")}</strong></label>
        ${this._users.map((u) => html`<label class="check"><input type="checkbox" ?disabled=${everyone}
          .checked=${everyone || list.includes(u.id)}
          @change=${(e: Event) => toggle(u.id, (e.target as HTMLInputElement).checked)} />${u.name}</label>`)}
        ${this._users.length ? nothing : html`<span class="hint">${t("no_users")}</span>`}
        ${list.length ? nothing : html`<span class="error-text">${t("err_share")}</span>`}
      </div>` : nothing}`;
  }

  /** §15.5: personal switches of the features turned on by the admin, and their preferences. */
  private _renderFeatures() {
    const t = this.t;
    const p = this._prefs;
    const f = this._settings?.features;
    if (!p || !f) return nothing;
    const personal = USER_FEATURE_IDS.filter((id) => !!f[id]);
    const share = this._on("default_sharing");
    const order = this._on("manual_order");
    const low = this._on("low_balance");
    const contrast = this._on("high_contrast_cashier");
    if (!personal.length && !share && !order && !low && !contrast) return nothing;
    const off = new Set(p.features_off ?? []);
    const threshold = p.low_balance_threshold;
    return html`<div class="section feats">
      <h2>${t("features_title")}</h2>
      ${personal.length ? html`<span class="hint">${t("features_user_hint")}</span>
        ${personal.map((id) => html`<label class="check"><input type="checkbox" .checked=${!off.has(id)}
          @change=${(e: Event) => this._toggleFeatureOff(id, (e.target as HTMLInputElement).checked)} />
          ${t(FEATURE_LABELS[id].name)}</label>
          <span class="hint">${t(FEATURE_LABELS[id].hint)}</span>`)}` : nothing}
      ${share ? this._renderDefaultShare() : nothing}
      ${order ? html`<h3>${t("list_order_title")}</h3>
        <div class="field">
          <select aria-label=${t("list_order_title")} @change=${(e: Event) =>
            this._save({ list_order: (e.target as HTMLSelectElement).value as ListOrder })}>
            <option value="habits" ?selected=${p.list_order !== "manual"}>${t("list_order_habits")}</option>
            <option value="manual" ?selected=${p.list_order === "manual"}>${t("list_order_manual")}</option>
          </select>
          <span class="hint">${t("list_order_hint")}</span>
        </div>` : nothing}
      ${low ? html`<h3>${t("low_balance_title")}</h3>
        <div class="field threshold ${this._thresholdError ? "invalid" : ""}">
          <label for="lowb">${t("low_balance_threshold")}</label>
          <input id="lowb" type="text" inputmode="decimal"
            .value=${typeof threshold === "number" ? String(threshold) : ""}
            @change=${(e: Event) => this._saveThreshold((e.target as HTMLInputElement).value)} />
          ${this._thresholdError ? html`<span class="error-text">${t("low_balance_invalid")}</span>` : nothing}
          <span class="hint">${t("low_balance_hint")}</span>
        </div>` : nothing}
      ${contrast ? html`<h3>${t("feature_high_contrast_cashier")}</h3>
        <label class="check"><input type="checkbox" .checked=${!!p.cashier_high_contrast}
          @change=${(e: Event) => this._save({ cashier_high_contrast: (e.target as HTMLInputElement).checked })} />
          ${t("cashier_high_contrast")}</label>
        <span class="hint">${t("cashier_high_contrast_hint")}</span>` : nothing}
    </div>`;
  }

  private async _onImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this._importResult = null;
    this._importError = "";
    if (file.size > MAX_IMPORT_BYTES) {
      this._importError = this.t("error_generic", { msg: "> 5 MB" });
      return;
    }
    let data: string;
    try {
      data = await fileToBase64(file);
    } catch (err) {
      this._importError = this.t("error_generic", { msg: errorMessage(err) });
      return;
    }
    const wa = this._importFormat === "wallet_assistant";
    await this._runImport(this._importFormat, wa ? { dataBase64: data, importLogos: this._importLogos } : { dataBase64: data });
  }

  private async _export(format: IoFormat) {
    this._busy = true;
    try {
      const res = await exportCards(this.hass, format);
      const fallback = format === "csv" ? "loyalty_hub.csv" : "loyalty_hub_catima.zip";
      downloadBlob(base64ToBlob(res.data_base64, res.mime), res.filename || fallback);
    } catch (err) {
      fireEvent(this, "show-toast", { message: this.t("error_generic", { msg: errorMessage(err) }) });
    } finally {
      this._busy = false;
    }
  }

  private _renderNotifications() {
    const t = this.t;
    const p = this._prefs;
    if (!p) return html`<p class="muted">${this._error || t("loading")}</p>`;
    const current = p.notify_service ?? "";
    const options = current && !this._services.includes(current) ? [current, ...this._services] : this._services;
    return html`
      <div class="field">
        <label for="svc">${t("notify_service")}</label>
        <select id="svc" @change=${(e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          this._save({ notify_service: v || null });
        }}>
          <option value="" ?selected=${!current}>${t("notify_none")}</option>
          ${options.map((s) => html`<option value=${s} ?selected=${s === current}>${s}</option>`)}
        </select>
        ${this._services.length ? nothing : html`<span class="hint">${t("no_notify_services")}</span>`}
      </div>
      <label class="check"><input type="checkbox" .checked=${p.zone_notifications}
        @change=${(e: Event) => this._save({ zone_notifications: (e.target as HTMLInputElement).checked })} />
        ${t("zone_notifications")}</label>
      <label class="check"><input type="checkbox" .checked=${p.expiry_notifications}
        @change=${(e: Event) => this._save({ expiry_notifications: (e.target as HTMLInputElement).checked })} />
        ${t("expiry_notifications")}</label>
      <span class="hint">${t("zone_notify_hint")}</span>
    `;
  }

  private _renderNearby() {
    const t = this.t;
    const p = this._prefs;
    if (!p) return nothing;
    return html`<div class="section">
      <h2>${t("nearby_title")}</h2>
      <label class="check"><input type="checkbox" .checked=${p.nearby !== false}
        @change=${(e: Event) => this._save({ nearby: (e.target as HTMLInputElement).checked })} />
        ${t("nearby_toggle")}</label>
      <span class="hint">${t("nearby_privacy")}</span>
    </div>`;
  }

  private _renderOffline() {
    const t = this.t;
    const favs = this.cards.filter((c) => c.favorite && !c.admin_view).length;
    return html`<div class="section">
      <h2>${t("offline_title")}</h2>
      <span class="hint">${t("favorites_sheet_hint")}</span>
      <button class="btn" ?disabled=${this._sheetBusy || !favs} @click=${this._saveFavorites}>
        <ha-icon icon="mdi:image-move"></ha-icon>${t("favorites_sheet")}</button>
      ${favs ? nothing : html`<p class="hint">${t("favorites_sheet_none")}</p>`}
      <p class="hint">${t("offline_catima_hint")}</p>
    </div>`;
  }

  /** §11.3: logo storage usage, admins only. */
  private _renderLogoUsage() {
    const u = this._settings?.logo_usage;
    if (!u || !this.hass?.user?.is_admin) return nothing;
    const t = this.t;
    const mb = (b: number) => {
      try {
        return new Intl.NumberFormat(this.language, { maximumFractionDigits: 1 }).format(b / MB);
      } catch {
        return (b / MB).toFixed(1);
      }
    };
    const pctFiles = u.max_files > 0 ? u.files / u.max_files : 0;
    const pctBytes = u.max_bytes > 0 ? u.bytes / u.max_bytes : 0;
    return html`<div class="section usage">
      <h2>${t("logo_usage_title")}</h2>
      <p>${t("logo_usage_files", { files: formatNumber(u.files, this.language), max: formatNumber(u.max_files, this.language) })}</p>
      <meter min="0" max="1" low="0.8" high="0.95" optimum="0" .value=${pctFiles}></meter>
      <p>${t("logo_usage_space", { mb: mb(u.bytes), max: mb(u.max_bytes) })}</p>
      <meter min="0" max="1" low="0.8" high="0.95" optimum="0" .value=${pctBytes}></meter>
      <span class="hint">${t("logo_usage_hint")}</span>
    </div>`;
  }

  /** §14.1 / §14.2: Logo.dev state (never a key) and "Update all logos". */
  private _renderOnlineLogos() {
    const t = this.t;
    const isAdmin = !!this.hass?.user?.is_admin;
    const state: LogoDevState | undefined = this._settings?.logo_dev?.state;
    const p = this.logoRefresh;
    let help: string | null = null;
    if (state && state !== "ready") help = isAdmin ? t("logodev_admin_see_below") : t("logodev_ask_admin");
    return html`<div class="section">
      <h2>${t("logodev_title")}</h2>
      ${state ? html`<p>${t(`logodev_state_${state}`)}</p>` : nothing}
      ${help ? html`<p class="hint">${help}</p>` : nothing}
      <span class="hint">${isAdmin ? t("refresh_all_hint_admin") : t("refresh_all_hint_user")}</span>
      <button class="btn" @click=${() => { this._refreshOpen = true; }}>
        <ha-icon icon="mdi:image-refresh-outline"></ha-icon>${t("refresh_all_button")}</button>
      <p class="hint">${t("logo_colors_settings_hint")}</p>
      <button class="btn" @click=${() => { this._colorsOpen = true; }}>
        <ha-icon icon="mdi:palette-outline"></ha-icon>${t("logo_colors_button")}</button>
      ${p?.running ? html`<p class="hint" role="status">${t("refresh_all_running_bg", {
        done: formatNumber(p.done, this.language), total: formatNumber(p.total, this.language) })}</p>` : nothing}
      <lh-refresh-all-dialog .hass=${this.hass} .t=${t} language=${this.language} .open=${this._refreshOpen}
        .admin=${isAdmin} .progress=${p}
        @closed=${() => { this._refreshOpen = false; }}></lh-refresh-all-dialog>
    </div>`;
  }

  /** §14.3: up to 2 countries for the guided add; "" in the first selector = home default (null). */
  private _renderCountries() {
    const t = this.t;
    const p = this._prefs;
    if (!p) return nothing;
    const other = t("country_other");
    const opts = countryOptions(this.language, other);
    const chosen = (p.countries ?? []).map((c) => normalizeCountry(c)).filter((c): c is string => !!c);
    const first = chosen[0] ?? "";
    const second = chosen[1] ?? "";
    const def = normalizeCountry(this._settings?.default_country) ?? COUNTRY_OTHER;
    const save = (a: string, b: string) => {
      const list = a ? [a, ...(b && b !== a ? [b] : [])].slice(0, MAX_USER_COUNTRIES) : null;
      this._save({ countries: list });
    };
    return html`<div class="section">
      <h2>${t("countries_title")}</h2>
      <span class="hint">${t("countries_hint")}</span>
      <div class="field">
        <label for="cc1">${t("country_first")}</label>
        <select id="cc1" @change=${(e: Event) => save((e.target as HTMLSelectElement).value, second)}>
          <option value="" ?selected=${!first}>${t("country_home_default", { country: countryName(def, this.language, other) })}</option>
          ${opts.map((o) => html`<option value=${o.code} ?selected=${o.code === first}>${o.name}</option>`)}
        </select>
      </div>
      ${first ? html`<div class="field">
        <label for="cc2">${t("country_second")}</label>
        <select id="cc2" @change=${(e: Event) => save(first, (e.target as HTMLSelectElement).value)}>
          <option value="" ?selected=${!second}>${t("country_none")}</option>
          ${opts.filter((o) => o.code !== first).map((o) => html`<option value=${o.code} ?selected=${o.code === second}>
            ${o.name}</option>`)}
        </select>
      </div>` : nothing}
    </div>`;
  }

  /** §12.8: trash button and privacy text. */
  private _renderTrash() {
    const t = this.t;
    const n = this.trashCount;
    return html`<div class="section">
      <h2>${t("trash_title")}</h2>
      <span class="hint">${t("trash_privacy")}</span>
      <button class="btn" @click=${() => fireEvent(this, "open-trash")}>
        <ha-icon icon="mdi:delete-restore"></ha-icon>${t("trash_open")}</button>
      ${n ? html`<p class="hint">${t("trash_count", { count: n })}</p>` : nothing}
    </div>`;
  }

  private _renderPriceCompare() {
    const t = this.t;
    const p = this._prefs;
    if (!p || !this._sites.length) return nothing;
    const enabled = p.price_compare !== false;
    const chosen = p.price_compare_sites;
    return html`
      <div class="section">
        <h2>${t("price_compare")}</h2>
        <label class="check"><input type="checkbox" .checked=${enabled}
          @change=${(e: Event) => this._save({ price_compare: (e.target as HTMLInputElement).checked })} />
          ${t("price_compare_enable")}</label>
        <div class="sites" aria-disabled=${enabled ? "false" : "true"}>
          <span class="hint">${t("price_compare_sites")}</span>
          ${this._sites.map((s) => html`<label class="check">
            <input type="checkbox" ?disabled=${!enabled}
              .checked=${!Array.isArray(chosen) || chosen.includes(s.name)}
              @change=${(e: Event) => this._toggleSite(s.name, (e.target as HTMLInputElement).checked)} />
            ${s.name}</label>`)}
        </div>
      </div>`;
  }

  private _renderResult(r: ImportResult) {
    const t = this.t;
    return html`<div class="result" role="status">
      <p><ha-icon icon="mdi:check-circle-outline"></ha-icon>
        ${t("import_result", { imported: r.imported, skipped: r.skipped })}</p>
      ${r.logos_imported ? html`<p><ha-icon icon="mdi:image-multiple-outline"></ha-icon>
        ${t("import_logos_result", { count: r.logos_imported })}</p>` : nothing}
      ${r.imported_for_others ? html`<p><ha-icon icon="mdi:account-arrow-right-outline"></ha-icon>
        ${t("import_for_others", { count: r.imported_for_others })}</p>` : nothing}
      ${r.logos_skipped_limit ? html`<p class="error-text"><ha-icon icon="mdi:alert-outline"></ha-icon>
        ${t("import_logos_skipped_limit", { count: r.logos_skipped_limit })}</p>` : nothing}
      ${r.skipped_other_users ? html`<p><ha-icon icon="mdi:shield-account-outline"></ha-icon>
        ${t("import_other_users", { count: r.skipped_other_users })}</p>` : nothing}
      ${r.errors?.length ? html`<ul class="errors error-text">${r.errors.map((e) => html`<li>${e}</li>`)}</ul>`
        : nothing}
      ${r.imported > 0 && colorCandidates(this.cards).length ? html`<button class="btn"
        @click=${() => { this._colorsOpen = true; }}>
        <ha-icon icon="mdi:palette-outline"></ha-icon>${t("logo_colors_button")}</button>` : nothing}
    </div>`;
  }

  private _accept(): string {
    switch (this._importFormat) {
      case "csv": return ".csv,text/csv";
      case "wallet_assistant": return ".json,application/json";
      default: return ".zip,.csv,application/zip,text/csv";
    }
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const r = this._importResult;
    const wa = this._importFormat === "wallet_assistant";
    return html`
      <div class="section">
        <h2>${t("notifications")}</h2>
        ${this._renderNotifications()}
      </div>

      ${this._renderNearby()}

      ${this._renderGrouping()}

      ${this._renderFromOthers()}

      ${this._renderFeatures()}

      ${this._renderOffline()}

      ${this._renderPriceCompare()}

      ${this._renderCountries()}

      ${this._renderOnlineLogos()}

      ${this._renderLogoUsage()}
      <lh-admin-section .hass=${this.hass} .t=${t} .settings=${this._settings}
        @settings-changed=${(e: CustomEvent<{ settings: LoyaltySettings }>) => { this._settings = e.detail.settings; }}>
      </lh-admin-section>

      ${this._renderTrash()}

      <div class="section">
        <h2>${t("import")}</h2>
        <div class="field">
          <label for="ifmt">${t("import_format")}</label>
          <select id="ifmt" @change=${(e: Event) => {
            this._importFormat = (e.target as HTMLSelectElement).value as ImportFormat;
            this._importResult = null;
            this._importError = "";
          }}>
            <option value="catima" ?selected=${this._importFormat === "catima"}>${t("format_catima")}</option>
            <option value="csv" ?selected=${this._importFormat === "csv"}>${t("format_csv")}</option>
            <option value="wallet_assistant" ?selected=${wa}>${t("format_wallet_assistant")}</option>
          </select>
        </div>
        ${wa ? html`<div class="wa">
          <span class="hint">${t("import_wa_hint")}</span>
          <label class="check"><input type="checkbox" .checked=${this._importLogos}
            @change=${(e: Event) => { this._importLogos = (e.target as HTMLInputElement).checked; }} />
            ${t("import_logos")}</label>
          ${this._waLocal ? html`<button class="btn primary" ?disabled=${this._busy}
            @click=${() => this._runImport("wallet_assistant", { fromLocal: true, importLogos: this._importLogos })}>
            <ha-icon icon="mdi:home-import-outline"></ha-icon>${t("import_wa_local")}</button>` : nothing}
        </div>` : nothing}
        <button class="btn ${wa && this._waLocal ? "" : "primary"}" ?disabled=${this._busy}
          @click=${() => (this.renderRoot.querySelector("#ifile") as HTMLInputElement | null)?.click()}>
          <ha-icon icon="mdi:file-import"></ha-icon>${wa ? t("import_wa_file") : t("import_file")}
        </button>
        <input id="ifile" type="file" accept=${this._accept()} @change=${this._onImportFile} />
        ${this._busy ? html`<p class="muted">${t("loading")}</p>` : nothing}
        ${this._importError ? html`<p class="error-text">${this._importError}</p>` : nothing}
        ${r ? this._renderResult(r) : nothing}
      </div>

      <lh-logo-colors-dialog .open=${this._colorsOpen} .hass=${this.hass} .t=${t} .cards=${this.cards}
        @closed=${() => { this._colorsOpen = false; }}></lh-logo-colors-dialog>

      <div class="section">
        <h2>${t("export")}</h2>
        <div class="row">
          <button class="btn" ?disabled=${this._busy} @click=${() => this._export("catima")}>
            <ha-icon icon="mdi:folder-zip"></ha-icon>${t("export_catima")}</button>
          <button class="btn" ?disabled=${this._busy} @click=${() => this._export("csv")}>
            <ha-icon icon="mdi:file-delimited"></ha-icon>${t("export_csv")}</button>
        </div>
      </div>
    `;
  }
}

defineElement("lh-settings-view", LhSettingsView);

declare global {
  interface HTMLElementTagNameMap { "lh-settings-view": LhSettingsView }
}
