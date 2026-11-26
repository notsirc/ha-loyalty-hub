import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { Translate } from "../i18n";
import { normalizeFormat } from "../scanner";
import { sharedStyles } from "../styles";
import type { BarcodeFormat, Card } from "../types";
import { defineElement, fireEvent } from "../util";
import "./lh-dialog";
import "./lh-scanner-dialog";

/** Only digits, without leading zeros ("" when there are no digits). */
const digitsKey = (code: string) => code.replace(/\D+/g, "").replace(/^0+/, "");

/**
 * §15.5 find_by_code: exact equality first, then "only digits without leading zeros".
 * Among several matches the first in `cards` order wins.
 */
export function findByCode(cards: Card[], code: string): Card | null {
  const q = code.trim();
  if (!q) return null;
  const exact = cards.find((c) => (c.code ?? "").trim() === q);
  if (exact) return exact;
  const k = digitsKey(q);
  if (!k) return null;
  return cards.find((c) => digitsKey(c.code ?? "") === k) ?? null;
}

/**
 * Scanner → visible card with that code. Found → `open-card` {id}; none → a dialog with
 * "Add as a new card", which fires `add-with-code` {code, format}. Fires `closed` (not bubbling).
 */
export class LhFindByCode extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) cards: Card[] = [];
  @state() private _notFound: { code: string; format: BarcodeFormat | null } | null = null;

  static override styles = [sharedStyles, css`
    :host { display: contents; }
    .code { font-family: monospace; font-size: 1.1em; word-break: break-all; margin: 8px 0 0; }
  `];

  private _done() {
    this.open = false;
    this._notFound = null;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private _onScanned = (e: CustomEvent<{ code: string; format: unknown }>) => {
    e.stopPropagation();
    const code = String(e.detail?.code ?? "");
    const format = normalizeFormat(e.detail?.format as string | number | null | undefined);
    const card = findByCode(this.cards, code);
    if (card) {
      this.open = false;
      fireEvent(this, "open-card", { id: card.id });
      this.dispatchEvent(new CustomEvent("closed"));
      return;
    }
    this._notFound = { code, format };
  };

  /** The scanner closed by itself (×, Esc): nothing found yet → close everything. */
  private _onScannerClosed = () => {
    if (!this._notFound) this._done();
  };

  private _add() {
    const nf = this._notFound;
    this._done();
    if (nf) fireEvent(this, "add-with-code", nf);
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const nf = this._notFound;
    return html`
      <lh-scanner-dialog .open=${this.open && !nf} .t=${t} @scanned=${this._onScanned}
        @closed=${this._onScannerClosed}></lh-scanner-dialog>
      <lh-dialog .open=${this.open && !!nf} heading=${t("find_code_none_title")} close-label=${t("close")}
        @closed=${() => this._done()}>
        <p>${t("find_code_none")}</p>
        ${nf ? html`<p class="code">${nf.code}</p>` : nothing}
        <button slot="actions" class="btn" @click=${() => this._done()}>${t("close")}</button>
        <button slot="actions" class="btn primary" @click=${() => this._add()}>
          <ha-icon icon="mdi:plus"></ha-icon>${t("find_code_add")}</button>
      </lh-dialog>`;
  }
}

defineElement("lh-find-by-code", LhFindByCode);

declare global {
  interface HTMLElementTagNameMap { "lh-find-by-code": LhFindByCode }
}
