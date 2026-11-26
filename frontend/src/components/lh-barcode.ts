import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { renderBarcode } from "../barcode";
import type { BarcodeFormat } from "../types";
import { defineElement } from "../util";

/** Renders a barcode on a canvas (black on white, quiet zone). `fill` = as large as the host. */
export class LhBarcode extends LitElement {
  @property() code = "";
  @property() format: BarcodeFormat = "CODE_128";
  @property({ attribute: "error-text" }) errorText = "";
  /** Scales the barcode up to fill the host box (cashier mode, §11.8). */
  @property({ type: Boolean, reflect: true }) fill = false;
  @state() private _error = false;
  @query("canvas") private _canvas!: HTMLCanvasElement;

  static override styles = css`
    :host { display: block; background: #ffffff; }
    canvas {
      display: block; margin: 0 auto; max-width: 100%; height: auto;
      image-rendering: pixelated; image-rendering: crisp-edges;
    }
    :host([fill]) { display: flex; align-items: center; justify-content: center; }
    :host([fill]) canvas { width: 100%; height: 100%; max-height: 100%; object-fit: contain; }
    canvas.hidden { display: none; }
    .err { color: #b00020; padding: 24px 8px; text-align: center; font-size: 0.9em; }
  `;

  /** The rendered canvas, or null if rendering failed. */
  get canvas(): HTMLCanvasElement | null {
    return this._error ? null : this._canvas ?? null;
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("code") || changed.has("format")) this._draw();
  }

  private _draw() {
    if (!this._canvas) return;
    if (!this.code) {
      this._error = false;
      this._canvas.width = 0;
      this._canvas.height = 0;
      return;
    }
    try {
      renderBarcode(this._canvas, this.code, this.format);
      this._error = false;
    } catch {
      this._error = true;
    }
  }

  protected override render() {
    return html`
      <canvas class=${this._error ? "hidden" : ""} role="img" aria-label=${this.code}></canvas>
      ${this._error ? html`<div class="err">${this.errorText || "Invalid code"}</div>` : nothing}
    `;
  }
}

defineElement("lh-barcode", LhBarcode);

declare global {
  interface HTMLElementTagNameMap { "lh-barcode": LhBarcode }
}
