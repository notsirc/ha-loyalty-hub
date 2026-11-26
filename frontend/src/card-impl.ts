// Lovelace card implementation, loaded on demand by the small loader in card.ts (§12.9).
// <loyalty-hub-card-impl> receives `config` and `hass` from <loyalty-hub-card>.
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ChangeBatcher, errorMessage, getPrefs, getSettings, listCards, markUsed, subscribeChanges } from "./api";
import { FORMAT_LABELS } from "./barcode";
import { dropOtherUsersLogos } from "./logo";
import { ensureLanguage, getLanguage, languageReady, makeT } from "./i18n";
import { sharedStyles } from "./styles";
import { computeGroups, pickTab, rememberTab, tabLabel, type CardGroup } from "./groups";
import { baseOrder, sections } from "./ordering";
import { featureOn, sortCards, type Card, type HomeAssistant, type LoyaltySettings, type UserPrefs } from "./types";
import { defineElement, formatMoney, navigate } from "./util";
import "./components/lh-barcode";
import "./components/lh-card-tile";
import "./components/lh-dialog";
import "./components/lh-cashier-view";
import type { CashierTab } from "./components/lh-cashier-view";
import { AutoUsedTimer, observeVisible } from "./components/lh-helpers";

export type CardMode = "auto" | "all" | "favorites" | "nearby";
export const CARD_MODES: readonly CardMode[] = ["auto", "all", "favorites", "nearby"];
export interface LoyaltyHubCardConfig {
  type: string;
  /** §16.3: initial mode (default "auto", also for configs saved without `mode`). */
  mode?: CardMode;
  max_items?: number;
  /** §16.3: selector under the title (default true); off = always `mode`. */
  show_selector?: boolean;
}

/** §16.3: the mode chosen with the selector, per user and dashboard view (this device only). */
const modeKey = (userId: string | undefined) =>
  `loyalty_hub:card_mode:${userId ?? ""}:${typeof location !== "undefined" ? location.pathname : ""}`;

function readMode(userId: string | undefined): CardMode | null {
  try {
    const v = localStorage.getItem(modeKey(userId));
    return CARD_MODES.includes(v as CardMode) ? (v as CardMode) : null;
  } catch {
    return null;
  }
}

function writeMode(userId: string | undefined, mode: CardMode) {
  try {
    localStorage.setItem(modeKey(userId), mode);
  } catch {
    /* ignore */
  }
}

const HUB_PATH = "/loyalty-hub";

/** Zone entity ids the current user's person entity is in. */
export function currentUserZones(hass: HomeAssistant): Set<string> {
  const zones = new Set<string>();
  const uid = hass.user?.id;
  if (!uid) return zones;
  const persons = Object.values(hass.states).filter(
    (s) => s.entity_id.startsWith("person.") && s.attributes?.user_id === uid);
  for (const person of persons) {
    for (const z of Object.values(hass.states)) {
      if (!z.entity_id.startsWith("zone.") || z.entity_id === "zone.home") continue;
      const inByName = z.attributes?.friendly_name === person.state;
      const inByList = Array.isArray(z.attributes?.persons) && z.attributes.persons.includes(person.entity_id);
      if (inByName || inByList) zones.add(z.entity_id);
    }
  }
  return zones;
}

export class LoyaltyHubCard extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @state() private _config: LoyaltyHubCardConfig = { type: "custom:loyalty-hub-card", mode: "auto", max_items: 6, show_selector: true };
  /** §16.3: mode chosen with the selector (undefined = not read yet from localStorage). */
  @state() private _chosen: CardMode | null | undefined = undefined;
  @state() private _cards: Card[] = [];
  @state() private _loaded = false;
  @state() private _error = "";
  @state() private _open: Card | null = null;
  /** §15.3: key of the group of the opened card (its tabs are shown in the dialog). */
  @state() private _openGroup: string | null = null;
  @state() private _prefs: UserPrefs | null = null;
  @state() private _settings: LoyaltySettings | null = null;
  @state() private _busy = false;
  @state() private _cashier = false;
  @state() private _toast = "";
  @state() private _toastError = false;
  /** §11.8: automatic "used" after 4 s of visible barcode, once per opened card. */
  private _auto = new AutoUsedTimer(() => this._autoMarkUsed());
  private _unobserve: (() => void) | null = null;
  private _observedFor: string | null = null;
  private _toastTimer?: number;
  private _unsub: (() => Promise<void> | void) | null = null;
  private _subscribing = false;
  private _initialized = false;
  private _batcher = new ChangeBatcher(
    () => this.hass,
    () => this._cards,
    (cards) => this._setCards(cards),
    (err) => { this._error = errorMessage(err); },
  );

  setConfig(config: LoyaltyHubCardConfig): void {
    if (!config) throw new Error("Invalid configuration");
    const mode = config.mode ?? "auto";
    if (!CARD_MODES.includes(mode)) throw new Error(`Invalid mode: ${mode}`);
    const max = Number(config.max_items ?? 6);
    this._config = {
      ...config, mode, max_items: Number.isFinite(max) && max > 0 ? Math.floor(max) : 6,
      show_selector: config.show_selector !== false,
    };
  }

  getCardSize(): number {
    const n = Math.min(this._visible().length || 1, this._config.max_items ?? 6);
    return 1 + Math.ceil(n / 2) * 2;
  }

  static override styles = [sharedStyles, css`
    ha-card { padding: 12px 16px 8px; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .head .title { flex: 1; font-size: 1.2em; font-weight: 500; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
    .empty { color: var(--secondary-text-color); padding: 8px 0 12px; }
    .empty .link {
      display: inline; border: none; background: none; padding: 0 0 0 4px; cursor: pointer; font: inherit;
      color: var(--primary-color); font-weight: 500; text-decoration: underline;
    }
    .modes { display: flex; gap: 6px; margin: 0 0 10px; flex-wrap: wrap; }
    .modes button {
      min-height: 36px; min-width: 44px; padding: 0 14px; border-radius: 18px; cursor: pointer; font: inherit;
      display: inline-flex; align-items: center; justify-content: center; --mdc-icon-size: 20px;
      border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color);
    }
    .modes button[aria-checked="true"] {
      background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent;
    }
    .modes button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    .footer { display: flex; justify-content: flex-end; margin-top: 8px; }
    .footer a { color: var(--primary-color); text-decoration: none; font-weight: 500; padding: 8px; }
    .barcode-box { margin-bottom: 12px; }
    .hero { max-width: 240px; margin: 0 auto 12px; }
    lh-barcode { width: 100%; }
    .info { margin-bottom: 8px; }
    button.barcode-box { width: 100%; border: none; cursor: pointer; font: inherit; }
    .tap-hint { color: #555; font-size: 0.8em; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; margin: 0 0 10px; padding: 2px 0 6px; }
    .tabs button {
      flex: none; min-height: 36px; max-width: 50vw; padding: 0 14px; border-radius: 18px; cursor: pointer;
      border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color); font: inherit;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tabs button[aria-selected="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
    .toast { font-size: 0.85em; color: var(--success-color, #2e7d32); margin-top: 4px; }
    .toast.error-text { color: var(--error-color, #db4437); }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    if (this._initialized) {
      // Re-attached (e.g. dashboard view switch): changes may have been missed while detached.
      this._batcher.push(null);
      this._subscribe();
    }
    this._auto.attach();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    const unsub = this._unsub;
    this._unsub = null;
    if (unsub) Promise.resolve().then(unsub).catch(() => undefined);
    this._batcher.cancel();
    clearTimeout(this._toastTimer);
    this._auto.detach();
    this._stopObserving();
  }

  protected override updated(): void {
    // Observe the barcode of the opened card (inside the dialog) for the automatic "used".
    const id = this._open?.id ?? null;
    if (id !== this._observedFor) {
      this._stopObserving();
      this._auto.reset();
      this._observedFor = id;
      if (!id && this._cashier) this._cashier = false;
    }
    if (id && !this._unobserve) {
      const box = this.renderRoot.querySelector(".barcode-box");
      if (box) this._unobserve = observeVisible(box, (v) => this._auto.setVisible("dialog", v));
    }
    this._auto.setVisible("cashier", this._cashier);
  }

  private _stopObserving() {
    this._unobserve?.();
    this._unobserve = null;
    this._auto.setVisible("dialog", false);
  }

  private _showToast(msg: string, error = false) {
    this._toast = msg;
    this._toastError = error;
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => { this._toast = ""; }, 3000);
  }

  private async _autoMarkUsed() {
    const id = this._open?.id;
    if (!id || this._open?.admin_view) return;
    try {
      const before = this._open?.use_count;
      const card = await markUsed(this.hass, id);
      if (this._open?.id === id) this._open = card;
      if (card.use_count !== before) this._showToast(makeT(this.hass)("tiles_auto_used"));
    } catch {
      /* silent: the manual button is still there */
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (this._chosen === undefined && this.hass?.user) this._chosen = readMode(this.hass.user.id);
    if (changed.has("hass") && this.hass && !this._initialized) {
      this._initialized = true;
      this._load();
      this._subscribe();
    }
  }

  private async _subscribe() {
    if (this._unsub || this._subscribing || !this.hass || !this.isConnected) return;
    this._subscribing = true;
    try {
      const unsub = await subscribeChanges(this.hass, (ids) => this._batcher.push(ids), undefined, undefined, {
        onSettings: () => { getSettings(this.hass).then((st) => { this._settings = st; }, () => undefined); },
      });
      if (this.isConnected) this._unsub = unsub;
      else await unsub();
    } catch {
      /* integration not loaded */
    } finally {
      this._subscribing = false;
    }
  }

  private _setCards(cards: Card[]) {
    this._cards = cards;
    this._error = "";
    if (this._open) this._open = this._cards.find((c) => c.id === this._open?.id) ?? null;
  }

  private async _load() {
    // §15.3: the user's group view (prefs) and the features (cashier high contrast), best effort.
    getPrefs(this.hass).then((p) => { this._prefs = p; }, () => undefined);
    getSettings(this.hass).then((st) => { this._settings = st; }, () => undefined);
    try {
      this._setCards(await listCards(this.hass));
      dropOtherUsersLogos(this.hass.user?.id).catch(() => undefined);
    } catch (err) {
      this._error = errorMessage(err);
    } finally {
      this._loaded = true;
    }
  }

  /** §16.3: the mode in use: the selector's choice (if shown and saved), otherwise the config. */
  private get _mode(): CardMode {
    const initial = this._config.mode ?? "auto";
    if (this._config.show_selector === false) return initial;
    return this._chosen ?? initial;
  }

  private _setMode(mode: CardMode) {
    this._chosen = mode;
    writeMode(this.hass?.user?.id, mode);
  }

  /** "Near" for the card: linked to a zone the user's person is in (no browser position). */
  private _isNear(): (c: Card) => boolean {
    if (!this.hass) return () => false;
    const zones = currentUserZones(this.hass);
    return (c) => (c.zones ?? []).some((z) => zones.has(z));
  }

  /** Cards passing the card mode, never admin_view (§11.1). */
  private _matcher(): (c: Card) => boolean {
    const mode = this._mode;
    if (mode === "favorites") return (c) => c.favorite;
    if (mode === "nearby") return this._isNear();
    return () => true;
  }

  /**
   * §15.3: groups of the user's cards (same rules as the panel), kept when at least one card passes the
   * mode; `first` = the card the group opens on (the matching one for favorites/nearby).
   */
  private _visibleGroups(): { group: CardGroup; first: Card }[] {
    const match = this._matcher();
    const mode = this._mode;
    const own = this._cards.filter((c) => !c.admin_view);
    // §16.3 "auto": the panel's order (habits or manual order), then near / favorites / the rest.
    const manualOn = featureOn("manual_order", this._settings, this._prefs) && this._prefs?.list_order === "manual";
    const cards = mode === "auto" ? baseOrder(own, this._prefs, manualOn) : sortCards(own);
    let groups = computeGroups(cards, this._prefs, this.hass?.user?.id);
    if (mode === "auto") {
      const s = sections(groups.map((group) => ({ group })), this._isNear());
      groups = [...s.near, ...s.favs, ...s.rest].map((e) => e.group);
    }
    const out: { group: CardGroup; first: Card }[] = [];
    for (const g of groups) {
      const hit = g.cards.filter(match);
      if (!hit.length) continue;
      const first = mode === "all" || mode === "auto" || hit.length > 1 ? pickTab(g, { userId: this.hass?.user?.id, hass: this.hass }) : hit[0];
      out.push({ group: g, first: hit.includes(first) ? first : hit[0] });
    }
    return out.slice(0, this._config.max_items ?? 6);
  }

  private _visible(): Card[] {
    return this._visibleGroups().map((x) => x.first);
  }

  private get _openTabs(): CashierTab[] {
    const o = this._open;
    if (!o || !this._openGroup) return [];
    const g = computeGroups(sortCards(this._cards.filter((c) => !c.admin_view)), this._prefs, this.hass?.user?.id)
      .find((x) => x.key === this._openGroup && x.cards.some((c) => c.id === o.id));
    if (!g || g.cards.length < 2) return [];
    return g.cards.map((c, i) => ({ card: c, label: tabLabel(c, i, this.hass?.user?.id) }));
  }

  /** The group of the opened card (for its personal name, §16.2). */
  private _openGroupObj(): CardGroup | undefined {
    const o = this._open;
    if (!o || !this._openGroup) return undefined;
    return computeGroups(this._cards.filter((c) => !c.admin_view), this._prefs, this.hass?.user?.id)
      .find((x) => x.key === this._openGroup && x.cards.some((c) => c.id === o.id));
  }

  /** §16.3: [ Auto ] [ All ] [ ⭐ ] [ 📍 ] under the title. */
  private _renderSelector(t: ReturnType<typeof makeT>, mode: CardMode) {
    const items: { m: CardMode; label: string; name: string; icon?: string }[] = [
      { m: "auto", label: t("mode_auto_short"), name: t("mode_auto") },
      { m: "all", label: t("mode_all"), name: t("mode_all") },
      { m: "favorites", label: "", name: t("mode_favorites"), icon: "mdi:star" },
      { m: "nearby", label: "", name: t("section_nearby"), icon: "mdi:map-marker-radius" },
    ];
    return html`<div class="modes" role="radiogroup" aria-label=${t("card_mode_selector")}>
      ${items.map((x) => html`<button role="radio" aria-checked=${x.m === mode ? "true" : "false"}
        aria-label=${x.name} title=${x.name} @click=${() => this._setMode(x.m)}>
        ${x.icon ? html`<ha-icon icon=${x.icon}></ha-icon>` : x.label}</button>`)}
    </div>`;
  }

  private _renderEmpty(t: ReturnType<typeof makeT>, mode: CardMode) {
    if (mode === "favorites") return html`<div class="empty">${t("card_empty_favorites")}</div>`;
    if (mode === "nearby") {
      return html`<div class="empty">${t("card_empty_nearby")}
        ${this._config.show_selector !== false ? html`<button class="link" @click=${() => this._setMode("auto")}>
          ${t("card_show_auto")}</button>` : nothing}</div>`;
    }
    return html`<div class="empty">${t("no_cards_card")}</div>`;
  }

  private _openCard(group: CardGroup, card: Card) {
    this._openGroup = group.cards.length > 1 ? group.key : null;
    this._open = card;
  }

  /** Tab change (dialog tabs or cashier arrows): a new "opening" for the automatic "used". */
  private _selectTab(cardId: string) {
    const c = this._cards.find((x) => x.id === cardId);
    if (!c || c.id === this._open?.id) return;
    if (this._openGroup) rememberTab(this.hass?.user?.id, this._openGroup, c.id);
    this._open = c;
  }

  private async _markUsed() {
    if (!this._open) return;
    this._busy = true;
    try {
      this._open = await markUsed(this.hass, this._open.id);
      this._showToast(makeT(this.hass)("marked_used"));
    } catch (err) {
      // Shown inside the dialog (the card-level error is only visible without cards).
      this._showToast(makeT(this.hass)("error_generic", { msg: errorMessage(err) }), true);
    } finally {
      this._busy = false;
    }
  }

  private _openHub(e: Event, cardId?: string) {
    e.preventDefault();
    this._open = null;
    navigate(cardId ? `${HUB_PATH}?card=${encodeURIComponent(cardId)}` : HUB_PATH);
  }

  protected override render() {
    if (!this.hass) return nothing;
    // §14.5: load the language chunk, then render again.
    if (!languageReady(this.hass)) ensureLanguage(this.hass).then((ok) => { if (ok) this.requestUpdate(); }, () => undefined);
    const t = makeT(this.hass);
    const lang = getLanguage(this.hass);
    const visible = this._visibleGroups();
    const tabs = this._openTabs;
    const hc = featureOn("high_contrast_cashier", this._settings, this._prefs) && !!this._prefs?.cashier_high_contrast;
    const mode = this._mode;
    const o = this._open;
    const openGroup = this._openGroupObj();
    return html`
      <ha-card>
        <div class="head">
          <ha-icon icon="mdi:wallet-membership"></ha-icon>
          <span class="title">${t("app_title")}</span>
        </div>
        ${this._config.show_selector !== false ? this._renderSelector(t, mode) : nothing}
        ${!this._loaded ? html`<div class="empty">${t("loading")}</div>`
          : this._error && !this._cards.length ? html`<div class="empty error-text">${t("error_generic", { msg: this._error })}</div>`
          : visible.length ? html`<div class="grid">
              ${visible.map(({ group, first }) => html`<lh-card-tile .card=${group.cards[0]} .hass=${this.hass} .t=${t}
                language=${lang} layout="grid" .groupCount=${group.cards.length} displayName=${group.name ?? ""}
                @click=${() => this._openCard(group, first)}></lh-card-tile>`)}
            </div>`
          : this._renderEmpty(t, mode)}
        <div class="footer">
          <a href=${HUB_PATH} @click=${(e: Event) => this._openHub(e)}>${t("open_hub")}</a>
        </div>
      </ha-card>
      <lh-dialog .open=${!!o} heading=${openGroup?.name || o?.name || ""} close-label=${t("close")} @closed=${() => { this._open = null; }}>
        ${o ? html`
          ${tabs.length ? html`<div class="tabs" role="tablist" aria-label=${t("tiles_group_tabs")}>
            ${tabs.map((x) => html`<button role="tab" aria-selected=${x.card.id === o.id ? "true" : "false"}
              title=${x.card.name} @click=${() => this._selectTab(x.card.id)}>${x.label}</button>`)}
          </div>` : nothing}
          <lh-card-tile class="hero" layout="large" .card=${o} .hass=${this.hass} .t=${t} language=${lang}></lh-card-tile>
          <button class="barcode-box" aria-label=${t("tiles_cashier_open")} @click=${() => { this._cashier = true; }}>
            <lh-barcode .code=${o.code} .format=${o.barcode_format}
              error-text=${t("render_error", { format: FORMAT_LABELS[o.barcode_format] ?? o.barcode_format })}></lh-barcode>
            <div class="code-text">${o.code}</div>
            <span class="tap-hint">${t("tiles_cashier_tap")}</span>
          </button>
          <div class="info muted">
            ${o.kind === "voucher" && o.balance !== null && o.balance !== undefined
              ? html`${t("balance")}: <strong>${formatMoney(o.balance, o.currency, lang)}</strong>`
              : o.points !== null && o.points !== undefined ? t("points", { count: o.points }) : nothing}
          </div>
          ${this._toast ? html`<div class="toast ${this._toastError ? "error-text" : ""}" role="status">${this._toast}</div>` : nothing}
          <lh-cashier-view .open=${this._cashier} .card=${o} .t=${t} .tabs=${tabs} ?high-contrast=${hc}
            @tab-change=${(e: CustomEvent<{ cardId: string }>) => this._selectTab(e.detail.cardId)}
            @closed=${() => { this._cashier = false; }}></lh-cashier-view>` : nothing}
        <button slot="actions" class="btn" @click=${(e: Event) => this._openHub(e, o?.id)}>
          <ha-icon icon="mdi:open-in-app"></ha-icon>${t("open_hub")}</button>
        <button slot="actions" class="btn primary" ?disabled=${this._busy} @click=${this._markUsed}>
          <ha-icon icon="mdi:check-circle"></ha-icon>${t("mark_used")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("loyalty-hub-card-impl", LoyaltyHubCard);

declare global {
  interface HTMLElementTagNameMap { "loyalty-hub-card-impl": LoyaltyHubCard }
}
