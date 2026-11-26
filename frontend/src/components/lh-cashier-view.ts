import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { FORMAT_LABELS } from "../barcode";
import type { Translate } from "../i18n";
import type { BarcodeFormat, Card } from "../types";
import { defineElement } from "../util";
import "./lh-barcode";
import { WakeLockHandle } from "./lh-helpers";

/**
 * Cashier mode (§11.8): full screen white overlay with the barcode as large as possible, screen kept
 * on (Wake Lock) and Fullscreen API when available. Tap anywhere or "Close" to exit.
 * Built on a modal <dialog> (top layer) so it also works inside other dialogs (Lovelace card).
 * Fires `closed` (not bubbling) when dismissed.
 * §15.3: with `tabs` (≥ 2 cards of a group) arrows ‹ › on the sides, horizontal swipe and ←/→ keys change
 * the card; the tab label is shown above the code. Fires `tab-change` {cardId} (not bubbling): the
 * owner switches `card` (the detail view restarts the automatic "used" on every change).
 * §15.5 high_contrast_cashier: `highContrast` = pure white, no logo/name/colors, code as large as
 * possible with a wide quiet zone; linear codes rotated by 90° on a portrait screen.
 */
export interface CashierTab { card: Card; label: string }

const TWO_D: readonly BarcodeFormat[] = ["QR_CODE", "AZTEC", "DATA_MATRIX"];
/** Not rotated in high contrast (already wide and short, or square). */
const NO_ROTATE: readonly BarcodeFormat[] = [...TWO_D, "PDF_417"];
const SWIPE_MIN_PX = 50;

export class LhCashierView extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ attribute: false }) card?: Card;
  @property({ attribute: false }) t!: Translate;
  /** Format to show (e.g. QR instead of the original); defaults to the card format. */
  @property({ attribute: false }) format?: BarcodeFormat;
  /** §15.3: the tabs of the group (fewer than 2 = no navigation). */
  @property({ attribute: false }) tabs: CashierTab[] = [];
  /** §15.5: high contrast mode. */
  @property({ type: Boolean, attribute: "high-contrast" }) highContrast = false;
  @state() private _portrait = false;
  private _swipe: { x: number; y: number; id: number } | null = null;
  /** A swipe just happened: the click that follows must not close the overlay. */
  private _swiped = false;
  private _portraitMql: MediaQueryList | null = null;
  private _onPortrait = (e: MediaQueryListEvent | MediaQueryList) => { this._portrait = e.matches; };
  @query("dialog") private _dialog?: HTMLDialogElement;
  @query(".stage") private _stage?: HTMLElement;
  private _wake = new WakeLockHandle();
  private _fullscreen = false;

  static override styles = css`
    :host { display: contents; }
    dialog {
      border: none; margin: 0; padding: 0; width: 100vw; height: 100vh; height: 100dvh;
      max-width: none; max-height: none; background: #ffffff; color: #000000; overflow: hidden;
    }
    dialog::backdrop { background: #ffffff; }
    .stage {
      width: 100%; height: 100%; background: #ffffff; color: #000000; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
      padding: max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom));
      cursor: pointer; user-select: none; -webkit-user-select: none;
      font-family: var(--ha-font-family-body, Roboto, sans-serif);
    }
    .stage:fullscreen { background: #ffffff; }
    .name { font-size: 0.95em; color: #444; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    lh-barcode { width: min(100%, 900px); flex: 1 1 auto; min-height: 0; max-height: 62vh; }
    lh-barcode.two-d { max-height: 70vh; width: min(100%, 70vh); }
    .code { font-family: monospace; font-size: 1.25em; letter-spacing: 0.08em; word-break: break-all; text-align: center; }
    .hint { color: #666; font-size: 0.85em; }
    .tab {
      font-size: 1.15em; font-weight: 600; color: #000; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dots { display: flex; gap: 6px; }
    .dots span { width: 8px; height: 8px; border-radius: 50%; background: #ccc; }
    .dots span.on { background: #000; }
    .stage { position: relative; touch-action: pan-y; }
    button.nav {
      position: absolute; top: 50%; transform: translateY(-50%); z-index: 1;
      width: 48px; height: 72px; min-height: 0; padding: 0; border-radius: 12px; font-size: 2em; line-height: 1;
      border: 1px solid #ddd; background: rgba(255, 255, 255, 0.92); color: #000;
    }
    button.nav.prev { left: max(4px, env(safe-area-inset-left)); }
    button.nav.next { right: max(4px, env(safe-area-inset-right)); }
    /* §15.5 high contrast: as large as possible, wide white quiet zone, crisp pixels. */
    .stage.hc { gap: 8px; padding-left: 8px; padding-right: 8px; }
    .stage.hc lh-barcode {
      width: 100%; max-height: 80vh; padding: 6vmin; box-sizing: border-box; image-rendering: pixelated;
    }
    .stage.hc lh-barcode.two-d { width: min(100%, 84vh); max-height: 84vh; }
    .stage.hc .rot-wrap {
      flex: 1 1 auto; min-height: 0; width: 100%; display: flex; align-items: center; justify-content: center;
      overflow: hidden;
    }
    .stage.hc lh-barcode.rot { width: 74vh; height: 92vw; max-height: none; flex: none; transform: rotate(90deg); }
    button {
      font: inherit; min-height: 44px; padding: 0 24px; border-radius: 22px; cursor: pointer;
      border: 1px solid #bbb; background: #ffffff; color: #000000; font-weight: 500;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this._portraitMql = window.matchMedia("(orientation: portrait)");
    this._onPortrait(this._portraitMql);
    this._portraitMql.addEventListener("change", this._onPortrait);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._leave();
    this._portraitMql?.removeEventListener("change", this._onPortrait);
    this._portraitMql = null;
  }

  private get _index(): number {
    return this.tabs.findIndex((x) => x.card.id === this.card?.id);
  }

  /** Moves to the previous (-1) or next (+1) tab, wrapping around. */
  private _step(dir: number) {
    const n = this.tabs.length;
    if (n < 2) return;
    const i = Math.max(0, this._index);
    const next = this.tabs[(i + dir + n) % n];
    this.dispatchEvent(new CustomEvent("tab-change", { detail: { cardId: next.card.id } }));
  }

  private _onKey = (e: KeyboardEvent) => {
    if (this.tabs.length < 2) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      this._step(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      this._step(1);
    }
  };

  private _onPointerDown = (e: PointerEvent) => {
    if (this.tabs.length < 2 || !e.isPrimary) return;
    this._swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };

  private _onPointerUp = (e: PointerEvent) => {
    const s = this._swipe;
    this._swipe = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    this._swiped = true;
    window.setTimeout(() => { this._swiped = false; }, 400);
    this._step(dx < 0 ? 1 : -1);
  };

  private _onStageClick = () => {
    if (this._swiped) {
      this._swiped = false;
      return;
    }
    this._close();
  };

  protected override updated(changed: Map<string, unknown>): void {
    if (!changed.has("open")) return;
    if (this.open) this._enter();
    else this._leave();
  }

  private _enter() {
    const dlg = this._dialog;
    if (dlg && !dlg.open) dlg.showModal();
    this._wake.acquire();
    document.addEventListener("fullscreenchange", this._onFullscreenChange);
    const stage = this._stage;
    if (stage?.requestFullscreen && document.fullscreenEnabled !== false && !document.fullscreenElement) {
      // Needs a user gesture: silently ignored when opened from a link (?cashier=1).
      stage.requestFullscreen({ navigationUI: "hide" }).then(() => { this._fullscreen = true; })
        .catch(() => undefined);
    }
  }

  private _leave() {
    this._wake.release();
    document.removeEventListener("fullscreenchange", this._onFullscreenChange);
    if (this._fullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    this._fullscreen = false;
    if (this._dialog?.open) this._dialog.close();
  }

  /** Leaving fullscreen with the system back gesture also leaves cashier mode. */
  private _onFullscreenChange = () => {
    if (this._fullscreen && !document.fullscreenElement) {
      this._fullscreen = false;
      this._close();
    }
  };

  private _close = () => {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  };

  private _onCancel = (e: Event) => {
    e.preventDefault();
    this._close();
  };

  protected override render() {
    const c = this.card;
    const t = this.t;
    const format = this.format ?? c?.barcode_format ?? "CODE_128";
    const twoD = TWO_D.includes(format);
    const hc = this.highContrast;
    const multi = this.tabs.length > 1;
    const idx = this._index;
    const tab = multi && idx >= 0 ? this.tabs[idx] : null;
    const rotate = hc && this._portrait && !NO_ROTATE.includes(format);
    const stop = (e: Event) => e.stopPropagation();
    const code = html`<lh-barcode fill class="${twoD ? "two-d" : ""} ${rotate ? "rot" : ""}" .code=${c?.code ?? ""}
      .format=${format} error-text=${t ? t("render_error", { format: FORMAT_LABELS[format] ?? format }) : ""}></lh-barcode>`;
    return html`
      <dialog @cancel=${this._onCancel} @keydown=${this._onKey} aria-label=${t ? t("tiles_cashier_title") : ""}>
        ${this.open && c && t ? html`
          <div class="stage ${hc ? "hc" : ""}" @click=${this._onStageClick}
            @pointerdown=${this._onPointerDown} @pointerup=${this._onPointerUp}
            @pointercancel=${() => { this._swipe = null; }}>
            ${hc ? nothing : html`<div class="name">${c.name}</div>`}
            ${tab ? html`<div class="tab" aria-live="polite">${tab.label}</div>` : nothing}
            ${rotate ? html`<div class="rot-wrap">${code}</div>` : code}
            ${hc ? nothing : html`<div class="code">${c.code}</div>`}
            ${multi ? html`<div class="dots" aria-hidden="true">${this.tabs.map((x) =>
              html`<span class=${x.card.id === c.id ? "on" : ""}></span>`)}</div>` : nothing}
            ${hc ? nothing : html`<span class="hint">${t("tiles_cashier_hint")}</span>`}
            <button @click=${(e: Event) => { e.stopPropagation(); this._close(); }}>${t("close")}</button>
            ${multi ? html`
              <button class="nav prev" aria-label=${t("tiles_tab_prev")} title=${t("tiles_tab_prev")}
                @pointerdown=${stop} @click=${(e: Event) => { e.stopPropagation(); this._step(-1); }}>‹</button>
              <button class="nav next" aria-label=${t("tiles_tab_next")} title=${t("tiles_tab_next")}
                @pointerdown=${stop} @click=${(e: Event) => { e.stopPropagation(); this._step(1); }}>›</button>` : nothing}
          </div>` : nothing}
      </dialog>
    `;
  }
}

defineElement("lh-cashier-view", LhCashierView);

declare global {
  interface HTMLElementTagNameMap { "lh-cashier-view": LhCashierView }
}
