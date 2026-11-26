import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ensureLanguage, languageReady, makeT } from "../i18n";
import { sharedStyles } from "../styles";
import type { HomeAssistant } from "../types";
import { defineElement, fireEvent } from "../util";

interface EditorConfig {
  type: string;
  mode?: "auto" | "all" | "favorites" | "nearby";
  max_items?: number;
  /** §16.3: selector on the card (default true). */
  show_selector?: boolean;
}

/** Simple visual editor for loyalty-hub-card. Fires HA's `config-changed`. */
export class LoyaltyHubCardEditor extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @state() private _config: EditorConfig = { type: "custom:loyalty-hub-card" };

  static override styles = [sharedStyles, css`
    :host { display: block; padding: 8px 0; }
    .check { display: flex; align-items: center; gap: 8px; min-height: 40px; }
    .hint { margin: 0 0 8px 30px; line-height: 1.4; }
  `];

  setConfig(config: EditorConfig): void {
    this._config = { ...config };
  }

  private _update(changes: Partial<EditorConfig>) {
    this._config = { ...this._config, ...changes };
    fireEvent(this, "config-changed", { config: this._config });
  }

  protected override render() {
    if (!this._config) return nothing;
    // §14.5: load the language chunk, then render again.
    if (!languageReady(this.hass)) ensureLanguage(this.hass).then((ok) => { if (ok) this.requestUpdate(); }, () => undefined);
    const t = makeT(this.hass);
    const mode = this._config.mode ?? "auto";
    return html`
      <div class="field">
        <label for="mode">${t("mode_initial")}</label>
        <select id="mode" @change=${(e: Event) =>
          this._update({ mode: (e.target as HTMLSelectElement).value as EditorConfig["mode"] })}>
          <option value="auto" ?selected=${mode === "auto"}>${t("mode_auto")}</option>
          <option value="all" ?selected=${mode === "all"}>${t("mode_all")}</option>
          <option value="favorites" ?selected=${mode === "favorites"}>${t("mode_favorites")}</option>
          <option value="nearby" ?selected=${mode === "nearby"}>${t("mode_nearby")}</option>
        </select>
      </div>
      <div class="field">
        <label for="max">${t("max_items")}</label>
        <input id="max" type="number" min="1" max="50" .value=${String(this._config.max_items ?? 6)}
          @change=${(e: Event) => {
            const n = parseInt((e.target as HTMLInputElement).value, 10);
            this._update({ max_items: Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 6 });
          }} />
      </div>
      <label class="check"><input type="checkbox" .checked=${this._config.show_selector !== false}
        @change=${(e: Event) => this._update({ show_selector: (e.target as HTMLInputElement).checked })} />
        ${t("editor_show_selector")}</label>
      <div class="hint muted">${t("editor_show_selector_help")}</div>
    `;
  }
}

defineElement("loyalty-hub-card-editor", LoyaltyHubCardEditor);

declare global {
  interface HTMLElementTagNameMap { "loyalty-hub-card-editor": LoyaltyHubCardEditor }
}
