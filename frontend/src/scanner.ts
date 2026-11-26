// Barcode scanning: native BarcodeDetector when available, @zxing/browser otherwise.
import { BrowserMultiFormatReader } from "@zxing/browser";
import type { IScannerControls } from "@zxing/browser";
import { BarcodeFormat as ZxFormat, DecodeHintType } from "@zxing/library";
import { BARCODE_FORMATS, type BarcodeFormat } from "./types";

export interface ScanResult {
  code: string;
  format: BarcodeFormat | null;
}

export interface ScanSession {
  stop(): void;
}

// ---- Format normalization (mirrors core/barcode.py normalize_format) ----
const ALIASES: Record<string, BarcodeFormat> = {
  code128: "CODE_128", code_128: "CODE_128",
  code39: "CODE_39", code_39: "CODE_39",
  code93: "CODE_93", code_93: "CODE_93",
  codabar: "CODABAR",
  ean13: "EAN_13", ean_13: "EAN_13",
  ean8: "EAN_8", ean_8: "EAN_8",
  upca: "UPC_A", upc_a: "UPC_A",
  upce: "UPC_E", upc_e: "UPC_E",
  itf: "ITF", itf14: "ITF", itf_14: "ITF", interleaved2of5: "ITF",
  qr: "QR_CODE", qrcode: "QR_CODE", qr_code: "QR_CODE",
  aztec: "AZTEC",
  datamatrix: "DATA_MATRIX", data_matrix: "DATA_MATRIX",
  pdf417: "PDF_417", pdf_417: "PDF_417",
};

/** Normalizes BarcodeDetector names, ZXing enum values/names and common aliases. */
export function normalizeFormat(value: string | number | null | undefined): BarcodeFormat | null {
  if (value === null || value === undefined) return null;
  let s: string;
  if (typeof value === "number") {
    const name = (ZxFormat as unknown as Record<number, string>)[value];
    if (!name) return null;
    s = name;
  } else {
    s = value;
  }
  const upper = s.trim().toUpperCase();
  if ((BARCODE_FORMATS as readonly string[]).includes(upper)) return upper as BarcodeFormat;
  return ALIASES[s.trim().toLowerCase().replace(/[\s-]/g, "_")]
    ?? ALIASES[s.trim().toLowerCase().replace(/[\s_-]/g, "")] ?? null;
}

// ---- Native BarcodeDetector (not yet in lib.dom typings) ----
interface DetectedBarcode { rawValue: string; format: string }
interface NativeDetector { detect(source: ImageBitmapSource): Promise<DetectedBarcode[]> }
interface NativeDetectorCtor {
  new (opts?: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = [
  "code_128", "code_39", "code_93", "codabar", "ean_13", "ean_8", "upc_a", "upc_e", "itf",
  "qr_code", "aztec", "data_matrix", "pdf417",
];

let nativeDetector: Promise<NativeDetector | null> | null = null;

function getNativeDetector(): Promise<NativeDetector | null> {
  if (!nativeDetector) {
    nativeDetector = (async () => {
      const Ctor = (globalThis as unknown as { BarcodeDetector?: NativeDetectorCtor }).BarcodeDetector;
      if (!Ctor) return null;
      try {
        const supported = await Ctor.getSupportedFormats();
        const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        return formats.length ? new Ctor({ formats }) : null;
      } catch {
        return null;
      }
    })();
  }
  return nativeDetector;
}

function fromNative(found: DetectedBarcode[]): ScanResult | null {
  const hit = found.find((b) => b.rawValue);
  return hit ? { code: hit.rawValue, format: normalizeFormat(hit.format) } : null;
}

// ---- ZXing ----
const ZX_FORMATS = [
  ZxFormat.CODE_128, ZxFormat.CODE_39, ZxFormat.CODE_93, ZxFormat.CODABAR, ZxFormat.EAN_13,
  ZxFormat.EAN_8, ZxFormat.UPC_A, ZxFormat.UPC_E, ZxFormat.ITF, ZxFormat.QR_CODE, ZxFormat.AZTEC,
  ZxFormat.DATA_MATRIX, ZxFormat.PDF_417,
];

function zxingReader(): BrowserMultiFormatReader {
  const hints = new Map<DecodeHintType, unknown>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
}

const CAMERA: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

export const liveScanAvailable = () =>
  window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

function stopStream(video: HTMLVideoElement) {
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/**
 * Starts the camera in `video` and calls `onResult` once with the first code found.
 * The returned session must be stopped (it also stops on the first result).
 */
export async function startLiveScan(
  video: HTMLVideoElement, onResult: (r: ScanResult) => void,
): Promise<ScanSession> {
  const detector = await getNativeDetector();
  if (detector) {
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA);
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    video.muted = true;
    await video.play().catch(() => undefined);
    let stopped = false;
    let timer: number | undefined;
    const stop = () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      stopStream(video);
    };
    const tick = async () => {
      if (stopped) return;
      try {
        if (video.readyState >= 2) {
          const r = fromNative(await detector.detect(video));
          if (r && !stopped) {
            stop();
            onResult(r);
            return;
          }
        }
      } catch {
        /* keep trying */
      }
      if (!stopped) timer = window.setTimeout(tick, 200);
    };
    tick();
    return { stop };
  }

  const reader = zxingReader();
  let controls: IScannerControls | null = null;
  let done = false;
  const stop = () => {
    done = true;
    controls?.stop();
    stopStream(video);
  };
  controls = await reader.decodeFromConstraints(CAMERA, video, (result, _err, ctl) => {
    if (result && !done) {
      done = true;
      ctl.stop();
      stopStream(video);
      onResult({ code: result.getText(), format: normalizeFormat(result.getBarcodeFormat()) });
    }
  });
  if (done) controls.stop();
  return { stop };
}

/** Decodes a still image (photo). Returns null when no code is found. */
export async function scanImageFile(file: Blob): Promise<ScanResult | null> {
  const detector = await getNativeDetector();
  if (detector) {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const r = fromNative(await detector.detect(bitmap));
        if (r) return r;
      } finally {
        bitmap.close();
      }
    } catch {
      /* fall through to ZXing */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const result = await zxingReader().decodeFromImageUrl(url);
    return { code: result.getText(), format: normalizeFormat(result.getBarcodeFormat()) };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
