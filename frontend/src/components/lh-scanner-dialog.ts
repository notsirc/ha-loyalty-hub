import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import type { Translate } from "../i18n";
import { liveScanAvailable, scanImageFile, startLiveScan, type ScanSession } from "../scanner";
import { sharedStyles } from "../styles";
import { defineElement, fireEvent } from "../util";
import "./lh-dialog";

/** Camera / photo barcode scanner. Fires `scanned` {code, format} and `closed`. */
export class LhScannerDialog extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ attribute: false }) t!: Translate;
  @state() private _error = "";
  @state() private _busy = false;
  @query("video") private _video?: HTMLVideoElement;
  @query("#photo") private _photo?: HTMLInputElement;
  private _session: ScanSession | null = null;
  private _starting = false;

  static override styles = [sharedStyles, css`
    .viewport {
      position: relative; background: #000; border-radius: 8px; overflow: hidden;
      aspect-ratio: 4 / 3; margin-bottom: 12px;
    }
    video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .frame {
      position: absolute; inset: 22% 10%; border: 2px solid rgba(255, 255, 255, 0.85);
      border-radius: 8px; pointer-events: none;
    }
    .buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    input[type="file"] { display: none; }
    p { margin: 8px 0; }
  `];

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._stop();
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("open")) {
      if (this.open) {
        this._error = "";
        if (liveScanAvailable()) this.updateComplete.then(() => this._start());
      } else {
        this._stop();
      }
    }
  }

  private async _start() {
    if (this._session || this._starting || !this.open) return;
    const video = this._video;
    if (!video) return;
    this._starting = true;
    try {
      const session = await startLiveScan(video, (r) => {
        this._session = null;
        this._emit(r.code, r.format);
      });
      if (!this.open) session.stop();
      else this._session = session;
    } catch (err) {
      this._error = this.t("scan_camera_error", { msg: err instanceof Error ? err.message : String(err) });
    } finally {
      this._starting = false;
    }
  }

  private _stop() {
    this._session?.stop();
    this._session = null;
    const stream = this._video?.srcObject as MediaStream | null | undefined;
    stream?.getTracks().forEach((tr) => tr.stop());
    if (this._video) this._video.srcObject = null;
  }

  private _emit(code: string, format: unknown) {
    this._stop();
    fireEvent(this, "scanned", { code, format });
    this._close();
  }

  private _close() {
    this._stop();
    this.open = false;
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private async _onPhoto(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    this._busy = true;
    this._error = "";
    try {
      const r = await scanImageFile(file);
      if (r) this._emit(r.code, r.format);
      else this._error = this.t("scan_not_found");
    } finally {
      this._busy = false;
    }
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const live = liveScanAvailable();
    return html`
      <lh-dialog .open=${this.open} heading=${t("scan_title")} close-label=${t("close")} @closed=${this._close}>
        ${live ? html`
          <div class="viewport">
            <video muted playsinline autoplay></video>
            <div class="frame"></div>
          </div>
          <p class="hint">${t("scan_hint")}</p>`
          : html`<p class="hint">${t("scan_https_hint")}</p>`}
        ${this._error ? html`<p class="error-text">${this._error}</p>` : nothing}
        <div class="buttons">
          <button class="btn ${live ? "" : "primary"}" ?disabled=${this._busy} @click=${() => this._photo?.click()}>
            <ha-icon icon="mdi:image"></ha-icon>${t("scan_photo")}
          </button>
        </div>
        <input id="photo" type="file" accept="image/*" capture="environment" @change=${this._onPhoto} />
      </lh-dialog>
    `;
  }
}

defineElement("lh-scanner-dialog", LhScannerDialog);

declare global {
  interface HTMLElementTagNameMap { "lh-scanner-dialog": LhScannerDialog }
}
