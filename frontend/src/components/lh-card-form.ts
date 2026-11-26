import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { createCard, createCardFor, errorMessage, listUsers, listZones, updateCard } from "../api";
import { FORMAT_LABELS } from "../barcode";
import { isListedName, loadMergedShops, userCountries } from "../countries";
import type { Translate } from "../i18n";
import { normalizeFormat } from "../scanner";
import { sharedStyles } from "../styles";
import {
  BARCODE_FORMATS, emptyCard, featureOn, toEditable, type BalanceCorner, type BalanceSize, type BarcodeFormat, type Card,
  type CountryShop, type EditableCard, type HaUser, type HaZone, type HomeAssistant, type LogoFit, type LoyaltySettings,
  type UserPrefs,
} from "../types";
import { defineElement, fireEvent, safeColor } from "../util";
import { parseNumber, validateCard, type FieldErrors } from "../validation";
import "./lh-barcode";
import "./lh-guided-add";
import { findDuplicate, initialShare, type FullFormDetail } from "./lh-guided-add";
import { errorCode, wsErrorText } from "./lh-helpers";
import "./lh-scanner-dialog";
import "./lh-logo-editor";
import type { LhLogoEditor } from "./lh-logo-editor";

const PRESET_COLORS = [
  "#185FA5", "#C62828", "#2E7D32", "#F9A825", "#6A1B9A", "#EF6C00", "#00838F", "#37474F",
];
const AUTO = "__auto__";

/** Fields shown in the collapsible "More" section (opened on submit if one of them is invalid). */
const MORE_FIELDS: (keyof FieldErrors)[] = [
  "color", "logo_domain", "points_raw", "expiry", "notes", "shared_with", "zones", "visibility",
];
const CORNERS: BalanceCorner[] = ["top_left", "bottom_left", "bottom_right"];
const SIZES: BalanceSize[] = ["off", "s", "m", "l"];

/**
 * Add / edit form. New cards start with the guided add (`lh-guided-add`, §11.9), which can switch
 * to this full form. Essentials on top, everything else in a collapsible "More" section.
 * Events: `saved` {card}, `cancel`, `card-updated` {card}, `show-toast` {message},
 * `lh-request-delete` {card} (edit only, `can_manage`; the panel deletes with undo).
 * Property `dirty` (read-only, §12.6): true when the fields differ from the initial ones.
 * §14.3: `prefs` / `settings` (from the panel) give the user's countries (shop list, forwarded to the
 * guided add) and the HA currency proposed for new cards. Renaming a card to a name not in the loaded
 * list sets `shop_custom`; private hand-written shops get the "suggest to the household" checkbox.
 * §15.4 (new cards): "Who is this card for?" (default me). For someone else: "Share it with me" (checked,
 * warning when unchecked), no sharing section, created with `createCardFor` (logo in the same call);
 * result null (not visible to me) → toast + `cancel`. §15.3 `short_name`, §15.5 `todo_entity`
 * (shopping_list), `points_expiry` (points_expiry), initial sharing from `prefs.default_share` (default_sharing).
 */
export class LhCardForm extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  /** Card being edited; null/undefined = new card. */
  @property({ attribute: false }) card: Card | null = null;
  @property() language = "en";
  /** Visible cards (from the panel), for the non-blocking duplicate code warning. */
  @property({ attribute: false }) cards: Card[] = [];
  /** §14.3: user prefs (countries) and integration settings (default country, currency). */
  @property({ attribute: false }) prefs?: UserPrefs | null;
  @property({ attribute: false }) settings?: LoyaltySettings;
  @state() private _guided = true;
  @state() private _moreOpen = false;
  @state() private _colorTouched = false;
  @state() private _colorFromLogo = false;
  @query("lh-logo-editor") private _logoEditor?: LhLogoEditor;
  @state() private _data: EditableCard = emptyCard();
  @state() private _auto = true;
  @state() private _detected: BarcodeFormat | null = null;
  @state() private _points = "";
  @state() private _balance = "";
  @state() private _errors: FieldErrors = {};
  @state() private _submitError = "";
  @state() private _users: HaUser[] = [];
  @state() private _zones: HaZone[] = [];
  @state() private _scanOpen = false;
  @state() private _busy = false;
  /** §15.4: owner of the new card ("" = me). */
  @state() private _forUser = "";
  @state() private _shareWithMe = true;
  /** Snapshot of the initial fields, compared by `dirty`. */
  private _initial = "";
  /** Guided add (new card): the user typed, scanned or picked something. */
  private _guidedTouched = false;
  /** Set after a successful save: nothing is left to lose. */
  private _saved = false;
  /** §14.3: shop list of the user's countries, loaded on the first name change (null = not loaded). */
  private _shopList: CountryShop[] | null = null;
  private _shopListKey = "";

  /**
   * §12.6: true when the fields differ from the initial ones (new card: something entered;
   * edit: something changed). The panel reads it before leaving the form.
   */
  get dirty(): boolean {
    if (this._saved) return false;
    if (!this.card && this._guided) return this._guidedTouched;
    return this._snapshot() !== this._initial;
  }

  private _snapshot(): string {
    const d = this._data;
    const sorted = (a: string[]) => [...a].sort();
    return JSON.stringify({
      ...d, shared_with: sorted(d.shared_with), zones: sorted(d.zones),
      name: d.name.trim(), code: d.code.trim(), notes: d.notes.trim(),
      currency: d.currency.trim().toUpperCase(), logo_domain: d.logo_domain?.trim().toLowerCase() || null,
      expiry: d.expiry || null,
      barcode_format: this._effectiveFormat, _points: this._points.trim(), _balance: this._balance.trim(),
      _for: this._forUser, _share_me: this._shareWithMe,
    });
  }

  private _onGuidedTouch = () => { this._guidedTouched = true; };

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .code-row { display: flex; gap: 8px; }
    .code-row input { flex: 1; }
    .swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .swatch {
      width: 36px; height: 36px; border-radius: 50%; cursor: pointer; padding: 0;
      border: 2px solid var(--card-background-color); box-shadow: 0 0 0 1px var(--divider-color);
    }
    .swatch[aria-pressed="true"] { box-shadow: 0 0 0 3px var(--primary-color); }
    input[type="color"] { width: 44px; height: 36px; border: none; padding: 0; background: none; cursor: pointer; }
    .seg { display: flex; border: 1px solid var(--divider-color); border-radius: 22px; overflow: hidden; }
    .seg button {
      flex: 1; min-height: 40px; border: none; background: transparent; color: var(--primary-text-color);
      cursor: pointer; font: inherit; padding: 0 10px;
    }
    .seg button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .checks { display: flex; flex-direction: column; border: 1px solid var(--divider-color); border-radius: 8px; padding: 4px 12px; }
    .preview { margin-bottom: 14px; }
    .barcode-box { padding: 12px; }
    .footer { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 8px; }
    .footer .spacer { flex: 1; }
    .warn { color: var(--warning-color, #f57c00); font-size: 0.85em; display: flex; gap: 6px; align-items: center; }
    .warn ha-icon { --mdc-icon-size: 18px; }
    details.more { margin-bottom: 16px; }
    details.more > summary {
      cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; min-height: 44px;
      padding: 0 16px; border-radius: var(--ha-card-border-radius, 12px); border: 1px solid var(--divider-color);
      background: var(--card-background-color); font-weight: 500; color: var(--primary-color);
    }
    details.more > summary::-webkit-details-marker { display: none; }
    details.more > summary::before { content: "\\25B8"; transition: transform 0.15s; }
    details.more[open] > summary::before { transform: rotate(90deg); }
    details.more[open] > summary { margin-bottom: 12px; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    this._loadLists();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("card")) {
      const c = this.card;
      const prev = changed.get("card") as Card | null | undefined;
      // Same card refreshed (targeted update §12.5, logo change…) while the user is editing:
      // keep the edits instead of wiping them.
      if (c && prev && prev.id === c.id && this.hasUpdated && this.dirty) return;
      this._data = c ? toEditable(c) : this._newData();
      this._forUser = "";
      this._shareWithMe = true;
      this._auto = !c;
      this._detected = null;
      this._points = c?.points !== null && c?.points !== undefined ? String(c.points) : "";
      this._balance = c?.initial_balance !== null && c?.initial_balance !== undefined ? String(c.initial_balance) : "";
      this._errors = {};
      this._submitError = "";
      this._colorTouched = false;
      this._colorFromLogo = false;
      this._guided = !c;
      this._moreOpen = !!c;
      this._guidedTouched = false;
      this._saved = false;
      this._nameChanged = false;
      this._initial = this._snapshot();
    } else if ((changed.has("settings") || changed.has("prefs")) && !this.card && !this.dirty) {
      // Settings/prefs arrived after the form opened: HA currency (§14.3), default sharing (§15.5).
      this._data = this._newData();
      this._initial = this._snapshot();
    }
  }

  /** Empty new card with the HA currency and, for my own cards, the default sharing (§15.5). */
  private _newData(): EditableCard {
    return { ...emptyCard(this.settings?.currency), ...initialShare(this.settings, this.prefs) };
  }

  /** §15.4: the new card is for another user. */
  private get _forOther(): boolean {
    return !this.card && !!this._forUser && this._forUser !== this.hass?.user?.id;
  }

  private _userName(id: string): string {
    return this._users.find((u) => u.id === id)?.name ?? "";
  }

  /** §14.3: loads the shop list once (per countries), for `shop_custom` on rename. */
  private _ensureShopList() {
    const countries = userCountries(this.prefs, this.settings);
    const key = countries.join(",");
    if (key === this._shopListKey) return;
    this._shopListKey = key;
    this._shopList = null;
    loadMergedShops(countries).then((s) => {
      if (this._shopListKey !== key) return;
      this._shopList = s;
      if (this._nameChanged) this._updateShopCustom();
    }).catch(() => undefined);
  }

  /** The user edited the name in this form (before that, `shop_custom` is left as it is). */
  private _nameChanged = false;

  private _updateShopCustom() {
    if (!this._shopList) return; // list not loaded: keep the current value
    const custom = !isListedName(this._shopList, this._data.name);
    if (custom !== this._data.shop_custom) this._data = { ...this._data, shop_custom: custom };
  }

  private _onName(e: Event) {
    this._set("name", (e.target as HTMLInputElement).value);
    this._nameChanged = true;
    this._ensureShopList();
    this._updateShopCustom();
  }

  /** Owner (or new card): may change visibility/sharing and delete (§11.1). */
  private get _canManage(): boolean {
    return !this.card || this.card.can_manage !== false;
  }

  private _onFullForm = (e: CustomEvent<FullFormDetail>) => {
    e.stopPropagation();
    this._data = { ...e.detail.data };
    this._forUser = e.detail.forUser ?? "";
    this._shareWithMe = e.detail.shareWithMe ?? true;
    this._detected = e.detail.detected;
    this._auto = true;
    if (e.detail.data.color !== emptyCard().color) this._colorTouched = true;
    this._guided = false;
    this._moreOpen = true;
  };

  private async _loadLists() {
    if (!this.hass) return;
    const [users, zones] = await Promise.allSettled([listUsers(this.hass), listZones(this.hass)]);
    if (users.status === "fulfilled") this._users = users.value;
    if (zones.status === "fulfilled") this._zones = zones.value;
  }

  private _set<K extends keyof EditableCard>(key: K, value: EditableCard[K]) {
    this._data = { ...this._data, [key]: value };
    if (this._errors[key]) this._errors = { ...this._errors, [key]: undefined };
  }

  private get _effectiveFormat(): BarcodeFormat {
    return this._auto ? (this._detected ?? "CODE_128") : this._data.barcode_format;
  }

  private _onScanned(e: CustomEvent<{ code: string; format: unknown }>) {
    const { code, format } = e.detail;
    this._set("code", code);
    const f = normalizeFormat(format as string | number | null);
    this._detected = f;
    if (f && !this._auto) this._set("barcode_format", f);
    this._scanOpen = false;
  }

  private _pickColor(c: string) {
    this._colorTouched = true;
    this._colorFromLogo = false;
    this._set("color", c);
  }

  private _onColorSuggested = (e: CustomEvent<{ color: string }>) => {
    if (this._colorTouched) return;
    this._set("color", e.detail.color);
    this._colorFromLogo = true;
  };

  private _toggleIn(key: "shared_with" | "zones", id: string, on: boolean) {
    const cur = this._data[key].filter((x) => x !== "*" || key !== "shared_with");
    const next = on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    this._set(key, next);
  }

  private async _submit(e: Event) {
    e.preventDefault();
    const data: EditableCard = {
      ...this._data,
      name: this._data.name.trim(),
      code: this._data.code.trim(),
      barcode_format: this._effectiveFormat,
      currency: this._data.currency.trim().toUpperCase(),
    };
    const errors = validateCard(data, this._points, this._balance, this.t);
    this._errors = errors;
    if (Object.values(errors).some(Boolean)) {
      this._submitError = this.t("err_form");
      if (MORE_FIELDS.some((k) => errors[k])) this._moreOpen = true;
      return;
    }
    const pts = parseNumber(this._points);
    const bal = parseNumber(this._balance);
    data.points = typeof pts === "number" ? pts : null;
    data.initial_balance = typeof bal === "number" ? Math.round(bal * 100) / 100 : null;
    if (data.visibility === "private") data.shared_with = [];
    if (data.kind !== "voucher") data.reloadable = false;
    data.expiry = data.expiry || null;
    data.logo_domain = data.logo_domain?.trim().toLowerCase() || null;
    data.short_name = data.short_name.trim().slice(0, 20);
    if (!featureOn("shopping_list", this.settings, this.prefs)) delete (data as Partial<EditableCard>).todo_entity;
    // Fields of a feature turned off are not sent (the server keeps them, §15.5).
    if (!featureOn("points_expiry", this.settings, this.prefs)) delete (data as Partial<EditableCard>).points_expiry;
    else data.points_expiry = data.kind === "voucher" ? null : data.points_expiry || null;
    if (data.kind !== "voucher") {
      data.balance_corner = this.card?.balance_corner ?? "bottom_right";
      data.balance_size = this.card?.balance_size ?? "s";
    }
    // A non-owner admin must not send visibility/shared_with at all (server → unauthorized).
    const changes: Partial<EditableCard> = { ...data };
    if (!this._canManage) {
      delete changes.visibility;
      delete changes.shared_with;
      // §14.3: only the owner decides whether the shop is suggested to the household.
      delete changes.shop_custom;
      delete changes.suggest_shop;
    }
    this._submitError = "";
    this._busy = true;
    try {
      // §14.3: new card with the currency still unknown (settings not loaded) → the server uses the HA one.
      if (!this.card && !this.settings?.currency && data.currency === "EUR") delete (data as Partial<EditableCard>).currency;
      if (this._forOther) {
        // §15.4: sharing is decided only by "Share it with me"; the logo travels in the same call.
        const opts = this._logoEditor?.pendingForCreate(data) ?? {};
        const created = await createCardFor(this.hass, data, this._forUser, this._shareWithMe, opts);
        this._saved = true;
        const name = this._userName(this._forUser);
        if (!created) {
          fireEvent(this, "show-toast", { message: this.t("tiles_created_for_hidden", { name }) });
          fireEvent(this, "cancel");
          return;
        }
        fireEvent(this, "show-toast", { message: this.t("tiles_created_for", { name }) });
        fireEvent(this, "saved", { card: created });
        return;
      }
      let card = this.card ? await updateCard(this.hass, this.card.id, changes) : await createCard(this.hass, data);
      if (!this.card && this._logoEditor) {
        // New card: queued logo upload/lookup needs the id, so it runs right after create.
        try {
          card = await this._logoEditor.applyPending(card);
        } catch (err) {
          fireEvent(this, "show-toast", { message: wsErrorText(err, this.t) });
        }
      }
      this._saved = true;
      fireEvent(this, "saved", { card });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "invalid_code") this._errors = { ...this._errors, code: errorMessage(err) };
      this._submitError = errorCode(err) === "recipient_refuses"
        ? this.t("tiles_recipient_refuses", { name: this._userName(this._forUser) })
        : wsErrorText(err, this.t);
    } finally {
      this._busy = false;
    }
  }

  private _field(id: keyof FieldErrors, label: string, content: unknown) {
    const err = this._errors[id];
    return html`<div class="field ${err ? "invalid" : ""}">
      <label for=${id}>${label}</label>${content}
      ${err ? html`<span class="error-text">${err}</span>` : nothing}
    </div>`;
  }

  private _text(id: keyof EditableCard, label: string, opts: { max?: number; type?: string } = {}) {
    return this._field(id, label, html`<input id=${id} type=${opts.type ?? "text"} maxlength=${opts.max ?? 512}
      .value=${String(this._data[id] ?? "")}
      @input=${(e: Event) => this._set(id, (e.target as HTMLInputElement).value as never)} />`);
  }

  private _renderSharing() {
    const t = this.t;
    const d = this._data;
    if (!this._canManage) {
      return html`<div class="field">
        <span class="label">${t("visibility")}</span>
        <span>${d.visibility === "shared" ? t("visibility_shared") : t("visibility_private")}</span>
        <span class="hint">${t("tiles_owner_only_sharing")}</span>
      </div>`;
    }
    const everyone = d.shared_with.includes("*");
    return html`
      <div class="field">
        <span class="label">${t("visibility")}</span>
        <div class="seg" role="group">
          <button type="button" aria-pressed=${d.visibility === "private"}
            @click=${() => this._set("visibility", "private")}><ha-icon icon="mdi:lock"></ha-icon>
            ${t("visibility_private")}</button>
          <button type="button" aria-pressed=${d.visibility === "shared"}
            @click=${() => this._set("visibility", "shared")}><ha-icon icon="mdi:account-multiple"></ha-icon>
            ${t("visibility_shared")}</button>
        </div>
      </div>
      ${d.visibility === "shared" ? html`
        <div class="field ${this._errors.shared_with ? "invalid" : ""}">
          <span class="label">${t("share_with")}</span>
          <div class="checks">
            <label class="check"><input type="checkbox" .checked=${everyone}
              @change=${(e: Event) => this._set("shared_with", (e.target as HTMLInputElement).checked ? ["*"] : [])} />
              <strong>${t("share_everyone")}</strong></label>
            ${this._users.map((u) => html`<label class="check">
              <input type="checkbox" .checked=${everyone || d.shared_with.includes(u.id)} ?disabled=${everyone}
                @change=${(e: Event) => this._toggleIn("shared_with", u.id, (e.target as HTMLInputElement).checked)} />
              ${u.name}</label>`)}
            ${this._users.length ? nothing : html`<span class="hint">${t("no_users")}</span>`}
          </div>
          ${this._errors.shared_with ? html`<span class="error-text">${this._errors.shared_with}</span>` : nothing}
        </div>` : nothing}
      ${d.visibility === "private" && d.shop_custom ? html`
        <label class="check"><input type="checkbox" .checked=${d.suggest_shop}
          @change=${(e: Event) => this._set("suggest_shop", (e.target as HTMLInputElement).checked)} />
          <ha-icon icon="mdi:storefront-outline"></ha-icon>${t("tiles_suggest_shop")}</label>
        <span class="hint">${t("tiles_suggest_shop_hint")}</span>` : nothing}
    `;
  }

  /** §15.4: "Who is this card for?" (new cards only). */
  private _renderForWhom() {
    const t = this.t;
    if (this.card) return nothing;
    const me = this.hass?.user?.id;
    const others = this._users.filter((u) => u.id !== me);
    if (!others.length) return nothing;
    return html`<div class="field">
      <label for="for_user">${t("tiles_for_whom")}</label>
      <select id="for_user" @change=${(e: Event) => { this._forUser = (e.target as HTMLSelectElement).value; }}>
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

  /** §15.5 shopping_list: the HA to-do entities (todo.*). */
  private _renderTodo() {
    const t = this.t;
    if (!featureOn("shopping_list", this.settings, this.prefs)) return nothing;
    const cur = this._data.todo_entity;
    const ids = Object.keys(this.hass?.states ?? {}).filter((id) => id.startsWith("todo.")).sort();
    if (cur && !ids.includes(cur)) ids.unshift(cur);
    const name = (id: string) => String(this.hass?.states?.[id]?.attributes?.friendly_name ?? id);
    return html`<div class="field">
      <label for="todo_entity">${t("tiles_todo_entity")}</label>
      <select id="todo_entity" @change=${(e: Event) => this._set("todo_entity", (e.target as HTMLSelectElement).value || null)}>
        <option value="" ?selected=${!cur}>${t("tiles_todo_none")}</option>
        ${ids.map((id) => html`<option value=${id} ?selected=${cur === id}>${name(id)}</option>`)}
      </select>
      <span class="hint">${t(ids.length ? "tiles_todo_entity_hint" : "tiles_todo_no_lists")}</span>
    </div>`;
  }

  private _renderBalanceTile() {
    const t = this.t;
    const d = this._data;
    const cornerLabel: Record<BalanceCorner, string> = {
      top_left: t("tiles_corner_top_left"), bottom_left: t("tiles_corner_bottom_left"),
      bottom_right: t("tiles_corner_bottom_right"),
    };
    const sizeLabel: Record<BalanceSize, string> = {
      off: t("tiles_size_off"), s: t("tiles_size_s"), m: t("tiles_size_m"), l: t("tiles_size_l"),
    };
    return html`
      <div class="field">
        <span class="label">${t("tiles_balance_size")}</span>
        <div class="seg" role="group">
          ${SIZES.map((s) => html`<button type="button" aria-pressed=${d.balance_size === s}
            @click=${() => this._set("balance_size", s)}>${sizeLabel[s]}</button>`)}
        </div>
      </div>
      ${d.balance_size !== "off" ? html`<div class="field">
        <span class="label">${t("tiles_balance_corner")}</span>
        <div class="seg" role="group">
          ${CORNERS.map((c) => html`<button type="button" aria-pressed=${d.balance_corner === c}
            @click=${() => this._set("balance_corner", c)}>${cornerLabel[c]}</button>`)}
        </div>
      </div>` : nothing}`;
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    if (!this.card && this._guided) {
      return html`<lh-guided-add .hass=${this.hass} .t=${t} language=${this.language} .cards=${this.cards}
        .prefs=${this.prefs} .settings=${this.settings}
        @lh-created-hidden=${() => { this._saved = true; }}
        @input=${this._onGuidedTouch} @change=${this._onGuidedTouch} @scanned=${this._onGuidedTouch}
        @saved=${() => { this._saved = true; }}
        @lh-full-form=${this._onFullForm}></lh-guided-add>`;
    }
    const d = this._data;
    const fmt = this._effectiveFormat;
    const color = safeColor(d.color);
    const dup = findDuplicate(this.cards, d.code, this.card?.id);
    return html`
      <form @submit=${this._submit} novalidate>
        <div class="section">
          <h2>${this.card ? t("edit_card") : t("new_card")}</h2>
          ${this._renderForWhom()}
          ${this._field("name", t("name"), html`<input id="name" type="text" maxlength="80" .value=${d.name}
            @input=${this._onName} />`)}
          ${this._field("code", t("code"), html`<div class="code-row">
            <input id="code" type="text" maxlength="512" autocomplete="off" .value=${d.code}
              @input=${(e: Event) => this._set("code", (e.target as HTMLInputElement).value)} />
            <button type="button" class="btn" @click=${() => { this._scanOpen = true; }}>
              <ha-icon icon="mdi:barcode-scan"></ha-icon>${t("scan")}</button>
          </div>
          ${dup ? html`<span class="warn"><ha-icon icon="mdi:alert-outline"></ha-icon>
            ${t("tiles_duplicate", { name: dup.name })}</span>` : nothing}`)}
          ${this._field("barcode_format", t("barcode_format"), html`
            <select id="barcode_format" @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              this._auto = v === AUTO;
              if (v !== AUTO) this._set("barcode_format", v as BarcodeFormat);
            }}>
              <option value=${AUTO} ?selected=${this._auto}>${t("format_auto")}</option>
              ${BARCODE_FORMATS.map((f) => html`<option value=${f} ?selected=${!this._auto && d.barcode_format === f}>
                ${FORMAT_LABELS[f]}</option>`)}
            </select>
            ${this._detected ? html`<span class="hint">${t("format_detected", { format: FORMAT_LABELS[this._detected] })}</span>`
              : nothing}`)}
          <div class="field">
            <span class="label">${t("kind")}</span>
            <div class="seg" role="group">
              <button type="button" aria-pressed=${d.kind === "card"} @click=${() => this._set("kind", "card")}>
                ${t("kind_card")}</button>
              <button type="button" aria-pressed=${d.kind === "voucher"} @click=${() => this._set("kind", "voucher")}>
                ${t("kind_voucher")}</button>
            </div>
          </div>
          ${d.kind === "voucher" ? html`<div class="row">
            <div class="grow">${this._field("balance_raw", t("initial_balance"), html`<input id="balance_raw" type="text"
              inputmode="decimal" .value=${this._balance}
              @input=${(e: Event) => { this._balance = (e.target as HTMLInputElement).value; }} />`)}</div>
            <div class="grow">${this._text("currency", t("currency"), { max: 3 })}</div>
          </div>` : nothing}
          ${d.code.trim() ? html`<div class="preview"><span class="label">${t("preview")}</span>
            <div class="barcode-box"><lh-barcode .code=${d.code.trim()} .format=${fmt}
              error-text=${t("render_error", { format: FORMAT_LABELS[fmt] })}></lh-barcode></div></div>` : nothing}
        </div>

        <details class="more" .open=${this._moreOpen}
          @toggle=${(e: Event) => { this._moreOpen = (e.target as HTMLDetailsElement).open; }}>
          <summary>${t("tiles_more")}</summary>
          <div class="section">
            ${this._field("color", t("color"), html`<div class="swatches">
              ${PRESET_COLORS.map((c) => html`<button type="button" class="swatch" style="background:${c}"
                aria-pressed=${color.toLowerCase() === c.toLowerCase()} aria-label=${c}
                @click=${() => this._pickColor(c)}></button>`)}
              <input id="color" type="color" .value=${color} aria-label=${t("color")}
                @input=${(e: Event) => this._pickColor((e.target as HTMLInputElement).value.toUpperCase())} />
            </div>
            ${this._colorFromLogo ? html`<span class="hint">${t("color_from_logo")}</span>` : nothing}`)}
          </div>

          <div class="section">
            <h2>${t("logo")}</h2>
            <lh-logo-editor .hass=${this.hass} .t=${t} language=${this.language} .card=${this.card} .data=${d}
              @logo-fit-changed=${(e: CustomEvent<{ fit: LogoFit }>) => this._set("logo_fit", e.detail.fit)}
              @logo-domain-changed=${(e: CustomEvent<{ domain: string }>) => this._set("logo_domain", e.detail.domain)}
              @color-suggested=${this._onColorSuggested}></lh-logo-editor>
            ${this._errors.logo_domain ? html`<span class="error-text">${this._errors.logo_domain}</span>` : nothing}
          </div>

          <div class="section">
            <div class="row">
              ${d.kind === "card" ? html`<div class="grow">${this._field("points_raw", t("points_label"),
                html`<input id="points_raw" type="text" inputmode="numeric" .value=${this._points}
                  @input=${(e: Event) => { this._points = (e.target as HTMLInputElement).value; }} />`)}</div>` : nothing}
              ${d.kind === "card" && featureOn("points_expiry", this.settings, this.prefs) ? html`<div class="grow">
                <div class="field"><label for="points_expiry">${t("tiles_points_expiry_label")}</label>
                <input id="points_expiry" type="date" .value=${d.points_expiry ?? ""}
                  @input=${(e: Event) => this._set("points_expiry", (e.target as HTMLInputElement).value || null)} /></div>
              </div>` : nothing}
              <div class="grow">${this._field("expiry", t("expiry"), html`<input id="expiry" type="date"
                .value=${d.expiry ?? ""}
                @input=${(e: Event) => this._set("expiry", (e.target as HTMLInputElement).value || null)} />`)}</div>
            </div>
            <div class="field"><label for="short_name">${t("tiles_short_name")}</label>
              <input id="short_name" type="text" maxlength="20" .value=${d.short_name}
                @input=${(e: Event) => this._set("short_name", (e.target as HTMLInputElement).value)} />
              <span class="hint">${t("tiles_short_name_hint")}</span></div>
            ${this._renderTodo()}
            ${d.kind === "voucher" ? html`
              <label class="check"><input type="checkbox" .checked=${d.reloadable}
                @change=${(e: Event) => this._set("reloadable", (e.target as HTMLInputElement).checked)} />
                <ha-icon icon="mdi:cash-refund"></ha-icon>${t("reloadable")}</label>
              <span class="hint reload-hint">${t("reloadable_hint")}</span>
              ${this._renderBalanceTile()}` : nothing}
            ${this._field("notes", t("notes"), html`<textarea id="notes" maxlength="1000" .value=${d.notes}
              @input=${(e: Event) => this._set("notes", (e.target as HTMLTextAreaElement).value)}></textarea>`)}
            <label class="check"><input type="checkbox" .checked=${d.favorite}
              @change=${(e: Event) => this._set("favorite", (e.target as HTMLInputElement).checked)} />
              <ha-icon icon="mdi:star"></ha-icon>${t("favorite")}</label>
          </div>

          <div class="section">
            ${this._forOther ? nothing : this._renderSharing()}
            <div class="field">
              <span class="label">${t("zones")}</span>
              <div class="checks">
                ${this._zones.map((z) => html`<label class="check">
                  <input type="checkbox" .checked=${d.zones.includes(z.entity_id)}
                    @change=${(e: Event) => this._toggleIn("zones", z.entity_id, (e.target as HTMLInputElement).checked)} />
                  ${z.name}</label>`)}
                ${this._zones.length ? nothing : html`<span class="hint">${t("no_zones")}</span>`}
              </div>
            </div>
          </div>
        </details>

        ${this._submitError ? html`<p class="error-text">${this._submitError}</p>` : nothing}
        <div class="footer">
          ${this.card && this._canManage ? html`<button type="button" class="btn danger"
            @click=${() => fireEvent(this, "lh-request-delete", { card: this.card })}>
            <ha-icon icon="mdi:delete"></ha-icon>${t("delete")}</button>` : nothing}
          <span class="spacer"></span>
          <button type="button" class="btn" @click=${() => fireEvent(this, "cancel")}>${t("cancel")}</button>
          <button type="submit" class="btn primary" ?disabled=${this._busy}>
            <ha-icon icon="mdi:content-save"></ha-icon>${t("save")}</button>
        </div>
      </form>
      <lh-scanner-dialog .open=${this._scanOpen} .t=${t} @scanned=${this._onScanned}
        @closed=${() => { this._scanOpen = false; }}></lh-scanner-dialog>
    `;
  }
}

defineElement("lh-card-form", LhCardForm);

declare global {
  interface HTMLElementTagNameMap { "lh-card-form": LhCardForm }
}
