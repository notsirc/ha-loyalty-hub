import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applyLogoPreview, previewLogo, revertLogo } from "../api";
import type { I18nKey, Translate } from "../i18n";
import { previewDataUrl, previousLogoUrl } from "../logo";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant, LogoLookupProvider, LogoPreview, LogoProvider } from "../types";
import { defineElement, fireEvent } from "../util";
import "./lh-card-tile";
import "./lh-dialog";
import { errorCode, wsErrorText } from "./lh-helpers";

const PROVIDER_NAME: Record<LogoProvider, I18nKey> = {
  logo_dev: "tiles_provider_logo_dev",
  logoapi: "tiles_provider_logoapi",
  website: "tiles_provider_website",
};

/**
 * §14.2: "Before / After" dialog of a logo refresh. `show(card, provider, domain)` asks the server
 * for a preview (nothing saved); "Use the new one" applies it, "Keep the old one" just closes (the
 * preview expires by itself). With `same` only "Close". The "after" image is a `data:` URL in <img>.
 * Events: `card-updated` {card}, `show-toast` {message} (bubbling), `closed` (not bubbling).
 */
export class LhLogoPreviewDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @state() private _open = false;
  @state() private _card: Card | null = null;
  @state() private _domain = "";
  @state() private _preview: LogoPreview | null = null;
  @state() private _loading = false;
  @state() private _busy = false;
  @state() private _error = "";
  /** Increases at every show(): late answers of an older request are ignored. */
  private _seq = 0;

  static override styles = [sharedStyles, css`
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 10px; }
    .pair figure { margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .pair figcaption { font-size: 0.85em; color: var(--secondary-text-color); text-align: center; font-weight: 500; }
    .single { max-width: 240px; margin: 0 auto 10px; }
    p { margin: 0 0 8px; }
  `];

  async show(card: Card, provider: LogoLookupProvider, domain: string): Promise<void> {
    const seq = ++this._seq;
    this._card = card;
    this._domain = domain;
    this._preview = null;
    this._error = "";
    this._loading = true;
    this._open = true;
    try {
      const res = await previewLogo(this.hass, card.id, provider, domain);
      if (seq === this._seq) this._preview = res;
    } catch (err) {
      if (seq !== this._seq) return;
      this._error = errorCode(err) === "not_found"
        ? this.t("tiles_preview_not_found", { domain }) : wsErrorText(err, this.t);
    } finally {
      if (seq === this._seq) this._loading = false;
    }
  }

  private _close = () => {
    this._seq++;
    this._open = false;
    this._preview = null;
    this.dispatchEvent(new CustomEvent("closed"));
  };

  private async _apply() {
    const card = this._card;
    const p = this._preview;
    if (!card || !p) return;
    this._busy = true;
    try {
      const updated = await applyLogoPreview(this.hass, card.id, p.preview_id);
      fireEvent(this, "card-updated", { card: updated });
      fireEvent(this, "show-toast", { message: this.t("logo_updated") });
      this._close();
    } catch (err) {
      this._error = errorCode(err) === "not_found" ? this.t("tiles_preview_expired")
        : errorCode(err) === "limit_reached" ? wsErrorText(err, this.t, this.t("tiles_logo_limit"))
          : wsErrorText(err, this.t);
      this._preview = null;
    } finally {
      this._busy = false;
    }
  }

  private _body() {
    const t = this.t;
    const c = this._card!;
    const p = this._preview;
    if (this._loading) return html`<p class="muted">${t("tiles_preview_loading", { domain: this._domain })}</p>`;
    if (!p) return this._error ? html`<p class="error-text">${this._error}</p>` : nothing;
    if (p.same) {
      return html`<div class="single"><lh-card-tile layout="large" .card=${c} .hass=${this.hass} .t=${t}
        language=${this.language}></lh-card-tile></div>
        <p>${t("tiles_preview_same")}</p>`;
    }
    const after = { ...c, logo_fit: "contain" } as Card;
    return html`
      <div class="pair">
        <figure>
          <lh-card-tile layout="large" .card=${c} .hass=${this.hass} .t=${t} language=${this.language}></lh-card-tile>
          <figcaption>${t("tiles_preview_before")}</figcaption>
        </figure>
        <figure>
          <lh-card-tile layout="large" .card=${after} .hass=${this.hass} .t=${t} language=${this.language}
            .logoSrc=${previewDataUrl(p.mime, p.data_base64)}></lh-card-tile>
          <figcaption>${t("tiles_preview_after")}</figcaption>
        </figure>
      </div>
      <p class="hint">${t("tiles_preview_source", { provider: t(PROVIDER_NAME[p.provider] ?? "tiles_provider_website") })}</p>
      ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}`;
  }

  protected override render() {
    const t = this.t;
    if (!t || !this._card) return nothing;
    const p = this._preview;
    const choose = !!p && !p.same && !this._loading;
    return html`
      <lh-dialog .open=${this._open} wide heading=${t("tiles_preview_title")} close-label=${t("close")}
        @closed=${this._close}>
        ${this._body()}
        ${choose ? html`
          <button slot="actions" class="btn" ?disabled=${this._busy} @click=${this._close}>${t("tiles_preview_keep_old")}</button>
          <button slot="actions" class="btn primary" ?disabled=${this._busy} @click=${this._apply}>
            <ha-icon icon="mdi:check"></ha-icon>${t("tiles_preview_use_new")}</button>`
          : html`<button slot="actions" class="btn" @click=${this._close}>${t("close")}</button>`}
      </lh-dialog>`;
  }
}

/**
 * §14.2: small "Back to the previous logo" button with a thumbnail of the previous logo.
 * Runs `logo/revert` itself. Events: `card-updated` {card}, `show-toast` {message}.
 */
export class LhLogoRevertButton extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  @property({ attribute: false }) card!: Card;
  @property({ type: Boolean }) disabled = false;
  @state() private _src: string | null = null;
  @state() private _busy = false;
  private _key = "";

  static override styles = [sharedStyles, css`
    :host { display: inline-block; }
    .thumb { width: 44px; flex: none; }
    .btn { padding-left: 6px; }
  `];

  protected override willUpdate(): void {
    const prev = this.card?.logo_previous;
    const key = prev && this.hass ? `${this.card.id}:${prev.version}` : "";
    if (key === this._key) return;
    this._key = key;
    this._src = null;
    if (!key) return;
    previousLogoUrl(this.hass, this.card)?.then((u) => { if (this._key === key) this._src = u; }, () => undefined);
  }

  private async _revert() {
    this._busy = true;
    try {
      const card = await revertLogo(this.hass, this.card.id);
      fireEvent(this, "card-updated", { card });
      fireEvent(this, "show-toast", { message: this.t("tiles_logo_reverted") });
    } catch (err) {
      fireEvent(this, "show-toast", {
        message: errorCode(err) === "limit_reached" ? wsErrorText(err, this.t, this.t("tiles_logo_limit")) : wsErrorText(err, this.t),
      });
    } finally {
      this._busy = false;
    }
  }

  protected override render() {
    const t = this.t;
    const c = this.card;
    if (!t || !c?.logo_previous) return nothing;
    const thumb = { ...c, kind: "card", visibility: "private", favorite: false } as Card;
    return html`<button type="button" class="btn" ?disabled=${this.disabled || this._busy} @click=${this._revert}
      title=${t("tiles_logo_previous")}>
      <span class="thumb"><lh-card-tile layout="large" .card=${thumb} .hass=${this.hass} .t=${t}
        language=${this.language} .logoSrc=${this._src ?? ""}></lh-card-tile></span>
      ${t("tiles_logo_revert")}</button>`;
  }
}

defineElement("lh-logo-preview-dialog", LhLogoPreviewDialog);
defineElement("lh-logo-revert-button", LhLogoRevertButton);

declare global {
  interface HTMLElementTagNameMap {
    "lh-logo-preview-dialog": LhLogoPreviewDialog;
    "lh-logo-revert-button": LhLogoRevertButton;
  }
}
