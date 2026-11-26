import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { I18nKey, Translate } from "../i18n";
import { sharedStyles } from "../styles";
import { LOGO_DEV_URL, type LogoDevState } from "../types";
import { defineElement } from "../util";
import "./lh-dialog";

const STEPS: I18nKey[] = [
  "logodev_guide_step1", "logodev_guide_step2", "logodev_guide_step3",
  "logodev_guide_step4", "logodev_guide_step5", "logodev_guide_step6",
];

/**
 * §14.1: dialog shown by the Logo.dev button when the provider is not "ready".
 * Admins get "Why Logo.dev is recommended" (§15.1) and the step-by-step guide (plus how to re-enable it when "disabled"); other users are
 * asked to contact the household administrator. Fires `closed` (not bubbling).
 */
export class LhLogoDevGuide extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) t!: Translate;
  @property() state: LogoDevState = "no_key";
  @property({ type: Boolean }) admin = false;

  static override styles = [sharedStyles, css`
    ol { padding-inline-start: 22px; margin: 8px 0 12px; display: flex; flex-direction: column; gap: 6px; }
    p { margin: 0 0 10px; }
  `];

  private _close = () => {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  };

  private _body() {
    const t = this.t;
    if (!this.admin) {
      return html`<p>${t(this.state === "disabled" ? "logodev_state_disabled" : "logodev_state_no_key")}</p>
        <p>${t("logodev_ask_admin")}</p>`;
    }
    return html`
      ${this.state === "disabled" ? html`<p>${t("logodev_state_disabled")}</p>
        <p>${t("logodev_disabled_admin")}</p>` : nothing}
      <p><strong>${t("logodev_why_title")}</strong><br />${t("logodev_why_text")}</p>
      <p>${t("logodev_guide_intro")}</p>
      <ol>${STEPS.map((k) => html`<li>${t(k)}</li>`)}</ol>
      <p class="hint"><ha-icon icon="mdi:shield-check-outline"></ha-icon> ${t("logodev_guide_privacy")}</p>`;
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    return html`
      <lh-dialog .open=${this.open} heading=${t(this.admin ? "logodev_guide_title" : "logodev_title")}
        close-label=${t("close")} @closed=${this._close}>
        ${this._body()}
        ${this.admin ? html`<a slot="actions" class="btn" href=${LOGO_DEV_URL} target="_blank" rel="noopener noreferrer">
          <ha-icon icon="mdi:open-in-new"></ha-icon>${t("logodev_open_site")}</a>` : nothing}
        <button slot="actions" class="btn primary" @click=${this._close}>${t("close")}</button>
      </lh-dialog>`;
  }
}

defineElement("lh-logo-dev-guide", LhLogoDevGuide);

declare global {
  interface HTMLElementTagNameMap { "lh-logo-dev-guide": LhLogoDevGuide }
}
