import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { createCard, createCardFor, getLogoProviders, listHouseholdShops, listUsers, lookupLogo } from "../api";
import { FORMAT_LABELS } from "../barcode";
import {
  ambiguousNames, filterHousehold, groupByCategory, isListedName, loadAllShops, loadMergedShops, normName,
  SHOPS_UPDATED, userCountries,
} from "../countries";
import type { I18nKey, Translate } from "../i18n";
import { normalizeFormat } from "../scanner";
import { sharedStyles } from "../styles";
import {
  emptyCard, featureOn, type BarcodeFormat, type Card, type CardKind, type CountryShop, type EditableCard, type HaUser,
  type HomeAssistant, type HouseholdShop, type LoyaltySettings, type UserPrefs,
} from "../types";
import { contrastText, defineElement, fireEvent, formatDate, safeColor } from "../util";
import { validateCode } from "../validation";
import "./lh-barcode";
import "./lh-card-tile";
import { errorCode, wsErrorText } from "./lh-helpers";
import "./lh-scanner-dialog";

type Step = "code" | "shop" | "done";

/** The chosen shop: from the country lists, from the household, or written by hand. */
interface Picked { name: string; domain: string | null; color: string; custom: boolean }

/** Existing card with the same code (excluding `exceptId`), for the non-blocking duplicate warning. */
export function findDuplicate(cards: Card[] | undefined, code: string, exceptId?: string): Card | undefined {
  const c = code.trim();
  if (!c || !cards) return undefined;
  return cards.find((x) => x.id !== exceptId && (x.code ?? "").trim() === c);
}

/** §15.5 default_sharing: initial visibility / sharing of my new cards (empty when off or unset). */
export function initialShare(
  settings: LoyaltySettings | null | undefined, prefs: UserPrefs | null | undefined,
): Partial<Pick<EditableCard, "visibility" | "shared_with">> {
  const d = prefs?.default_share;
  if (!d || !featureOn("default_sharing", settings, prefs)) return {};
  if (d.visibility !== "shared" || !Array.isArray(d.shared_with) || !d.shared_with.length) {
    return { visibility: "private", shared_with: [] };
  }
  return { visibility: "shared", shared_with: [...d.shared_with] };
}

/** Detail of `lh-full-form`: the data so far and, §15.4, who the card is for ("" = me). */
export interface FullFormDetail {
  data: EditableCard;
  detected: BarcodeFormat | null;
  forUser?: string;
  shareWithMe?: boolean;
}

/**
 * Guided add for a new card (§11.9, §14.3): 1) scanner right away (or manual entry), 2) shop from the
 * lists of the user's countries (chunks loaded lazily), the household shops, or a hand-written name,
 * 3) "Done" creates the card; then, with a domain and an online provider, the logo ("auto", best effort).
 * Events: `saved` {card}, `cancel`, `lh-full-form` (FullFormDetail), `show-toast` {message}.
 * §15.4: in the last step "Who is this card for?" (default me) and "Share it with me"; a card for someone
 * else is created with `createCardFor` (logo lookup in the same call); when I do not see it afterwards:
 * `lh-created-hidden`, toast and `cancel`.
 */
export class LhGuidedAdd extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  /** Visible cards, for the duplicate warning. */
  @property({ attribute: false }) cards: Card[] = [];
  /** §14.3: the user's countries come from prefs (else the admin default in settings). */
  @property({ attribute: false }) prefs?: UserPrefs | null;
  @property({ attribute: false }) settings?: LoyaltySettings;
  @state() private _step: Step = "code";
  @state() private _scanOpen = false;
  @state() private _code = "";
  @state() private _detected: BarcodeFormat | null = null;
  @state() private _query = "";
  @state() private _picked: Picked | null = null;
  @state() private _name = "";
  @state() private _kind: CardKind = "card";
  @state() private _error = "";
  @state() private _busy = false;
  /** Merged list of the user's countries (null while loading). */
  @state() private _shops: CountryShop[] | null = null;
  /** "Search in all countries" (null = not requested). */
  @state() private _allShops: CountryShop[] | null = null;
  @state() private _searchAll = false;
  @state() private _household: HouseholdShop[] = [];
  @state() private _users: HaUser[] = [];
  /** §15.4: owner of the new card ("" = me). */
  @state() private _forUser = "";
  @state() private _shareWithMe = true;
  private _countriesKey = "";
  private _hasProviders = false;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .steps { display: flex; gap: 6px; margin-bottom: 12px; }
    .steps span { flex: 1; height: 4px; border-radius: 2px; background: var(--divider-color); }
    .steps span.on { background: var(--primary-color); }
    .big { width: 100%; min-height: 56px; font-size: 1.05em; margin-bottom: 12px; }
    .code-row { display: flex; gap: 8px; }
    .code-row input { flex: 1; }
    h3 { font-size: 0.85em; font-weight: 500; color: var(--secondary-text-color); margin: 14px 0 6px; }
    .shops { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
    .shop {
      display: flex; align-items: center; justify-content: center; min-height: 52px; padding: 6px 10px;
      border-radius: 10px; border: none; cursor: pointer; font: inherit; font-weight: 700; text-align: center;
      overflow-wrap: anywhere;
    }
    .shop .cc { font-weight: 400; opacity: 0.85; white-space: nowrap; }
    .shop:focus-visible { outline: 3px solid var(--primary-color); outline-offset: 2px; }
    .free { margin-top: 8px; width: 100%; }
    .updated { font-size: 0.75em; color: var(--secondary-text-color); margin: 12px 0 0; }
    .preview { max-width: 260px; margin: 0 auto 12px; }
    .barcode-box { padding: 12px; margin-bottom: 12px; }
    .seg { display: flex; border: 1px solid var(--divider-color); border-radius: 22px; overflow: hidden; }
    .seg button {
      flex: 1; min-height: 40px; border: none; background: transparent; color: var(--primary-text-color);
      cursor: pointer; font: inherit; padding: 0 10px;
    }
    .seg button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .warn { color: var(--warning-color, #f57c00); font-size: 0.9em; display: flex; gap: 6px; align-items: center; }
    .footer { display: flex; gap: 8px; justify-content: space-between; flex-wrap: wrap; margin-top: 12px; }
    .footer .right { display: flex; gap: 8px; margin-left: auto; }
    .link { background: none; border: none; color: var(--primary-color); cursor: pointer; font: inherit; padding: 8px 0; text-decoration: underline; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    if (!this.hass) return;
    getLogoProviders(this.hass).then((p) => { this._hasProviders = p.providers.length > 0; }).catch(() => undefined);
    listHouseholdShops(this.hass).then((s) => { this._household = s; }).catch(() => undefined);
    listUsers(this.hass).then((u) => { this._users = u; }).catch(() => undefined);
  }

  protected override willUpdate(): void {
    // Lazy: only the chunks of the user's countries; reloaded if prefs/settings arrive later.
    const countries = userCountries(this.prefs, this.settings);
    const key = countries.join(",");
    if (key === this._countriesKey) return;
    this._countriesKey = key;
    this._shops = null;
    loadMergedShops(countries).then((s) => { if (this._countriesKey === key) this._shops = s; })
      .catch(() => { if (this._countriesKey === key) this._shops = []; });
  }

  protected override firstUpdated(): void {
    this._scanOpen = true; // step 1: camera right away
  }

  private get _format(): BarcodeFormat {
    return this._detected ?? "CODE_128";
  }

  /** The name was changed after picking a listed shop: custom unless it is another listed name. */
  private get _shopCustom(): boolean {
    const p = this._picked;
    if (!p || p.custom) return true;
    const name = this._name.trim();
    if (normName(name) === normName(p.name)) return false;
    const list = this._searchAll ? this._allShops : this._shops;
    return list ? !isListedName(list, name) : false;
  }

  private _data(): EditableCard {
    const p = this._picked;
    const base = emptyCard(this.settings?.currency);
    return {
      ...base,
      ...initialShare(this.settings, this.prefs),
      kind: this._kind,
      name: this._name.trim(),
      code: this._code.trim(),
      barcode_format: this._format,
      color: p ? safeColor(p.color) : base.color,
      logo_domain: p?.domain ?? null,
      shop_custom: this._shopCustom,
    };
  }

  private _onScanned(e: CustomEvent<{ code: string; format: unknown }>) {
    this._code = e.detail.code;
    this._detected = normalizeFormat(e.detail.format as string | number | null);
    this._scanOpen = false;
    this._error = "";
    this._step = "shop";
  }

  private _codeNext() {
    if (!this._code.trim()) {
      this._error = this.t("err_required");
      return;
    }
    this._error = "";
    this._step = "shop";
  }

  private _pick(p: Picked) {
    this._picked = p;
    this._name = p.name;
    this._error = "";
    this._step = "done";
  }

  private _pickCustom() {
    const name = this._query.trim();
    if (!name) return;
    this._pick({ name, domain: null, color: emptyCard().color, custom: true });
  }

  private async _searchAllCountries() {
    this._searchAll = true;
    if (this._allShops) return;
    try {
      this._allShops = await loadAllShops();
    } catch {
      this._allShops = [];
    }
  }

  private _fullForm() {
    this._scanOpen = false;
    const detail: FullFormDetail = {
      data: this._data(), detected: this._detected, forUser: this._forUser, shareWithMe: this._shareWithMe,
    };
    fireEvent(this, "lh-full-form", detail);
  }

  private async _create() {
    const t = this.t;
    const data = this._data();
    if (!data.name) {
      this._error = t("tiles_err_name");
      return;
    }
    const codeErr = validateCode(data.code, data.barcode_format, t);
    if (codeErr) {
      this._error = `${t("code")}: ${codeErr}`;
      return;
    }
    this._error = "";
    this._busy = true;
    let card: Card;
    try {
      // §14.3: currency unknown here (settings not loaded) → let the server use the HA one.
      if (!this.settings?.currency) delete (data as Partial<EditableCard>).currency;
      if (this._forOther) {
        // §15.4: the logo lookup travels in the same call (afterwards I cannot edit the card).
        const opts = this._hasProviders && data.logo_domain ? { logoLookup: true } : {};
        const created = await createCardFor(this.hass, data, this._forUser, this._shareWithMe, opts);
        const name = this._userName(this._forUser);
        this._busy = false;
        if (!created) {
          fireEvent(this, "lh-created-hidden");
          fireEvent(this, "show-toast", { message: t("tiles_created_for_hidden", { name }) });
          fireEvent(this, "cancel");
          return;
        }
        fireEvent(this, "show-toast", { message: t("tiles_created_for", { name }) });
        fireEvent(this, "saved", { card: created });
        return;
      }
      card = await createCard(this.hass, data);
    } catch (err) {
      this._error = errorCode(err) === "recipient_refuses"
        ? t("tiles_recipient_refuses", { name: this._userName(this._forUser) }) : wsErrorText(err, t);
      this._busy = false;
      return;
    }
    // §14.2: best effort, provider "auto", saved at once (no old logo to compare with).
    if (this._hasProviders && data.logo_domain) {
      try {
        card = await lookupLogo(this.hass, card.id, "auto", data.logo_domain);
      } catch (err) {
        if (errorCode(err) === "limit_reached") fireEvent(this, "show-toast", { message: wsErrorText(err, t) });
      }
    }
    this._busy = false;
    fireEvent(this, "saved", { card });
  }

  private get _forOther(): boolean {
    return !!this._forUser && this._forUser !== this.hass?.user?.id;
  }

  private _userName(id: string): string {
    return this._users.find((u) => u.id === id)?.name ?? "";
  }

  /** §15.4: "Who is this card for?" + "Share it with me". */
  private _renderForWhom() {
    const t = this.t;
    const me = this.hass?.user?.id;
    const others = this._users.filter((u) => u.id !== me);
    if (!others.length) return nothing;
    return html`<div class="field">
      <label for="gfor">${t("tiles_for_whom")}</label>
      <select id="gfor" @change=${(e: Event) => { this._forUser = (e.target as HTMLSelectElement).value; this._error = ""; }}>
        <option value="" ?selected=${!this._forUser}>${t("tiles_for_me")}</option>
        ${others.map((u) => html`<option value=${u.id} ?selected=${this._forUser === u.id}>${u.name}</option>`)}
      </select>
      ${this._forOther ? html`
        <label class="check"><input type="checkbox" .checked=${this._shareWithMe}
          @change=${(e: Event) => { this._shareWithMe = (e.target as HTMLInputElement).checked; }} />
          ${t("tiles_share_with_me")}</label>
        ${this._shareWithMe ? html`<span class="hint">${t("tiles_for_other_hint", { name: this._userName(this._forUser) })}</span>`
          : html`<span class="warn"><ha-icon icon="mdi:alert-outline"></ha-icon>${t("tiles_not_visible_warning")}</span>`}`
        : nothing}
    </div>`;
  }

  private _renderCode() {
    const t = this.t;
    return html`
      <h2>${t("tiles_guided_scan_title")}</h2>
      <button class="btn primary big" @click=${() => { this._scanOpen = true; }}>
        <ha-icon icon="mdi:barcode-scan"></ha-icon>${t("tiles_guided_scan")}</button>
      <div class="field ${this._error ? "invalid" : ""}">
        <label for="gcode">${t("tiles_guided_manual")}</label>
        <div class="code-row">
          <input id="gcode" type="text" maxlength="512" autocomplete="off" .value=${this._code}
            @input=${(e: Event) => { this._code = (e.target as HTMLInputElement).value; this._detected = null; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this._codeNext(); }} />
          <button class="btn" @click=${this._codeNext}>${t("tiles_next")}</button>
        </div>
        ${this._error ? html`<span class="error-text">${this._error}</span>` : nothing}
      </div>`;
  }

  private _shopButton(name: string, color: string, onPick: () => void, cc?: string) {
    const bg = safeColor(color);
    return html`<button class="shop" style="background:${bg};color:${contrastText(bg)}" @click=${onPick}>
      <span>${name}${cc ? html`<span class="cc"> · ${cc.toUpperCase()}</span>` : nothing}</span></button>`;
  }

  private _renderShop() {
    const t = this.t;
    const q = this._query.trim();
    const list = this._searchAll ? this._allShops : this._shops;
    const loading = list === null;
    const groups = list ? groupByCategory(list, q) : [];
    const ambiguous = list ? ambiguousNames(list) : new Set<string>();
    const household = filterHousehold(this._household, q);
    const noResults = !loading && !groups.length && !household.length;
    return html`
      <h2>${t("tiles_guided_shop_title")}</h2>
      <div class="field">
        <input type="search" .value=${this._query} placeholder=${t("tiles_guided_shop_search")}
          aria-label=${t("tiles_guided_shop_search")} autocomplete="off"
          @input=${(e: Event) => { this._query = (e.target as HTMLInputElement).value; }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key !== "Enter" || !q) return;
            const only = groups.length === 1 && groups[0].shops.length === 1 && !household.length ? groups[0].shops[0] : null;
            if (only) this._pick({ name: only.name, domain: only.domain, color: only.color, custom: false });
            else this._pickCustom();
          }} />
      </div>
      ${q ? html`<button class="btn free" @click=${this._pickCustom}>
        <ha-icon icon="mdi:pencil"></ha-icon>${t("tiles_guided_free_name", { name: q })}</button>` : nothing}
      ${household.length ? html`<h3>${t("tiles_guided_household")}</h3>
        <div class="shops">${household.map((s) => this._shopButton(s.name, s.color,
          () => this._pick({ name: s.name, domain: s.domain, color: s.color, custom: true })))}</div>` : nothing}
      ${groups.map((g) => html`<h3>${t(`shop_category_${g.category}` as I18nKey)}</h3>
        <div class="shops">${g.shops.map((s) => this._shopButton(s.name, s.color,
          () => this._pick({ name: s.name, domain: s.domain, color: s.color, custom: false }),
          this._searchAll || ambiguous.has(normName(s.name)) ? s.cc : undefined))}</div>`)}
      ${loading ? html`<p class="muted">${t("tiles_guided_loading")}</p>` : nothing}
      ${noResults && q ? html`<p class="muted">${t("tiles_guided_no_shop")}</p>` : nothing}
      ${noResults && !this._searchAll ? html`<button class="btn free" @click=${this._searchAllCountries}>
        <ha-icon icon="mdi:earth"></ha-icon>${t("tiles_guided_search_all")}</button>` : nothing}
      <p class="updated">${t("tiles_guided_list_date", { date: formatDate(SHOPS_UPDATED, this.language) })}</p>`;
  }

  private _renderDone() {
    const t = this.t;
    const d = this._data();
    const preview = {
      ...d, id: "preview", owner_id: "", transactions: [], balance: null, use_count: 0, last_used: null,
      created_at: "", updated_at: "", name: d.name || "?",
    } as Card;
    const dup = findDuplicate(this.cards, d.code);
    return html`
      <h2>${t("tiles_guided_done_title")}</h2>
      <div class="preview"><lh-card-tile layout="large" .card=${preview} .hass=${this.hass} .t=${t}
        language=${this.language}></lh-card-tile></div>
      <div class="field">
        <label for="gname">${t("name")}</label>
        <input id="gname" type="text" maxlength="80" .value=${this._name}
          @input=${(e: Event) => { this._name = (e.target as HTMLInputElement).value; }} />
      </div>
      <div class="field">
        <span class="label">${t("kind")}</span>
        <div class="seg" role="group">
          <button type="button" aria-pressed=${this._kind === "card"} @click=${() => { this._kind = "card"; }}>
            ${t("kind_card")}</button>
          <button type="button" aria-pressed=${this._kind === "voucher"} @click=${() => { this._kind = "voucher"; }}>
            ${t("kind_voucher")}</button>
        </div>
      </div>
      ${this._renderForWhom()}
      <div class="barcode-box">
        <lh-barcode .code=${d.code} .format=${d.barcode_format}
          error-text=${t("render_error", { format: FORMAT_LABELS[d.barcode_format] })}></lh-barcode>
        <div class="code-text">${d.code}</div>
        <span class="hint">${FORMAT_LABELS[d.barcode_format]}</span>
      </div>
      ${dup ? html`<p class="warn"><ha-icon icon="mdi:alert-outline"></ha-icon>${t("tiles_duplicate", { name: dup.name })}</p>`
        : nothing}
      ${this._kind === "voucher" ? html`<p class="hint">${t("tiles_guided_voucher_hint")}</p>` : nothing}
      ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}`;
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const idx = ["code", "shop", "done"].indexOf(this._step);
    return html`
      <div class="section">
        <div class="steps" aria-hidden="true">${[0, 1, 2].map((i) => html`<span class=${i <= idx ? "on" : ""}></span>`)}</div>
        ${this._step === "code" ? this._renderCode() : this._step === "shop" ? this._renderShop() : this._renderDone()}
        <div class="footer">
          <button class="link" @click=${this._fullForm}>${t("tiles_guided_full_form")}</button>
          <div class="right">
            ${idx > 0 ? html`<button class="btn" @click=${() => { this._error = ""; this._step = idx === 2 ? "shop" : "code"; }}>
              ${t("back")}</button>` : html`<button class="btn" @click=${() => fireEvent(this, "cancel")}>${t("cancel")}</button>`}
            ${this._step === "done" ? html`<button class="btn primary" ?disabled=${this._busy} @click=${this._create}>
              <ha-icon icon="mdi:check"></ha-icon>${t("tiles_done")}</button>` : nothing}
          </div>
        </div>
      </div>
      <lh-scanner-dialog .open=${this._scanOpen} .t=${t} @scanned=${this._onScanned}
        @closed=${() => { this._scanOpen = false; }}></lh-scanner-dialog>
    `;
  }
}

defineElement("lh-guided-add", LhGuidedAdd);

declare global {
  interface HTMLElementTagNameMap { "lh-guided-add": LhGuidedAdd }
}
