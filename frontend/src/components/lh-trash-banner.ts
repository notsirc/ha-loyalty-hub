import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { TrashItem } from "../types";
import { defineElement, fireEvent } from "../util";

const MAX_LINES = 3;

/**
 * §12.8: pending admin restore requests for the current user, on top of the list.
 * `items` = own trash entries with a pending request. Fires `open-trash` {id}.
 */
export class LhTrashBanner extends LitElement {
  @property({ attribute: false }) items: TrashItem[] = [];
  @property({ attribute: false }) t!: Translate;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .banner {
      display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; padding: 6px;
      border-radius: var(--ha-card-border-radius, 12px);
      border: 1px solid var(--warning-color, #ffa600);
      background: var(--card-background-color);
    }
    button.line {
      display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 6px 10px;
      border: none; border-radius: 8px; background: transparent; color: var(--primary-text-color);
      font: inherit; text-align: left; cursor: pointer;
    }
    button.line:hover { background: var(--secondary-background-color, rgba(0, 0, 0, 0.05)); }
    button.line:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
    button.line > ha-icon { color: var(--warning-color, #ffa600); flex: none; }
    button.line > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    button.line > ha-icon.chev { color: var(--secondary-text-color); --mdc-icon-size: 20px; }
    .more { padding: 0 10px 4px 44px; }
  `];

  protected override render() {
    const t = this.t;
    const items = this.items ?? [];
    if (!t || !items.length) return nothing;
    const shown = items.slice(0, MAX_LINES);
    return html`<div class="banner" role="region" aria-label=${t("trash_title")}>
      ${shown.map((i) => html`<button class="line" @click=${() => fireEvent(this, "open-trash", { id: i.card_id })}>
        <ha-icon icon="mdi:delete-restore"></ha-icon>
        <span>${t("trash_banner", { admin: i.request?.admin_name ?? "", card: i.name })}</span>
        <ha-icon class="chev" icon="mdi:chevron-right"></ha-icon>
      </button>`)}
      ${items.length > MAX_LINES ? html`<span class="hint more">+${items.length - MAX_LINES}</span>` : nothing}
    </div>`;
  }
}

defineElement("lh-trash-banner", LhTrashBanner);

declare global {
  interface HTMLElementTagNameMap { "lh-trash-banner": LhTrashBanner }
}
