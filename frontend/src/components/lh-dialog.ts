import { LitElement, css, html, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { sharedStyles } from "../styles";
import { defineElement } from "../util";

/**
 * Lightweight modal dialog built on the native <dialog> element (top layer, no z-index issues).
 * Fires `closed` when dismissed (Escape, backdrop, close button).
 */
export class LhDialog extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property() heading = "";
  @property({ attribute: "close-label" }) closeLabel = "Close";
  @property({ type: Boolean }) wide = false;
  @query("dialog") private _dialog!: HTMLDialogElement;

  static override styles = [sharedStyles, css`
    dialog {
      border: none; padding: 0; border-radius: var(--ha-card-border-radius, 12px);
      background: var(--card-background-color, var(--primary-background-color));
      color: var(--primary-text-color); width: min(92vw, 440px); max-height: 92vh;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    }
    dialog.wide { width: var(--lh-dialog-wide-width, min(96vw, 640px)); }
    dialog::backdrop { background: rgba(0, 0, 0, 0.55); }
    .head {
      display: flex; align-items: center; gap: 8px; padding: 8px 8px 0 20px; min-height: 52px;
    }
    .head h2 { flex: 1; margin: 0; font-size: 1.15em; font-weight: 500; overflow-wrap: anywhere; }
    .body { padding: 8px 20px 16px; overflow: auto; max-height: calc(92vh - 130px); }
    .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 0 20px 16px; }
    .actions:empty { display: none; }
  `];

  protected override updated(changed: Map<string, unknown>): void {
    if (!changed.has("open") || !this._dialog) return;
    if (this.open && !this._dialog.open) this._dialog.showModal();
    else if (!this.open && this._dialog.open) this._dialog.close();
  }

  private _dismiss = () => {
    this.open = false;
    // Not bubbling: only the direct owner of the dialog should react.
    this.dispatchEvent(new CustomEvent("closed"));
  };

  private _onCancel = (e: Event) => {
    e.preventDefault();
    this._dismiss();
  };

  private _onClick = (e: MouseEvent) => {
    if (e.target === this._dialog) {
      const r = this._dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) this._dismiss();
    }
  };

  protected override render() {
    return html`
      <dialog class=${this.wide ? "wide" : ""} @cancel=${this._onCancel} @click=${this._onClick}
        aria-label=${this.heading}>
        <div class="head">
          ${this.heading ? html`<h2>${this.heading}</h2>` : html`<span style="flex:1"></span>`}
          <button class="icon-btn" @click=${this._dismiss} aria-label=${this.closeLabel} title=${this.closeLabel}>
            <ha-icon icon="mdi:close"></ha-icon>
          </button>
        </div>
        <div class="body">${this.open ? html`<slot></slot>` : nothing}</div>
        <div class="actions"><slot name="actions"></slot></div>
      </dialog>
    `;
  }
}

defineElement("lh-dialog", LhDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-dialog": LhDialog }
}
