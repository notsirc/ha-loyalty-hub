// §11.7: "Save favorite codes": one PNG with name + barcode (black on white) of every favorite,
// generated entirely in the browser.
import { is2D, renderBarcode } from "./barcode";
import type { Card } from "./types";

const PAD = 32;
const GAP = 40;
const NAME_SIZE = 30;
const CODE_SIZE = 22;
const MIN_CELL = 520;

interface Item { name: string; code: string; canvas: HTMLCanvasElement | null }

function renderItem(card: Card): Item {
  let canvas: HTMLCanvasElement | null = document.createElement("canvas");
  try {
    renderBarcode(canvas, card.code, card.barcode_format, is2D(card.barcode_format) ? 6 : 3);
  } catch {
    canvas = null; // invalid code for its format: only name + code text
  }
  return { name: card.name, code: card.code, canvas };
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png");
  });
}

/** Builds the PNG. Throws if there is nothing to draw or the canvas is not available. */
export async function buildFavoritesSheet(cards: Card[]): Promise<Blob> {
  const items = cards.filter((c) => c.favorite).map(renderItem);
  if (!items.length) throw new Error("no favorites");
  const cols = items.length > 10 ? 2 : 1;
  const cellW = Math.max(MIN_CELL, ...items.map((i) => (i.canvas?.width ?? 0) + PAD));
  const cellH = (i: Item) => NAME_SIZE + 16 + (i.canvas?.height ?? 0) + 12 + CODE_SIZE;
  const rows: Item[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  const rowH = rows.map((r) => Math.max(...r.map(cellH)));
  const width = PAD * 2 + cols * cellW + (cols - 1) * GAP;
  const height = PAD * 2 + rowH.reduce((a, b) => a + b, 0) + (rows.length - 1) * GAP;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  let y = PAD;
  rows.forEach((row, r) => {
    row.forEach((item, c) => {
      const cx = PAD + c * (cellW + GAP) + cellW / 2;
      ctx.fillStyle = "#000000";
      ctx.font = `bold ${NAME_SIZE}px sans-serif`;
      ctx.fillText(item.name, cx, y, cellW - 16);
      let by = y + NAME_SIZE + 16;
      if (item.canvas) {
        ctx.drawImage(item.canvas, Math.round(cx - item.canvas.width / 2), by);
        by += item.canvas.height;
      }
      ctx.font = `${CODE_SIZE}px monospace`;
      ctx.fillText(item.code, cx, by + 12, cellW - 16);
    });
    y += rowH[r];
    if (r < rows.length - 1) {
      // Thin separator between rows, so the cashier scans one code at a time.
      ctx.fillStyle = "#DDDDDD";
      ctx.fillRect(PAD, y + GAP / 2, width - PAD * 2, 1);
      y += GAP;
    }
  });
  return canvasToBlob(out);
}
