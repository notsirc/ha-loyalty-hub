// Image tools for the logo cropper (docs/ARCHITETTURA.md §10.5): EXIF-aware loading, rotation,
// border trimming, background removal, edge color and size-capped encoding. Canvas only, no network.
import { loadImage } from "./logo";

/** Largest side kept in memory while cropping (camera photos can be 4000+ px). */
const WORK_MAX = 2048;
/** Server limit is 512 KB on disk; stay safely below it. */
export const MAX_OUTPUT_BYTES = 500 * 1024;
export const PHOTO_SIZE = { w: 1012, h: 638 };
export const PHOTO_RATIO = 1.586;
export const LOGO_MAX = 512;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return ctx;
}

/**
 * Decodes a file with its EXIF orientation applied, downscaled to WORK_MAX.
 * `createImageBitmap(..., {imageOrientation: "from-image"})` where available, else <img>
 * (modern browsers apply EXIF orientation to <img> by default).
 */
export async function loadOriented(file: Blob): Promise<HTMLCanvasElement> {
  let source: ImageBitmap | HTMLImageElement | null = null;
  let w = 0;
  let h = 0;
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      source = bmp;
      w = bmp.width;
      h = bmp.height;
    } catch {
      source = null;
    }
  }
  let url = "";
  if (!source) {
    url = URL.createObjectURL(file);
    const img = await loadImage(url);
    source = img;
    w = img.naturalWidth;
    h = img.naturalHeight;
  }
  try {
    if (!w || !h) throw new Error("empty image");
    const k = Math.min(1, WORK_MAX / Math.max(w, h));
    const c = makeCanvas(w * k, h * k);
    ctx2d(c).drawImage(source, 0, 0, c.width, c.height);
    return c;
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (source && "close" in source) source.close();
  }
}

/** Rotates 90° clockwise. */
export function rotate90(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.height, src.width);
  const ctx = ctx2d(c);
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(src, 0, 0);
  return c;
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Copies `rect` (source px) of `src` into a new canvas of size outW×outH. */
export function cropTo(src: HTMLCanvasElement, rect: Rect, outW: number, outH: number): HTMLCanvasElement {
  const c = makeCanvas(outW, outH);
  ctx2d(c).drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return c;
}

type RGB = [number, number, number];

const dist = (d: Uint8ClampedArray, i: number, c: RGB) =>
  Math.max(Math.abs(d[i] - c[0]), Math.abs(d[i + 1] - c[1]), Math.abs(d[i + 2] - c[2]));

/**
 * Background color estimated from the border pixels (per-channel median of opaque pixels) and how
 * uniform the border is (share of border pixels within 24 levels of it). null if the border is transparent.
 */
export function edgeColor(c: HTMLCanvasElement): { color: RGB; uniform: number } | null {
  const { width: w, height: h } = c;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const idx: number[] = [];
  const step = Math.max(1, Math.floor((w + h) / 400));
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (d[i + 3] < 200) return;
    rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); idx.push(i);
  };
  for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
  if (idx.length < 8) return null;
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const color: RGB = [med(rs), med(gs), med(bs)];
  const near = idx.filter((i) => dist(d, i, color) <= 24).length;
  return { color, uniform: near / idx.length };
}

export const rgbHex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/**
 * Bounding box of the content: drops outer rows/columns that are transparent or within `tol`
 * of the border color. Returns null when nothing would be trimmed.
 */
export function contentBox(c: HTMLCanvasElement, bg: RGB | null, tol = 22): Rect | null {
  const { width: w, height: h } = c;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const isBg = (i: number) => d[i + 3] < 16 || (bg !== null && dist(d, i, bg) <= tol);
  // A row/column counts as background if (almost) all its pixels are: tolerates noise/JPEG artefacts.
  const rowBg = (y: number) => {
    let n = 0;
    for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) n++;
    return n <= Math.max(1, w * 0.004);
  };
  const colBg = (x: number, y0: number, y1: number) => {
    let n = 0;
    for (let y = y0; y <= y1; y++) if (!isBg((y * w + x) * 4)) n++;
    return n <= Math.max(1, (y1 - y0 + 1) * 0.004);
  };
  let top = 0;
  while (top < h - 1 && rowBg(top)) top++;
  let bottom = h - 1;
  while (bottom > top && rowBg(bottom)) bottom--;
  let left = 0;
  while (left < w - 1 && colBg(left, top, bottom)) left++;
  let right = w - 1;
  while (right > left && colBg(right, top, bottom)) right--;
  if (top >= bottom || left >= right) return null; // all background: keep everything
  // Keep a hairline margin so anti-aliased edges are not cut.
  const m = Math.round(Math.max(w, h) * 0.01);
  const box = {
    x: Math.max(0, left - m), y: Math.max(0, top - m),
    w: Math.min(w, right + m + 1) - Math.max(0, left - m), h: Math.min(h, bottom + m + 1) - Math.max(0, top - m),
  };
  return box.w === w && box.h === h ? null : box;
}

/**
 * Background removal: flood fill from every border pixel within `tol` of `bg` → transparent.
 * Pixels next to the removed area that are close to `bg` get partial alpha (soft edges).
 */
export function removeBackground(c: HTMLCanvasElement, bg: RGB, tol: number): HTMLCanvasElement {
  const { width: w, height: h } = c;
  const out = makeCanvas(w, h);
  const ctx = ctx2d(out);
  ctx.drawImage(c, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (p: number) => {
    if (seen[p]) return;
    const i = p * 4;
    if (d[i + 3] < 16 || dist(d, i, bg) <= tol) {
      seen[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!;
    d[p * 4 + 3] = 0;
    const x = p % w;
    if (x > 0) tryPush(p - 1);
    if (x < w - 1) tryPush(p + 1);
    if (p >= w) tryPush(p - w);
    if (p < w * (h - 1)) tryPush(p + w);
  }
  // Soft edge: one ring of neighbours, alpha by distance from the background color.
  const soft = tol * 2 + 8;
  for (let p = 0; p < w * h; p++) {
    if (seen[p]) continue;
    const x = p % w;
    const nb = (x > 0 && seen[p - 1]) || (x < w - 1 && seen[p + 1]) || (p >= w && seen[p - w])
      || (p < w * (h - 1) && seen[p + w]);
    if (!nb) continue;
    const i = p * 4;
    const k = dist(d, i, bg);
    if (k < soft) d[i + 3] = Math.round(d[i + 3] * Math.max(0, (k - tol) / (soft - tol)));
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Scales down so that the long side is at most `max`. */
export function fitMax(c: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(c.width, c.height));
  if (k >= 1) return c;
  // Two-step downscale for large ratios keeps edges crisp.
  let cur = c;
  while (Math.max(cur.width, cur.height) * 0.5 > max) {
    const half = makeCanvas(cur.width / 2, cur.height / 2);
    ctx2d(half).drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = makeCanvas(c.width * k, c.height * k);
  ctx2d(out).drawImage(cur, 0, 0, out.width, out.height);
  return out;
}

export function hasAlpha(c: HTMLCanvasElement): boolean {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] < 250) return true;
  return false;
}

export interface Encoded { base64: string; dataUrl: string; mime: string; bytes: number }

const decodedBytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

function encode(c: HTMLCanvasElement, mime: string, q?: number): Encoded | null {
  const dataUrl = q === undefined ? c.toDataURL(mime) : c.toDataURL(mime, q);
  if (!dataUrl.startsWith(`data:${mime}`)) return null; // format not supported → browser fell back to PNG
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, dataUrl, mime, bytes: decodedBytes(base64) };
}

/**
 * Encodes under MAX_OUTPUT_BYTES. Photo: WebP 0.9 → JPEG 0.9, lowering quality step by step.
 * Logo with alpha: WebP (alpha) → PNG; if still too big, lossy WebP steps then downscale.
 */
export function encodeCapped(c: HTMLCanvasElement, kind: "photo" | "logo"): Encoded {
  const qualities = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42];
  let cur = c;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (kind === "logo") {
      const png = encode(cur, "image/png");
      const webp = encode(cur, "image/webp", 0.92);
      const best = [webp, png].filter((e): e is Encoded => !!e).sort((a, b) => a.bytes - b.bytes)[0];
      if (best && best.bytes <= MAX_OUTPUT_BYTES) return best;
    }
    const mime = encode(cur, "image/webp", 0.9) ? "image/webp" : kind === "logo" ? "image/png" : "image/jpeg";
    if (mime === "image/png") {
      const png = encode(cur, mime)!;
      if (png.bytes <= MAX_OUTPUT_BYTES) return png;
    } else {
      for (const q of qualities) {
        const e = encode(cur, mime, q);
        if (e && e.bytes <= MAX_OUTPUT_BYTES) return e;
      }
    }
    cur = fitMax(cur, Math.max(cur.width, cur.height) * 0.75);
  }
  return encode(cur, "image/jpeg", 0.4) ?? encode(cur, "image/png")!;
}

/** Share (0..1) of the opaque pixels within 48 levels of `hex`: how much of the logo is that color. */
export function colorCoverage(c: HTMLCanvasElement, hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const col: RGB = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  let near = 0;
  for (let i = 0; i < d.length; i += 16) {
    if (d[i + 3] < 128) continue;
    opaque++;
    if (dist(d, i, col) <= 48) near++;
  }
  return opaque ? near / opaque : 0;
}
