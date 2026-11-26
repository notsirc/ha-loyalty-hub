import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { addTransaction, adjustBalance } from "../api";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant } from "../types";
import { defineElement, fireEvent, formatMoney, todayIso } from "../util";
import "./lh-dialog";
import { wsErrorText } from "./lh-helpers";

export type AmountMode = "spend" | "topup" | "adjust";

/** Parses "12,50" / "12.5" → 12.5 (2 decimals). `allowZero` for the adjusted balance. */
export function parseAmount(raw: string, allowZero = false): number | null {
  const s = raw.trim().replace(",", ".");
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Voucher movement dialog (§11.4/§11.10): "spend" and "topup" (amount, date = today, note,
 * "Use whole balance" for spend) and "adjust" (new balance + mandatory reason → adjust_balance).
 * Runs the WS command itself. Fires `card-updated` {card}, `show-toast` {message} and `closed`.
 */
/** §11.4: balance the server adjusts from: a null initial balance counts as 0 (spending included). */
function adjustBase(c: Card): number {
  if (c.balance !== null && c.balance !== undefined) return c.balance;
  const total = (c.transactions ?? []).reduce(
    (a, t) => a + (t.type === "topup" || t.type === "adjust" ? t.amount : -t.amount), c.initial_balance ?? 0);
  return Math.round(total * 100) / 100;
}

export class LhAmountDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) card!: Card;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @property() mode: AmountMode = "spend";
  @property({ type: Boolean }) open = false;
  @state() private _amount = "";
  @state() private _date = "";
  @state() private _note = "";
  @state() private _error = "";
  @state() private _busy = false;

  static override styles = [sharedStyles, css`
    .row > .field { flex: 1 1 130px; }
    .use-all { margin: -6px 0 12px; }
    .warn { color: var(--warning-color, #f57c00); font-size: 0.85em; }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      this._amount = this.mode === "adjust" && this.card?.balance !== null && this.card?.balance !== undefined
        ? String(this.card.balance) : "";
      this._date = todayIso();
      this._note = "";
      this._error = "";
    }
  }

  private _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private async _submit(e?: Event) {
    e?.preventDefault();
    const t = this.t;
    const adjust = this.mode === "adjust";
    const amount = parseAmount(this._amount, adjust);
    if (amount === null) {
      this._error = adjust ? t("tiles_err_balance") : t("err_number");
      return;
    }
    const note = this._note.trim();
    if (adjust && !note) {
      this._error = t("tiles_err_reason");
      return;
    }
    if (adjust && amount === adjustBase(this.card)) {
      this._error = t("tiles_err_same_balance");
      return;
    }
    let date: string | undefined;
    if (!adjust && this._date && this._date !== todayIso()) {
      const d = new Date(`${this._date}T12:00:00`);
      if (Number.isNaN(d.getTime()) || this._date > todayIso()) {
        this._error = t("err_date");
        return;
      }
      date = d.toISOString();
    }
    this._error = "";
    this._busy = true;
    try {
      const card = adjust
        ? await adjustBalance(this.hass, this.card.id, amount, note)
        : await addTransaction(this.hass, this.card.id, amount, note || undefined, date, this.mode);
      fireEvent(this, "card-updated", { card });
      fireEvent(this, "show-toast", {
        message: t(adjust ? "tiles_adjust_done" : this.mode === "topup" ? "topup_done" : "tiles_spend_done"),
      });
      this._close();
    } catch (err) {
      this._error = wsErrorText(err, t);
    } finally {
      this._busy = false;
    }
  }

  protected override render() {
    const t = this.t;
    const c = this.card;
    if (!t || !c) return nothing;
    const mode = this.mode;
    const balance = mode === "adjust" ? adjustBase(c) : c.balance ?? 0;
    const money = (n: number) => formatMoney(n, c.currency, this.language);
    const heading = mode === "adjust" ? t("tiles_adjust_title") : mode === "topup" ? t("topup_title") : t("tiles_spend_title");
    const parsed = parseAmount(this._amount, mode === "adjust");
    const over = mode === "spend" && parsed !== null && parsed > balance;
    return html`
      <lh-dialog .open=${this.open} heading=${heading} close-label=${t("close")} @closed=${() => this._close()}>
        <form @submit=${this._submit} novalidate>
          <p class="muted">${t("tiles_current_balance", { balance: money(balance) })}</p>
          <div class="field ${this._error && parsed === null ? "invalid" : ""}">
            <label for="amt">${mode === "adjust" ? t("tiles_new_balance") : t("amount")} (${c.currency})</label>
            <input id="amt" type="text" inputmode="decimal" autocomplete="off" .value=${this._amount}
              @input=${(e: Event) => { this._amount = (e.target as HTMLInputElement).value; }} />
          </div>
          ${mode === "spend" && balance > 0 ? html`<div class="use-all">
            <button type="button" class="btn" @click=${() => { this._amount = String(balance); }}>
              <ha-icon icon="mdi:cash-check"></ha-icon>${t("tiles_use_all")}</button></div>` : nothing}
          ${over ? html`<p class="warn">${t("tiles_over_balance")}</p>` : nothing}
          ${mode === "adjust" && parsed !== null ? html`<p class="hint">${t("tiles_adjust_diff", {
            diff: `${parsed - balance >= 0 ? "+" : "−"}${money(Math.abs(Math.round((parsed - balance) * 100) / 100))}`,
          })}</p>` : nothing}
          ${mode !== "adjust" ? html`<div class="field">
            <label for="dt">${t("date")}</label>
            <input id="dt" type="date" .value=${this._date} max=${todayIso()}
              @input=${(e: Event) => { this._date = (e.target as HTMLInputElement).value; }} />
          </div>` : nothing}
          <div class="field ${this._error && mode === "adjust" && !this._note.trim() ? "invalid" : ""}">
            <label for="nt">${mode === "adjust" ? t("tiles_reason") : t("note")}</label>
            <input id="nt" type="text" maxlength="200" .value=${this._note}
              @input=${(e: Event) => { this._note = (e.target as HTMLInputElement).value; }} />
          </div>
          ${this._error ? html`<div class="error-text">${this._error}</div>` : nothing}
          <button type="submit" hidden></button>
        </form>
        <button slot="actions" class="btn" @click=${() => this._close()}>${t("cancel")}</button>
        <button slot="actions" class="btn primary" ?disabled=${this._busy} @click=${() => this._submit()}>
          <ha-icon icon=${mode === "adjust" ? "mdi:scale-balance" : mode === "topup" ? "mdi:cash-plus" : "mdi:cart-minus"}>
          </ha-icon>${mode === "adjust" ? t("tiles_adjust") : mode === "topup" ? t("topup") : t("tiles_spend")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-amount-dialog", LhAmountDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-amount-dialog": LhAmountDialog }
}
