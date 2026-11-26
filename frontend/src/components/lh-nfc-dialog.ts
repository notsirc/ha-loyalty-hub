import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { nfcLinkStart, nfcList, nfcUnlink, subscribeChanges } from "../api";
import type { Translate } from "../i18n";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant, NfcTag } from "../types";
import { defineElement } from "../util";
import "./lh-dialog";
import { wsErrorText } from "./lh-helpers";

/** True inside the Home Assistant Companion app (Android `externalApp`, iOS message handlers). */
function inCompanionApp(): boolean {
  const w = window as unknown as { externalApp?: unknown; webkit?: { messageHandlers?: { externalBus?: unknown } } };
  return !!w.externalApp || !!w.webkit?.messageHandlers?.externalBus || /Home ?Assistant\//i.test(navigator.userAgent);
}

/**
 * §15.5 nfc "Link to an NFC tag": steps (write a tag with the Companion app, "Start" here, hold the tag
 * within 60 s), wait for the `nfc_linked` event of this card, list of the tags linked to this card with
 * "Unlink". Subscribes only while open. Fires `closed`.
 */
export class LhNfcDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) card: Card | null = null;
  @property({ type: Boolean }) open = false;
  @state() private _tags: NfcTag[] | null = null;
  /** Waiting for a tag until this time (ms). */
  @state() private _until = 0;
  @state() private _left = 0;
  @state() private _linked = false;
  @state() private _error = "";
  @state() private _busy = false;
  private _unsub: (() => Promise<void> | void) | null = null;
  private _tick?: number;

  static override styles = [sharedStyles, css`
    ol { padding-left: 20px; margin: 0 0 12px; }
    li { margin-bottom: 6px; }
    .wait { display: flex; align-items: center; gap: 8px; margin: 8px 0; font-weight: 500; }
    .ok { color: var(--success-color, #2e7d32); font-weight: 500; }
    ul.tags { list-style: none; margin: 4px 0 0; padding: 0; }
    ul.tags li { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--divider-color); padding: 2px 0; }
    ul.tags li span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  `];

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stop();
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (!changed.has("open")) return;
    if (this.open) {
      this._linked = false;
      this._error = "";
      this._until = 0;
      this._tags = null;
      this._load();
      this._subscribe();
    } else {
      this._stop();
    }
  }

  private async _subscribe() {
    if (this._unsub || !this.hass) return;
    try {
      const unsub = await subscribeChanges(this.hass, () => undefined, undefined, undefined, {
        onNfcLinked: (id) => {
          if (id !== this.card?.id) return;
          this._linked = true;
          this._until = 0;
          this._load();
        },
      });
      if (this.open && this.isConnected) this._unsub = unsub;
      else await unsub();
    } catch {
      /* the list still works; the link is shown after reopening */
    }
  }

  private _stop() {
    const u = this._unsub;
    this._unsub = null;
    if (u) Promise.resolve().then(u).catch(() => undefined);
    clearInterval(this._tick);
    this._tick = undefined;
    this._until = 0;
  }

  private async _load() {
    try {
      this._tags = await nfcList(this.hass);
    } catch (err) {
      this._tags = [];
      this._error = wsErrorText(err, this.t);
    }
  }

  private async _start() {
    const card = this.card;
    if (!card) return;
    this._busy = true;
    this._error = "";
    this._linked = false;
    try {
      const res = await nfcLinkStart(this.hass, card.id);
      const exp = Date.parse(res.expires_at);
      this._until = Number.isFinite(exp) ? exp : Date.now() + 60000;
      this._left = Math.max(0, Math.round((this._until - Date.now()) / 1000));
      clearInterval(this._tick);
      this._tick = window.setInterval(() => {
        this._left = Math.max(0, Math.round((this._until - Date.now()) / 1000));
        if (this._left <= 0) {
          clearInterval(this._tick);
          this._tick = undefined;
          if (this._until) this._error = this.t("tiles_nfc_expired");
          this._until = 0;
        }
      }, 1000);
    } catch (err) {
      this._error = wsErrorText(err, this.t);
    } finally {
      this._busy = false;
    }
  }

  private async _unlink(tag: NfcTag) {
    this._busy = true;
    try {
      this._tags = await nfcUnlink(this.hass, tag.tag_id);
    } catch (err) {
      this._error = wsErrorText(err, this.t);
    } finally {
      this._busy = false;
    }
  }

  private _close() {
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const mine = (this._tags ?? []).filter((x) => x.card_id === this.card?.id);
    const waiting = this._until > 0;
    return html`
      <lh-dialog .open=${this.open} heading=${t("tiles_nfc_title")} close-label=${t("close")} @closed=${this._close}>
        <ol>
          <li>${t("tiles_nfc_step1")}</li>
          <li>${t("tiles_nfc_step2")}</li>
          <li>${t("tiles_nfc_step3")}</li>
        </ol>
        ${inCompanionApp() ? nothing : html`<p class="hint">${t("tiles_nfc_no_app")}</p>`}
        ${waiting ? html`<div class="wait" role="status"><ha-icon icon="mdi:nfc-search-variant"></ha-icon>
          ${t("tiles_nfc_waiting", { seconds: this._left })}</div>` : nothing}
        ${this._linked ? html`<p class="ok" role="status">${t("tiles_nfc_linked")}</p>` : nothing}
        ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}
        <span class="label">${t("tiles_nfc_tags")}</span>
        ${this._tags === null ? html`<p class="muted">${t("loading")}</p>`
          : mine.length ? html`<ul class="tags">${mine.map((tag) => html`<li>
              <ha-icon icon="mdi:nfc-variant"></ha-icon><span>${tag.tag_name || tag.tag_id}</span>
              <button class="btn" ?disabled=${this._busy} @click=${() => this._unlink(tag)}>${t("tiles_nfc_unlink")}</button>
            </li>`)}</ul>`
          : html`<p class="muted">${t("tiles_nfc_none")}</p>`}
        <button slot="actions" class="btn" @click=${this._close}>${t("close")}</button>
        <button slot="actions" class="btn primary" ?disabled=${this._busy || waiting} @click=${this._start}>
          <ha-icon icon="mdi:nfc-tap"></ha-icon>${t("tiles_nfc_start")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-nfc-dialog", LhNfcDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-nfc-dialog": LhNfcDialog }
}
