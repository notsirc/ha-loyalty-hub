import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { styleMap } from "lit/directives/style-map.js";
import { updateCard } from "../api";
import type { Translate } from "../i18n";
import { loadImage, logoBackground, logoUrl, type LogoBackgroundRule } from "../logo";
import { sharedStyles } from "../styles";
import { DEFAULT_COLOR, type Card, type HomeAssistant } from "../types";
import { defineElement, fireEvent, safeColor } from "../util";
import "./lh-dialog";

/** Logos analysed at the same time. */
const PARALLEL = 4;

/** §15.2: own cards (can_manage), not admin_view, with a logo and still the default color (archived included). */
export const colorCandidates = (cards: Card[]) => cards.filter((c) =>
  c.can_manage !== false && !c.admin_view && !!c.logo && (c.color || "").toUpperCase() === DEFAULT_COLOR);

interface Row { card: Card; url: string | null; color: string | null; rule: LogoBackgroundRule; checked: boolean }
type Phase = "computing" | "review" | "applying" | "done";

/**
 * §15.2 "Color from logos": computes a background from each candidate logo in the browser (cached
 * logos, at most 4 at a time), shows before/after with a checkbox, saves one card at a time.
 * Fires `card-updated` {card} for every saved card and `closed` (not bubbling). Cancel saves nothing.
 */
export class LhLogoColorsDialog extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) cards: Card[] = [];
  @state() private _phase: Phase = "computing";
  @state() private _rows: Row[] = [];
  @state() private _done = 0;
  @state() private _total = 0;
  @state() private _result = { ok: 0, failed: 0 };
  /** Bumped on every (re)open and on close: stale async work stops. */
  private _run = 0;

  static override styles = [sharedStyles, css`
    :host { display: contents; }
    lh-dialog { --lh-dialog-wide-width: min(96vw, 720px); }
    progress { width: 100%; height: 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 8px; }
    .cell {
      display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 10px;
      border: 1px solid var(--divider-color); cursor: pointer;
    }
    .cell.off { opacity: 0.6; }
    .cell .name { display: flex; align-items: center; gap: 6px; font-size: 0.9em; min-width: 0; }
    .cell .name span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cell input { width: 18px; height: 18px; accent-color: var(--primary-color); flex: none; margin: 0; }
    .pair { display: flex; align-items: center; gap: 4px; }
    .pair ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); flex: none; }
    .mini {
      flex: 1; aspect-ratio: 1.586; border-radius: 6px; display: flex; align-items: center; justify-content: center;
      overflow: hidden; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
    }
    .mini img { max-width: 78%; max-height: 70%; object-fit: contain; }
    .mini.none { background: repeating-linear-gradient(45deg, transparent 0 6px, var(--divider-color) 6px 8px); }
    .none-text { font-size: 0.8em; color: var(--secondary-text-color); }
    .bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  `];

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) this._start();
      else this._run++;
    }
  }

  private async _start() {
    const run = ++this._run;
    const cands = colorCandidates(this.cards);
    this._rows = cands.map((card) => ({ card, url: null, color: null, rule: "none" as LogoBackgroundRule, checked: false }));
    this._total = cands.length;
    this._done = 0;
    this._result = { ok: 0, failed: 0 };
    this._phase = "computing";
    if (!cands.length) {
      this._phase = "review";
      return;
    }
    let next = 0;
    const worker = async () => {
      while (run === this._run) {
        const i = next++;
        if (i >= cands.length) return;
        const row = await this._analyse(cands[i]);
        if (run !== this._run) return;
        this._rows = this._rows.map((r, j) => (j === i ? row : r));
        this._done++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, cands.length) }, worker));
    if (run === this._run) this._phase = "review";
  }

  private async _analyse(card: Card): Promise<Row> {
    let url: string | null = null;
    try {
      url = (await logoUrl(this.hass, card)) ?? null;
      if (!url) return { card, url, color: null, rule: "none", checked: false };
      const img = await loadImage(url);
      const res = logoBackground(img);
      const color = res.color ? safeColor(res.color).toUpperCase() : null;
      // Same as the current color: nothing to change.
      const useful = !!color && color !== DEFAULT_COLOR;
      return { card, url, color: useful ? color : null, rule: useful ? res.rule : "none", checked: useful };
    } catch {
      return { card, url, color: null, rule: "none", checked: false };
    }
  }

  private _toggle(i: number, on: boolean) {
    this._rows = this._rows.map((r, j) => (j === i ? { ...r, checked: on && !!r.color } : r));
  }

  private _setAll(on: boolean) {
    this._rows = this._rows.map((r) => ({ ...r, checked: on && !!r.color }));
  }

  private async _apply() {
    const run = this._run;
    const chosen = this._rows.filter((r) => r.checked && r.color);
    this._phase = "applying";
    this._total = chosen.length;
    this._done = 0;
    let ok = 0;
    let failed = 0;
    for (const r of chosen) {
      if (run !== this._run) return;
      try {
        const card = await updateCard(this.hass, r.card.id, { color: r.color! });
        ok++;
        fireEvent(this, "card-updated", { card });
      } catch {
        failed++;
      }
      this._done++;
    }
    this._result = { ok, failed };
    this._phase = "done";
  }

  private _close() {
    this.open = false;
    this._run++;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private _mini(bg: string | null, url: string | null) {
    if (!bg) return html`<div class="mini none">${url ? html`<img src=${url} alt="" />` : nothing}</div>`;
    return html`<div class="mini" style=${styleMap({ background: safeColor(bg) })}>
      ${url ? html`<img src=${url} alt="" />` : nothing}</div>`;
  }

  private _renderGrid() {
    const t = this.t;
    return html`<div class="grid">
      ${this._rows.map((r, i) => html`<label class="cell ${r.color ? "" : "off"}">
        <span class="name"><input type="checkbox" .checked=${r.checked} ?disabled=${!r.color}
          @change=${(e: Event) => this._toggle(i, (e.target as HTMLInputElement).checked)} />
          <span title=${r.card.name}>${r.card.name}</span></span>
        <span class="pair" aria-label=${t("logo_colors_before_after")}>
          ${this._mini(r.card.color, r.url)}<ha-icon icon="mdi:arrow-right"></ha-icon>${this._mini(r.color, r.url)}
        </span>
        ${r.color ? nothing : html`<span class="none-text">${t("logo_colors_none_suitable")}</span>`}
      </label>`)}
    </div>`;
  }

  private _body() {
    const t = this.t;
    switch (this._phase) {
      case "computing":
        return html`<p>${t("logo_colors_computing", { done: this._done, total: this._total })}</p>
          <progress max=${this._total || 1} .value=${this._done}></progress>
          ${this._renderGrid()}`;
      case "applying":
        return html`<p>${t("logo_colors_applying", { done: this._done, total: this._total })}</p>
          <progress max=${this._total || 1} .value=${this._done}></progress>`;
      case "done":
        return html`<p role="status">${t("logo_colors_result", { ok: this._result.ok, failed: this._result.failed })}</p>`;
      default: {
        if (!this._rows.length) return html`<p>${t("logo_colors_no_candidates")}</p>`;
        const usable = this._rows.filter((r) => r.color).length;
        return html`<p class="hint">${t("logo_colors_hint")}</p>
          ${usable ? html`<div class="bar">
            <button class="btn" @click=${() => this._setAll(true)}>${t("logo_colors_select_all")}</button>
            <button class="btn" @click=${() => this._setAll(false)}>${t("logo_colors_select_none")}</button>
          </div>` : nothing}
          ${this._renderGrid()}`;
      }
    }
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const phase = this._phase;
    const count = this._rows.filter((r) => r.checked && r.color).length;
    return html`<lh-dialog wide .open=${this.open} heading=${t("logo_colors_title")} close-label=${t("close")}
      @closed=${() => this._close()}>
      ${this._body()}
      ${phase === "done" || (phase === "review" && !this._rows.length)
        ? html`<button slot="actions" class="btn primary" @click=${() => this._close()}>${t("close")}</button>`
        : html`<button slot="actions" class="btn" ?disabled=${phase === "applying"} @click=${() => this._close()}>
            ${t("cancel")}</button>
          <button slot="actions" class="btn primary" ?disabled=${phase !== "review" || !count} @click=${() => this._apply()}>
            ${t("logo_colors_apply", { count })}</button>`}
    </lh-dialog>`;
  }
}

defineElement("lh-logo-colors-dialog", LhLogoColorsDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-logo-colors-dialog": LhLogoColorsDialog }
}
