import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  cancelPurgeTrash, errorMessage, purgeTrash, requestTrashRestore, respondTrashRequest, restoreFromTrash,
} from "../api";
import type { Translate } from "../i18n";
import { logoUrl } from "../logo";
import { sharedStyles } from "../styles";
import { TRASH_BLOCK_CONFIRM_S, TRASH_MAX_REJECTIONS, type Card, type HomeAssistant, type TrashItem, type TrashResponse } from "../types";
import { contrastText, defineElement, fireEvent, formatDate, safeColor } from "../util";
import "./lh-dialog";

/** Remaining time as m:ss (never negative). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Detail of `trash-update`: what changed after an action (the panel merges it and reloads). */
export interface TrashUpdate { items?: TrashItem[]; removeId?: string; card?: Card }

/**
 * §12.8: trash view. Own entries: restore, delete forever (15 min countdown, cancel), empty trash,
 * answer admin requests. Admins also see other users' entries (minimal data) and can ask to restore.
 * `focusId` scrolls to an entry, `block` opens the "don't ask again" confirmation for it.
 * Fires `trash-update` {items?, removeId?, card?}, `show-toast` {message}.
 */
export class LhTrashView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  /** null = still loading. */
  @property({ attribute: false }) items: TrashItem[] | null = null;
  @property({ attribute: false }) focusId: string | null = null;
  @property({ type: Boolean }) block = false;
  @state() private _now = Date.now();
  @state() private _busy: ReadonlySet<string> = new Set();
  /** Entries whose last request reached nobody (owner without notifications). */
  @state() private _notNotified: ReadonlySet<string> = new Set();
  @state() private _blockItem: TrashItem | null = null;
  @state() private _blockLeft = 0;
  @state() private _logos: ReadonlyMap<string, string> = new Map();
  private _tick?: number;
  private _blockTimer?: number;
  private _focusDone = "";
  private _logoKeys = new Set<string>();

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    .top .hint { flex: 1 1 220px; }
    h2 { font-size: 1.05em; font-weight: 500; margin: 20px 0 8px; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    li.item {
      display: flex; gap: 12px; padding: 12px; border-radius: var(--ha-card-border-radius, 12px);
      border: 1px solid var(--divider-color); background: var(--card-background-color);
    }
    li.item.focus { border-color: var(--primary-color); box-shadow: 0 0 0 1px var(--primary-color); }
    li.item:focus { outline: none; }
    .logo {
      flex: none; width: 48px; height: 48px; border-radius: 10px; overflow: hidden;
      display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 1.2em;
    }
    .logo img { width: 100%; height: 100%; object-fit: contain; background: #fff; }
    .logo img.cover { object-fit: cover; }
    .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .name { font-weight: 500; overflow-wrap: anywhere; }
    .meta { font-size: 0.88em; color: var(--secondary-text-color); }
    .countdown { font-size: 0.9em; color: var(--error-color, #db4437); font-variant-numeric: tabular-nums; }
    .status { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .pill {
      font-size: 0.8em; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
    }
    .pill.warn { color: var(--error-color, #db4437); border-color: var(--error-color, #db4437); }
    .request {
      margin-top: 6px; padding: 8px 10px; border-radius: 8px;
      border: 1px solid var(--warning-color, #ffa600);
    }
    .request p { margin: 0 0 6px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .btn.small { min-height: 40px; padding: 0 12px; }
    .state { padding: 32px 16px; text-align: center; color: var(--secondary-text-color); }
    .live { font-variant-numeric: tabular-nums; }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    this._syncTick();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    clearInterval(this._tick);
    this._tick = undefined;
    this._stopBlockTimer();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("items")) {
      this._syncTick();
      this._loadLogos();
      // Keep the open block dialog on fresh data; close it when the request is gone.
      if (this._blockItem) {
        const cur = this.items?.find((i) => i.card_id === this._blockItem!.card_id);
        if (!cur || !this._canBlock(cur)) this._closeBlock();
        else this._blockItem = cur;
      }
    }
    if (changed.has("focusId") || changed.has("block")) this._focusDone = "";
  }

  protected override updated(): void {
    this._handleFocus();
  }

  /** One timer per second, only while an entry has a purge countdown. */
  private _syncTick() {
    const need = this.isConnected && !!this.items?.some((i) => i.purge_at);
    if (need && this._tick === undefined) {
      this._now = Date.now();
      this._tick = window.setInterval(() => { this._now = Date.now(); }, 1000);
    } else if (!need && this._tick !== undefined) {
      clearInterval(this._tick);
      this._tick = undefined;
    }
  }

  private _loadLogos() {
    if (!this.hass) return;
    for (const i of this.items ?? []) {
      if (!i.is_own || !i.logo) continue;
      const key = `${i.card_id}:${i.logo.version}`;
      if (this._logoKeys.has(key)) continue;
      this._logoKeys.add(key);
      logoUrl(this.hass, { id: i.card_id, logo: i.logo })?.then((url) => {
        const next = new Map(this._logos);
        next.set(key, url);
        this._logos = next;
      }, () => undefined);
    }
  }

  private _handleFocus() {
    const id = this.focusId;
    if (!id || this.items === null) return;
    const key = `${id}|${this.block}`;
    if (this._focusDone === key) return;
    this._focusDone = key;
    const item = this.items.find((i) => i.card_id === id);
    if (!item) {
      this._toast(this.t("trash_item_gone"));
    } else {
      const el = [...this.renderRoot.querySelectorAll<HTMLElement>("li.item")].find((e) => e.dataset.id === id);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
      if (this.block && this._canBlock(item)) this._openBlock(item);
    }
  }

  private _toast(message: string) {
    fireEvent(this, "show-toast", { message });
  }

  private _error(err: unknown) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    this._toast(code === "limit_reached" ? this.t("trash_limit_reached") : this.t("error_generic", { msg: errorMessage(err) }));
  }

  private async _run(id: string, fn: () => Promise<void>) {
    if (this._busy.has(id)) return;
    this._busy = new Set([...this._busy, id]);
    try {
      await fn();
    } catch (err) {
      this._error(err);
    } finally {
      const next = new Set(this._busy);
      next.delete(id);
      this._busy = next;
    }
  }

  private _update(detail: TrashUpdate) {
    fireEvent(this, "trash-update", detail);
  }

  private _restore(item: TrashItem) {
    return this._run(item.card_id, async () => {
      const card = await restoreFromTrash(this.hass, item.card_id);
      this._update({ removeId: item.card_id, card });
      this._toast(this.t("trash_restored"));
    });
  }

  private _purge(item?: TrashItem) {
    return this._run(item?.card_id ?? "*", async () => {
      const items = await purgeTrash(this.hass, item?.card_id);
      this._update({ items });
      this._toast(this.t("trash_purge_started"));
    });
  }

  private _cancelPurge(item: TrashItem) {
    return this._run(item.card_id, async () => {
      const items = await cancelPurgeTrash(this.hass, item.card_id);
      this._update({ items });
      this._toast(this.t("trash_purge_cancelled"));
    });
  }

  private _request(item: TrashItem) {
    return this._run(item.card_id, async () => {
      const res = await requestTrashRestore(this.hass, item.card_id);
      const next = new Set(this._notNotified);
      if (res.notified === false) next.add(item.card_id);
      else next.delete(item.card_id);
      this._notNotified = next;
      this._update({ items: res.item ? [res.item] : [] });
      this._toast(this.t("trash_request_done"));
    });
  }

  private _respond(item: TrashItem, response: TrashResponse) {
    return this._run(item.card_id, async () => {
      const res = await respondTrashRequest(this.hass, item.card_id, response);
      if (response === "accept") {
        this._update({ removeId: item.card_id, card: res.card });
        this._toast(this.t("trash_restored"));
      } else {
        this._update({ items: res.item ? [res.item] : [] });
        this._toast(this.t(response === "block" ? "trash_blocked_toast" : "trash_rejected_toast"));
      }
    });
  }

  // ---- "Reject and don't ask again" confirmation (§12.8, 10 s) ----
  private _canBlock(i: TrashItem): boolean {
    return i.is_own && !i.blocked && !!i.request && (i.request.status === "pending" || i.request.status === "rejected");
  }

  private _openBlock(item: TrashItem) {
    this._stopBlockTimer();
    this._blockItem = item;
    this._blockLeft = TRASH_BLOCK_CONFIRM_S;
    this._blockTimer = window.setInterval(() => {
      this._blockLeft = Math.max(0, this._blockLeft - 1);
      if (this._blockLeft <= 0) this._stopBlockTimer();
    }, 1000);
  }

  private _stopBlockTimer() {
    clearInterval(this._blockTimer);
    this._blockTimer = undefined;
  }

  private _closeBlock() {
    this._stopBlockTimer();
    this._blockItem = null;
  }

  private async _confirmBlock() {
    const item = this._blockItem;
    if (!item || this._blockLeft > 0) return;
    this._closeBlock();
    await this._respond(item, "block");
  }

  // ---- Rendering ----
  private _renderLogo(i: TrashItem) {
    const color = safeColor(i.color);
    const url = i.is_own && i.logo ? this._logos.get(`${i.card_id}:${i.logo.version}`) : undefined;
    if (url) {
      return html`<div class="logo" style="background:${color}">
        <img src=${url} alt="" class=${i.logo_fit === "cover" ? "cover" : ""} /></div>`;
    }
    return html`<div class="logo" aria-hidden="true" style="background:${color};color:${contrastText(color)}">
      ${(i.name.trim()[0] ?? "?").toUpperCase()}</div>`;
  }

  private _renderDates(i: TrashItem) {
    const t = this.t;
    const lang = this.language;
    const deleted = t("trash_deleted_on", { date: formatDate(i.deleted_at, lang, true) });
    if (i.purge_at) {
      const left = Date.parse(i.purge_at) - this._now;
      return html`<span class="meta">${deleted}</span>
        <span class="countdown live" role="timer">${t("trash_purge_in", { time: formatCountdown(left) })}</span>`;
    }
    return html`<span class="meta">${deleted} · ${t("trash_expires_on", { date: formatDate(i.expires_at, lang) })}</span>`;
  }

  private _renderOwn(i: TrashItem) {
    const t = this.t;
    const busy = this._busy.has(i.card_id) || this._busy.has("*");
    const req = i.request;
    return html`<li class="item ${this.focusId === i.card_id ? "focus" : ""}" data-id=${i.card_id} tabindex="-1">
      ${this._renderLogo(i)}
      <div class="info">
        <span class="name">${i.name}</span>
        ${this._renderDates(i)}
        ${i.blocked ? html`<div class="status"><span class="pill">${t("trash_blocked")}</span></div>` : nothing}
        ${req?.status === "pending" ? html`<div class="request" role="group" aria-label=${t("trash_request_by", { admin: req.admin_name })}>
          <p>${t("trash_request_by", { admin: req.admin_name })}</p>
          <div class="actions">
            <button class="btn primary small" ?disabled=${busy} @click=${() => this._respond(i, "accept")}>
              <ha-icon icon="mdi:check"></ha-icon>${t("trash_accept")}</button>
            <button class="btn small" ?disabled=${busy} @click=${() => this._respond(i, "reject")}>
              <ha-icon icon="mdi:close"></ha-icon>${t("trash_reject")}</button>
            <button class="btn danger small" ?disabled=${busy} @click=${() => this._openBlock(i)}>
              <ha-icon icon="mdi:cancel"></ha-icon>${t("trash_block")}</button>
          </div>
        </div>` : nothing}
        <div class="actions">
          ${i.can_restore ? html`<button class="btn small" ?disabled=${busy} @click=${() => this._restore(i)}
            aria-label="${t("trash_restore")}: ${i.name}">
            <ha-icon icon="mdi:restore"></ha-icon>${t("trash_restore")}</button>` : nothing}
          ${i.purge_at
            ? html`<button class="btn small" ?disabled=${busy} @click=${() => this._cancelPurge(i)}
                aria-label="${t("trash_cancel_purge")}: ${i.name}">
                <ha-icon icon="mdi:undo"></ha-icon>${t("trash_cancel_purge")}</button>`
            : html`<button class="btn danger small" ?disabled=${busy} @click=${() => this._purge(i)}
                aria-label="${t("trash_delete_forever")}: ${i.name}">
                <ha-icon icon="mdi:delete-forever"></ha-icon>${t("trash_delete_forever")}</button>`}
        </div>
      </div>
    </li>`;
  }

  private _renderOther(i: TrashItem) {
    const t = this.t;
    const busy = this._busy.has(i.card_id);
    const req = i.request;
    return html`<li class="item ${this.focusId === i.card_id ? "focus" : ""}" data-id=${i.card_id} tabindex="-1">
      ${this._renderLogo(i)}
      <div class="info">
        <span class="name">${i.name}</span>
        <span class="meta">${t("trash_owner", { name: i.owner_name })}</span>
        ${this._renderDates(i)}
        <div class="status">
          ${req ? html`<span class="pill">${t("trash_request_sent", { n: req.sends, max: req.max_sends })}</span>` : nothing}
          ${req?.status === "rejected" ? html`<span class="pill warn">${t("trash_request_rejected")}</span>` : nothing}
          ${i.rejections > 0
            ? html`<span class="pill">${t("trash_rejections", { n: i.rejections, max: TRASH_MAX_REJECTIONS })}</span>` : nothing}
          ${i.blocked ? html`<span class="pill warn">${t("trash_blocked")}</span>` : nothing}
          ${i.purge_at ? html`<span class="pill">${t("trash_owner_purging")}</span>` : nothing}
        </div>
        ${this._notNotified.has(i.card_id) ? html`<span class="hint" role="status">${t("trash_not_notified")}</span>` : nothing}
        ${i.can_request ? html`<div class="actions">
          <button class="btn small" ?disabled=${busy} @click=${() => this._request(i)}
            aria-label="${req ? t("trash_request_again") : t("trash_request")}: ${i.name}">
            <ha-icon icon="mdi:send"></ha-icon>${req ? t("trash_request_again") : t("trash_request")}</button>
        </div>` : nothing}
      </div>
    </li>`;
  }

  private _renderBlockDialog() {
    const t = this.t;
    const item = this._blockItem;
    const left = this._blockLeft;
    return html`<lh-dialog .open=${!!item} heading=${t("trash_block_title")} close-label=${t("close")}
      @closed=${() => this._closeBlock()}>
      ${item ? html`<p><strong>${item.name}</strong></p><p>${t("trash_block_text")}</p>` : nothing}
      <button slot="actions" class="btn" @click=${() => this._closeBlock()}>${t("cancel")}</button>
      <button slot="actions" class="btn danger" ?disabled=${left > 0} aria-live="polite"
        @click=${() => this._confirmBlock()}>
        ${left > 0 ? t("trash_block_wait", { s: left }) : t("trash_block")}</button>
    </lh-dialog>`;
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const items = this.items;
    if (items === null) return html`<div class="state">${t("loading")}</div>`;
    const own = items.filter((i) => i.is_own);
    const others = items.filter((i) => !i.is_own);
    const canEmpty = own.some((i) => !i.purge_at);
    return html`
      <div class="top">
        <span class="hint">${t("trash_hint")}</span>
        ${own.length ? html`<button class="btn danger" ?disabled=${!canEmpty || this._busy.has("*")}
          @click=${() => this._purge()}><ha-icon icon="mdi:delete-sweep"></ha-icon>${t("trash_empty_all")}</button>`
          : nothing}
      </div>
      ${!items.length ? html`<div class="state">${t("trash_empty")}</div>` : nothing}
      ${own.length ? html`${others.length ? html`<h2>${t("trash_own_title")}</h2>` : nothing}
        <ul>${own.map((i) => this._renderOwn(i))}</ul>` : nothing}
      ${others.length ? html`<h2>${t("trash_others_title")}</h2>
        <p class="hint">${t("trash_others_hint")}</p>
        <ul>${others.map((i) => this._renderOther(i))}</ul>` : nothing}
      ${this._renderBlockDialog()}
    `;
  }
}

defineElement("lh-trash-view", LhTrashView);

declare global {
  interface HTMLElementTagNameMap { "lh-trash-view": LhTrashView }
}
