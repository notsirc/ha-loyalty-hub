import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { acceptAdminNotice, errorMessage } from "../api";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { HomeAssistant, LoyaltySettings, UserPrefs } from "../types";
import { defineElement, fireEvent } from "../util";

/** §11.1: true when the blocking notice must be shown to this user. */
export function needsAdminNotice(
  hass: HomeAssistant | undefined, settings: LoyaltySettings | undefined, prefs: UserPrefs | null,
): boolean {
  if (!hass?.user || hass.user.is_admin) return false;
  if (!settings?.admin_full_access || !prefs) return false;
  return (prefs.admin_notice_accepted ?? null) !== (settings.admin_notice_epoch ?? 0);
}

/**
 * Blocking notice: "the administrator can see and edit all cards". Shown once per epoch to
 * non-admin users. Fires `admin-notice-accepted` {prefs}.
 */
export class LhAdminNotice extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @state() private _busy = false;
  @state() private _error = "";

  static override styles = [sharedStyles, css`
    :host {
      position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
      padding: 16px; background: rgba(0, 0, 0, 0.55);
    }
    .box {
      width: 100%; max-width: 440px; max-height: calc(100vh - 32px); overflow: auto;
      background: var(--card-background-color, var(--primary-background-color));
      color: var(--primary-text-color); border-radius: var(--ha-card-border-radius, 12px);
      padding: 20px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    }
    h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; font-size: 1.2em; font-weight: 500; }
    h2 ha-icon { color: var(--warning-color, var(--primary-color)); }
    ul { margin: 8px 0 16px; padding-left: 20px; line-height: 1.45; }
    p { line-height: 1.45; margin: 0 0 8px; }
    .actions { display: flex; justify-content: flex-end; }
  `];

  override firstUpdated(): void {
    (this.renderRoot.querySelector("button") as HTMLButtonElement | null)?.focus();
  }

  private async _accept() {
    this._busy = true;
    this._error = "";
    try {
      const prefs = await acceptAdminNotice(this.hass);
      fireEvent(this, "admin-notice-accepted", { prefs });
    } catch (err) {
      this._error = this.t("error_generic", { msg: errorMessage(err) });
    } finally {
      this._busy = false;
    }
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    return html`<div class="box" role="alertdialog" aria-modal="true" aria-labelledby="ttl" aria-describedby="txt">
      <h2 id="ttl"><ha-icon icon="mdi:shield-account-outline"></ha-icon>${t("admin_notice_title")}</h2>
      <div id="txt">
        <p>${t("admin_notice_intro")}</p>
        <ul>
          <li>${t("admin_notice_can")}</li>
          <li>${t("admin_notice_cannot")}</li>
          <li>${t("admin_notice_notify")}</li>
        </ul>
      </div>
      ${this._error ? html`<p class="error-text" role="alert">${this._error}</p>` : nothing}
      <div class="actions">
        <button class="btn primary" ?disabled=${this._busy} @click=${this._accept}>${t("admin_notice_ok")}</button>
      </div>
    </div>`;
  }
}

defineElement("lh-admin-notice", LhAdminNotice);

declare global {
  interface HTMLElementTagNameMap { "lh-admin-notice": LhAdminNotice }
}
