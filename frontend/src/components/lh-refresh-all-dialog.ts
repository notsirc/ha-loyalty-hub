import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { errorMessage, refreshAllLogos } from "../api";
import { formatNumber, type Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { HomeAssistant, LogoRefreshProgress } from "../types";
import { defineElement, fireEvent } from "../util";
import "./lh-dialog";

type Phase = "confirm" | "starting" | "running" | "busy" | "error";

/**
 * §14.2: "Update all logos": warning → Start → logo/refresh_all → progress bar (counts only).
 * The progress comes from the panel (`progress`, fed by the `logo_refresh` subscribe events).
 * Fires `closed` and `logo-refresh-started` {progress} (initial counts, before the first event).
 */
export class LhRefreshAllDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @property({ type: Boolean }) open = false;
  @property({ type: Boolean }) admin = false;
  @property({ attribute: false }) progress: LogoRefreshProgress | null = null;
  @state() private _phase: Phase = "confirm";
  @state() private _error = "";

  static override styles = [sharedStyles, css`
    :host { display: contents; }
    progress { width: 100%; height: 12px; margin: 8px 0; }
    p { margin: 6px 0; line-height: 1.4; }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      // A run still going on (started earlier in this session): show its progress directly.
      this._phase = this.progress?.running ? "running" : "confirm";
      this._error = "";
    }
  }

  private async _start() {
    const before = this.progress;
    this._phase = "starting";
    this._error = "";
    try {
      const { total } = await refreshAllLogos(this.hass);
      // No event arrived meanwhile: show the initial counts until the first one.
      if (this.progress === before) {
        fireEvent(this, "logo-refresh-started", {
          progress: { done: 0, total, updated: 0, failed: 0, running: total > 0 } satisfies LogoRefreshProgress,
        });
      }
      this._phase = "running";
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code === "limit_reached") this._phase = "busy";
      else {
        this._phase = "error";
        this._error = this.t("error_generic", { msg: errorMessage(err) });
      }
    }
  }

  private _close() {
    fireEvent(this, "closed");
  }

  private _renderProgress() {
    const t = this.t;
    const p = this.progress;
    if (!p) return html`<p class="muted">${t("loading")}</p>`;
    if (!p.total) return html`<p>${t("refresh_all_none")}</p>`;
    const n = (v: number) => formatNumber(v, this.language);
    return html`
      <progress max=${p.total} .value=${Math.min(p.done, p.total)}></progress>
      <p role="status">${t("refresh_all_progress", { done: n(p.done), total: n(p.total) })}</p>
      <p class="hint">${t("refresh_all_counts", { updated: n(p.updated), failed: n(p.failed) })}</p>
      <p>${p.running ? html`<span class="hint">${t("refresh_all_background_hint")}</span>` : t("refresh_all_done")}</p>`;
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const ph = this._phase;
    let body;
    if (ph === "confirm" || ph === "starting") {
      body = html`<p>${t("refresh_all_warning")}</p>
        <p class="hint">${this.admin ? t("refresh_all_hint_admin") : t("refresh_all_hint_user")}</p>`;
    } else if (ph === "busy") body = html`<p>${t("refresh_all_busy")}</p>`;
    else if (ph === "error") body = html`<p class="error-text">${this._error}</p>`;
    else body = this._renderProgress();
    const confirm = ph === "confirm" || ph === "starting";
    return html`<lh-dialog .open=${this.open} heading=${t("refresh_all_title")} close-label=${t("close")}
      @closed=${(e: Event) => { e.stopPropagation(); this._close(); }}>
      ${body}
      ${confirm
        ? html`<button slot="actions" class="btn" @click=${this._close}>${t("cancel")}</button>
          <button slot="actions" class="btn primary" ?disabled=${ph === "starting"} @click=${this._start}>
            <ha-icon icon="mdi:refresh"></ha-icon>${t("refresh_all_start")}</button>`
        : html`<button slot="actions" class="btn" @click=${this._close}>${t("close")}</button>`}
    </lh-dialog>`;
  }
}

defineElement("lh-refresh-all-dialog", LhRefreshAllDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-refresh-all-dialog": LhRefreshAllDialog }
}
