import { wordmarkColor } from "./logo";
import type { Card, PriceCompareSite, UserPrefs } from "./types";

/** Defines a custom element only once (both bundles may ship the same shared elements). */
export function defineElement(name: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(name)) customElements.define(name, ctor);
}

export function fireEvent<T>(node: EventTarget, type: string, detail?: T): void {
  node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** HA-style in-app navigation (falls back to a full load outside HA). */
export function navigate(path: string): void {
  history.pushState(null, "", path);
  window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function base64ToBlob(data: string, mime: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result ?? "");
      resolve(res.slice(res.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}_ -]+/gu, "").trim().replace(/\s+/g, "_") || "card";
}

export function formatMoney(amount: number | null | undefined, currency: string, lang: string): string {
  if (amount === null || amount === undefined) return "–";
  try {
    return new Intl.NumberFormat(lang, { style: "currency", currency: currency || "EUR" }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Formats an ISO date (YYYY-MM-DD) or datetime. */
export function formatDate(iso: string | null | undefined, lang: string, withTime = false): string {
  if (!iso) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(lang, withTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(d);
  } catch {
    return iso;
  }
}

export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isExpired = (expiry: string | null | undefined) => !!expiry && expiry < todayIso();

/** §11.10: exhausted non-reloadable vouchers and expired cards. */
export function isArchived(c: Card): boolean {
  if (isExpired(c.expiry)) return true;
  return c.kind === "voucher" && !c.reloadable && typeof c.balance === "number" && c.balance <= 0;
}

/** Builds price compare links, only for http(s) URLs. */
export function priceCompareLinks(sites: PriceCompareSite[] | undefined, query: string) {
  const q = query.trim();
  if (!q || !sites) return [];
  return sites.flatMap((s) => {
    if (!s?.url || !s.name) return [];
    const href = s.url.split("{query}").join(encodeURIComponent(q));
    try {
      const u = new URL(href);
      return u.protocol === "https:" || u.protocol === "http:" ? [{ name: s.name, href: u.href }] : [];
    } catch {
      return [];
    }
  });
}

/** Picks white or near-black text for a #RRGGBB background (WCAG contrast). */
export const contrastText = (hex: string) => wordmarkColor(hex);

export const safeColor = (hex: string | undefined) =>
  /^#[0-9a-f]{6}$/i.test(hex ?? "") ? (hex as string) : "#185FA5";

/** §10.2: admin sites filtered by the user prefs (disabled → none; null sites → all). */
export function userPriceSites(
  sites: PriceCompareSite[] | undefined, prefs: Pick<UserPrefs, "price_compare" | "price_compare_sites"> | null | undefined,
): PriceCompareSite[] {
  if (!sites?.length) return [];
  if (prefs?.price_compare === false) return [];
  const chosen = prefs?.price_compare_sites;
  if (!Array.isArray(chosen)) return sites;
  return sites.filter((s) => chosen.includes(s.name));
}
