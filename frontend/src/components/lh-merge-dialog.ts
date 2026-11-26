import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { groupable, normalizeName, type CardGroup } from "../groups";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { HomeAssistant } from "../types";
import { defineElement } from "../util";
import "./lh-card-tile";
import "./lh-dialog";

/**
 * §15.3 "Merge with…": the visible cards and groups (except the current group, archived and
 * admin_view cards) with a search box. Fires `merge-picked` {targetId} (not bubbling; any card of
 * the chosen group) and `closed`.
 */
export class LhMergeDialog extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  /** All the groups of the user (computeGroups of the visible cards). */
  @property({ attribute: false }) groups: CardGroup[] = [];
  /** Key of the group being merged (left out of the list). */
  @property() exclude = "";
  @property({ type: Boolean }) open = false;
  @state() private _query = "";

  static override styles = [sharedStyles, css`
    ul { list-style: none; margin: 8px 0 0; padding: 0; }
    li button {
      display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 6px 4px;
      border: none; border-bottom: 1px solid var(--divider-color); background: transparent; color: inherit;
      cursor: pointer; text-align: start; font: inherit;
    }
    li button:hover { background: var(--secondary-background-color, rgba(127, 127, 127, 0.12)); }
    li button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
    lh-card-tile { width: 64px; flex: none; pointer-events: none; }
    .name { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .name span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
  `];

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) this._query = "";
  }

  private _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private _pick(g: CardGroup) {
    this.dispatchEvent(new CustomEvent("merge-picked", { detail: { targetId: g.cards[0].id } }));
    this._close();
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const q = normalizeName(this._query);
    const list = this.groups.filter((g) => g.key !== this.exclude && g.cards.every(groupable)
      && (!q || g.cards.some((c) => [c.name, c.short_name, c.owner_name ?? ""].some((s) => normalizeName(s).includes(q)))));
    return html`
      <lh-dialog .open=${this.open} heading=${t("tiles_merge_title")} close-label=${t("close")} @closed=${this._close}>
        <p class="hint">${t("tiles_merge_hint")}</p>
        <input type="search" .value=${this._query} placeholder=${t("search")} aria-label=${t("search")}
          @input=${(e: Event) => { this._query = (e.target as HTMLInputElement).value; }} />
        ${list.length ? html`<ul>${list.map((g) => {
          const c = g.cards[0];
          const owners = [...new Set(g.cards.map((x) => x.owner_name).filter(Boolean))].join(", ");
          return html`<li><button @click=${() => this._pick(g)}>
            <lh-card-tile layout="large" .card=${c} .hass=${this.hass} .t=${t} language=${this.language}
              .groupCount=${g.cards.length} aria-hidden="true"></lh-card-tile>
            <span class="name"><span>${c.name}</span>
              <span class="hint">${g.cards.length > 1 ? t("tiles_group_count", { count: g.cards.length }) : owners}</span></span>
          </button></li>`;
        })}</ul>` : html`<p class="muted">${t("tiles_merge_none")}</p>`}
        <button slot="actions" class="btn" @click=${this._close}>${t("cancel")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-merge-dialog", LhMergeDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-merge-dialog": LhMergeDialog }
}
