import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { Translate } from "../i18n";
import { logoUrl, wordmarkColor } from "../logo";
import type { Card, HomeAssistant } from "../types";
import { defineElement, formatDate, formatMoney, isExpired, safeColor } from "../util";

/** CSS font-size for the automatic wordmark, fitted to the tile via container query units. */
export function wordmarkFontSize(name: string): string {
  const text = name.trim() || "?";
  const longestWord = Math.max(...text.split(/\s+/).map((w) => w.length), 1);
  // §11.10: at most two lines; longer names end with an ellipsis instead of shrinking forever.
  const lines = text.length <= 12 ? 1 : 2;
  const perLine = Math.min(Math.max(longestWord, Math.ceil(text.length / lines)), 16);
  const byWidth = 82 / (perLine * 0.74); // % of tile width (extra-bold glyph ≈ 0.74em)
  const byHeight = 66 / (lines * 1.12); // % of tile height
  return `min(${byWidth.toFixed(2)}cqw, ${byHeight.toFixed(2)}cqh, 34cqh)`;
}

/**
 * Stocard-style tile (credit-card ratio 1.586): brand color + large centered logo, or an automatic
 * wordmark. No text on tiles with a logo (name only in aria-label/title). Discreet corner badges.
 * layout: "grid" (tile), "list" (small tile + text row), "large" (detail header, not clickable).
 */
export class LhCardTile extends LitElement {
  @property({ attribute: false }) card!: Card;
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @property() layout: "grid" | "list" | "large" = "grid";
  /** §15.3: number of cards of the group shown by this tile (> 1 → "×N" badge, bottom left). */
  @property({ type: Number }) groupCount = 1;
  /** §16.2: personal group name, shown instead of the card name (label, list layout). */
  @property() displayName = "";
  /** §15.5 low_balance: balance at or below the user's threshold → orange balance pill. */
  @property({ type: Boolean }) lowBalance = false;
  /** Overrides the logo source (form preview). `""` = force wordmark. */
  @property({ attribute: false }) logoSrc?: string;
  @state() private _src: string | null = null;
  @state() private _failed = false;
  private _key = "";
  /** One retry per logo version when a cached object URL stops working (e.g. revoked by the cache pruning). */
  private _retried = "";

  static override styles = css`
    :host { display: block; }
    .wrap { display: flex; align-items: center; gap: 12px; width: 100%; }
    button.wrap { border: none; padding: 0; background: none; font: inherit; color: inherit; cursor: pointer; text-align: left; }
    button.wrap:focus-visible .tile { outline: 3px solid var(--primary-color); outline-offset: 2px; }
    button.wrap:active .tile { transform: scale(0.97); }
    .tile {
      position: relative; width: 100%; aspect-ratio: 1.586; overflow: hidden; flex: none;
      border-radius: calc(var(--ha-card-border-radius, 12px) * 0.9);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.08);
      container-type: size; transition: transform 0.08s ease-out;
    }
    .list .tile { width: 96px; border-radius: 8px; }
    .large .tile { border-radius: 16px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); }
    img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    img.contain { object-fit: contain; padding: 8%; box-sizing: border-box; }
    img.cover { object-fit: cover; }
    .wordmark {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      padding: 8cqh 8cqw; box-sizing: border-box; text-align: center; font-weight: 800;
      line-height: 1.08; letter-spacing: -0.01em; overflow: hidden; overflow-wrap: break-word; hyphens: manual;
      font-family: var(--ha-font-family-body, Roboto, "Helvetica Neue", Arial, sans-serif);
    }
    .wordmark .wm {
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
      overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
    .balance {
      position: absolute; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: rgba(0, 0, 0, 0.55); color: #fff; font-weight: 600; line-height: 1.25;
      border-radius: 999px; padding: 0.25em 0.7em; font-variant-numeric: tabular-nums;
      font-family: var(--ha-font-family-body, Roboto, sans-serif);
    }
    .balance.top_left { top: 5cqh; left: 3.5cqw; }
    .balance.bottom_left { bottom: 5cqh; left: 3.5cqw; }
    .balance.bottom_right { bottom: 5cqh; right: 3.5cqw; }
    .balance.low { background: var(--warning-color, #f57c00); color: #000; }
    .balance.s { font-size: max(10px, 10cqh); }
    .balance.m { font-size: max(11px, 14cqh); }
    .balance.l { font-size: max(12px, 19cqh); }
    .list .balance { display: none; }
    .badges { position: absolute; top: 5cqh; right: 3.5cqw; display: flex; gap: 2.5cqw; }
    .badge {
      width: max(18px, 13cqh); height: max(18px, 13cqh); border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.38); color: #fff; --mdc-icon-size: max(12px, 8.5cqh);
    }
    .list .badges { display: none; }
    .count {
      position: absolute; bottom: 5cqh; left: 3.5cqw; padding: 0.15em 0.55em; border-radius: 999px;
      background: rgba(0, 0, 0, 0.55); color: #fff; font-weight: 700; line-height: 1.25;
      font-size: max(10px, 11cqh); font-family: var(--ha-font-family-body, Roboto, sans-serif);
    }
    /* The balance pill already sits bottom-left: the badge moves above it. */
    .count.raised { bottom: 24cqh; }
    .list .count { font-size: 10px; bottom: 4px; left: 4px; }
    .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .text .name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .text .info { color: var(--secondary-text-color); font-size: 0.85em; display: flex; gap: 8px; flex-wrap: wrap; }
    .text ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); }
    .expired { text-decoration: line-through; }
  `;

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (this.logoSrc !== undefined) {
      if (changed.has("logoSrc")) {
        this._src = this.logoSrc || null;
        this._failed = false;
        this._key = "\u0000override"; // forces a recompute when the override is removed
      }
      return;
    }
    const c = this.card;
    const key = c?.logo ? `${c.id}:${c.logo.version}` : "";
    if (key === this._key) return;
    this._key = key;
    this._src = null;
    this._failed = false;
    if (!key || !this.hass) {
      if (!this.hass) this._key = ""; // retry once hass is set
      return;
    }
    const promise = logoUrl(this.hass, c);
    promise?.then((url) => {
      if (this._key === key) this._src = url;
    }).catch(() => {
      if (this._key === key) this._failed = true;
    });
  }

  private _onImgError = () => {
    const key = this._key;
    if (this.logoSrc === undefined && this._src?.startsWith("blob:") && key && this._retried !== key) {
      this._retried = key;
      this._key = ""; // next update asks logo.ts again (its memo entry was dropped by the pruning)
      this._src = null;
      return;
    }
    this._failed = true;
  };

  private _badges() {
    const c = this.card;
    const t = this.t;
    return html`<span class="badges" aria-hidden="true">
      ${c.kind === "voucher" ? html`<span class="badge" title=${t("voucher")}><ha-icon icon="mdi:ticket-percent"></ha-icon></span>` : nothing}
      ${c.visibility === "shared" ? html`<span class="badge" title=${t("shared")}><ha-icon icon="mdi:account-multiple"></ha-icon></span>` : nothing}
      ${c.favorite ? html`<span class="badge" title=${t("favorite")}><ha-icon icon="mdi:star"></ha-icon></span>` : nothing}
    </span>`;
  }

  /** §11.10: semi-transparent balance pill on voucher tiles (corner and size are card fields). */
  private _balancePill() {
    const c = this.card;
    const size = c.balance_size ?? "s";
    if (c.kind !== "voucher" || size === "off" || c.balance === null || c.balance === undefined) return nothing;
    const corner = ["top_left", "bottom_left", "bottom_right"].includes(c.balance_corner) ? c.balance_corner : "bottom_right";
    return html`<span class="balance ${corner} ${size} ${this.lowBalance ? "low" : ""}"
      aria-hidden="true">${formatMoney(c.balance, c.currency, this.language)}</span>`;
  }

  /** True when the balance pill is drawn in the bottom-left corner. */
  private get _pillBottomLeft(): boolean {
    const c = this.card;
    return c.kind === "voucher" && (c.balance_size ?? "s") !== "off" && c.balance !== null && c.balance !== undefined
      && c.balance_corner === "bottom_left" && this.layout !== "list";
  }

  /** §15.3: "×N" badge of a group tile. */
  private _countBadge() {
    if (!(this.groupCount > 1)) return nothing;
    return html`<span class="count ${this._pillBottomLeft ? "raised" : ""}" aria-hidden="true">×${this.groupCount}</span>`;
  }

  private _face() {
    const c = this.card;
    const bg = safeColor(c.color);
    const showImg = !!this._src && !this._failed;
    const fit = c.logo_fit === "cover" ? "cover" : "contain";
    return html`<div class="tile" style="background:${bg}" title=${this.displayName || c.name}>
      ${showImg
        ? html`<img class=${fit} src=${this._src!} alt="" loading="lazy" decoding="async" draggable="false"
            @error=${this._onImgError} />`
        : html`<div class="wordmark" style="color:${wordmarkColor(bg)};font-size:${wordmarkFontSize(c.name)}">
            <span class="wm">${c.name}</span></div>`}
      ${this._balancePill()}
      ${this._badges()}
      ${this._countBadge()}
    </div>`;
  }

  private _info() {
    const c = this.card;
    const t = this.t;
    const expired = isExpired(c.expiry);
    return html`<span class="info">
      ${c.kind === "voucher" && c.balance !== null && c.balance !== undefined
        ? html`<strong>${formatMoney(c.balance, c.currency, this.language)}</strong>` : nothing}
      ${c.kind !== "voucher" && c.points !== null && c.points !== undefined
        ? html`<span>${t("points", { count: c.points })}</span>` : nothing}
      ${c.expiry ? html`<span class=${expired ? "expired" : ""}>${t(expired ? "expired" : "expires",
        { date: formatDate(c.expiry, this.language) })}</span>` : nothing}
      ${c.favorite ? html`<ha-icon icon="mdi:star" title=${t("favorite")}></ha-icon>` : nothing}
      ${c.visibility === "shared" ? html`<ha-icon icon="mdi:account-multiple" title=${t("shared")}></ha-icon>` : nothing}
      ${c.zones?.length ? html`<ha-icon icon="mdi:map-marker" title=${t("has_zones")}></ha-icon>` : nothing}
    </span>`;
  }

  protected override render() {
    const c = this.card;
    if (!c || !this.t) return nothing;
    const name = this.displayName || c.name;
    const label = this.groupCount > 1 ? `${name} (${this.t("tiles_group_count", { count: this.groupCount })})` : name;
    if (this.layout === "large") {
      return html`<div class="wrap large" role="img" aria-label=${label}>${this._face()}</div>`;
    }
    return html`<button class="wrap ${this.layout}" aria-label=${label}>
      ${this._face()}
      ${this.layout === "list" ? html`<span class="text"><span class="name">${name}</span>${this._info()}</span>` : nothing}
    </button>`;
  }
}

defineElement("lh-card-tile", LhCardTile);

declare global {
  interface HTMLElementTagNameMap { "lh-card-tile": LhCardTile }
}
