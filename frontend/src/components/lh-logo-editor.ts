import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import { deleteLogo, getLogoProviders, lookupLogo, uploadLogo, type LogoOnCreate } from "../api";
import type { I18nKey, Translate } from "../i18n";
import { isValidDomain, loadImage, logoBackground, logoUrl, suggestDomain } from "../logo";
import { sharedStyles } from "../styles";
import type { Card, EditableCard, HomeAssistant, LogoDevState, LogoFit, LogoLookupProvider, LogoProvider } from "../types";
import { defineElement, fireEvent } from "../util";
import "./lh-card-tile";
import { errorCode, wsErrorText } from "./lh-helpers";
import "./lh-image-cropper";
import type { CropResult } from "./lh-image-cropper";
import "./lh-logo-dev-guide";
import "./lh-logo-preview-dialog";
import type { LhLogoPreviewDialog } from "./lh-logo-preview-dialog";

const PROVIDER_LABEL: Record<LogoProvider, I18nKey> = {
  logo_dev: "logo_search_logo_dev",
  logoapi: "logo_search_logoapi",
  website: "logo_search_website",
};

type Pending = { kind: "upload"; base64: string; dataUrl: string } | { kind: "lookup"; provider: LogoLookupProvider; domain: string };

/**
 * Logo section of the card form (§8.3, §14.2): upload/photo, online lookup, remove, fit toggle, live preview.
 * Saved cards: uploads/removals run immediately; online lookups open the "Before / After" preview
 * (`lh-logo-preview-dialog`); "Back to the previous logo" swaps current and previous (a removal can be
 * undone the same way). New cards: operations are queued and run by `applyPending(card)` right after
 * creation (with a domain and no explicit choice, the provider "auto" is used, best effort).
 * The Logo.dev button is always there (§14.1): when the provider is not "ready" it opens `lh-logo-dev-guide`.
 * Events: `logo-fit-changed` {fit}, `logo-domain-changed` {domain}, `color-suggested` {color},
 * `card-updated` {card}, `show-toast` {message}.
 */
export class LhLogoEditor extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) t!: Translate;
  @property() language = "en";
  /** Saved card (null for a new card). */
  @property({ attribute: false }) card: Card | null = null;
  /** Current form values (for the live preview). */
  @property({ attribute: false }) data!: EditableCard;
  @state() private _current: Card | null = null;
  @state() private _pending: Pending | null = null;
  @state() private _providers: LogoProvider[] = [];
  /** null until logo/providers answered. */
  @state() private _logoDev: LogoDevState | null = null;
  @state() private _guideOpen = false;
  @state() private _domain = "";
  @state() private _domainTouched = false;
  @state() private _error = "";
  @state() private _busy = false;
  /** File picked by the user, being cropped (§10.5). */
  @state() private _cropFile: Blob | null = null;
  @query("#logo-file") private _file?: HTMLInputElement;
  @query("lh-logo-preview-dialog") private _previewDialog?: LhLogoPreviewDialog;

  static override styles = [sharedStyles, css`
    :host { display: block; }
    .preview { max-width: 260px; margin: 0 auto 12px; }
    .seg { display: flex; border: 1px solid var(--divider-color); border-radius: 22px; overflow: hidden; }
    .seg button {
      flex: 1; min-height: 38px; border: none; background: transparent; color: var(--primary-text-color);
      cursor: pointer; font: inherit;
    }
    .seg button[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
    input[type="file"] { display: none; }
    .online { border-top: 1px solid var(--divider-color); padding-top: 12px; margin-top: 4px; }
    .btn.off { color: var(--secondary-text-color); }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    if (this.hass) {
      getLogoProviders(this.hass).then((p) => {
        this._providers = p.providers;
        this._logoDev = p.logo_dev;
      }).catch(() => { this._logoDev = "no_key"; });
    }
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("card")) {
      this._current = this.card;
      this._pending = null;
    }
    if (!this._domainTouched && this.data) {
      this._domain = this.data.logo_domain || suggestDomain(this.data.name, this.language);
    }
  }

  private get _hasLogo(): boolean {
    return this._pending?.kind === "upload" || !!this._current?.logo;
  }

  private get _canEdit(): boolean {
    return !this._current || this._current.can_edit !== false;
  }

  /**
   * Executes queued logo operations for a newly created card. Without an explicit choice but with a
   * domain: best-effort lookup with "auto" (only limit_reached is reported).
   */
  async applyPending(card: Card): Promise<Card> {
    const p = this._pending;
    this._pending = null;
    if (!p) {
      if (!card.logo_domain || !this._providers.length) return card;
      try {
        const updated = await lookupLogo(this.hass, card.id, "auto", card.logo_domain);
        this._suggestFromServer(updated);
        return updated;
      } catch (err) {
        if (errorCode(err) === "limit_reached") throw err;
        return card;
      }
    }
    const updated = p.kind === "upload"
      ? await uploadLogo(this.hass, card.id, p.base64)
      : await lookupLogo(this.hass, card.id, p.provider, p.domain);
    if (p.kind === "lookup") this._suggestFromServer(updated);
    return updated;
  }

  /**
   * §15.4: card created for another user (the creator cannot edit it afterwards): the queued logo goes
   * in the same `cards/create` call. A lookup uses the "auto" provider with the card domain (the
   * chosen domain is written into `data.logo_domain`). Clears the queue.
   */
  pendingForCreate(data: EditableCard): LogoOnCreate {
    const p = this._pending;
    this._pending = null;
    if (p?.kind === "upload") return { logoUpload: p.base64 };
    if (p?.kind === "lookup") data.logo_domain = p.domain;
    return data.logo_domain && this._providers.length ? { logoLookup: true } : {};
  }

  private async _run(op: () => Promise<Card>, toastKey: I18nKey): Promise<Card | null> {
    this._busy = true;
    this._error = "";
    try {
      const card = await op();
      this._current = card;
      fireEvent(this, "card-updated", { card });
      fireEvent(this, "show-toast", { message: this.t(toastKey) });
      return card;
    } catch (err) {
      this._error = errorCode(err) === "limit_reached"
        ? wsErrorText(err, this.t, this.t("tiles_logo_limit")) : wsErrorText(err, this.t);
      return null;
    } finally {
      this._busy = false;
    }
  }

  private _onFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this._error = "";
    this._cropFile = file;
  }

  private async _onCropped(e: CustomEvent<CropResult>) {
    const res = e.detail;
    this._cropFile = null;
    if (res.color) fireEvent(this, "color-suggested", { color: res.color });
    this._setFit(res.fit);
    if (this._current) {
      // logo_fit is a card field: saved with the form; the image itself is uploaded right away.
      await this._run(() => uploadLogo(this.hass, this._current!.id, res.base64), "logo_updated");
    } else {
      this._pending = { kind: "upload", base64: res.base64, dataUrl: res.dataUrl };
    }
  }

  private async _suggestFromServer(card: Card) {
    const url = logoUrl(this.hass, card);
    if (!url) return;
    try {
      // §15.2: the one rule shared with the cropper and "Color from logos".
      const { color } = logoBackground(await loadImage(await url));
      if (color) fireEvent(this, "color-suggested", { color });
    } catch {
      /* SVG without size or load failure: no suggestion */
    }
  }

  /** Valid domain from the field (also reported to the form), or null with an error shown. */
  private _validDomain(): string | null {
    const domain = this._domain.trim().toLowerCase();
    if (!isValidDomain(domain)) {
      this._error = this.t("err_domain");
      return null;
    }
    this._error = "";
    fireEvent(this, "logo-domain-changed", { domain });
    return domain;
  }

  /** Saved card: "Before / After" preview; new card: queued until creation. */
  private _lookup(provider: LogoLookupProvider) {
    const domain = this._validDomain();
    if (!domain) return;
    if (this._current) this._previewDialog?.show(this._current, provider, domain);
    else this._pending = { kind: "lookup", provider, domain };
  }

  private _onLogoDev() {
    if (this._logoDev === "ready") this._lookup("logo_dev");
    else this._guideOpen = true;
  }

  private _onPreviewApplied = (e: CustomEvent<{ card: Card }>) => {
    // The event keeps bubbling to the panel; here only the local copy and the color suggestion.
    this._current = e.detail.card;
    this._suggestFromServer(e.detail.card);
  };

  private _onReverted = (e: CustomEvent<{ card: Card }>) => {
    this._current = e.detail.card;
  };

  private async _remove() {
    if (this._current?.logo) {
      // §14.2: the removed logo becomes the previous one, "Back to the previous logo" undoes it.
      await this._run(() => deleteLogo(this.hass, this._current!.id), "tiles_logo_removed_undo");
    }
    this._pending = null;
  }

  private _setFit(fit: LogoFit) {
    fireEvent(this, "logo-fit-changed", { fit });
  }

  protected override render() {
    const t = this.t;
    if (!t || !this.data) return nothing;
    const d = this.data;
    const base = this._current;
    const previewCard = {
      ...(base ?? { id: "preview", owner_id: "", transactions: [], balance: null, use_count: 0, last_used: null,
        created_at: "", updated_at: "" }),
      ...d,
      name: d.name || "?",
      logo: base?.logo ?? null,
    } as Card;
    const pendingSrc = this._pending?.kind === "upload" ? this._pending.dataUrl : undefined;
    // §15.1: server order; Logo.dev is always rendered first as its own button.
    const others = this._providers.filter((p) => p !== "logo_dev");
    const canRefresh = !!base && this._canEdit && this._providers.length > 0;
    return html`
      <div class="preview">
        <lh-card-tile layout="large" .card=${previewCard} .hass=${this.hass} .t=${t} language=${this.language}
          .logoSrc=${pendingSrc}></lh-card-tile>
      </div>
      ${this._hasLogo ? html`<div class="field">
        <span class="label">${t("logo_fit")}</span>
        <div class="seg" role="group">
          <button type="button" aria-pressed=${d.logo_fit !== "cover"} @click=${() => this._setFit("contain")}>
            ${t("logo_fit_contain")}</button>
          <button type="button" aria-pressed=${d.logo_fit === "cover"} @click=${() => this._setFit("cover")}>
            ${t("logo_fit_cover")}</button>
        </div>
      </div>` : nothing}
      <div class="buttons">
        <button type="button" class="btn" ?disabled=${this._busy} @click=${() => this._file?.click()}>
          <ha-icon icon="mdi:camera"></ha-icon>${t("logo_upload")}</button>
        ${canRefresh ? html`<button type="button" class="btn" ?disabled=${this._busy} @click=${() => this._lookup("auto")}
          title=${t("tiles_logo_refresh_hint", { domain: this._domain.trim().toLowerCase() })}>
          <ha-icon icon="mdi:refresh"></ha-icon>${t("tiles_logo_refresh")}</button>` : nothing}
        ${base?.logo_previous && this._canEdit ? html`<lh-logo-revert-button .hass=${this.hass} .t=${t}
          language=${this.language} .card=${base} ?disabled=${this._busy}
          @card-updated=${this._onReverted}></lh-logo-revert-button>` : nothing}
        ${this._hasLogo || this._pending ? html`<button type="button" class="btn danger" ?disabled=${this._busy}
          @click=${this._remove}><ha-icon icon="mdi:image-remove"></ha-icon>${t("logo_remove")}</button>` : nothing}
      </div>
      <input id="logo-file" type="file" accept="image/*" @change=${this._onFile} />
      <lh-image-cropper .t=${t} .hass=${this.hass} language=${this.language} .file=${this._cropFile}
        .baseCard=${previewCard} @cropped=${this._onCropped}
        @closed=${() => { this._cropFile = null; }}></lh-image-cropper>
      ${this._pending?.kind === "upload" ? html`<p class="hint">${t("logo_pending_upload")}</p>` : nothing}
      ${this._pending?.kind === "lookup" ? html`<p class="hint">${t("logo_pending_lookup")}</p>` : nothing}

      <div class="online">
        <div class="field">
          <label for="logo-domain">${t("logo_domain")}</label>
          <input id="logo-domain" type="text" inputmode="url" autocomplete="off" autocapitalize="off"
            spellcheck="false" .value=${this._domain}
            placeholder=${t("logo_domain_hint", { example: suggestDomain("shop", this.language) })}
            @input=${(e: Event) => {
              this._domainTouched = true;
              this._domain = (e.target as HTMLInputElement).value;
            }} />
        </div>
        <div class="buttons">
          <button type="button" class="btn ${this._logoDev === "ready" ? "" : "off"}"
            ?disabled=${this._busy || this._logoDev === null} @click=${this._onLogoDev}>
            <ha-icon icon=${this._logoDev === "ready" ? "mdi:web" : "mdi:key-outline"}></ha-icon>${t(PROVIDER_LABEL.logo_dev)}</button>
          ${others.map((p) => html`<button type="button" class="btn" ?disabled=${this._busy}
            @click=${() => this._lookup(p)}><ha-icon icon="mdi:web"></ha-icon>${t(PROVIDER_LABEL[p])}</button>`)}
        </div>
        <p class="hint"><ha-icon icon="mdi:shield-alert-outline"></ha-icon> ${t("logo_privacy")}</p>
      </div>
      ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}
      <lh-logo-preview-dialog .hass=${this.hass} .t=${t} language=${this.language}
        @card-updated=${this._onPreviewApplied}></lh-logo-preview-dialog>
      <lh-logo-dev-guide .open=${this._guideOpen} .t=${t} state=${this._logoDev ?? "no_key"}
        ?admin=${!!this.hass?.user?.is_admin} @closed=${() => { this._guideOpen = false; }}></lh-logo-dev-guide>
    `;
  }
}

defineElement("lh-logo-editor", LhLogoEditor);

declare global {
  interface HTMLElementTagNameMap { "lh-logo-editor": LhLogoEditor }
}
