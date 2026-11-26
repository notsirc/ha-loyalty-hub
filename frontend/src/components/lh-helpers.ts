// Small browser helpers shared by the card components (v0.4, §11.3/§11.7/§11.8).
import { errorMessage } from "../api";
import type { Translate } from "../i18n";
import type { LogoProvider } from "../types";

// ---- Screen wake lock (§11.8) ----
interface WakeLockSentinelLike { release(): Promise<void>; released?: boolean }
type WakeLockApi = { request(type: "screen"): Promise<WakeLockSentinelLike> };

/** Keeps the screen on while active; re-acquired when the page becomes visible again. */
export class WakeLockHandle {
  private _sentinel: WakeLockSentinelLike | null = null;
  private _active = false;

  acquire(): void {
    if (this._active) return;
    this._active = true;
    document.addEventListener("visibilitychange", this._onVisibility);
    this._request();
  }

  release(): void {
    this._active = false;
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._sentinel?.release().catch(() => undefined);
    this._sentinel = null;
  }

  private _onVisibility = () => {
    if (this._active && document.visibilityState === "visible" && (!this._sentinel || this._sentinel.released)) {
      this._request();
    }
  };

  private async _request() {
    const wl = (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;
    if (!wl || document.visibilityState !== "visible") return;
    try {
      const s = await wl.request("screen");
      if (this._active) this._sentinel = s;
      else s.release().catch(() => undefined);
    } catch {
      /* not allowed (battery saver, no permission) */
    }
  }
}

// ---- Automatic "used" (§11.8) ----
/**
 * Calls `cb` once after the barcode has been visible for `ms` continuous milliseconds while the
 * page is visible. Several sources (detail barcode, cashier overlay) may report visibility.
 * `reset()` starts a new "opening".
 */
export class AutoUsedTimer {
  private _sources = new Set<string>();
  private _timer?: number;
  private _done = false;
  private _attached = false;

  constructor(private readonly _cb: () => void, private readonly _ms = 4000) {}

  attach(): void {
    if (this._attached) return;
    this._attached = true;
    document.addEventListener("visibilitychange", this._eval);
    this._eval();
  }

  detach(): void {
    this._attached = false;
    document.removeEventListener("visibilitychange", this._eval);
    this._clear();
  }

  reset(): void {
    this._done = false;
    this._sources.clear();
    this._clear();
  }

  setVisible(source: string, visible: boolean): void {
    if (visible) this._sources.add(source);
    else this._sources.delete(source);
    this._eval();
  }

  private get _running(): boolean {
    return this._attached && !this._done && this._sources.size > 0 && document.visibilityState === "visible";
  }

  private _clear() {
    if (this._timer !== undefined) clearTimeout(this._timer);
    this._timer = undefined;
  }

  private _eval = () => {
    if (!this._running) {
      this._clear();
      return;
    }
    if (this._timer !== undefined) return;
    this._timer = window.setTimeout(() => {
      this._timer = undefined;
      if (!this._running) return;
      this._done = true;
      this._cb();
    }, this._ms);
  };
}

/** Observes whether `el` is (mostly) on screen. Returns the disconnect function. */
export function observeVisible(el: Element, cb: (visible: boolean) => void, threshold = 0.5): () => void {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => undefined;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) cb(e.isIntersecting && e.intersectionRatio >= threshold);
  }, { threshold: [0, threshold, 1] });
  io.observe(el);
  return () => io.disconnect();
}

// ---- Links (§11.7) ----
export function cardLink(cardId: string, cashier = false): string {
  return `${location.origin}/loyalty-hub?card=${encodeURIComponent(cardId)}${cashier ? "&cashier=1" : ""}`;
}

/** Copies text to the clipboard (Clipboard API, fallback to a temporary textarea). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

// ---- Errors ----
export const errorCode = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** Error text for the UI; `limit_reached` (§11.3/§11.5) gets a clear dedicated message. */
export function wsErrorText(err: unknown, t: Translate, limitText?: string): string {
  if (errorCode(err) === "limit_reached") {
    const msg = errorMessage(err);
    return limitText ?? t("tiles_limit_reached", { msg: msg === "limit_reached" ? "" : msg });
  }
  return t("error_generic", { msg: errorMessage(err) });
}

// ---- Logo providers (§11.3, §15.1) ----
// The order (Logo.dev → shop website → logoapi.sh) is defined only on the server
// (`core/logo_sources.py` PROVIDER_ORDER): `logo/providers` returns the list already sorted.

/** `source` if it is an enabled online provider, otherwise the first enabled one (or null). */
export function pickLogoProvider(enabled: LogoProvider[], source?: string | null): LogoProvider | null {
  if (source && enabled.includes(source as LogoProvider)) return source as LogoProvider;
  return enabled[0] ?? null;
}

// ---- Geolocation (§11.5, explicit button only) ----
export function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext || !navigator.geolocation) {
      reject(new Error("unavailable"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 60000,
    });
  });
}
