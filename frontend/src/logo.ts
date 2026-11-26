// Logo helpers (§8): signed URLs, dominant color, wordmark colors. Cropping/encoding: crop.ts (§10.5).
import { signPath } from "./api";
import { colorCoverage, edgeColor, rgbHex } from "./crop";
import type { HomeAssistant } from "./types";

/** Anything with a card id and logo metadata: a Card, or `{id: item.card_id, logo: item.logo}` for trash items. */
export interface LogoRef {
  id: string;
  logo?: { version: number } | null;
  /** §14.2: previous logo kept by the server (cards only). */
  logo_previous?: { version: number } | null;
}

/** Cache/version tag: "<v>" for the current logo, "prev-<v>" for the previous one (§14.2). */
type Tag = string;
const tagOf = (version: number, prev: boolean): Tag => (prev ? `prev-${version}` : String(version));

// ---- §12.9: persistent logo cache (Cache Storage), shared by panel and card ----
const CACHE_NAME = "loyalty-hub-logos-v1";
const KEY_PREFIX = "/__loyalty_hub_logo__/";
const SIGN_TTL_S = 86400;

/** In-memory: card id + version → object URL (or signed URL fallback). */
const urlCache = new Map<string, { url: Promise<string>; until: number }>();

function cacheAvailable(): boolean {
  try {
    return typeof caches !== "undefined" && !!window.isSecureContext;
  } catch {
    return false;
  }
}

/** Per HA user: on a shared device one user's logos never show which shops another user has. */
function userPrefix(userId: string): string {
  return `${location.origin}${KEY_PREFIX}${encodeURIComponent(userId)}/`;
}

function cacheKey(userId: string, id: string, tag: Tag): string {
  return `${userPrefix(userId)}${encodeURIComponent(id)}/${encodeURIComponent(tag)}`;
}

function logoPath(id: string, tag: Tag): string {
  const prev = tag.startsWith("prev-");
  const v = prev ? tag.slice(5) : tag;
  return `/api/loyalty_hub/logo/${encodeURIComponent(id)}?${prev ? "prev=1&" : ""}v=${encodeURIComponent(v)}`;
}

async function signedUrl(hass: HomeAssistant, id: string, tag: Tag): Promise<string> {
  return signPath(hass, logoPath(id, tag), SIGN_TTL_S);
}

/** Cache hit → object URL; miss → sign + fetch + store; any failure → plain signed URL. */
async function cachedUrl(hass: HomeAssistant, userId: string, id: string, tag: Tag): Promise<string> {
  const key = cacheKey(userId, id, tag);
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(key);
    if (hit) return URL.createObjectURL(await hit.blob());
  } catch {
    cache = null;
  }
  const signed = await signedUrl(hass, id, tag);
  if (!cache) return signed;
  try {
    const res = await fetch(signed, { credentials: "same-origin" });
    if (!res.ok) return signed;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return signed;
    const blob = await res.blob();
    await cache.put(key, new Response(blob, { headers: { "content-type": type } })).catch(() => undefined);
    return URL.createObjectURL(blob);
  } catch {
    return signed;
  }
}

export function logoUrl(hass: HomeAssistant, card: LogoRef): Promise<string> | null {
  const v = card.logo?.version;
  if (!card.logo || v === undefined) return null;
  return urlFor(hass, card.id, tagOf(v, false));
}

/** §14.2: URL of the previous logo (thumbnail of "Back to the previous logo"), or null. */
export function previousLogoUrl(hass: HomeAssistant, card: LogoRef): Promise<string> | null {
  const v = card.logo_previous?.version;
  if (!card.logo_previous || v === undefined) return null;
  return urlFor(hass, card.id, tagOf(v, true));
}

/** §14.2: `data:` URL of a logo/preview result (shown only in <img>; SVG scripts never run there). */
export function previewDataUrl(mime: string, dataBase64: string): string {
  const safeMime = /^image\/(png|jpeg|webp|gif|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(mime) ? mime : "image/png";
  return `data:${safeMime};base64,${dataBase64}`;
}

function urlFor(hass: HomeAssistant, id: string, tag: Tag): Promise<string> {
  const key = `${id}:${tag}`;
  const hit = urlCache.get(key);
  if (hit && hit.until > Date.now()) return hit.url;
  const userId = hass.user?.id;
  const persistent = cacheAvailable() && !!userId;
  const url = persistent ? cachedUrl(hass, userId!, id, tag) : signedUrl(hass, id, tag);
  // Object URLs never expire; signed URLs are refreshed a bit before their signature expires.
  urlCache.set(key, { url, until: persistent ? Number.POSITIVE_INFINITY : Date.now() + (SIGN_TTL_S - 600) * 1000 });
  url.then((u) => {
    if (!u.startsWith("blob:")) urlCache.set(key, { url, until: Date.now() + (SIGN_TTL_S - 600) * 1000 });
  }, () => urlCache.delete(key));
  return url;
}

/**
 * §12.9: after a full card list, drop cached logos of cards that are gone or have a new version.
 * `keep` = all refs still in use (visible cards + own trash entries). Best effort, silent.
 */
export async function pruneLogoCache(keep: LogoRef[], userId: string | undefined): Promise<void> {
  const wanted = new Set<string>();
  for (const r of keep) {
    if (r.logo) wanted.add(`${r.id}:${tagOf(r.logo.version, false)}`);
    if (r.logo_previous) wanted.add(`${r.id}:${tagOf(r.logo_previous.version, true)}`);
  }
  for (const [key, entry] of urlCache) {
    if (wanted.has(key)) continue;
    urlCache.delete(key);
    entry.url.then((u) => { if (u.startsWith("blob:")) URL.revokeObjectURL(u); }, () => undefined);
  }
  if (!cacheAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const all = `${location.origin}${KEY_PREFIX}`;
    const mine = userId ? userPrefix(userId) : null;
    for (const req of await cache.keys()) {
      if (!req.url.startsWith(all)) continue;
      if (!mine || !req.url.startsWith(mine)) {
        await cache.delete(req); // another HA user on this device (or an old key format)
        continue;
      }
      const [id, version] = req.url.slice(mine.length).split("/").map((s) => decodeURIComponent(s));
      if (!wanted.has(`${id}:${version}`)) await cache.delete(req);
    }
  } catch {
    /* ignore */
  }
}

/** Card (no trash list): only drop the logos cached for other HA users on this device. */
export async function dropOtherUsersLogos(userId: string | undefined): Promise<void> {
  if (!userId || !cacheAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    const all = `${location.origin}${KEY_PREFIX}`;
    const mine = userPrefix(userId);
    for (const req of await cache.keys()) {
      if (req.url.startsWith(all) && !req.url.startsWith(mine)) await cache.delete(req);
    }
  } catch {
    /* ignore */
  }
}

// ---- Image loading / resize ----
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

/**
 * Dominant color of an image, ignoring transparent and near-white pixels.
 * Returns #RRGGBB or null (e.g. all white, or tainted canvas).
 */
export function dominantColor(img: CanvasImageSource): string | null {
  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 128) continue;
      if (r > 235 && g > 235 && b > 235) continue;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (const bucket of buckets.values()) if (!best || bucket.n > best.n) best = bucket;
    if (!best || best.n < 8) return null;
    const hex = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, "0");
    return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`.toUpperCase();
  } catch {
    return null;
  }
}

// ---- §15.2: card background from a logo (one rule for cropper, editor and "Color from logos") ----
export const EDGE_UNIFORM_MIN = 0.6;
export const SINGLE_COLOR_COVERAGE = 0.5;
export type LogoBackgroundRule = "edge" | "contrast" | "dominant" | "none";

/**
 * 1) uniform opaque border → that color; 2) transparent border and the logo is mostly one color →
 * white / near-black (whichever contrasts more); 3) dominant color; 4) nothing usable → null.
 */
export function logoBackground(img: CanvasImageSource): { color: string | null; rule: LogoBackgroundRule } {
  try {
    const src = img as { naturalWidth?: number; naturalHeight?: number; width?: number | SVGAnimatedLength; height?: number | SVGAnimatedLength };
    const w0 = src.naturalWidth || (typeof src.width === "number" ? src.width : 0);
    const h0 = src.naturalHeight || (typeof src.height === "number" ? src.height : 0);
    if (!w0 || !h0) return { color: null, rule: "none" };
    const scale = Math.min(1, 128 / Math.max(w0, h0));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w0 * scale));
    canvas.height = Math.max(1, Math.round(h0 * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { color: null, rule: "none" };
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const edge = edgeColor(canvas);
    if (edge && edge.uniform >= EDGE_UNIFORM_MIN) return { color: rgbHex(edge.color), rule: "edge" };
    const dom = dominantColor(canvas);
    if (!dom) return { color: null, rule: "none" };
    if (!edge && colorCoverage(canvas, dom) > SINGLE_COLOR_COVERAGE) {
      return { color: wordmarkColor(dom) === "#FFFFFF" ? "#FFFFFF" : NEAR_BLACK, rule: "contrast" };
    }
    return { color: dom, rule: "dominant" };
  } catch {
    return { color: null, rule: "none" };
  }
}

// ---- Domain helpers ----
/** Suggests a domain from a shop name: "Coop" → "coop.it" (TLD from UI language). */
export function suggestDomain(name: string, lang: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  if (!slug) return "";
  const tld = lang.toLowerCase().startsWith("it") ? "it" : "com";
  return `${slug}.${tld}`;
}

/** Public hostname only: no scheme, IP, port or path (mirrors server validation, §8.1). */
export function isValidDomain(d: string): boolean {
  const s = d.trim().toLowerCase();
  if (!s || s.length > 253) return false;
  if (/^\d+(\.\d+){3}$/.test(s) || s.includes(":")) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1]) && !/^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) {
    return false;
  }
  return labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

// ---- WCAG contrast ----
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export const NEAR_BLACK = "#1A1A1A";

/** White or near-black, whichever has the higher WCAG contrast ratio on `bg` (#RRGGBB). */
export function wordmarkColor(bg: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(bg)) return "#FFFFFF";
  const l = luminance(bg);
  const vsWhite = 1.05 / (l + 0.05);
  const vsDark = (l + 0.05) / (luminance(NEAR_BLACK) + 0.05);
  return vsWhite >= vsDark ? "#FFFFFF" : NEAR_BLACK;
}
