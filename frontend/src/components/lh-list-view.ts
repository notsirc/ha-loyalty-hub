import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { setPrefs } from "../api";
import { computeGroups, firstMatching, pickTab, type CardGroup } from "../groups";
import { baseOrder, sections, sortManual } from "../ordering";
import type { Translate } from "../i18n";
import { isNearby, type Position } from "../nearby";
import { sharedStyles } from "../styles";
import { featureOn, type Card, type FeatureId, type HomeAssistant, type LoyaltySettings, type UserPrefs } from "../types";
import { defineElement, fireEvent, formatDate, isArchived, priceCompareLinks, todayIso } from "../util";
import "./lh-card-tile";
import { featureErrorText } from "./lh-features-section";
import "./lh-find-by-code";
import "./lh-reorder";
import type { ReorderItem } from "./lh-reorder";

/** §15.5 manual_order limit (server). */
const MAX_MANUAL_ORDER = 2000;

/** A tile of the list: a group (or single card), the card drawn on the tile and the card it opens on. */
interface Entry { group: CardGroup; tile: Card; open: Card | null }

/** Banner item: card expiry or points expiry (§15.5 points_expiry). */
interface ExpiryItem { card: Card; date: string; points: boolean }

type Filter = "all" | "favorites" | "vouchers" | "shared";
const LAYOUT_KEY = "loyalty_hub_layout";

function loadLayout(): "grid" | "list" {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// §11.10 isArchived moved to util.ts (also used by groups.ts, §15.3); re-exported for old imports.
export { isArchived };

// §16.3: sortManual moved to ordering.ts (shared with the Lovelace card); re-exported for old imports.
export { sortManual };

/** §15.5 low_balance: voucher with 0 < balance <= threshold (archived excluded). */
export function isLowBalance(c: Card, threshold: number | null | undefined): boolean {
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0) return false;
  return c.kind === "voucher" && typeof c.balance === "number" && c.balance > 0 && c.balance <= threshold && !isArchived(c);
}

/**
 * Card list: search, filter chips, grid/list toggle, expiry banner, "Near you", favorites, archive.
 * §15.3: one tile per group (first tab + "×N"); search/filters show a group when one card matches and
 * open it on that card. §15.5: manual order ("Reorder"), low balance pill, points expiry, find by code.
 * `onlyIds` (§15.4 inbox): only those cards, with a "Show all" chip (`clear-only`).
 * Fires `open-card` {id}, `prefs-changed` {prefs}, `add-with-code` {code, format}, `clear-only`, `show-toast`.
 */
export class LhListView extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  @property({ attribute: false }) cards: Card[] = [];
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) settings?: LoyaltySettings;
  @property() language = "en";
  /** §11.5: browser position (never sent to the server), null = unknown. */
  @property({ attribute: false }) position: Position | null = null;
  /** §15.3 / §15.5: user prefs (groups, manual order, low balance threshold, features off). */
  @property({ attribute: false }) prefs: UserPrefs | null = null;
  /** §15.4: show only these cards (inbox banner), null = all. */
  @property({ attribute: false }) onlyIds: string[] | null = null;
  @state() private _reorderOpen = false;
  @state() private _reorderBusy = false;
  @state() private _findOpen = false;
  @state() private _search = "";
  @state() private _filter: Filter = "all";
  @state() private _layout: "grid" | "list" = loadLayout();
  @state() private _archiveOpen = false;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .top { display: flex; flex-direction: column; margin-bottom: 4px; }
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
    .search { position: relative; flex: 1; min-width: 0; }
    .search ha-icon {
      position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
      color: var(--secondary-text-color); --mdc-icon-size: 20px; pointer-events: none;
    }
    .search input { padding-left: 38px; border-radius: 22px; }
    .chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; margin-bottom: 8px; scrollbar-width: none; }
    /* Wider screens: search ~400 px + layout toggle, filters on the same row. */
    @media (min-width: 600px) {
      .top { flex-direction: row; align-items: center; gap: 12px; margin-bottom: 10px; }
      .toolbar { flex: 0 1 452px; max-width: 452px; margin-bottom: 0; }
      .chips { flex: 1 1 auto; min-width: 0; padding-bottom: 0; margin-bottom: 0; }
    }
    .chip {
      flex: none; min-height: 34px; padding: 0 14px; border-radius: 17px; cursor: pointer; font: inherit;
      border: 1px solid var(--divider-color); background: var(--card-background-color);
      color: var(--primary-text-color); font-size: 0.9em;
    }
    .chip[aria-pressed="true"] {
      background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent;
    }
    /* Stocard-like: 2 columns on phones, auto-fill (min 160px) on wider screens. */
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    @media (min-width: 600px) {
      .grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; }
    }
    .list { display: flex; flex-direction: column; gap: 10px; }
    .tw { position: relative; min-width: 0; }
    .admin-mark {
      position: absolute; top: -6px; left: -6px; width: 22px; height: 22px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; pointer-events: none;
      background: var(--warning-color, #ffa600); color: #fff; --mdc-icon-size: 14px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    }
    h2.sect {
      display: flex; align-items: center; gap: 6px;
      font-size: 0.95em; font-weight: 500; color: var(--secondary-text-color); margin: 18px 2px 10px;
      text-transform: none; letter-spacing: 0.01em;
    }
    h2.sect:first-of-type { margin-top: 6px; }
    h2.sect ha-icon { --mdc-icon-size: 18px; color: var(--primary-color); }
    .empty { padding: 32px 16px; text-align: center; color: var(--secondary-text-color); }
    .compare { margin: 12px 0; }
    .banner {
      display: flex; gap: 10px; align-items: flex-start; margin: 4px 0 12px; padding: 10px 12px;
      border-radius: 10px; border: 1px solid var(--warning-color, #ffa600);
      background: var(--card-background-color);
    }
    .banner > ha-icon { color: var(--warning-color, #ffa600); flex: none; margin-top: 2px; }
    .banner-body { flex: 1; min-width: 0; }
    .banner-title { font-weight: 500; margin-bottom: 6px; }
    .banner-items { display: flex; flex-wrap: wrap; gap: 6px; }
    .exp-chip {
      border: 1px solid var(--divider-color); background: transparent; color: var(--primary-text-color);
      border-radius: 14px; padding: 4px 10px; cursor: pointer; font-size: 0.85em; max-width: 100%;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .archive { margin-top: 24px; }
    .archive summary {
      display: flex; align-items: center; gap: 6px; cursor: pointer; min-height: 40px;
      color: var(--secondary-text-color); font-weight: 500; font-size: 0.95em;
    }
    .archive summary ha-icon { --mdc-icon-size: 18px; }
    .archive .hint { margin: 0 2px 10px; }
    .archive .grid, .archive .list { opacity: 0.75; }
    .only {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 10px;
      color: var(--secondary-text-color); font-size: 0.9em;
    }
    /* Room for the floating "+" button so it never covers the last row. */
    .fab-space { height: calc(48px + env(safe-area-inset-bottom)); }
  `];

  private _setLayout(l: "grid" | "list") {
    this._layout = l;
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  }

  private _on(id: FeatureId): boolean {
    return featureOn(id, this.settings, this.prefs);
  }

  /** §15.5: manual order chosen by the user (and the feature is on). */
  private get _manual(): boolean {
    return this._on("manual_order") && this.prefs?.list_order === "manual";
  }

  /**
   * Cards expiring within `expiry_warning_days` (today included), archived/exhausted excluded;
   * §15.5: also points expiring (`points_expiry`) when that feature is on.
   */
  private _expiring(): ExpiryItem[] {
    const days = this.settings?.expiry_warning_days ?? 7;
    if (!(days > 0)) return [];
    const today = todayIso();
    const limit = isoInDays(days);
    const within = (d: string | null | undefined): d is string => !!d && d >= today && d <= limit;
    const out: ExpiryItem[] = [];
    const points = this._on("points_expiry");
    for (const c of this._scope) {
      if (isArchived(c)) continue;
      if (within(c.expiry)) out.push({ card: c, date: c.expiry, points: false });
      if (points && within(c.points_expiry)) out.push({ card: c, date: c.points_expiry, points: true });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.card.name.localeCompare(b.card.name));
  }

  /** Cards in scope: all, or only the inbox ones. */
  private get _scope(): Card[] {
    const only = this.onlyIds;
    if (!only) return this.cards;
    const set = new Set(only);
    return this.cards.filter((c) => set.has(c.id));
  }

  private get _filtering(): boolean {
    return this._filter !== "all" || !!this._search.trim();
  }

  /** Card the tile opens on: the matching one while filtering, otherwise the automatic tab (§15.3). */
  private _openId(e: Entry): string {
    if (e.open) return e.open.id;
    return pickTab(e.group, { userId: this.hass?.user?.id, position: this.position, hass: this.hass }).id;
  }

  private _matches(c: Card): boolean {
    if (this._filter === "favorites" && !c.favorite) return false;
    if (this._filter === "vouchers" && c.kind !== "voucher") return false;
    if (this._filter === "shared" && c.visibility !== "shared") return false;
    const q = this._search.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) || (c.notes ?? "").toLowerCase().includes(q)
      || c.code.toLowerCase().includes(q);
  }

  private _renderTile(e: Entry) {
    const t = this.t;
    const c = e.tile;
    const threshold = this._on("low_balance") ? this.prefs?.low_balance_threshold : null;
    return html`<div class="tw">
      <lh-card-tile .card=${c} .hass=${this.hass} .t=${t} language=${this.language}
        layout=${this._layout} .groupCount=${e.group.cards.length} displayName=${e.group.name ?? ""} .lowBalance=${isLowBalance(c, threshold)}
        @click=${() => fireEvent(this, "open-card", { id: this._openId(e) })}></lh-card-tile>
      ${c.admin_view ? html`<span class="admin-mark" role="img" title=${t("admin_view_badge")}
        aria-label=${t("admin_view_badge")}><ha-icon icon="mdi:shield-account"></ha-icon></span>` : nothing}
    </div>`;
  }

  private _renderGrid(entries: Entry[]) {
    return html`<div class=${this._layout}>${entries.map((e) => this._renderTile(e))}</div>`;
  }

  /** Near you / Favorites / All (Stocard style) when not searching/filtering, flat list otherwise. */
  private _renderSections(active: Entry[]) {
    const t = this.t;
    if (this._filtering) return this._renderGrid(active);
    const pos = this.position;
    const { near, favs, rest } = sections(active, (c) => !!pos && isNearby(c, pos, this.hass));
    return html`
      ${near.length ? html`<h2 class="sect"><ha-icon icon="mdi:map-marker-radius"></ha-icon>${t("section_nearby")}</h2>
        ${this._renderGrid(near)}` : nothing}
      ${favs.length ? html`<h2 class="sect">${t("section_favorites")}</h2>${this._renderGrid(favs)}` : nothing}
      ${rest.length ? html`${near.length || favs.length ? html`<h2 class="sect">${t("section_all")}</h2>` : nothing}
        ${this._renderGrid(rest)}` : nothing}
    `;
  }

  private _renderArchive(archived: Entry[]) {
    if (!archived.length) return nothing;
    const t = this.t;
    return html`<details class="archive" ?open=${this._archiveOpen}
      @toggle=${(e: Event) => { this._archiveOpen = (e.target as HTMLDetailsElement).open; }}>
      <summary><ha-icon icon="mdi:archive-outline"></ha-icon>${t("section_archive", { n: archived.length })}</summary>
      ${this._archiveOpen ? html`<p class="hint">${t("archive_hint")}</p>${this._renderGrid(archived)}` : nothing}
    </details>`;
  }

  private _renderExpiring() {
    if (this._search.trim()) return nothing;
    const list = this._expiring();
    if (!list.length) return nothing;
    const t = this.t;
    const today = todayIso();
    return html`<div class="banner" role="status">
      <ha-icon icon="mdi:calendar-alert"></ha-icon>
      <div class="banner-body">
        <div class="banner-title">${t("expiring_banner", { count: list.length })}</div>
        <div class="banner-items">
          ${list.map((it) => html`<button class="exp-chip" @click=${() => fireEvent(this, "open-card", { id: it.card.id })}>
            ${it.points ? t("points_expiring_chip", { name: it.card.name }) : it.card.name} ·
            ${it.date === today ? t("expiring_today") : formatDate(it.date, this.language)}</button>`)}
        </div>
      </div>
    </div>`;
  }

  /** Ordered cards (habits or manual), grouped (§15.3), then filtered by search/chips. */
  private _entries(): { active: Entry[]; archived: Entry[] } {
    const scope = this._scope;
    const ordered = baseOrder(scope, this.prefs, this._manual);
    // Groups are computed on every card in scope, so a group stays the same while filtering.
    const groups = computeGroups(ordered, this.prefs, this.hass?.user?.id);
    const filtering = this._filtering;
    const entries: Entry[] = [];
    for (const g of groups) {
      if (!filtering) {
        entries.push({ group: g, tile: g.cards[0], open: null });
        continue;
      }
      const hit = firstMatching(g, (c) => this._matches(c));
      if (hit) entries.push({ group: g, tile: g.cards[0], open: hit }); // §16.2: always the first tab
    }
    // Groups never contain archived cards (computeGroups keeps them single).
    const archived = entries.filter((e) => e.group.cards.length === 1 && isArchived(e.tile));
    const active = entries.filter((e) => !archived.includes(e));
    return { active, archived };
  }

  // ---- §15.5 manual order ----
  /** Every group in the manual order, split into active (reorderable) and archived. */
  private _manualGroups(): { active: CardGroup[]; archived: CardGroup[] } {
    const ordered = sortManual(this.cards, this.prefs?.manual_order);
    const groups = computeGroups(ordered, this.prefs, this.hass?.user?.id);
    const isArch = (g: CardGroup) => g.cards.length === 1 && isArchived(g.cards[0]);
    return { active: groups.filter((g) => !isArch(g)), archived: groups.filter(isArch) };
  }

  private _reorderItems(): ReorderItem[] {
    return this._manualGroups().active.map((g) => ({
      key: g.key, label: g.cards[0].name, color: g.cards[0].color, count: g.cards.length,
    }));
  }

  /** A group takes the position of its first card: its cards are written one after the other. */
  private async _saveOrder(keys: string[]) {
    if (!this.hass) return;
    const { active, archived } = this._manualGroups();
    const byKey = new Map(active.map((g) => [g.key, g]));
    const ids: string[] = [];
    const used = new Set<string>();
    const add = (g: CardGroup | undefined) => {
      if (!g || used.has(g.key)) return;
      used.add(g.key);
      g.cards.forEach((c) => ids.push(c.id));
    };
    keys.forEach((k) => add(byKey.get(k)));
    // Groups that appeared meanwhile, then archived cards, keep their order at the end.
    active.forEach(add);
    archived.forEach(add);
    this._reorderBusy = true;
    try {
      const changes: Partial<UserPrefs> = { manual_order: ids.slice(0, MAX_MANUAL_ORDER) };
      const prefs = await setPrefs(this.hass, changes);
      fireEvent(this, "prefs-changed", { prefs });
      fireEvent(this, "show-toast", { message: this.t("saved") });
      this._reorderOpen = false;
    } catch (err) {
      fireEvent(this, "show-toast", { message: featureErrorText(this.t, err) });
    } finally {
      this._reorderBusy = false;
    }
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const { active, archived } = this._entries();
    const filters: [Filter, string][] = [
      ["all", t("filter_all")], ["favorites", t("filter_favorites")],
      ["vouchers", t("filter_vouchers")], ["shared", t("filter_shared")],
    ];
    const links = priceCompareLinks(this.settings?.price_compare, this._search);
    const find = this._on("find_by_code") && !!this.hass;
    const reorder = this._manual && !!this.hass && !this.onlyIds;
    const scope = this._scope;
    return html`
      <div class="top">
        <div class="toolbar">
          <div class="search">
            <ha-icon icon="mdi:magnify"></ha-icon>
            <input type="search" .value=${this._search} placeholder=${t("search")} aria-label=${t("search")}
              @input=${(e: Event) => { this._search = (e.target as HTMLInputElement).value; }} />
          </div>
          ${find ? html`<button class="icon-btn" title=${t("find_code")} aria-label=${t("find_code")}
            @click=${() => { this._findOpen = true; }}><ha-icon icon="mdi:barcode-scan"></ha-icon></button>` : nothing}
          ${reorder ? html`<button class="icon-btn" title=${t("reorder")} aria-label=${t("reorder")}
            @click=${() => { this._reorderOpen = true; }}><ha-icon icon="mdi:sort"></ha-icon></button>` : nothing}
          <button class="icon-btn" @click=${() => this._setLayout(this._layout === "grid" ? "list" : "grid")}
            title=${this._layout === "grid" ? t("view_list") : t("view_grid")}
            aria-label=${this._layout === "grid" ? t("view_list") : t("view_grid")}>
            <ha-icon icon=${this._layout === "grid" ? "mdi:view-list" : "mdi:view-grid"}></ha-icon>
          </button>
        </div>
        <div class="chips" role="group">
          ${filters.map(([f, label]) => html`
            <button class="chip" aria-pressed=${this._filter === f ? "true" : "false"}
              @click=${() => { this._filter = f; }}>${label}</button>`)}
        </div>
      </div>
      ${this.onlyIds ? html`<div class="only" role="status">
        <span>${t("inbox_only_shown", { count: scope.length })}</span>
        <button class="chip" @click=${() => fireEvent(this, "clear-only")}>${t("inbox_show_all")}</button>
      </div>` : nothing}
      ${this._renderExpiring()}
      ${links.length ? html`
        <div class="compare links">
          <span class="muted">${t("price_compare")}:</span>
          ${links.map((l) => html`<a href=${l.href} target="_blank" rel="noopener noreferrer">${l.name}</a>`)}
        </div>` : nothing}
      ${active.length ? this._renderSections(active) : nothing}
      ${active.length || archived.length ? nothing
        : html`<div class="empty">${scope.length ? t("no_results") : t("empty_list")}</div>`}
      ${this._renderArchive(archived)}
      <div class="fab-space" aria-hidden="true"></div>
      ${find ? html`<lh-find-by-code .open=${this._findOpen} .t=${t} .cards=${this.cards}
        @closed=${() => { this._findOpen = false; }}></lh-find-by-code>` : nothing}
      ${reorder ? html`<lh-reorder .open=${this._reorderOpen} .t=${t} .busy=${this._reorderBusy}
        .items=${this._reorderOpen ? this._reorderItems() : []}
        @reorder-done=${(e: CustomEvent<{ keys: string[] }>) => this._saveOrder(e.detail.keys)}
        @closed=${() => { this._reorderOpen = false; }}></lh-reorder>` : nothing}
    `;
  }
}

defineElement("lh-list-view", LhListView);

declare global {
  interface HTMLElementTagNameMap { "lh-list-view": LhListView }
}
