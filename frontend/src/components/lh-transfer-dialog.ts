import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { listUsers, transferCard } from "../api";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { Card, HaUser, HomeAssistant } from "../types";
import { defineElement } from "../util";
import "./lh-dialog";
import { errorCode, wsErrorText } from "./lh-helpers";

/**
 * §15.4 "Transfer to…" (owner only): pick a user of `loyalty_hub/users` (not the current owner) and
 * "Keep sharing it with me" (checked). Fires `transferred` {card: Card | null} (not bubbling;
 * null = I no longer see the card) and `closed`.
 */
export class LhTransferDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) card: Card | null = null;
  @property({ type: Boolean }) open = false;
  @state() private _users: HaUser[] | null = null;
  @state() private _to = "";
  @state() private _keep = true;
  @state() private _busy = false;
  @state() private _error = "";

  static override styles = [sharedStyles, css`
    .users { display: flex; flex-direction: column; border: 1px solid var(--divider-color); border-radius: 8px; padding: 4px 12px; margin-bottom: 12px; }
    .warn { color: var(--warning-color, #f57c00); font-size: 0.9em; }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      this._to = "";
      this._keep = true;
      this._error = "";
      this._busy = false;
      if (this._users === null && this.hass) {
        listUsers(this.hass).then((u) => { this._users = u; }, () => { this._users = []; });
      }
    }
  }

  private _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private async _confirm() {
    const card = this.card;
    if (!card || !this._to) return;
    this._busy = true;
    this._error = "";
    try {
      const res = await transferCard(this.hass, card.id, this._to, this._keep);
      this.dispatchEvent(new CustomEvent("transferred", { detail: { card: res, toName: this._name(this._to) } }));
      this._close();
    } catch (err) {
      this._error = errorCode(err) === "recipient_refuses"
        ? this.t("tiles_recipient_refuses", { name: this._name(this._to) })
        : wsErrorText(err, this.t);
    } finally {
      this._busy = false;
    }
  }

  private _name(id: string) {
    return this._users?.find((u) => u.id === id)?.name ?? "";
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const owner = this.card?.owner_id;
    const me = this.hass?.user?.id;
    const users = (this._users ?? []).filter((u) => u.id !== owner && u.id !== me);
    return html`
      <lh-dialog .open=${this.open} heading=${t("tiles_transfer_title")} close-label=${t("close")} @closed=${this._close}>
        <p class="hint">${t("tiles_transfer_hint")}</p>
        ${this._users === null ? html`<p class="muted">${t("loading")}</p>`
          : users.length ? html`<div class="users" role="radiogroup" aria-label=${t("tiles_transfer_to")}>
              ${users.map((u) => html`<label class="check"><input type="radio" name="to" .checked=${this._to === u.id}
                @change=${() => { this._to = u.id; this._error = ""; }} />${u.name}</label>`)}
            </div>`
          : html`<p class="muted">${t("no_users")}</p>`}
        <label class="check"><input type="checkbox" .checked=${this._keep}
          @change=${(e: Event) => { this._keep = (e.target as HTMLInputElement).checked; }} />
          ${t("tiles_transfer_keep")}</label>
        ${this._keep ? nothing : html`<p class="warn">${t("tiles_not_visible_warning")}</p>`}
        ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}
        <button slot="actions" class="btn" @click=${this._close}>${t("cancel")}</button>
        <button slot="actions" class="btn primary" ?disabled=${!this._to || this._busy} @click=${this._confirm}>
          <ha-icon icon="mdi:account-arrow-right"></ha-icon>${t("tiles_transfer_confirm")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-transfer-dialog", LhTransferDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-transfer-dialog": LhTransferDialog }
}
