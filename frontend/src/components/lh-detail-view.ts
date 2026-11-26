import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { addLocation, clearPointsHistory, getLogoProviders, markUsed, removeLocation } from "../api";
import { composeImage, FORMAT_LABELS } from "../barcode";
import type { I18nKey, Translate } from "../i18n";
import { isValidDomain } from "../logo";
import { sharedStyles } from "../styles";
import { featureOn, type Card, type CardLocation, type HomeAssistant, type LoyaltySettings, type UserPrefs } from "../types";
import {
  defineElement, downloadBlob, fireEvent, formatDate, isExpired, priceCompareLinks,
  sanitizeFilename,
} from "../util";
import "./lh-barcode";
import type { LhBarcode } from "./lh-barcode";
import "./lh-card-tile";
import "./lh-cashier-view";
import type { CashierTab } from "./lh-cashier-view";
import "./lh-dialog";
import "./lh-logo-preview-dialog";
import type { LhLogoPreviewDialog } from "./lh-logo-preview-dialog";
import {
  AutoUsedTimer, cardLink, copyText, currentPosition, observeVisible, wsErrorText,
} from "./lh-helpers";
import "./lh-nfc-dialog";
import "./lh-points-chart";
import { recentPoints } from "./lh-points-chart";
import "./lh-todo-box";
import "./lh-transfer-dialog";
import "./lh-voucher-section";

/**
 * Full card detail: large barcode (tap → cashier mode, §11.8), actions, links (§11.7),
 * "I'm in this shop now" (§11.5), voucher section. Deleting is only in the edit form (§11.9).
 * Property `cashier`: open directly in cashier mode (panel: `?cashier=1`).
 * Events: `edit-card` {card}, `card-updated` {card}, `show-toast` {message}, `cashier-opened`, `cashier-closed`,
 * `lh-back` (bottom bar, §12.7: the panel decides between history.back() and the list).
 * §14.4: on touch devices (`pointer: coarse`, any width) the actions move to a fixed bottom bar with a
 * "⋮" menu; with a mouse they stay a row of buttons. A discreet "Logo" section (can_edit) offers
 * "Refresh logo" (Before / After preview, provider "auto") and "Back to the previous logo" (§14.2).
 * §15: `prefs` (features turned off by the user, high contrast cashier) and `tabs` (the cards of the
 * group, passed to the cashier overlay: its arrows/swipe fire `tab-changed` {cardId}, bubbling).
 * "Added by" / "Transferred by", "Transfer to…" (can_manage), "Link to an NFC tag" (nfc), shopping list
 * (shopping_list + todo_entity), points chart (points_history, ≥ 2 entries), points expiry (points_expiry).
 * A transfer after which the card is no longer visible fires `card-deleted` {id}.
 * §16.1 `extraActions`: the group actions of `lh-group-detail`, after a separator at the end of the same
 * menu (touch) or row of buttons (mouse); a click fires `lh-extra-action` {id}.
 */
export interface ExtraAction { id: string; label: string; icon: string }

const TOUCH_QUERY = "(pointer: coarse)";

export class LhDetailView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) card!: Card;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) settings?: LoyaltySettings;
  @property() language = "en";
  /** Opens (or re-opens) the cashier overlay when set to true. */
  @property({ type: Boolean }) cashier = false;
  /** §15.5: user prefs (features_off, cashier_high_contrast). */
  @property({ attribute: false }) prefs?: UserPrefs | null;
  /** §15.3: tabs of the group (cashier navigation); fewer than 2 = single card. */
  @property({ attribute: false }) tabs: CashierTab[] = [];
  /** §16.1: group actions appended to the menu / row of actions. */
  @property({ attribute: false }) extraActions: ExtraAction[] = [];
  @state() private _transferOpen = false;
  @state() private _nfcOpen = false;
  @state() private _clearHistoryOpen = false;
  @state() private _showQr = false;
  @state() private _busy = false;
  @state() private _cashierOpen = false;
  @state() private _locating = false;
  @state() private _toRemove: CardLocation | null = null;
  @state() private _touch = false;
  /** §14.2: null until the "Logo" section is opened the first time. */
  @state() private _logoProviders: string[] | null = null;
  @state() private _logoLoading = false;
  @state() private _menuOpen = false;
  @query("lh-barcode") private _barcode?: LhBarcode;
  @query(".barcode-box") private _barcodeBox?: HTMLElement;
  @query("lh-logo-preview-dialog") private _previewDialog?: LhLogoPreviewDialog;
  private _auto = new AutoUsedTimer(() => this._autoMarkUsed());
  private _unobserve: (() => void) | null = null;
  private _cardId = "";
  private _mql: MediaQueryList | null = null;
  private _onMql = (e: MediaQueryListEvent | MediaQueryList) => {
    this._touch = e.matches;
    if (!e.matches) this._menuOpen = false;
  };
  private _onDocPointer = (e: Event) => {
    const path = e.composedPath();
    const menu = this.renderRoot.querySelector(".menu");
    const toggle = this.renderRoot.querySelector(".menu-toggle");
    if ((menu && path.includes(menu)) || (toggle && path.includes(toggle))) return;
    this._menuOpen = false;
  };
  private _onDocKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !this._menuOpen) return;
    e.preventDefault();
    e.stopPropagation();
    this._closeMenu(true);
  };

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .hero { max-width: 280px; margin: 0 auto 14px; }
    .header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .header h1 { flex: 1; margin: 0; font-size: 1.35em; font-weight: 600; overflow-wrap: anywhere; }
    .header .icons { display: flex; gap: 6px; --mdc-icon-size: 20px; color: var(--secondary-text-color); }
    .barcode-box { margin-bottom: 12px; padding: 20px 12px; cursor: pointer; border: none; width: 100%; font: inherit; }
    .barcode-box:focus-visible { outline: 3px solid var(--primary-color); outline-offset: 2px; }
    lh-barcode { width: 100%; }
    .tap-hint { color: #555; font-size: 0.8em; display: flex; align-items: center; gap: 4px; --mdc-icon-size: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .actions .btn { flex: 1 1 auto; }
    .meta { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; font-size: 0.95em; }
    .origin { font-size: 0.8em; color: var(--secondary-text-color); }
    .chart { margin-bottom: 16px; }
    .chart .head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .chart .head .label { flex: 1; }
    .chart .head .btn { min-height: 32px; padding: 0 10px; font-size: 0.85em; }
    .notes { white-space: pre-wrap; overflow-wrap: anywhere; }
    .format { color: #555; font-size: 0.8em; }
    details.more-actions { margin-bottom: 16px; }
    details.more-actions > summary {
      cursor: pointer; min-height: 40px; display: flex; align-items: center; gap: 6px;
      color: var(--primary-color); font-weight: 500; list-style: none;
    }
    details.more-actions > summary::-webkit-details-marker { display: none; }
    .places { list-style: none; margin: 8px 0 0; padding: 0; }
    .places li { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--divider-color); }
    .places li:last-child { border-bottom: none; }
    .places li span { flex: 1; font-family: monospace; font-size: 0.9em; }
    /* §12.7: "Quick access" and "Shop locations" are small and discreet. */
    details.discreet > summary {
      color: var(--secondary-text-color); font-weight: 400; font-size: 0.85em; --mdc-icon-size: 16px;
    }
    details.discreet > summary:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }
    /* Touch bottom bar (§12.7, §14.4). */
    :host([touch]) { padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px)); }
    .bottom-bar {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 5;
      display: flex; align-items: center; gap: 6px;
      padding: 8px 8px calc(8px + env(safe-area-inset-bottom, 0px));
      background: var(--card-background-color, var(--primary-background-color));
      color: var(--primary-text-color);
      border-top: 1px solid var(--divider-color);
      box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.12);
    }
    .bottom-bar .spacer { flex: 1; }
    .bottom-bar .btn { padding: 0 12px; white-space: nowrap; flex: none; }
    .bottom-bar .back { border-color: transparent; padding: 0 8px 0 2px; gap: 2px; }
    /* The cashier label may wrap on two short lines so everything fits on a 360 px phone. */
    .bottom-bar .cashier {
      flex: 0 1 auto; min-width: 0; white-space: normal; line-height: 1.15;
      font-size: 0.85em; text-align: center; padding: 2px 10px;
    }
    .bottom-bar .menu-wrap { position: relative; }
    .menu {
      position: absolute; bottom: calc(100% + 8px); left: 0; min-width: 210px;
      display: flex; flex-direction: column; padding: 6px 0;
      background: var(--card-background-color, var(--primary-background-color));
      color: var(--primary-text-color); border: 1px solid var(--divider-color);
      border-radius: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    }
    .menu button {
      display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 16px;
      border: none; background: transparent; color: inherit; cursor: pointer; text-align: start;
      --mdc-icon-size: 20px;
    }
    .menu button:hover { background: var(--secondary-background-color, rgba(127, 127, 127, 0.12)); }
    .menu button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
    .menu .menu-sep { height: 1px; margin: 6px 0; background: var(--divider-color); }
    .actions .actions-sep { align-self: stretch; width: 1px; margin: 0 4px; background: var(--divider-color); }
    /* Very small phones: "Back" keeps only its chevron (the text stays as aria-label). */
    @media (max-width: 359px) {
      .bottom-bar .back .label { display: none; }
    }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    this._auto.attach();
    if (this.hasUpdated) this._observe();
    this._mql = window.matchMedia(TOUCH_QUERY);
    this._onMql(this._mql);
    this._mql.addEventListener("change", this._onMql);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._auto.detach();
    this._unobserve?.();
    this._unobserve = null;
    this._mql?.removeEventListener("change", this._onMql);
    this._mql = null;
    this._menuOpen = false;
    this._listenMenu(false);
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("card") && this.card && this.card.id !== this._cardId) {
      // A new "opening": the automatic mark is allowed once again.
      this._cardId = this.card.id;
      this._auto.reset();
      this._showQr = false;
      this._menuOpen = false;
      this._transferOpen = false;
      this._nfcOpen = false;
      this._clearHistoryOpen = false;
      this._unobserve?.();
      this._unobserve = null;
    }
    if (changed.has("cashier")) {
      if (this.cashier) this._cashierOpen = true;
      // Back gesture (popstate) closed it from the panel: close the overlay without a new event.
      else if (changed.get("cashier") === true) this._cashierOpen = false;
    }
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("_touch")) this.toggleAttribute("touch", this._touch);
    if (changed.has("_menuOpen")) {
      this._listenMenu(this._menuOpen);
      if (this._menuOpen) this.renderRoot.querySelector<HTMLElement>(".menu button")?.focus();
    }
    if (!this._unobserve) this._observe();
    this._auto.setVisible("cashier", this._cashierOpen);
  }

  private _observe() {
    const box = this._barcodeBox;
    if (!box) return;
    this._unobserve?.();
    this._unobserve = observeVisible(box, (v) => this._auto.setVisible("detail", v));
  }

  private _listenMenu(on: boolean) {
    if (on) {
      document.addEventListener("pointerdown", this._onDocPointer, true);
      document.addEventListener("keydown", this._onDocKey, true);
    } else {
      document.removeEventListener("pointerdown", this._onDocPointer, true);
      document.removeEventListener("keydown", this._onDocKey, true);
    }
  }

  private _closeMenu(refocus = false) {
    this._menuOpen = false;
    if (refocus) this.renderRoot.querySelector<HTMLElement>(".menu-toggle")?.focus();
  }

  /** Arrow keys / Home / End move between menu items; Tab closes the menu. */
  private _onMenuKey(e: KeyboardEvent) {
    const items = [...this.renderRoot.querySelectorAll<HTMLElement>(".menu button")];
    if (!items.length) return;
    const active = (this.renderRoot as ShadowRoot).activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Tab") { this._menuOpen = false; return; }
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  private _menuAction(fn: () => void) {
    this._closeMenu(true);
    fn();
  }

  private _toast(message: string) {
    fireEvent(this, "show-toast", { message });
  }

  private async _autoMarkUsed() {
    // An admin looking at someone else's card must not change its usage (§11.1).
    if (this.card.admin_view) return;
    try {
      const before = this.card.use_count;
      const card = await markUsed(this.hass, this.card.id);
      fireEvent(this, "card-updated", { card });
      // The server ignores uses within 10 minutes: say nothing then.
      if (card.use_count !== before) this._toast(this.t("tiles_auto_used"));
    } catch {
      /* silent: the manual button is still there */
    }
  }

  private async _markUsed() {
    this._busy = true;
    try {
      const card = await markUsed(this.hass, this.card.id);
      fireEvent(this, "card-updated", { card });
      this._toast(this.t("marked_used"));
    } catch (err) {
      this._toast(wsErrorText(err, this.t));
    } finally {
      this._busy = false;
    }
  }

  private _saveImage() {
    const canvas = this._barcode?.canvas;
    if (!canvas) return;
    composeImage(canvas, this.card.name, this.card.code).toBlob((blob) => {
      if (blob) downloadBlob(blob, `${sanitizeFilename(this.card.name)}.png`);
    }, "image/png");
  }

  private async _copy(cashier: boolean) {
    const ok = await copyText(cardLink(this.card.id, cashier));
    this._toast(this.t(ok ? "tiles_link_copied" : "tiles_link_copy_failed"));
  }

  private _closeCashier() {
    this._cashierOpen = false;
    fireEvent(this, "cashier-closed");
  }

  /** §11.5: one explicit position request, sent to the server only here. */
  private async _hereNow() {
    const t = this.t;
    if (!window.isSecureContext || !navigator.geolocation) {
      this._toast(t("tiles_geo_unavailable"));
      return;
    }
    this._locating = true;
    try {
      let pos: GeolocationPosition;
      try {
        pos = await currentPosition();
      } catch (err) {
        const code = (err as GeolocationPositionError)?.code;
        const key: I18nKey = code === 1 ? "tiles_geo_denied" : "tiles_geo_failed";
        this._toast(t(key));
        return;
      }
      const before = this.card.locations?.length ?? 0;
      const card = await addLocation(this.hass, this.card.id, pos.coords.latitude, pos.coords.longitude);
      fireEvent(this, "card-updated", { card });
      this._toast(t((card.locations?.length ?? 0) > before ? "tiles_place_saved" : "tiles_place_known"));
    } catch (err) {
      this._toast(wsErrorText(err, t));
    } finally {
      this._locating = false;
    }
  }

  private async _removePlace() {
    const loc = this._toRemove;
    if (!loc) return;
    this._busy = true;
    try {
      const card = await removeLocation(this.hass, this.card.id, loc.id);
      fireEvent(this, "card-updated", { card });
      this._toast(this.t("tiles_place_removed"));
    } catch (err) {
      this._toast(wsErrorText(err, this.t));
    } finally {
      this._toRemove = null;
      this._busy = false;
    }
  }

  private _coord(n: number) {
    try {
      return new Intl.NumberFormat(this.language, { minimumFractionDigits: 5, maximumFractionDigits: 5 }).format(n);
    } catch {
      return n.toFixed(5);
    }
  }

  private _renderPlaces() {
    const t = this.t;
    const c = this.card;
    const places = c.locations ?? [];
    return html`
      <details class="more-actions discreet">
        <summary><ha-icon icon="mdi:map-marker-radius"></ha-icon>${t("tiles_places_title", { count: places.length })}</summary>
        <p class="hint">${t("tiles_places_hint")}</p>
        <button class="btn" ?disabled=${this._locating} @click=${this._hereNow}>
          <ha-icon icon="mdi:crosshairs-gps"></ha-icon>${this._locating ? t("tiles_locating") : t("tiles_here_now")}</button>
        ${places.length ? html`<ul class="places">
          ${places.map((p, i) => html`<li>
            <ha-icon icon="mdi:map-marker"></ha-icon>
            <span title=${t("tiles_place_n", { n: i + 1 })}>${this._coord(p.lat)}, ${this._coord(p.lon)}</span>
            ${c.can_edit ? html`<button class="icon-btn" title=${t("tiles_place_remove")} aria-label=${t("tiles_place_remove")}
              @click=${() => { this._toRemove = p; }}><ha-icon icon="mdi:delete-outline"></ha-icon></button>` : nothing}
          </li>`)}
        </ul>` : nothing}
      </details>`;
  }

  /** §12.6: the panel pushes a history entry for the cashier overlay. */
  private _openCashier = () => {
    this._cashierOpen = true;
    fireEvent(this, "cashier-opened");
  };
  private _toggleQr = () => { this._showQr = !this._showQr; };
  private _edit = () => fireEvent(this, "edit-card", { card: this.card });

  /** §14.2: domain for "Refresh logo" (card field first, then the one of the current logo). */
  private get _refreshDomain(): string | null {
    const d = (this.card.logo_domain ?? this.card.logo?.domain ?? "").trim().toLowerCase();
    return isValidDomain(d) ? d : null;
  }

  private _onLogoToggle(e: Event) {
    if (!(e.target as HTMLDetailsElement).open || this._logoProviders !== null || this._logoLoading) return;
    this._logoLoading = true;
    getLogoProviders(this.hass)
      .then((p) => { this._logoProviders = p.providers; }, () => { this._logoProviders = []; })
      .finally(() => { this._logoLoading = false; });
  }

  private _refreshLogo() {
    const domain = this._refreshDomain;
    if (domain) this._previewDialog?.show(this.card, "auto", domain);
  }

  /** §14.2: discreet "Logo" section, only for editable cards with something to offer. */
  private _renderLogo() {
    const c = this.card;
    const t = this.t;
    if (!c.can_edit || (!this._refreshDomain && !c.logo_previous)) return nothing;
    const canRefresh = !!this._refreshDomain && (this._logoProviders?.length ?? 0) > 0;
    return html`
      <details class="more-actions discreet" @toggle=${this._onLogoToggle}>
        <summary><ha-icon icon="mdi:image-outline"></ha-icon>${t("logo")}</summary>
        <div class="actions">
          ${canRefresh ? html`<button class="btn" @click=${this._refreshLogo}
            title=${t("tiles_logo_refresh_hint", { domain: this._refreshDomain! })}>
            <ha-icon icon="mdi:refresh"></ha-icon>${t("tiles_logo_refresh")}</button>` : nothing}
          ${c.logo_previous ? html`<lh-logo-revert-button .hass=${this.hass} .t=${t} language=${this.language}
            .card=${c}></lh-logo-revert-button>` : nothing}
        </div>
        ${!canRefresh && !c.logo_previous && !this._logoLoading ? html`<p class="hint">${t("tiles_logo_no_provider")}</p>` : nothing}
      </details>`;
  }

  private _feature(id: Parameters<typeof featureOn>[0]) {
    return featureOn(id, this.settings, this.prefs);
  }

  private get _canTransfer(): boolean {
    return !!this.card.can_manage && !this.card.admin_view;
  }

  private get _canNfc(): boolean {
    return this._feature("nfc") && !this.card.admin_view;
  }

  private _onTransferred = (e: CustomEvent<{ card: Card | null; toName: string }>) => {
    const { card, toName } = e.detail;
    this._toast(this.t("tiles_transfer_done", { name: toName }));
    if (card) fireEvent(this, "card-updated", { card });
    else fireEvent(this, "card-deleted", { id: this.card.id });
  };

  private _onCashierTab = (e: CustomEvent<{ cardId: string }>) => {
    fireEvent(this, "tab-changed", { cardId: e.detail.cardId });
  };

  private async _clearHistory() {
    this._busy = true;
    try {
      const card = await clearPointsHistory(this.hass, this.card.id);
      fireEvent(this, "card-updated", { card });
      this._toast(this.t("tiles_points_history_cleared"));
    } catch (err) {
      this._toast(wsErrorText(err, this.t));
    } finally {
      this._busy = false;
      this._clearHistoryOpen = false;
    }
  }

  /** §15.4: "Added by Alice" / "Transferred by Alice on …" (small, secondary). */
  private _renderOrigin() {
    const c = this.card;
    const t = this.t;
    const lines = [];
    if (c.created_by && c.created_by_name) lines.push(t("tiles_added_by", { name: c.created_by_name }));
    if (c.transferred_at) {
      const date = formatDate(c.transferred_at, this.language);
      lines.push(c.transferred_by_name
        ? t("tiles_transferred_by", { name: c.transferred_by_name, date })
        : t("tiles_transferred_on", { date }));
    }
    return lines.map((l) => html`<span class="origin">${l}</span>`);
  }

  /** §15.5 points_history: chart of the last 12 months (≥ 2 entries). */
  private _renderChart() {
    const c = this.card;
    if (c.kind === "voucher" || !this._feature("points_history")) return nothing;
    const entries = recentPoints(c.points_history);
    if (entries.length < 2) return nothing;
    const t = this.t;
    return html`<div class="chart">
      <div class="head"><span class="label">${t("tiles_points_history")}</span>
        ${c.can_edit ? html`<button class="btn" @click=${() => { this._clearHistoryOpen = true; }}>
          ${t("tiles_points_history_clear")}</button>` : nothing}</div>
      <lh-points-chart .entries=${entries} .t=${t} language=${this.language}></lh-points-chart>
    </div>`;
  }

  private _extra(id: string) {
    fireEvent(this, "lh-extra-action", { id });
  }

  /** Mouse: the row of buttons (unchanged). */
  private _renderActions() {
    const c = this.card;
    const t = this.t;
    return html`
      <div class="actions">
        <button class="btn primary" ?disabled=${this._busy} @click=${this._markUsed}>
          <ha-icon icon="mdi:check-circle"></ha-icon>${t("mark_used")}
        </button>
        <button class="btn" @click=${this._openCashier}>
          <ha-icon icon="mdi:cellphone-screenshot"></ha-icon>${t("tiles_cashier_open")}
        </button>
        ${c.barcode_format !== "QR_CODE" ? html`
          <button class="btn" @click=${this._toggleQr}>
            <ha-icon icon=${this._showQr ? "mdi:barcode" : "mdi:qrcode"}></ha-icon>
            ${this._showQr ? t("show_original") : t("show_qr")}
          </button>` : nothing}
        <button class="btn" @click=${this._saveImage}>
          <ha-icon icon="mdi:download"></ha-icon>${t("save_image")}
        </button>
        ${c.can_edit ? html`
          <button class="btn" @click=${this._edit}>
            <ha-icon icon="mdi:pencil"></ha-icon>${t("edit")}
          </button>` : nothing}
        ${this._canTransfer ? html`
          <button class="btn" @click=${() => { this._transferOpen = true; }}>
            <ha-icon icon="mdi:account-arrow-right"></ha-icon>${t("tiles_transfer")}
          </button>` : nothing}
        ${this._canNfc ? html`
          <button class="btn" @click=${() => { this._nfcOpen = true; }}>
            <ha-icon icon="mdi:nfc-variant"></ha-icon>${t("tiles_nfc")}
          </button>` : nothing}
        ${this.extraActions.length ? html`<span class="actions-sep" role="separator"></span>
          ${this.extraActions.map((a) => html`<button class="btn" @click=${() => this._extra(a.id)}>
            <ha-icon icon=${a.icon}></ha-icon>${a.label}</button>`)}` : nothing}
      </div>`;
  }

  /** Touch devices (§12.7, §14.4): back · ⋮ menu · … · cashier · Used (filled, bottom-right corner). */
  private _renderBottomBar() {
    const c = this.card;
    const t = this.t;
    return html`
      <div class="bottom-bar" role="toolbar" aria-label=${c.name}>
        <button class="btn back" aria-label=${t("back")} @click=${() => fireEvent(this, "lh-back")}>
          <ha-icon icon="mdi:chevron-left"></ha-icon><span class="label">${t("back")}</span>
        </button>
        <span class="menu-wrap">
          <button class="icon-btn menu-toggle" aria-haspopup="menu" aria-expanded=${this._menuOpen ? "true" : "false"}
            aria-controls="detail-menu" title=${t("tiles_more_actions")} aria-label=${t("tiles_more_actions")}
            @click=${() => { this._menuOpen = !this._menuOpen; }}>
            <ha-icon icon="mdi:dots-vertical"></ha-icon>
          </button>
          ${this._menuOpen ? html`
            <div class="menu" id="detail-menu" role="menu" aria-label=${t("tiles_more_actions")}
              @keydown=${this._onMenuKey}>
              ${c.can_edit ? html`<button role="menuitem" @click=${() => this._menuAction(this._edit)}>
                <ha-icon icon="mdi:pencil"></ha-icon>${t("edit")}</button>` : nothing}
              <button role="menuitem" @click=${() => this._menuAction(() => this._saveImage())}>
                <ha-icon icon="mdi:download"></ha-icon>${t("save_image")}</button>
              ${c.barcode_format !== "QR_CODE" ? html`<button role="menuitem"
                @click=${() => this._menuAction(this._toggleQr)}>
                <ha-icon icon=${this._showQr ? "mdi:barcode" : "mdi:qrcode"}></ha-icon>
                ${this._showQr ? t("show_original") : t("show_qr")}</button>` : nothing}
              ${this._canTransfer ? html`<button role="menuitem"
                @click=${() => this._menuAction(() => { this._transferOpen = true; })}>
                <ha-icon icon="mdi:account-arrow-right"></ha-icon>${t("tiles_transfer")}</button>` : nothing}
              ${this._canNfc ? html`<button role="menuitem"
                @click=${() => this._menuAction(() => { this._nfcOpen = true; })}>
                <ha-icon icon="mdi:nfc-variant"></ha-icon>${t("tiles_nfc")}</button>` : nothing}
              ${this.extraActions.length ? html`<div class="menu-sep" role="separator"></div>
                ${this.extraActions.map((a) => html`<button role="menuitem"
                  @click=${() => this._menuAction(() => this._extra(a.id))}>
                  <ha-icon icon=${a.icon}></ha-icon>${a.label}</button>`)}` : nothing}
            </div>` : nothing}
        </span>
        <span class="spacer"></span>
        <button class="btn cashier" @click=${this._openCashier}>
          ${t("tiles_cashier_open")}
        </button>
        <button class="btn primary" ?disabled=${this._busy} @click=${this._markUsed}>
          <ha-icon icon="mdi:check-circle"></ha-icon>${t("mark_used")}
        </button>
      </div>`;
  }

  protected override render() {
    const c = this.card;
    if (!c || !this.t) return nothing;
    const t = this.t;
    const format = this._showQr ? "QR_CODE" : c.barcode_format;
    const links = priceCompareLinks(this.settings?.price_compare, c.name);
    const expired = isExpired(c.expiry);
    return html`
      <lh-card-tile class="hero" layout="large" .card=${c} .hass=${this.hass} .t=${t}
        language=${this.language}></lh-card-tile>
      <div class="header">
        <h1>${c.name}</h1>
        <span class="icons">
          ${c.favorite ? html`<ha-icon icon="mdi:star" title=${t("favorite")}></ha-icon>` : nothing}
          ${c.visibility === "shared"
            ? html`<ha-icon icon="mdi:account-multiple" title=${t("shared")}></ha-icon>`
            : html`<ha-icon icon="mdi:lock" title=${t("private")}></ha-icon>`}
          ${c.zones?.length ? html`<ha-icon icon="mdi:map-marker" title=${t("has_zones")}></ha-icon>` : nothing}
        </span>
      </div>

      <button class="barcode-box" aria-label=${t("tiles_cashier_open")} @click=${this._openCashier}>
        <lh-barcode .code=${c.code} .format=${format}
          error-text=${t("render_error", { format: FORMAT_LABELS[format] ?? format })}></lh-barcode>
        <div class="code-text">${c.code}</div>
        <div class="format">${FORMAT_LABELS[format] ?? format}</div>
        <span class="tap-hint"><ha-icon icon="mdi:gesture-tap"></ha-icon>${t("tiles_cashier_tap")}</span>
      </button>

      ${this._touch ? nothing : this._renderActions()}

      <div class="meta">
        ${c.kind !== "voucher" && c.points !== null && c.points !== undefined
          ? html`<span>${t("points", { count: c.points })}</span>` : nothing}
        ${c.kind !== "voucher" && c.points_expiry && this._feature("points_expiry") ? html`<span
          class=${isExpired(c.points_expiry) ? "error-text" : ""}>${t(isExpired(c.points_expiry)
            ? "tiles_points_expired" : "tiles_points_expire", { date: formatDate(c.points_expiry, this.language) })}</span>`
          : nothing}
        ${c.expiry && c.kind !== "voucher" ? html`<span class=${expired ? "error-text" : ""}>
          ${t(expired ? "expired" : "expires", { date: formatDate(c.expiry, this.language) })}</span>` : nothing}
        ${(c.can_manage === false || c.admin_view) && c.owner_name
          ? html`<span class="muted">${t("owner", { name: c.owner_name })}</span>` : nothing}
        <span class="muted">${t("used_times", { count: c.use_count ?? 0 })}${c.last_used
          ? html` · ${formatDate(c.last_used, this.language, true)}` : nothing}</span>
        ${c.notes ? html`<span class="label">${t("notes")}</span><span class="notes">${c.notes}</span>` : nothing}
        ${this._renderOrigin()}
      </div>

      ${c.todo_entity && this._feature("shopping_list") ? html`<lh-todo-box .hass=${this.hass} .t=${t}
        entity=${c.todo_entity}></lh-todo-box>` : nothing}
      ${this._renderChart()}

      ${c.kind === "voucher" ? html`<lh-voucher-section .hass=${this.hass} .card=${c} .t=${t}
        language=${this.language}></lh-voucher-section>` : nothing}

      <details class="more-actions discreet">
        <summary><ha-icon icon="mdi:link-variant"></ha-icon>${t("tiles_quick_access")}</summary>
        <p class="hint">${t("tiles_quick_access_hint")}</p>
        <div class="actions">
          <button class="btn" @click=${() => this._copy(false)}>
            <ha-icon icon="mdi:link-variant"></ha-icon>${t("tiles_copy_link")}</button>
          <button class="btn" @click=${() => this._copy(true)}>
            <ha-icon icon="mdi:cellphone-link"></ha-icon>${t("tiles_copy_cashier_link")}</button>
        </div>
      </details>

      ${this._renderPlaces()}
      ${this._renderLogo()}

      ${links.length ? html`
        <div class="links">
          <span class="muted">${t("price_compare")}:</span>
          ${links.map((l) => html`<a href=${l.href} target="_blank" rel="noopener noreferrer">${l.name}</a>`)}
        </div>` : nothing}

      ${this._touch ? this._renderBottomBar() : nothing}

      <lh-logo-preview-dialog .hass=${this.hass} .t=${t} language=${this.language}></lh-logo-preview-dialog>

      <lh-cashier-view .open=${this._cashierOpen} .card=${c} .t=${t} .format=${format} .tabs=${this.tabs}
        ?high-contrast=${this._feature("high_contrast_cashier") && !!this.prefs?.cashier_high_contrast}
        @tab-change=${this._onCashierTab} @closed=${this._closeCashier}></lh-cashier-view>

      ${this._canTransfer ? html`<lh-transfer-dialog .hass=${this.hass} .t=${t} .card=${c} .open=${this._transferOpen}
        @transferred=${this._onTransferred} @closed=${() => { this._transferOpen = false; }}></lh-transfer-dialog>` : nothing}
      ${this._canNfc ? html`<lh-nfc-dialog .hass=${this.hass} .t=${t} .card=${c} .open=${this._nfcOpen}
        @closed=${() => { this._nfcOpen = false; }}></lh-nfc-dialog>` : nothing}

      <lh-dialog .open=${this._clearHistoryOpen} heading=${t("tiles_points_history_clear")} close-label=${t("close")}
        @closed=${() => { this._clearHistoryOpen = false; }}>
        <p>${t("tiles_points_history_clear_confirm")}</p>
        <button slot="actions" class="btn" @click=${() => { this._clearHistoryOpen = false; }}>${t("cancel")}</button>
        <button slot="actions" class="btn danger" ?disabled=${this._busy} @click=${this._clearHistory}>${t("delete")}</button>
      </lh-dialog>

      <lh-dialog .open=${!!this._toRemove} heading=${t("tiles_place_remove")} close-label=${t("close")}
        @closed=${() => { this._toRemove = null; }}>
        <p>${t("tiles_place_remove_confirm")}</p>
        <button slot="actions" class="btn" @click=${() => { this._toRemove = null; }}>${t("cancel")}</button>
        <button slot="actions" class="btn danger" ?disabled=${this._busy} @click=${this._removePlace}>${t("delete")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-detail-view", LhDetailView);

declare global {
  interface HTMLElementTagNameMap { "lh-detail-view": LhDetailView }
}
