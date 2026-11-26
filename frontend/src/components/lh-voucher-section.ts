import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { deleteTransaction } from "../api";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant, Transaction } from "../types";
import { defineElement, fireEvent, formatDate, formatMoney, isExpired } from "../util";
import "./lh-amount-dialog";
import type { AmountMode } from "./lh-amount-dialog";
import "./lh-dialog";
import { wsErrorText } from "./lh-helpers";

/**
 * Voucher balance, movement buttons (§11.10: spend / top up / adjust open `lh-amount-dialog`) and
 * history with user names and adjustments (§11.4). Fires `card-updated` {card}, `show-toast` {message}.
 */
export class LhVoucherSection extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) card!: Card;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @state() private _busy = false;
  @state() private _toDelete: Transaction | null = null;
  @state() private _dialog: AmountMode | null = null;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .balance { font-size: 2em; font-weight: 600; margin: 4px 0; }
    .sub { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 0.9em; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--divider-color); }
    li:last-child { border-bottom: none; }
    li > ha-icon { --mdc-icon-size: 20px; flex: none; color: var(--secondary-text-color); }
    li .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    li .note { overflow-wrap: anywhere; }
    li .amount { font-weight: 600; white-space: nowrap; }
    li .plus { color: var(--success-color, #2e7d32); }
    li ha-icon.topup { color: var(--success-color, #2e7d32); }
    li ha-icon.adjust { color: var(--info-color, #039be5); }
    .actions-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .actions-row .btn { flex: 1 1 auto; }
    .pill {
      display: inline-flex; align-items: center; gap: 4px; font-size: 0.8em; padding: 2px 8px; border-radius: 10px;
      background: color-mix(in srgb, var(--success-color, #2e7d32) 14%, transparent); color: var(--success-color, #2e7d32);
    }
    .pill ha-icon { --mdc-icon-size: 16px; }
  `];

  private _canDelete(tx: Transaction): boolean {
    if (this.card.can_edit) return true;
    return tx.type !== "adjust" && tx.user_id === this.hass?.user?.id;
  }

  private async _delete() {
    const tx = this._toDelete;
    if (!tx) return;
    this._busy = true;
    try {
      const card = await deleteTransaction(this.hass, this.card.id, tx.id);
      this._toDelete = null;
      fireEvent(this, "card-updated", { card });
    } catch (err) {
      this._toDelete = null;
      fireEvent(this, "show-toast", { message: wsErrorText(err, this.t) });
    } finally {
      this._busy = false;
    }
  }

  /** Signed amount: spend −, topup +, adjust with its own sign. */
  private _signed(tx: Transaction): number {
    if (tx.type === "adjust") return tx.amount;
    return tx.type === "topup" ? Math.abs(tx.amount) : -Math.abs(tx.amount);
  }

  private _money(n: number) {
    return formatMoney(n, this.card.currency, this.language);
  }

  private _renderTx(tx: Transaction) {
    const t = this.t;
    const kind = tx.type ?? "spend";
    const signed = this._signed(tx);
    const icon = kind === "adjust" ? "mdi:scale-balance" : kind === "topup" ? "mdi:cash-plus" : "mdi:cart-outline";
    const label = kind === "adjust" ? t("tiles_tx_adjust") : kind === "topup" ? t("topup") : t("tiles_tx_spend");
    const text = kind === "adjust" ? (tx.note ? `${label}: ${tx.note}` : label) : (tx.note || label);
    return html`<li>
      <ha-icon class=${kind} icon=${icon} title=${label}></ha-icon>
      <span class="what">
        <span class="note">${text}</span>
        <span class="hint">${formatDate(tx.date, this.language, true)}${tx.user_name ? ` · ${tx.user_name}` : ""}</span>
      </span>
      <span class="amount ${signed > 0 ? "plus" : ""}">${signed > 0 ? "+" : "−"}${this._money(Math.abs(signed))}</span>
      ${this._canDelete(tx) ? html`
        <button class="icon-btn" title=${t("delete_transaction")} aria-label=${t("delete_transaction")}
          @click=${() => { this._toDelete = tx; }}><ha-icon icon="mdi:delete-outline"></ha-icon></button>` : nothing}
    </li>`;
  }

  protected override render() {
    const c = this.card;
    const t = this.t;
    if (!c || !t) return nothing;
    const txs = [...(c.transactions ?? [])].sort((a, b) => b.date.localeCompare(a.date));
    const expired = isExpired(c.expiry);
    return html`
      <div class="section">
        <span class="label">${t("balance")}</span>
        <div class="balance">${formatMoney(c.balance, c.currency, this.language)}</div>
        <div class="sub muted">
          ${c.initial_balance !== null && c.initial_balance !== undefined
            ? html`<span>${t("initial_balance")}: ${this._money(c.initial_balance)}</span>` : nothing}
          <span>${t("currency")}: ${c.currency}</span>
          ${c.reloadable ? html`<span class="pill"><ha-icon icon="mdi:cash-refund"></ha-icon>${t("reloadable_badge")}</span>`
            : nothing}
          ${c.expiry ? html`<span class=${expired ? "error-text" : ""}>${t(expired ? "expired" : "expires",
            { date: formatDate(c.expiry, this.language) })}</span>` : nothing}
        </div>
        <div class="actions-row">
          <button class="btn primary" @click=${() => { this._dialog = "spend"; }}>
            <ha-icon icon="mdi:cart-minus"></ha-icon>${t("tiles_spend")}</button>
          ${c.reloadable ? html`<button class="btn" @click=${() => { this._dialog = "topup"; }}>
            <ha-icon icon="mdi:cash-plus"></ha-icon>${t("topup")}</button>` : nothing}
          ${c.can_edit ? html`<button class="btn" @click=${() => { this._dialog = "adjust"; }}>
            <ha-icon icon="mdi:scale-balance"></ha-icon>${t("tiles_adjust")}</button>` : nothing}
        </div>
      </div>

      <div class="section">
        <h2>${t("transactions")}</h2>
        ${txs.length ? html`<ul>${txs.map((tx) => this._renderTx(tx))}</ul>`
          : html`<div class="muted">${t("no_transactions")}</div>`}
      </div>

      <lh-amount-dialog .hass=${this.hass} .card=${c} .t=${t} language=${this.language}
        mode=${this._dialog ?? "spend"} .open=${!!this._dialog}
        @closed=${() => { this._dialog = null; }}></lh-amount-dialog>

      <lh-dialog .open=${!!this._toDelete} heading=${t("delete_transaction")} close-label=${t("close")}
        @closed=${() => { this._toDelete = null; }}>
        <p>${t("delete_transaction_confirm")}</p>
        ${this._toDelete ? html`<p><strong>${this._money(this._signed(this._toDelete))}</strong>
          ${this._toDelete.note}</p>` : nothing}
        <button slot="actions" class="btn" @click=${() => { this._toDelete = null; }}>${t("cancel")}</button>
        <button slot="actions" class="btn danger" ?disabled=${this._busy} @click=${this._delete}>${t("delete")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-voucher-section", LhVoucherSection);

declare global {
  interface HTMLElementTagNameMap { "lh-voucher-section": LhVoucherSection }
}
