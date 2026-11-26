import { LitElement, css, html, nothing } from "lit";
import { property, query, state } from "lit/decorators.js";
import {
  LOGO_MAX, PHOTO_RATIO, PHOTO_SIZE, contentBox, cropTo, edgeColor, encodeCapped, fitMax, loadOriented,
  removeBackground, rotate90, type Rect,
} from "../crop";
import type { Translate } from "../i18n";
import { EDGE_UNIFORM_MIN, logoBackground } from "../logo";
import { sharedStyles } from "../styles";
import type { Card, HomeAssistant, LogoFit } from "../types";
import { defineElement } from "../util";
import "./lh-card-tile";
import "./lh-dialog";

export type CropMode = "photo" | "logo";

export interface CropResult {
  base64: string;
  dataUrl: string;
  mime: string;
  fit: LogoFit;
  /** Proposed card color (#RRGGBB) or null. */
  color: string | null;
}

const MARGIN = 18;
const MIN_FRAME = 48;
const MAX_ZOOM = 8;
const HANDLE_HIT = 26;
const PREVIEW_MS = 110;

type Drag =
  | { type: "pan"; x: number; y: number }
  | { type: "resize"; l: boolean; r: boolean; t: boolean; b: boolean; x: number; y: number; frame: Rect }
  | { type: "pinch"; dist: number; mx: number; my: number };

/** Copy with a transparent margin: after trimming, the border pixels must not be logo pixels. */
function padTransparent(c: HTMLCanvasElement): HTMLCanvasElement {
  const m = Math.max(2, Math.round(Math.max(c.width, c.height) * 0.04));
  const out = document.createElement("canvas");
  out.width = c.width + 2 * m;
  out.height = c.height + 2 * m;
  out.getContext("2d")?.drawImage(c, m, m);
  return out;
}

/** Result of the "logo only" pipeline (§10.5): crop → trim uniform borders → optional background removal. */
function processLogo(crop: HTMLCanvasElement, removeBg: boolean, tol: number) {
  const edge = edgeColor(crop);
  const bg = edge && edge.uniform >= EDGE_UNIFORM_MIN ? edge.color : null;
  const box = contentBox(crop, bg);
  let out = box ? cropTo(crop, box, box.w, box.h) : crop;
  let removed = false;
  const key = bg ?? edge?.color ?? null;
  if (removeBg && key) {
    out = removeBackground(out, key, tol);
    removed = true;
    const box2 = contentBox(out, null);
    if (box2) out = cropTo(out, box2, box2.w, box2.h);
  }
  // §15.2 (logo.ts), one rule: uniform border → that color (measured before trimming); background
  // removed → transparent border, so a single-color logo gets white / near-black; else the dominant color.
  const { color } = logoBackground(removed ? padTransparent(out) : crop);
  return { canvas: out, color, uniformBg: !!bg };
}

/**
 * Photo → logo cropper dialog (§10.5). Modes: "photo" (fixed 1.586 frame → 1012×638, cover) and
 * "logo" (free frame → auto trim → optional background removal → max 512 with alpha, contain).
 * Drag to pan, wheel/pinch/slider to zoom, rotate 90°, live preview with the real tile.
 * Events: `cropped` {CropResult}, `closed`.
 */
export class LhImageCropper extends LitElement {
  @property({ attribute: false }) t!: Translate;
  @property({ attribute: false }) hass?: HomeAssistant;
  @property() language = "en";
  @property({ attribute: false }) file: Blob | null = null;
  /** Card used for the preview tile (name, color, badges). */
  @property({ attribute: false }) baseCard: Card | null = null;
  @state() private _mode: CropMode = "photo";
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _zoom = 0;
  @state() private _removeBg = false;
  @state() private _tolerance = 30;
  @state() private _previewSrc = "";
  @state() private _previewColor: string | null = null;
  @state() private _uniformBg = true;
  @state() private _busy = false;
  @state() private _interacting = false;
  @query("canvas") private _canvas?: HTMLCanvasElement;
  @query(".stage") private _stage?: HTMLDivElement;

  private _src: HTMLCanvasElement | null = null;
  private _s = 1;
  private _tx = 0;
  private _ty = 0;
  private _frame: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private _sw = 0;
  private _sh = 0;
  private _pointers = new Map<number, { x: number; y: number }>();
  private _drag: Drag | null = null;
  private _ro?: ResizeObserver;
  private _previewTimer?: number;
  private _raf = 0;
  private _loadedFile: Blob | null = null;

  static override styles = [sharedStyles, css`
    :host { display: contents; --lh-dialog-wide-width: min(96vw, 860px); }
    .seg {
      display: flex; padding: 3px; gap: 3px; border-radius: 22px; margin-bottom: 12px;
      background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
    }
    .seg button {
      flex: 1; min-height: 38px; border: none; border-radius: 19px; background: transparent; cursor: pointer;
      color: var(--secondary-text-color); font: inherit; font-weight: 500; display: inline-flex;
      align-items: center; justify-content: center; gap: 6px; padding: 0 8px;
      transition: background 0.15s, color 0.15s;
    }
    .seg button ha-icon { --mdc-icon-size: 18px; }
    @media (max-width: 420px) {
      .seg button { font-size: 0.9em; white-space: nowrap; }
      .seg button ha-icon { display: none; }
    }
    .seg button[aria-pressed="true"] {
      background: var(--card-background-color, #fff); color: var(--primary-text-color);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
    }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .stage {
      position: relative; height: clamp(220px, 42vh, 420px); border-radius: 14px; overflow: hidden;
      background: var(--lh-cropper-stage, #15171c);
      background-image:
        linear-gradient(45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.04) 75%),
        linear-gradient(45deg, rgba(255, 255, 255, 0.04) 25%, transparent 25%, transparent 75%, rgba(255, 255, 255, 0.04) 75%);
      background-size: 20px 20px; background-position: 0 0, 10px 10px;
    }
    canvas {
      position: absolute; inset: 0; width: 100%; height: 100%; display: block;
      touch-action: none; cursor: grab; outline: none;
    }
    canvas.dragging { cursor: grabbing; }
    canvas:focus-visible { box-shadow: inset 0 0 0 3px var(--primary-color); }
    .stage .msg {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: rgba(255, 255, 255, 0.8); text-align: center; padding: 16px;
    }
    .gesture {
      position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); pointer-events: none;
      background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 0.78em; padding: 4px 10px; border-radius: 12px;
      white-space: nowrap; transition: opacity 0.2s;
    }
    .gesture.hide { opacity: 0; }
    .tools { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
    .tools input[type="range"] { flex: 1; min-width: 60px; accent-color: var(--primary-color); height: 32px; }
    .tools .icon-btn { width: 40px; height: 40px; color: var(--secondary-text-color); }
    .tools .icon-btn:hover { color: var(--primary-text-color); }
    .side { display: flex; gap: 14px; align-items: flex-start; }
    .preview { flex: 0 0 min(44%, 210px); margin: 0; }
    .preview figcaption { font-size: 0.78em; color: var(--secondary-text-color); margin-top: 6px; text-align: center; }
    .opts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .opts .check { min-height: 36px; }
    .opts .hint { margin: 0; }
    .tol { display: flex; flex-direction: column; gap: 2px; }
    .tol input { width: 100%; accent-color: var(--primary-color); }
    .swatch {
      display: inline-block; width: 14px; height: 14px; border-radius: 50%; vertical-align: -2px; margin-right: 4px;
      box-shadow: 0 0 0 1px var(--divider-color);
    }
    @media (min-width: 760px) {
      .layout { grid-template-columns: minmax(0, 1fr) 230px; }
      .stage { height: min(58vh, 460px); }
      .side { flex-direction: column; }
      .preview { flex: none; width: 100%; }
    }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    if (this._stage) this._observe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._ro?.disconnect();
    clearTimeout(this._previewTimer);
    cancelAnimationFrame(this._raf);
  }

  protected override firstUpdated(): void {
    this._observe();
    this._canvas?.addEventListener("wheel", this._onWheel, { passive: false });
  }

  private _observe() {
    if (!this._stage || typeof ResizeObserver === "undefined") return;
    this._ro?.disconnect();
    this._ro = new ResizeObserver(() => this._onStageResize());
    this._ro.observe(this._stage);
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("file") && this.file !== this._loadedFile) {
      this._loadedFile = this.file;
      if (this.file) this._load(this.file);
      else this._src = null;
    }
  }

  private async _load(file: Blob) {
    this._loading = true;
    this._error = "";
    this._previewSrc = "";
    this._previewColor = null;
    this._removeBg = false;
    this._src = null;
    this._draw();
    try {
      const src = await loadOriented(file);
      if (file !== this.file) return;
      this._src = src;
      const jpeg = /jpe?g|heic|heif/i.test(file.type || "");
      this._mode = jpeg && Math.min(src.width, src.height) >= 480 ? "photo" : "logo";
    } catch {
      this._error = this.t("logo_image_error");
      this._src = null;
    } finally {
      this._loading = false;
    }
    await this.updateComplete;
    // Measure now too: ResizeObserver may not have fired yet (dialog just opened).
    this._onStageResize();
    this._layout();
    this._draw();
  }

  // ---------- geometry ----------
  private get _iw() { return this._src?.width ?? 1; }
  private get _ih() { return this._src?.height ?? 1; }
  private get _minS() { return Math.max(this._frame.w / this._iw, this._frame.h / this._ih); }

  /** Source-pixel rectangle currently inside the frame. */
  private _sourceRect(): Rect {
    const s = this._s;
    const x = Math.max(0, (this._frame.x - this._tx) / s);
    const y = Math.max(0, (this._frame.y - this._ty) / s);
    return { x, y, w: Math.min(this._iw - x, this._frame.w / s), h: Math.min(this._ih - y, this._frame.h / s) };
  }

  /** Fits a frame with aspect `ratio` centered in the stage. */
  private _fitFrame(ratio: number): Rect {
    const aw = Math.max(1, this._sw - MARGIN * 2);
    const ah = Math.max(1, this._sh - MARGIN * 2);
    let w = aw;
    let h = w / ratio;
    if (h > ah) { h = ah; w = h * ratio; }
    return { x: (this._sw - w) / 2, y: (this._sh - h) / 2, w, h };
  }

  /** Shows the given source rectangle in the frame (frame re-fitted to the stage). */
  private _show(rect: Rect) {
    const ratio = this._mode === "photo" ? PHOTO_RATIO : Math.min(5, Math.max(0.25, rect.w / rect.h));
    this._frame = this._fitFrame(ratio);
    this._s = Math.max(this._frame.w / rect.w, this._frame.h / rect.h);
    this._tx = this._frame.x - rect.x * this._s + (this._frame.w - rect.w * this._s) / 2;
    this._ty = this._frame.y - rect.y * this._s + (this._frame.h - rect.h * this._s) / 2;
    this._clamp();
    this._afterChange();
  }

  /** Default framing for the current mode: whole image (logo) or centered cover crop (photo). */
  private _layout() {
    if (!this._src || !this._sw) return;
    this._show({ x: 0, y: 0, w: this._iw, h: this._ih });
  }

  private _onStageResize() {
    const st = this._stage;
    if (!st) return;
    const w = st.clientWidth;
    const h = st.clientHeight;
    if (!w || !h || (w === this._sw && h === this._sh)) return;
    const keep = this._src && this._sw ? this._sourceRect() : null;
    this._sw = w;
    this._sh = h;
    const c = this._canvas;
    if (c) {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (keep) this._show(keep);
    else this._layout();
    this._draw();
  }

  private _clamp() {
    const f = this._frame;
    this._s = Math.min(Math.max(this._s, this._minS), this._minS * MAX_ZOOM);
    const w = this._iw * this._s;
    const h = this._ih * this._s;
    this._tx = Math.min(f.x, Math.max(f.x + f.w - w, this._tx));
    this._ty = Math.min(f.y, Math.max(f.y + f.h - h, this._ty));
  }

  private _zoomAt(px: number, py: number, s: number) {
    const ns = Math.min(Math.max(s, this._minS), this._minS * MAX_ZOOM);
    this._tx = px - ((px - this._tx) * ns) / this._s;
    this._ty = py - ((py - this._ty) * ns) / this._s;
    this._s = ns;
    this._clamp();
  }

  private _afterChange() {
    this._zoom = Math.log(this._s / this._minS) / Math.log(MAX_ZOOM);
    this._scheduleDraw();
    this._schedulePreview();
  }

  // ---------- drawing ----------
  private _scheduleDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  private _draw() {
    const c = this._canvas;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = c.width / Math.max(1, this._sw);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this._src) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this._src, this._tx, this._ty, this._iw * this._s, this._ih * this._s);
    const f = this._frame;
    const radius = this._mode === "photo" ? f.w * 0.045 : 4;
    // Dim outside the frame.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this._sw, this._sh);
    this._roundRect(ctx, f, radius);
    ctx.fillStyle = "rgba(10, 12, 16, 0.62)";
    ctx.fill("evenodd");
    ctx.restore();
    // Rule of thirds while interacting.
    if (this._interacting) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(f.x + (f.w * i) / 3, f.y);
        ctx.lineTo(f.x + (f.w * i) / 3, f.y + f.h);
        ctx.moveTo(f.x, f.y + (f.h * i) / 3);
        ctx.lineTo(f.x + f.w, f.y + (f.h * i) / 3);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    this._roundRect(ctx, f, radius);
    ctx.stroke();
    if (this._mode === "logo") {
      // Corner handles (L shapes) + edge ticks.
      const L = Math.min(22, f.w / 3, f.h / 3);
      ctx.lineWidth = 4;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      const corners: [number, number, number, number][] = [
        [f.x, f.y, 1, 1], [f.x + f.w, f.y, -1, 1], [f.x, f.y + f.h, 1, -1], [f.x + f.w, f.y + f.h, -1, -1],
      ];
      for (const [x, y, dx, dy] of corners) {
        ctx.moveTo(x, y + dy * L);
        ctx.lineTo(x, y);
        ctx.lineTo(x + dx * L, y);
      }
      const mx = f.x + f.w / 2;
      const my = f.y + f.h / 2;
      const T = Math.min(10, f.w / 6, f.h / 6);
      ctx.moveTo(mx - T, f.y); ctx.lineTo(mx + T, f.y);
      ctx.moveTo(mx - T, f.y + f.h); ctx.lineTo(mx + T, f.y + f.h);
      ctx.moveTo(f.x, my - T); ctx.lineTo(f.x, my + T);
      ctx.moveTo(f.x + f.w, my - T); ctx.lineTo(f.x + f.w, my + T);
      ctx.stroke();
    }
  }

  private _roundRect(ctx: CanvasRenderingContext2D, f: Rect, r: number) {
    const rr = Math.min(r, f.w / 2, f.h / 2);
    ctx.moveTo(f.x + rr, f.y);
    ctx.arcTo(f.x + f.w, f.y, f.x + f.w, f.y + f.h, rr);
    ctx.arcTo(f.x + f.w, f.y + f.h, f.x, f.y + f.h, rr);
    ctx.arcTo(f.x, f.y + f.h, f.x, f.y, rr);
    ctx.arcTo(f.x, f.y, f.x + f.w, f.y, rr);
    ctx.closePath();
  }

  // ---------- pointer interaction ----------
  private _pos(e: PointerEvent | WheelEvent) {
    const r = this._canvas!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private _hitHandle(x: number, y: number) {
    if (this._mode !== "logo") return null;
    const f = this._frame;
    const inY = y > f.y - HANDLE_HIT && y < f.y + f.h + HANDLE_HIT;
    const inX = x > f.x - HANDLE_HIT && x < f.x + f.w + HANDLE_HIT;
    const l = inY && Math.abs(x - f.x) < HANDLE_HIT;
    const r = inY && !l && Math.abs(x - (f.x + f.w)) < HANDLE_HIT;
    const t = inX && Math.abs(y - f.y) < HANDLE_HIT;
    const b = inX && !t && Math.abs(y - (f.y + f.h)) < HANDLE_HIT;
    return l || r || t || b ? { l, r, t, b } : null;
  }

  private _pinchInfo() {
    const [a, b] = [...this._pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private _onDown = (e: PointerEvent) => {
    if (!this._src) return;
    e.preventDefault();
    this._canvas!.setPointerCapture?.(e.pointerId);
    this._canvas!.focus({ preventScroll: true });
    const p = this._pos(e);
    this._pointers.set(e.pointerId, p);
    this._interacting = true;
    if (this._pointers.size === 2) {
      this._drag = { type: "pinch", ...this._pinchInfo() };
    } else if (this._pointers.size === 1) {
      const h = this._hitHandle(p.x, p.y);
      this._drag = h ? { type: "resize", ...h, x: p.x, y: p.y, frame: { ...this._frame } } : { type: "pan", ...p };
    }
    this._scheduleDraw();
  };

  private _onMove = (e: PointerEvent) => {
    if (!this._pointers.has(e.pointerId)) {
      // Hover: resize cursor on the handles.
      if (this._canvas && this._mode === "logo") {
        const p = this._pos(e);
        const h = this._hitHandle(p.x, p.y);
        this._canvas.style.cursor = !h ? "" : (h.l || h.r) && (h.t || h.b)
          ? ((h.l && h.t) || (h.r && h.b) ? "nwse-resize" : "nesw-resize")
          : h.l || h.r ? "ew-resize" : "ns-resize";
      }
      return;
    }
    const p = this._pos(e);
    this._pointers.set(e.pointerId, p);
    const d = this._drag;
    if (!d) return;
    if (d.type === "pinch" && this._pointers.size >= 2) {
      const now = this._pinchInfo();
      this._zoomAt(now.mx, now.my, (this._s * now.dist) / d.dist);
      this._tx += now.mx - d.mx;
      this._ty += now.my - d.my;
      this._clamp();
      this._drag = { type: "pinch", ...now };
    } else if (d.type === "pan") {
      this._tx += p.x - d.x;
      this._ty += p.y - d.y;
      this._clamp();
      this._drag = { type: "pan", ...p };
    } else if (d.type === "resize") {
      this._resizeFrame(d, p.x - d.x, p.y - d.y);
    }
    this._afterChange();
  };

  private _resizeFrame(d: Extract<Drag, { type: "resize" }>, dx: number, dy: number) {
    const f0 = d.frame;
    const minX = Math.max(MARGIN / 2, this._tx);
    const minY = Math.max(MARGIN / 2, this._ty);
    const maxX = Math.min(this._sw - MARGIN / 2, this._tx + this._iw * this._s);
    const maxY = Math.min(this._sh - MARGIN / 2, this._ty + this._ih * this._s);
    let x0 = f0.x;
    let y0 = f0.y;
    let x1 = f0.x + f0.w;
    let y1 = f0.y + f0.h;
    if (d.l) x0 = Math.min(Math.max(minX, f0.x + dx), x1 - MIN_FRAME);
    if (d.r) x1 = Math.max(Math.min(maxX, x1 + dx), x0 + MIN_FRAME);
    if (d.t) y0 = Math.min(Math.max(minY, f0.y + dy), y1 - MIN_FRAME);
    if (d.b) y1 = Math.max(Math.min(maxY, y1 + dy), y0 + MIN_FRAME);
    this._frame = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this._clamp();
  }

  private _onUp = (e: PointerEvent) => {
    if (!this._pointers.delete(e.pointerId)) return;
    if (this._pointers.size === 1) {
      const [p] = [...this._pointers.values()];
      this._drag = { type: "pan", ...p };
      return;
    }
    if (this._pointers.size === 0) {
      this._drag = null;
      this._interacting = false;
      this._scheduleDraw();
      this._schedulePreview(true);
    }
  };

  private _onWheel = (e: WheelEvent) => {
    if (!this._src) return;
    e.preventDefault();
    const p = this._pos(e);
    const k = Math.exp(-Math.max(-120, Math.min(120, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * 0.0022);
    this._zoomAt(p.x, p.y, this._s * k);
    this._afterChange();
  };

  private _onKey = (e: KeyboardEvent) => {
    if (!this._src) return;
    const step = e.shiftKey ? 40 : 10;
    const f = this._frame;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    switch (e.key) {
      case "ArrowLeft": this._tx += step; break;
      case "ArrowRight": this._tx -= step; break;
      case "ArrowUp": this._ty += step; break;
      case "ArrowDown": this._ty -= step; break;
      case "+": case "=": this._zoomAt(cx, cy, this._s * 1.12); break;
      case "-": this._zoomAt(cx, cy, this._s / 1.12); break;
      default: return;
    }
    e.preventDefault();
    this._clamp();
    this._afterChange();
  };

  private _onSlider(v: number) {
    const f = this._frame;
    this._zoomAt(f.x + f.w / 2, f.y + f.h / 2, this._minS * MAX_ZOOM ** v);
    this._afterChange();
  }

  private _zoomStep(dir: 1 | -1) {
    const f = this._frame;
    this._zoomAt(f.x + f.w / 2, f.y + f.h / 2, this._s * (dir > 0 ? 1.25 : 0.8));
    this._afterChange();
  }

  private _rotate() {
    if (!this._src) return;
    // Keep the crop: rotate the source rectangle too (90° clockwise: (x,y) → (H - y - h, x)).
    const r = this._sourceRect();
    const H = this._ih;
    this._src = rotate90(this._src);
    const rotated = { x: H - r.y - r.h, y: r.x, w: r.h, h: r.w };
    this._show(this._mode === "photo" ? { x: 0, y: 0, w: this._iw, h: this._ih } : rotated);
  }

  private _setMode(m: CropMode) {
    if (m === this._mode) return;
    this._mode = m;
    this._previewSrc = "";
    this._layout();
  }

  private _reset() {
    this._layout();
  }

  // ---------- preview & output ----------
  private _schedulePreview(now = false) {
    clearTimeout(this._previewTimer);
    // While dragging, only refresh the (cheap) photo preview; the logo pipeline runs on release.
    if (this._drag && this._mode === "logo" && !now) return;
    this._previewTimer = window.setTimeout(() => this._renderPreview(), now ? 0 : PREVIEW_MS);
  }

  private _renderPreview() {
    if (!this._src) return;
    const rect = this._sourceRect();
    try {
      if (this._mode === "photo") {
        const c = cropTo(this._src, rect, PHOTO_SIZE.w / 2, PHOTO_SIZE.h / 2);
        this._previewSrc = c.toDataURL("image/jpeg", 0.82);
        this._previewColor = logoBackground(c).color;
      } else {
        const k = Math.min(1, 480 / Math.max(rect.w, rect.h));
        const crop = cropTo(this._src, rect, rect.w * k, rect.h * k);
        const res = processLogo(crop, this._removeBg, this._tolerance);
        this._uniformBg = res.uniformBg;
        this._previewSrc = res.canvas.toDataURL("image/png");
        this._previewColor = res.color;
      }
    } catch {
      this._previewSrc = "";
    }
  }

  private async _confirm() {
    if (!this._src) return;
    this._busy = true;
    await new Promise((r) => setTimeout(r, 20)); // let the button state paint
    try {
      const rect = this._sourceRect();
      let result: CropResult;
      if (this._mode === "photo") {
        const c = cropTo(this._src, rect, PHOTO_SIZE.w, PHOTO_SIZE.h);
        const enc = encodeCapped(c, "photo");
        result = { ...enc, fit: "cover", color: logoBackground(c).color };
      } else {
        const k = Math.min(1, 1024 / Math.max(rect.w, rect.h));
        const crop = cropTo(this._src, rect, rect.w * k, rect.h * k);
        const res = processLogo(crop, this._removeBg, this._tolerance);
        const enc = encodeCapped(fitMax(res.canvas, LOGO_MAX), "logo");
        result = { ...enc, fit: "contain", color: res.color };
      }
      this.dispatchEvent(new CustomEvent<CropResult>("cropped", { detail: result }));
    } catch {
      this._error = this.t("logo_image_error");
    } finally {
      this._busy = false;
    }
  }

  private _close() {
    this.dispatchEvent(new CustomEvent("closed"));
  }

  private _previewCard(): Card {
    const base = this.baseCard ?? ({
      id: "preview", owner_id: "", transactions: [], balance: null, use_count: 0, last_used: null,
      created_at: "", updated_at: "", name: "?", kind: "card", visibility: "private", favorite: false,
    } as unknown as Card);
    return {
      ...base,
      color: this._previewColor ?? base.color,
      logo_fit: this._mode === "photo" ? "cover" : "contain",
    } as Card;
  }

  protected override updated(changed: Map<string, unknown>): void {
    if (changed.has("_mode") || changed.has("_interacting")) this._scheduleDraw();
    if (changed.has("_removeBg") || changed.has("_tolerance")) this._schedulePreview(true);
  }

  protected override render() {
    const t = this.t;
    if (!t) return nothing;
    const open = !!this.file;
    const photo = this._mode === "photo";
    const ready = !!this._src && !this._loading;
    return html`
      <lh-dialog wide .open=${open} heading=${t("crop_title")} close-label=${t("close")} @closed=${this._close}>
        <div class="seg" role="radiogroup" aria-label=${t("crop_mode")}>
          <button type="button" role="radio" aria-pressed=${photo} aria-checked=${photo}
            @click=${() => this._setMode("photo")}><ha-icon icon="mdi:card-account-details-outline"></ha-icon>
            ${t("crop_mode_photo")}</button>
          <button type="button" role="radio" aria-pressed=${!photo} aria-checked=${!photo}
            @click=${() => this._setMode("logo")}><ha-icon icon="mdi:crop-free"></ha-icon>${t("crop_mode_logo")}</button>
        </div>
        <div class="layout">
          <div>
            <div class="stage">
              <canvas tabindex="0" class=${this._interacting ? "dragging" : ""} aria-label=${t("crop_area")}
                @pointerdown=${this._onDown} @pointermove=${this._onMove} @pointerup=${this._onUp}
                @pointercancel=${this._onUp} @lostpointercapture=${this._onUp} @keydown=${this._onKey}></canvas>
              ${this._loading ? html`<div class="msg">${t("loading")}</div>` : nothing}
              ${this._error && !this._src ? html`<div class="msg">${this._error}</div>` : nothing}
              ${ready ? html`<div class="gesture ${this._interacting ? "hide" : ""}">
                ${photo ? t("crop_gesture_photo") : t("crop_gesture_logo")}</div>` : nothing}
            </div>
            <div class="tools">
              <button type="button" class="icon-btn" ?disabled=${!ready} title=${t("crop_zoom_out")}
                aria-label=${t("crop_zoom_out")} @click=${() => this._zoomStep(-1)}>
                <ha-icon icon="mdi:magnify-minus-outline"></ha-icon></button>
              <input type="range" min="0" max="1" step="0.001" .value=${String(this._zoom)} ?disabled=${!ready}
                aria-label=${t("crop_zoom")}
                @input=${(e: Event) => this._onSlider(Number((e.target as HTMLInputElement).value))}
                @change=${() => this._schedulePreview(true)} />
              <button type="button" class="icon-btn" ?disabled=${!ready} title=${t("crop_zoom_in")}
                aria-label=${t("crop_zoom_in")} @click=${() => this._zoomStep(1)}>
                <ha-icon icon="mdi:magnify-plus-outline"></ha-icon></button>
              <button type="button" class="icon-btn" ?disabled=${!ready} title=${t("crop_rotate")}
                aria-label=${t("crop_rotate")} @click=${this._rotate}><ha-icon icon="mdi:rotate-right"></ha-icon></button>
              <button type="button" class="icon-btn" ?disabled=${!ready} title=${t("crop_reset")}
                aria-label=${t("crop_reset")} @click=${this._reset}><ha-icon icon="mdi:backup-restore"></ha-icon></button>
            </div>
          </div>
          <div class="side">
            <figure class="preview">
              <lh-card-tile layout="large" .card=${this._previewCard()} .hass=${this.hass} .t=${t}
                language=${this.language} .logoSrc=${this._previewSrc}></lh-card-tile>
              <figcaption>${t("preview")}</figcaption>
            </figure>
            <div class="opts">
              ${photo ? html`<p class="hint">${t("crop_photo_hint")}</p>` : html`
                <p class="hint">${t("crop_logo_hint")}</p>
                <label class="check"><input type="checkbox" .checked=${this._removeBg} ?disabled=${!ready}
                  @change=${(e: Event) => { this._removeBg = (e.target as HTMLInputElement).checked; }} />
                  ${t("crop_remove_bg")}</label>
                ${this._removeBg ? html`<label class="tol"><span class="hint">${t("crop_tolerance")}</span>
                  <input type="range" min="4" max="90" step="1" .value=${String(this._tolerance)}
                    @input=${(e: Event) => { this._tolerance = Number((e.target as HTMLInputElement).value); }} />
                </label>
                ${this._uniformBg ? nothing : html`<p class="hint">${t("crop_bg_not_uniform")}</p>`}` : nothing}
              `}
              ${this._previewColor ? html`<p class="hint"><span class="swatch"
                style="background:${this._previewColor}"></span>${t("crop_color_hint")}</p>` : nothing}
              ${this._error && this._src ? html`<p class="error-text">${this._error}</p>` : nothing}
            </div>
          </div>
        </div>
        <button slot="actions" class="btn" @click=${this._close}>${t("cancel")}</button>
        <button slot="actions" class="btn primary" ?disabled=${!ready || this._busy} @click=${this._confirm}>
          <ha-icon icon="mdi:check"></ha-icon>${this._busy ? t("loading") : t("crop_use")}</button>
      </lh-dialog>
    `;
  }
}

defineElement("lh-image-cropper", LhImageCropper);

declare global {
  interface HTMLElementTagNameMap { "lh-image-cropper": LhImageCropper }
}
