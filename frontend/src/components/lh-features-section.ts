import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { errorMessage, setFeatures } from "../api";
import type { I18nKey, Translate } from "../i18n";
import { sharedStyles } from "../styles";
import { FEATURE_IDS, type FeatureId, type HomeAssistant, type LoyaltySettings } from "../types";
import { defineElement, fireEvent } from "../util";

/** §15.5: name and one-line explanation of every admin feature (also used by the user settings). */
export const FEATURE_LABELS: Record<FeatureId, { name: I18nKey; hint: I18nKey }> = {
  nfc: { name: "feature_nfc", hint: "feature_nfc_hint" },
  shopping_list: { name: "feature_shopping_list", hint: "feature_shopping_list_hint" },
  unused_reminder: { name: "feature_unused_reminder", hint: "feature_unused_reminder_hint" },
  points_history: { name: "feature_points_history", hint: "feature_points_history_hint" },
  points_expiry: { name: "feature_points_expiry", hint: "feature_points_expiry_hint" },
  default_sharing: { name: "feature_default_sharing", hint: "feature_default_sharing_hint" },
  manual_order: { name: "feature_manual_order", hint: "feature_manual_order_hint" },
  low_balance: { name: "feature_low_balance", hint: "feature_low_balance_hint" },
  find_by_code: { name: "feature_find_by_code", hint: "feature_find_by_code_hint" },
  high_contrast_cashier: { name: "feature_high_contrast_cashier", hint: "feature_high_contrast_cashier_hint" },
};

/**
 * §15 error codes with a clear text: `feature_disabled` (feature turned off by the admin) and
 * `recipient_refuses` (the server message names the person); anything else → generic error.
 */
export function featureErrorText(t: Translate, err: unknown): string {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (code === "feature_disabled") return t("error_feature_disabled");
  if (code === "recipient_refuses") return t("error_recipient_refuses", { msg: errorMessage(err) });
  return t("error_generic", { msg: errorMessage(err) });
}

/**
 * §15.5 Administration → "Features": one switch per feature with a line of explanation.
 * Saves with `features/set`. Fires `settings-changed` {settings}, `show-toast` {message}.
 */
export class LhFeaturesSection extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) settings: LoyaltySettings | null = null;
  @state() private _saving: FeatureId | null = null;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    h3 { font-size: 1em; font-weight: 500; margin: 16px 0 6px; }
    .note { display: block; margin: 0 0 8px; line-height: 1.4; }
    .feat { margin-bottom: 4px; }
    .feat .hint { display: block; margin: -6px 0 6px 30px; line-height: 1.35; }
  `];

  private async _set(id: FeatureId, on: boolean) {
    this._saving = id;
    try {
      const features = await setFeatures(this.hass, { [id]: on });
      const settings = { ...(this.settings ?? {}), features } as LoyaltySettings;
      fireEvent(this, "settings-changed", { settings });
      fireEvent(this, "show-toast", { message: this.t("saved") });
    } catch (err) {
      fireEvent(this, "show-toast", { message: featureErrorText(this.t, err) });
      this.requestUpdate();
    } finally {
      this._saving = null;
    }
  }

  protected override render() {
    const t = this.t;
    if (!t || !this.hass?.user?.is_admin) return nothing;
    const f = this.settings?.features ?? {};
    return html`
      <h3>${t("features_title")}</h3>
      <span class="hint note">${t("features_admin_note")}</span>
      ${FEATURE_IDS.map((id) => html`<div class="feat">
        <label class="check"><input type="checkbox" .checked=${!!f[id]} ?disabled=${this._saving !== null}
          @change=${(e: Event) => this._set(id, (e.target as HTMLInputElement).checked)} />
          ${t(FEATURE_LABELS[id].name)}</label>
        <span class="hint">${t(FEATURE_LABELS[id].hint)}</span>
      </div>`)}`;
  }
}

defineElement("lh-features-section", LhFeaturesSection);

declare global {
  interface HTMLElementTagNameMap { "lh-features-section": LhFeaturesSection }
}
