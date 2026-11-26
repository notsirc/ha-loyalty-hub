import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { todoItems, type TodoItem } from "../api";
import type { Translate } from "../i18n";
import type { HomeAssistant } from "../types";
import { defineElement, navigate } from "../util";

const MAX_ITEMS = 10;

/**
 * §15.5 shopping_list: "List: <name>" box with the items still to do, read by the browser with the
 * HA core command `todo/item/list` (read only, nothing copied into Loyalty Hub). Reloaded when the
 * entity state (= number of items to do) changes.
 */
export class LhTodoBox extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() entity = "";
  @state() private _items: TodoItem[] | null = null;
  @state() private _error = false;
  private _key = "";

  static override styles = css`
    :host { display: block; }
    .box {
      border: 1px solid var(--divider-color); border-radius: var(--ha-card-border-radius, 12px);
      padding: 10px 14px; margin-bottom: 16px; background: var(--card-background-color);
    }
    .head { display: flex; align-items: center; gap: 8px; font-weight: 500; --mdc-icon-size: 20px; }
    .head span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ul { margin: 6px 0 4px; padding-left: 22px; }
    li { padding: 2px 0; overflow-wrap: anywhere; }
    .muted { color: var(--secondary-text-color); font-size: 0.9em; }
    a { color: var(--primary-color); display: inline-flex; min-height: 36px; align-items: center; font-size: 0.9em; }
  `;

  protected override willUpdate(): void {
    if (!this.hass || !this.entity) return;
    const st = this.hass.states?.[this.entity]?.state ?? "";
    const key = `${this.entity}|${st}`;
    if (key === this._key) return;
    this._key = key;
    const entity = this.entity;
    todoItems(this.hass, entity).then((items) => {
      if (this.entity !== entity) return;
      this._items = items.filter((i) => i.status === "needs_action");
      this._error = false;
    }).catch(() => {
      if (this.entity !== entity) return;
      this._items = [];
      this._error = true;
    });
  }

  private _open(e: Event) {
    e.preventDefault();
    navigate(`/todo?entity_id=${encodeURIComponent(this.entity)}`);
  }

  protected override render() {
    const t = this.t;
    if (!t || !this.entity) return nothing;
    const name = String(this.hass?.states?.[this.entity]?.attributes?.friendly_name ?? this.entity);
    const items = this._items;
    const more = items ? items.length - MAX_ITEMS : 0;
    return html`<div class="box">
      <div class="head"><ha-icon icon="mdi:format-list-checks"></ha-icon><span>${t("tiles_todo_title", { name })}</span></div>
      ${items === null ? html`<div class="muted">${t("loading")}</div>`
        : this._error ? html`<div class="muted">${t("tiles_todo_error")}</div>`
        : !items.length ? html`<div class="muted">${t("tiles_todo_empty")}</div>`
        : html`<ul>${items.slice(0, MAX_ITEMS).map((i) => html`<li>${i.summary}</li>`)}</ul>
          ${more > 0 ? html`<div class="muted">${t("tiles_todo_more", { count: more })}</div>` : nothing}`}
      <a href="/todo?entity_id=${encodeURIComponent(this.entity)}" @click=${this._open}>${t("tiles_todo_open")}</a>
    </div>`;
  }
}

defineElement("lh-todo-box", LhTodoBox);

declare global {
  interface HTMLElementTagNameMap { "lh-todo-box": LhTodoBox }
}
