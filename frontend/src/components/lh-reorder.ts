import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import { contrastText, defineElement, fireEvent, safeColor } from "../util";
import "./lh-dialog";

/** One row of the reorder list (a card or a group of cards). */
export interface ReorderItem { key: string; label: string; color: string; count: number }

/**
 * §15.5 manual_order: drag (pointer events: mouse and touch) or up/down buttons.
 * "Done" fires `reorder-done` {keys}; closing without "Done" fires `closed` only (nothing saved).
 */
export class LhReorder extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) items: ReorderItem[] = [];
  @property({ type: Boolean }) busy = false;
  @state() private _order: ReorderItem[] = [];
  @state() private _dragKey: string | null = null;
  private _pointerId: number | null = null;

  static override styles = [sharedStyles, css`
    :host { display: contents; }
    lh-dialog { --lh-dialog-wide-width: min(96vw, 520px); }
    .list { display: flex; flex-direction: column; gap: 6px; padding: 0; margin: 4px 0 0; list-style: none; }
    .item {
      display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 0; border-radius: 10px;
      border: 1px solid var(--divider-color); background: var(--card-background-color); min-height: 52px;
      user-select: none; -webkit-user-select: none;
    }
    .item.dragging { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); border-color: var(--primary-color); position: relative; z-index: 1; }
    .handle {
      width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; flex: none;
      cursor: grab; touch-action: none; color: var(--secondary-text-color);
    }
    .item.dragging .handle { cursor: grabbing; }
    .swatch {
      width: 36px; height: 24px; border-radius: 5px; flex: none; display: flex; align-items: center;
      justify-content: center; font-size: 0.72em; font-weight: 600;
    }
    .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .arrows { display: flex; flex: none; }
    .arrows .icon-btn { width: 40px; height: 40px; }
    .arrows .icon-btn[disabled] { opacity: 0.3; cursor: default; }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if ((changed.has("open") && this.open) || (changed.has("items") && !this._dragKey && this.open && !this._order.length)) {
      this._order = [...this.items];
    }
  }

  private _move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= this._order.length || to >= this._order.length) return;
    const next = [...this._order];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    this._order = next;
  }

  private _onDown(e: PointerEvent, key: string) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    this._dragKey = key;
    this._pointerId = e.pointerId;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  private _onMove(e: PointerEvent) {
    if (!this._dragKey || e.pointerId !== this._pointerId) return;
    e.preventDefault();
    const rows = [...this.renderRoot.querySelectorAll<HTMLElement>(".item")];
    const from = this._order.findIndex((i) => i.key === this._dragKey);
    if (from < 0) return;
    // Target: the row under the pointer; above the first / below the last row clamp to the ends.
    const y = e.clientY;
    let to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return y >= b.top && y < b.bottom;
    });
    if (to < 0 && rows.length) {
      if (y < rows[0].getBoundingClientRect().top) to = 0;
      else if (y >= rows[rows.length - 1].getBoundingClientRect().bottom) to = rows.length - 1;
    }
    if (to >= 0 && to !== from) this._move(from, to);
    // Keep the dragged row visible inside the scrolling dialog body.
    rows[to >= 0 ? to : from]?.scrollIntoView?.({ block: "nearest" });
  }

  private _onUp(e: PointerEvent) {
    if (e.pointerId !== this._pointerId) return;
    this._dragKey = null;
    this._pointerId = null;
  }

  private _close() {
    this.open = false;
    this._order = [];
    this._dragKey = null;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private _done() {
    fireEvent(this, "reorder-done", { keys: this._order.map((i) => i.key) });
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const n = this._order.length;
    return html`<lh-dialog wide .open=${this.open} heading=${t("reorder_title")} close-label=${t("close")}
      @closed=${() => this._close()}>
      <p class="hint">${t("reorder_hint")}</p>
      <ul class="list" @pointermove=${this._onMove} @pointerup=${this._onUp} @pointercancel=${this._onUp}>
        ${repeat(this._order, (i) => i.key, (it, idx) => {
          const bg = safeColor(it.color);
          return html`<li class="item ${this._dragKey === it.key ? "dragging" : ""}">
            <span class="handle" role="img" aria-label=${t("reorder_drag")} title=${t("reorder_drag")}
              @pointerdown=${(e: PointerEvent) => this._onDown(e, it.key)}>
              <ha-icon icon="mdi:drag-horizontal-variant"></ha-icon></span>
            <span class="swatch" style=${styleMap({ background: bg, color: contrastText(bg) })}>
              ${it.count > 1 ? `×${it.count}` : ""}</span>
            <span class="label">${it.label}</span>
            <span class="arrows">
              <button class="icon-btn" ?disabled=${idx === 0} title=${t("reorder_up")} aria-label=${t("reorder_up")}
                @click=${() => this._move(idx, idx - 1)}><ha-icon icon="mdi:chevron-up"></ha-icon></button>
              <button class="icon-btn" ?disabled=${idx === n - 1} title=${t("reorder_down")} aria-label=${t("reorder_down")}
                @click=${() => this._move(idx, idx + 1)}><ha-icon icon="mdi:chevron-down"></ha-icon></button>
            </span>
          </li>`;
        })}
      </ul>
      <button slot="actions" class="btn" @click=${() => this._close()}>${t("cancel")}</button>
      <button slot="actions" class="btn primary" ?disabled=${this.busy} @click=${() => this._done()}>${t("reorder_done")}</button>
    </lh-dialog>`;
  }
}

defineElement("lh-reorder", LhReorder);

declare global {
  interface HTMLElementTagNameMap { "lh-reorder": LhReorder }
}
