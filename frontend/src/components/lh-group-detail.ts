import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { setPrefs } from "../api";
import {
  computeGroups, groupable, linkCards, pickTab, pruneGroupPrefs, rememberTab, setGroupName, setGroupTabs, splitCard, tabLabel, MAX_GROUP_NAME,
  type CardGroup, type GroupPrefs,
} from "../groups";
import type { I18nKey, Translate } from "../i18n";
import type { Position } from "../nearby";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant, LoyaltySettings, TabMode, UserPrefs } from "../types";
import { defineElement, fireEvent } from "../util";
import type { CashierTab } from "./lh-cashier-view";
import "./lh-detail-view";
import type { ExtraAction } from "./lh-detail-view";
import "./lh-dialog";
import { wsErrorText } from "./lh-helpers";
import "./lh-merge-dialog";

/**
 * §15.3 detail of a group (also used for a single card): scrollable tabs on top, below the normal
 * `lh-detail-view` of the chosen card (all its events bubble up unchanged). §16.1: the group actions go
 * at the end of the detail's own menu (`extraActions`): "Merge with…" (`lh-merge-dialog`), "Split this
 * card", "Tab order" (Automatic / Manual, arrows and drag), "Rename group" (§16.2, personal name shown
 * above the tabs); a single card only has "Merge with…"; none for admin_view / archived cards.
 * Events (bubbling, composed): `tab-changed` {cardId} (tabs or cashier arrows; the panel updates
 * `selectedId` with replaceState), `prefs-changed` {prefs} (after saving the group prefs itself).
 */
export class LhGroupDetail extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @property({ attribute: false }) settings?: LoyaltySettings;
  @property({ attribute: false }) prefs: UserPrefs | null = null;
  /** All the visible cards (for "Merge with…" and to prune the saved ids). */
  @property({ attribute: false }) cards: Card[] = [];
  @property({ attribute: false }) group!: CardGroup;
  /** Card of the shown tab (not in the group → pickTab). */
  @property() selectedId = "";
  @property({ type: Boolean }) cashier = false;
  @property({ attribute: false }) position: Position | null = null;
  /** Hides the group menu (no split / merge / tab order). */
  @property({ type: Boolean, attribute: "no-group-menu" }) noGroupMenu = false;
  @state() private _mergeOpen = false;
  @state() private _renameOpen = false;
  @state() private _nameDraft = "";
  @state() private _orderOpen = false;
  @state() private _orderMode: TabMode = "auto";
  @state() private _order: string[] = [];
  @state() private _saving = false;
  @state() private _dragId: string | null = null;
  private _drag: { id: string; startY: number; from: number; rowH: number; base: string[] } | null = null;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .tabs {
      display: flex; gap: 6px; overflow-x: auto; scrollbar-width: thin; margin: 0 -4px 12px; padding: 2px 4px 6px;
      scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
    }
    .tabs button {
      flex: none; scroll-snap-align: center; min-height: 40px; max-width: 60vw; padding: 0 16px;
      border-radius: 20px; border: 1px solid var(--divider-color); background: transparent; cursor: pointer;
      color: var(--primary-text-color); font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tabs button[aria-selected="true"] {
      background: var(--primary-color); border-color: transparent; color: var(--text-primary-color, #fff); font-weight: 500;
    }
    .tabs button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
    .gname { margin: 0 0 8px; font-size: 1.15em; font-weight: 500; overflow-wrap: anywhere; }
    .rename input { width: 100%; box-sizing: border-box; }
    .seg { display: flex; border: 1px solid var(--divider-color); border-radius: 22px; overflow: hidden; margin-bottom: 12px; }
    .seg button {
      flex: 1; min-height: 40px; border: none; background: transparent; color: var(--primary-text-color);
      cursor: pointer; font: inherit; padding: 0 10px;
    }
    .seg button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    ol.order { list-style: none; margin: 0; padding: 0; }
    ol.order li {
      display: flex; align-items: center; gap: 4px; min-height: 52px; border-bottom: 1px solid var(--divider-color);
      background: var(--card-background-color, var(--primary-background-color));
    }
    ol.order li.dragging { opacity: 0.85; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); position: relative; z-index: 1; }
    ol.order li .n { width: 24px; text-align: center; color: var(--secondary-text-color); }
    ol.order li .lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ol.order .handle { cursor: grab; touch-action: none; color: var(--secondary-text-color); }
    ol.order .icon-btn[disabled] { opacity: 0.3; cursor: default; }
  `];

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("selectedId") || changed.has("group")) {
      this.renderRoot.querySelector<HTMLElement>('.tabs [aria-selected="true"]')
        ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  }

  private get _userId() {
    return this.hass?.user?.id;
  }

  private get _selected(): Card | undefined {
    const g = this.group;
    if (!g?.cards.length) return undefined;
    return g.cards.find((c) => c.id === this.selectedId)
      ?? pickTab(g, { userId: this._userId, position: this.position, hass: this.hass });
  }

  private _select(cardId: string) {
    if (cardId === this._selected?.id) return;
    rememberTab(this._userId, this.group.key, cardId);
    fireEvent(this, "tab-changed", { cardId });
  }

  /** Cashier arrows: the event of lh-detail-view goes on to the panel, here only the device memory. */
  private _onDetailTab = (e: CustomEvent<{ cardId: string }>) => {
    rememberTab(this._userId, this.group.key, e.detail.cardId);
  };

  private _onTabsKey(e: KeyboardEvent) {
    const cards = this.group.cards;
    const i = cards.findIndex((c) => c.id === this._selected?.id);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % cards.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + cards.length) % cards.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = cards.length - 1;
    if (next < 0) return;
    e.preventDefault();
    this._select(cards[next].id);
    this.updateComplete.then(() => this.renderRoot.querySelector<HTMLElement>('.tabs [aria-selected="true"]')?.focus());
  }

  // ---- Group prefs ----
  private get _groupPrefs(): GroupPrefs {
    const p = this.prefs;
    return { group_split: p?.group_split ?? [], group_links: p?.group_links ?? [], group_tabs: p?.group_tabs ?? {}, group_names: p?.group_names ?? {} };
  }

  private async _save(next: GroupPrefs, toastKey: I18nKey): Promise<boolean> {
    this._saving = true;
    try {
      const pruned = pruneGroupPrefs(next, new Set(this.cards.map((c) => c.id)));
      const prefs = await setPrefs(this.hass, pruned);
      fireEvent(this, "prefs-changed", { prefs });
      fireEvent(this, "show-toast", { message: this.t(toastKey) });
      return true;
    } catch (err) {
      fireEvent(this, "show-toast", { message: wsErrorText(err, this.t) });
      return false;
    } finally {
      this._saving = false;
    }
  }

  private _onExtra = (e: CustomEvent<{ id: string }>) => {
    e.stopPropagation();
    const id = e.detail.id;
    if (id === "merge") this._mergeOpen = true;
    else if (id === "split") this._split();
    else if (id === "order") this._openOrder();
    else if (id === "rename") {
      this._nameDraft = this.group.name ?? "";
      this._renameOpen = true;
    }
  };

  private async _saveName(name: string) {
    const ok = await this._save(setGroupName(this._groupPrefs, this.group.key, name), "tiles_group_name_saved");
    if (ok) this._renameOpen = false;
  }

  private _split() {
    const c = this._selected;
    if (c) this._save(splitCard(this._groupPrefs, c.id), "tiles_group_split_done");
  }

  private _onMergePicked = (e: CustomEvent<{ targetId: string }>) => {
    const c = this._selected;
    if (c) this._save(linkCards(this._groupPrefs, c.id, e.detail.targetId), "tiles_group_merge_done");
  };

  private _openOrder() {
    this._orderMode = this.group.mode;
    this._order = this.group.cards.map((c) => c.id);
    this._orderOpen = true;
  }

  private async _saveOrder() {
    const ok = await this._save(setGroupTabs(this._groupPrefs, this.group.key, {
      mode: this._orderMode, order: this._orderMode === "manual" ? this._order : [],
    }), "tiles_group_order_saved");
    if (ok) this._orderOpen = false;
  }

  private _move(i: number, dir: number) {
    const j = i + dir;
    if (j < 0 || j >= this._order.length) return;
    const next = [...this._order];
    [next[i], next[j]] = [next[j], next[i]];
    this._order = next;
  }

  // Drag with pointer events (mouse and touch) on the handle.
  private _dragStart(e: PointerEvent, id: string) {
    const li = (e.currentTarget as HTMLElement).closest("li");
    if (!li) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this._drag = { id, startY: e.clientY, from: this._order.indexOf(id), rowH: li.getBoundingClientRect().height || 52, base: [...this._order] };
    this._dragId = id;
  }

  private _dragMove(e: PointerEvent) {
    const d = this._drag;
    if (!d) return;
    const to = Math.max(0, Math.min(d.base.length - 1, d.from + Math.round((e.clientY - d.startY) / d.rowH)));
    const next = d.base.filter((x) => x !== d.id);
    next.splice(to, 0, d.id);
    if (next.join() !== this._order.join()) this._order = next;
  }

  private _dragEnd() {
    this._drag = null;
    this._dragId = null;
  }

  // ---- Render ----
  private _canMenu(sel: Card): boolean {
    return !this.noGroupMenu && this.prefs?.grouping !== false && groupable(sel) && !!this.hass;
  }

  private _extraActions(): ExtraAction[] {
    const t = this.t;
    const merge = { id: "merge", label: t("tiles_group_merge"), icon: "mdi:card-multiple-outline" };
    if (this.group.cards.length < 2) return [merge];
    return [
      merge,
      { id: "split", label: t("tiles_group_split"), icon: "mdi:call-split" },
      { id: "order", label: t("tiles_group_order"), icon: "mdi:sort" },
      { id: "rename", label: t("tiles_group_rename"), icon: "mdi:rename-outline" },
    ];
  }

  private _renderRename() {
    const t = this.t;
    return html`<lh-dialog .open=${this._renameOpen} heading=${t("tiles_group_rename")} close-label=${t("close")}
      @closed=${() => { this._renameOpen = false; }}>
      <div class="field rename">
        <label for="gname">${t("tiles_group_name_label")}</label>
        <input id="gname" maxlength=${MAX_GROUP_NAME} .value=${this._nameDraft}
          placeholder=${this.group.cards[0]?.name ?? ""}
          @input=${(e: Event) => { this._nameDraft = (e.target as HTMLInputElement).value; }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") this._saveName(this._nameDraft); }} />
      </div>
      ${this.group.name ? html`<button slot="actions" class="btn" ?disabled=${this._saving}
        @click=${() => this._saveName("")}>${t("tiles_group_name_clear")}</button>` : nothing}
      <button slot="actions" class="btn" @click=${() => { this._renameOpen = false; }}>${t("cancel")}</button>
      <button slot="actions" class="btn primary" ?disabled=${this._saving}
        @click=${() => this._saveName(this._nameDraft)}>${t("save")}</button>
    </lh-dialog>`;
  }

  private _renderOrder() {
    const t = this.t;
    const byId = new Map(this.group.cards.map((c, i) => [c.id, { c, i }]));
    const n = this._order.length;
    return html`<lh-dialog .open=${this._orderOpen} heading=${t("tiles_group_order")} close-label=${t("close")}
      @closed=${() => { this._orderOpen = false; }}>
      <div class="seg" role="group">
        <button type="button" aria-pressed=${this._orderMode === "auto"} @click=${() => { this._orderMode = "auto"; }}>
          ${t("tiles_group_order_auto")}</button>
        <button type="button" aria-pressed=${this._orderMode === "manual"} @click=${() => { this._orderMode = "manual"; }}>
          ${t("tiles_group_order_manual")}</button>
      </div>
      <p class="hint">${t(this._orderMode === "auto" ? "tiles_group_order_auto_hint" : "tiles_group_order_manual_hint")}</p>
      ${this._orderMode === "manual" ? html`<ol class="order" @pointermove=${this._dragMove}
        @pointerup=${this._dragEnd} @pointercancel=${this._dragEnd}>
        ${this._order.map((id, i) => {
          const x = byId.get(id);
          if (!x) return nothing;
          return html`<li class=${this._dragId === id ? "dragging" : ""}>
            <span class="icon-btn handle" role="presentation" @pointerdown=${(e: PointerEvent) => this._dragStart(e, id)}>
              <ha-icon icon="mdi:drag"></ha-icon></span>
            <span class="n">${i + 1}</span>
            <span class="lbl">${tabLabel(x.c, x.i, this._userId)}${x.c.name !== tabLabel(x.c, x.i, this._userId)
              ? html` <span class="muted">· ${x.c.name}</span>` : nothing}</span>
            <button class="icon-btn" ?disabled=${i === 0} aria-label=${t("tiles_move_up")} title=${t("tiles_move_up")}
              @click=${() => this._move(i, -1)}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
            <button class="icon-btn" ?disabled=${i === n - 1} aria-label=${t("tiles_move_down")} title=${t("tiles_move_down")}
              @click=${() => this._move(i, 1)}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
          </li>`;
        })}
      </ol>` : nothing}
      <button slot="actions" class="btn" @click=${() => { this._orderOpen = false; }}>${t("cancel")}</button>
      <button slot="actions" class="btn primary" ?disabled=${this._saving} @click=${this._saveOrder}>${t("save")}</button>
    </lh-dialog>`;
  }

  protected override render() {
    const t = this.t;
    const g = this.group;
    const sel = this._selected;
    if (!t || !g || !sel) return nothing;
    const multi = g.cards.length > 1;
    const uid = this._userId;
    const tabs: CashierTab[] = multi ? g.cards.map((c, i) => ({ card: c, label: tabLabel(c, i, uid) })) : [];
    const showMenu = this._canMenu(sel);
    return html`
      ${multi && g.name ? html`<h2 class="gname">${g.name}</h2>` : nothing}
      ${multi ? html`<div class="tabs" role="tablist" aria-label=${t("tiles_group_tabs")} @keydown=${this._onTabsKey}>
        ${tabs.map((x) => html`<button role="tab" aria-selected=${x.card.id === sel.id ? "true" : "false"}
          tabindex=${x.card.id === sel.id ? "0" : "-1"} title=${x.card.name}
          @click=${() => this._select(x.card.id)}>${x.label}</button>`)}
      </div>` : nothing}
      <lh-detail-view .hass=${this.hass} .card=${sel} .t=${t} .settings=${this.settings} .prefs=${this.prefs}
        language=${this.language} .cashier=${this.cashier} .tabs=${tabs}
        .extraActions=${showMenu ? this._extraActions() : []}
        @tab-changed=${this._onDetailTab} @lh-extra-action=${this._onExtra}></lh-detail-view>
      ${showMenu ? html`<lh-merge-dialog .hass=${this.hass} .t=${t} language=${this.language}
        .groups=${this._mergeOpen ? computeGroups(this.cards, this.prefs, uid) : []} exclude=${g.key}
        .open=${this._mergeOpen} @merge-picked=${this._onMergePicked}
        @closed=${() => { this._mergeOpen = false; }}></lh-merge-dialog>` : nothing}
      ${showMenu && multi ? this._renderOrder() : nothing}
      ${showMenu && multi ? this._renderRename() : nothing}
    `;
  }
}

defineElement("lh-group-detail", LhGroupDetail);

declare global {
  interface HTMLElementTagNameMap { "lh-group-detail": LhGroupDetail }
}
