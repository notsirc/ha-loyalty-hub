import { LitElement, css, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { InboxItem } from "../types";
import { defineElement, fireEvent } from "../util";

/** Card names shown in a row before "and N more". */
const MAX_NAMES = 2;

interface InboxRow { key: string; byName: string; kind: InboxItem["kind"]; ids: string[]; names: string[] }

/** One row per sender and kind, in order of the most recent arrival. */
export function inboxRows(items: InboxItem[]): InboxRow[] {
  const rows = new Map<string, InboxRow & { at: string }>();
  for (const it of items) {
    const key = `${it.kind}|${it.by_name}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, byName: it.by_name, kind: it.kind, ids: [], names: [], at: "" };
      rows.set(key, row);
    }
    if (!row.ids.includes(it.card_id)) {
      row.ids.push(it.card_id);
      row.names.push(it.card_name);
    }
    if ((it.at || "") > row.at) row.at = it.at || "";
  }
  return [...rows.values()].sort((a, b) => b.at.localeCompare(a.at));
}

function joinList(parts: string[], language: string): string {
  try {
    return new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(parts);
  } catch {
    return parts.join(", ");
  }
}

/**
 * §15.4: "Alice added 3 cards for you: Conad, Coop and 1 more" (one row per sender).
 * Tapping a row fires `inbox-show` {ids}; "Ok" fires `inbox-dismiss`. Text only (no innerHTML).
 */
export class LhInboxBanner extends LitElement {
  @property({ attribute: false }) items: InboxItem[] = [];
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  /** Ids currently shown alone in the list (row highlighted). */
  @property({ attribute: false }) activeIds: string[] | null = null;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .banner {
      display: flex; gap: 10px; align-items: flex-start; margin: 0 0 12px; padding: 10px 12px;
      border-radius: 10px; border: 1px solid var(--primary-color); background: var(--card-background-color);
    }
    .banner > ha-icon { color: var(--primary-color); flex: none; margin-top: 8px; }
    .rows { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .row {
      text-align: start; border: none; background: transparent; color: var(--primary-text-color);
      padding: 8px 6px; border-radius: 8px; cursor: pointer; min-height: 40px; line-height: 1.35;
    }
    .row:hover { background: var(--secondary-background-color, rgba(0, 0, 0, 0.05)); }
    .row[aria-pressed="true"] { background: var(--secondary-background-color, rgba(0, 0, 0, 0.08)); font-weight: 500; }
    .ok { flex: none; align-self: center; }
  `];

  private _text(row: InboxRow): string {
    const t = this.t;
    const shown = row.names.slice(0, MAX_NAMES);
    const rest = row.names.length - shown.length;
    const parts = rest > 0 ? [...shown, t("inbox_more", { count: rest })] : shown;
    const name = row.byName || t("inbox_someone");
    return t(row.kind === "transferred" ? "inbox_transferred" : "inbox_created", {
      count: row.ids.length, name, cards: joinList(parts, this.language),
    });
  }

  protected override render() {
    const t = this.t;
    if (!t || !this.items?.length) return nothing;
    const active = this.activeIds ? [...this.activeIds].sort().join(",") : "";
    return html`<div class="banner" role="status">
      <ha-icon icon="mdi:inbox-arrow-down"></ha-icon>
      <div class="rows">
        ${inboxRows(this.items).map((row) => html`<button class="row" title=${t("inbox_show")}
          aria-pressed=${active && active === [...row.ids].sort().join(",") ? "true" : "false"}
          @click=${() => fireEvent(this, "inbox-show", { ids: row.ids })}>${this._text(row)}</button>`)}
      </div>
      <button class="btn ok" @click=${() => fireEvent(this, "inbox-dismiss")}>${t("inbox_ok")}</button>
    </div>`;
  }
}

defineElement("lh-inbox-banner", LhInboxBanner);

declare global {
  interface HTMLElementTagNameMap { "lh-inbox-banner": LhInboxBanner }
}
