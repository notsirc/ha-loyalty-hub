// Lovelace card entry point (§12.9): a tiny loader loaded on every HA page via add_extra_js_url.
// The real card (Lit, barcode libraries…) is imported only when a <loyalty-hub-card> is shown.
// No imports here on purpose: everything else lives in chunks loaded on demand.

interface CardConfig { type: string; mode?: string; max_items?: number; show_selector?: boolean }

interface CardImpl extends HTMLElement {
  hass?: unknown;
  setConfig(config: CardConfig): void;
  getCardSize?(): number;
}

let implLoad: Promise<unknown> | null = null;
const loadImpl = () => (implLoad ??= import("./card-impl"));

class LoyaltyHubCardLoader extends HTMLElement {
  private _config: CardConfig | null = null;
  private _hass: unknown;
  private _impl: CardImpl | null = null;
  private _loading = false;

  static async getConfigElement(): Promise<HTMLElement> {
    await import("./components/lh-card-editor");
    return document.createElement("loyalty-hub-card-editor");
  }

  static getStubConfig(): CardConfig {
    return { type: "custom:loyalty-hub-card", mode: "auto", max_items: 6, show_selector: true };
  }

  setConfig(config: CardConfig): void {
    if (!config) throw new Error("Invalid configuration");
    const mode = config.mode ?? "auto";
    if (!["auto", "all", "favorites", "nearby"].includes(mode)) throw new Error(`Invalid mode: ${mode}`);
    this._config = config;
    this._impl?.setConfig(config);
  }

  set hass(hass: unknown) {
    this._hass = hass;
    if (this._impl) this._impl.hass = hass;
  }

  get hass(): unknown {
    return this._hass;
  }

  getCardSize(): number {
    if (this._impl?.getCardSize) return this._impl.getCardSize();
    const max = Number(this._config?.max_items ?? 6);
    const n = Number.isFinite(max) && max > 0 ? Math.min(Math.floor(max), 6) : 6;
    return 1 + Math.ceil(n / 2) * 2;
  }

  connectedCallback(): void {
    if (this._impl || this._loading) return;
    this._loading = true;
    loadImpl().then(() => {
      const impl = document.createElement("loyalty-hub-card-impl") as CardImpl;
      if (this._config) impl.setConfig(this._config);
      if (this._hass !== undefined) impl.hass = this._hass;
      this._impl = impl;
      this.textContent = ""; // a previous load error, if any
      this.appendChild(impl);
    }).catch((err) => {
      implLoad = null;
      this.textContent = `Loyalty Hub: ${String(err)}`;
    }).finally(() => {
      this._loading = false;
    });
  }
}

if (!customElements.get("loyalty-hub-card")) customElements.define("loyalty-hub-card", LoyaltyHubCardLoader);

interface CustomCardEntry { type: string; name: string; description?: string; preview?: boolean }
const w = window as unknown as { customCards?: CustomCardEntry[] };
w.customCards = w.customCards ?? [];
if (!w.customCards.some((c) => c.type === "loyalty-hub-card")) {
  w.customCards.push({
    type: "loyalty-hub-card",
    name: "Loyalty Hub",
    description: "Loyalty cards and vouchers from Loyalty Hub",
    preview: false,
  });
}
