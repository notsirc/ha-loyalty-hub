import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { errorMessage, setLogoCache, testLogoKey } from "../api";
import type { I18nKey, Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { HomeAssistant, LogoDevState, LogoKeyTestResult, LoyaltySettings } from "../types";
import { LOGO_CACHE_MAX_DAYS, LOGO_DEV_URL } from "../types";
import { defineElement, fireEvent } from "../util";
import "./lh-features-section";

/** Days proposed when "Keep logos forever" is turned off. */
const DEFAULT_CACHE_DAYS = 30;

const STATE_KEYS: Record<LogoDevState, I18nKey> = {
  ready: "logodev_state_ready", no_key: "logodev_state_no_key", disabled: "logodev_state_disabled",
};
const TEST_KEYS: Record<LogoKeyTestResult, I18nKey> = {
  ok: "logodev_test_ok", rejected: "logodev_test_rejected", rate_limited: "logodev_test_rate_limited",
  unreachable: "logodev_test_unreachable", missing: "logodev_test_missing",
};
const GUIDE_STEPS: I18nKey[] = [
  "logodev_guide_step1", "logodev_guide_step2", "logodev_guide_step3",
  "logodev_guide_step4", "logodev_guide_step5", "logodev_guide_step6",
];

/**
 * §14.2 / §14.1: "Administration" section of the settings (admins only): online logo cache
 * (forever / refresh after N days), Logo.dev key status, "Test the key", 6-step guide;
 * §15.5 "Features" (lh-features-section).
 * Never shows a key. Fires `settings-changed` {settings}, `show-toast` {message}.
 */
export class LhAdminSection extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) settings: LoyaltySettings | null = null;
  @state() private _days = "";
  @state() private _daysError = false;
  @state() private _saving = false;
  @state() private _testing = false;
  @state() private _test: LogoKeyTestResult | null = null;
  @state() private _testError = "";

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .days { max-width: 220px; margin: 4px 0 0 30px; }
    .section > .hint { display: block; margin: 4px 0 8px; line-height: 1.4; }
    h3 { font-size: 1em; font-weight: 500; margin: 16px 0 6px; }
    ol { margin: 6px 0; padding-left: 22px; line-height: 1.45; }
    ol li { margin-bottom: 4px; }
    details summary { cursor: pointer; color: var(--primary-color); min-height: 36px; display: flex; align-items: center; }
    .result { margin: 8px 0 0; }
    .result.ok { color: var(--success-color, #43a047); }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("settings") && !this._saving) {
      const d = this.settings?.logo_cache_days;
      this._days = typeof d === "number" ? String(d) : "";
      this._daysError = false;
    }
  }

  private get _forever(): boolean {
    return typeof this.settings?.logo_cache_days !== "number";
  }

  private async _saveCache(days: number | null) {
    this._saving = true;
    try {
      const saved = await setLogoCache(this.hass, days);
      const settings = { ...(this.settings ?? {}), logo_cache_days: saved } as LoyaltySettings;
      this._saving = false;
      fireEvent(this, "settings-changed", { settings });
      fireEvent(this, "show-toast", { message: this.t("saved") });
    } catch (err) {
      this._saving = false;
      fireEvent(this, "show-toast", { message: this.t("error_generic", { msg: errorMessage(err) }) });
      this.requestUpdate("settings");
    }
  }

  private _onForever(e: Event) {
    const on = (e.target as HTMLInputElement).checked;
    if (on) this._saveCache(null);
    else this._saveCache(Number(this._days) || DEFAULT_CACHE_DAYS);
  }

  private _onDays(e: Event) {
    const raw = (e.target as HTMLInputElement).value.trim();
    this._days = raw;
    const n = Number(raw);
    const ok = /^\d+$/.test(raw) && n >= 1 && n <= LOGO_CACHE_MAX_DAYS;
    this._daysError = !ok;
    if (ok && n !== this.settings?.logo_cache_days) this._saveCache(n);
  }

  private async _testKey() {
    this._testing = true;
    this._test = null;
    this._testError = "";
    try {
      this._test = await testLogoKey(this.hass);
    } catch (err) {
      this._testError = this.t("error_generic", { msg: errorMessage(err) });
    } finally {
      this._testing = false;
    }
  }

  private _renderCache() {
    const t = this.t;
    const forever = this._forever;
    return html`
      <h3>${t("logo_cache_title")}</h3>
      <label class="check"><input type="checkbox" .checked=${forever} ?disabled=${this._saving}
        @change=${this._onForever} />${t("logo_cache_forever")}</label>
      ${forever ? nothing : html`<div class="field days ${this._daysError ? "invalid" : ""}">
        <label for="cdays">${t("logo_cache_days")}</label>
        <input id="cdays" type="number" inputmode="numeric" min="1" max=${LOGO_CACHE_MAX_DAYS} step="1"
          .value=${this._days} @change=${this._onDays} />
        ${this._daysError ? html`<span class="error-text">${t("logo_cache_days_invalid", { max: LOGO_CACHE_MAX_DAYS })}</span>`
          : nothing}
      </div>`}
      <span class="hint">${t("logo_cache_hint")}</span>`;
  }

  private _renderLogoDev() {
    const t = this.t;
    const state: LogoDevState = this.settings?.logo_dev?.state ?? "no_key";
    const test = this._test;
    return html`
      <h3>${t("logodev_title")}</h3>
      <p>${t(STATE_KEYS[state])}</p>
      ${state === "disabled" ? html`<p class="hint">${t("logodev_disabled_admin")}</p>` : nothing}
      <button class="btn" ?disabled=${this._testing} @click=${this._testKey}>
        <ha-icon icon="mdi:key-chain-variant"></ha-icon>${this._testing ? t("logodev_testing") : t("logodev_test")}</button>
      ${test ? html`<p class="result ${test === "ok" ? "ok" : "error-text"}" role="status">${t(TEST_KEYS[test])}</p>`
        : nothing}
      ${this._testError ? html`<p class="result error-text" role="status">${this._testError}</p>` : nothing}
      <details ?open=${state === "no_key"}>
        <summary>${t("logodev_guide_title")}</summary>
        <p><strong>${t("logodev_why_title")}</strong><br />${t("logodev_why_text")}</p>
        <p>${t("logodev_guide_intro")}</p>
        <ol>${GUIDE_STEPS.map((k) => html`<li>${t(k)}</li>`)}</ol>
        <p class="hint">${t("logodev_guide_privacy")}</p>
        <div class="links"><a href=${LOGO_DEV_URL} target="_blank" rel="noopener noreferrer">${t("logodev_open_site")}</a></div>
      </details>`;
  }

  protected override render() {
    const t = this.t;
    if (!t || !this.hass?.user?.is_admin) return nothing;
    return html`<div class="section">
      <h2>${t("admin_section_title")}</h2>
      ${this._renderCache()}
      ${this._renderLogoDev()}
      <lh-features-section .hass=${this.hass} .t=${t} .settings=${this.settings}></lh-features-section>
    </div>`;
  }
}

defineElement("lh-admin-section", LhAdminSection);

declare global {
  interface HTMLElementTagNameMap { "lh-admin-section": LhAdminSection }
}
