// Barcode rendering with bwip-js (browser build), always black on white with a quiet zone.
import {
  azteccode, code128, code39, code93, datamatrix, ean13, ean8, interleaved2of5, pdf417, qrcode,
  rationalizedCodabar, upca, upce,
} from "bwip-js/browser";
import type { RenderOptions } from "bwip-js/browser";
import type { BarcodeFormat } from "./types";

type Encoder = (canvas: HTMLCanvasElement, opts: RenderOptions) => HTMLCanvasElement;

const ENCODERS: Record<BarcodeFormat, { bcid: string; fn: Encoder; twoD: boolean }> = {
  CODE_128: { bcid: "code128", fn: code128 as Encoder, twoD: false },
  CODE_39: { bcid: "code39", fn: code39 as Encoder, twoD: false },
  CODE_93: { bcid: "code93", fn: code93 as Encoder, twoD: false },
  CODABAR: { bcid: "rationalizedCodabar", fn: rationalizedCodabar as Encoder, twoD: false },
  EAN_13: { bcid: "ean13", fn: ean13 as Encoder, twoD: false },
  EAN_8: { bcid: "ean8", fn: ean8 as Encoder, twoD: false },
  UPC_A: { bcid: "upca", fn: upca as Encoder, twoD: false },
  UPC_E: { bcid: "upce", fn: upce as Encoder, twoD: false },
  ITF: { bcid: "interleaved2of5", fn: interleaved2of5 as Encoder, twoD: false },
  QR_CODE: { bcid: "qrcode", fn: qrcode as Encoder, twoD: true },
  AZTEC: { bcid: "azteccode", fn: azteccode as Encoder, twoD: true },
  DATA_MATRIX: { bcid: "datamatrix", fn: datamatrix as Encoder, twoD: true },
  PDF_417: { bcid: "pdf417", fn: pdf417 as Encoder, twoD: false },
};

export const FORMAT_LABELS: Record<BarcodeFormat, string> = {
  CODE_128: "Code 128", CODE_39: "Code 39", CODE_93: "Code 93", CODABAR: "Codabar",
  EAN_13: "EAN-13", EAN_8: "EAN-8", UPC_A: "UPC-A", UPC_E: "UPC-E", ITF: "ITF",
  QR_CODE: "QR Code", AZTEC: "Aztec", DATA_MATRIX: "Data Matrix", PDF_417: "PDF417",
};

export const is2D = (f: BarcodeFormat) => ENCODERS[f]?.twoD ?? false;

/** Adapts stored codes to what bwip-js expects for a given symbology. */
function prepareText(format: BarcodeFormat, code: string): string {
  const c = code.trim();
  if (format === "CODABAR" && !/^[A-D].*[A-D]$/i.test(c)) return `A${c}A`;
  if (format === "UPC_E" && /^\d{6}$/.test(c)) return `0${c}`;
  return c;
}

/**
 * Renders `code` into `canvas`. Throws if the code is not valid for the format.
 * `scale` is the pixel size of one module.
 */
export function renderBarcode(
  canvas: HTMLCanvasElement, code: string, format: BarcodeFormat, scale?: number,
): HTMLCanvasElement {
  const enc = ENCODERS[format] ?? ENCODERS.CODE_128;
  const twoD = enc.twoD;
  const opts: RenderOptions & { columns?: number } = {
    bcid: enc.bcid,
    text: prepareText(format, code),
    scale: scale ?? (twoD ? 6 : 3),
    padding: twoD ? 4 : 10,
    backgroundcolor: "FFFFFF",
    barcolor: "000000",
    includetext: false,
  };
  if (!twoD && format !== "PDF_417") opts.height = 22;
  if (format === "PDF_417") opts.columns = 3;
  return enc.fn(canvas, opts);
}

/** Builds a PNG-ready canvas with the card name above and the code below the barcode. */
export function composeImage(barcode: HTMLCanvasElement, name: string, code: string): HTMLCanvasElement {
  const pad = 32;
  const titleSize = 36;
  const codeSize = 28;
  const width = Math.max(barcode.width + pad * 2, 480);
  const height = pad + titleSize + 24 + barcode.height + 24 + codeSize + pad;
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return barcode;
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `bold ${titleSize}px sans-serif`;
  ctx.fillText(name, width / 2, pad, width - pad * 2);
  const by = pad + titleSize + 24;
  ctx.drawImage(barcode, Math.round((width - barcode.width) / 2), by);
  ctx.font = `${codeSize}px monospace`;
  ctx.fillText(code, width / 2, by + barcode.height + 24, width - pad * 2);
  return out;
}
