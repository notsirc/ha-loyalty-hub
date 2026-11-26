import type { Translate } from "./i18n";
import { isValidDomain } from "./logo";
import type { BarcodeFormat, EditableCard } from "./types";

export type FieldErrors = Partial<Record<keyof EditableCard | "points_raw" | "balance_raw", string>>;

/** Mirrors the light server-side validation of core/barcode.py (§3). */
export function validateCode(code: string, format: BarcodeFormat, t: Translate): string | undefined {
  const c = code.trim();
  if (!c) return t("err_required");
  if (c.length > 512) return t("err_too_long", { n: 512 });
  const digits = /^\d+$/.test(c);
  switch (format) {
    case "EAN_13": return digits && c.length === 13 ? undefined : t("err_digits", { n: 13 });
    case "EAN_8": return digits && c.length === 8 ? undefined : t("err_digits", { n: 8 });
    case "UPC_A": return digits && c.length === 12 ? undefined : t("err_digits", { n: 12 });
    case "UPC_E": return digits && c.length >= 6 && c.length <= 8 ? undefined
      : t("err_digits_range", { min: 6, max: 8 });
    case "ITF": return digits && c.length % 2 === 0 ? undefined : t("err_itf");
    default: return undefined;
  }
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

export function parseNumber(raw: string): number | null | "invalid" {
  const s = raw.trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : "invalid";
}

export function validateCard(
  card: EditableCard, pointsRaw: string, balanceRaw: string, t: Translate,
): FieldErrors {
  const e: FieldErrors = {};
  const name = card.name.trim();
  if (!name) e.name = t("err_required");
  else if (name.length > 80) e.name = t("err_too_long", { n: 80 });
  const codeErr = validateCode(card.code, card.barcode_format, t);
  if (codeErr) e.code = codeErr;
  if (!/^#[0-9a-fA-F]{6}$/.test(card.color)) e.color = t("err_color");
  if (card.notes.length > 1000) e.notes = t("err_too_long", { n: 1000 });
  const pts = parseNumber(pointsRaw);
  if (pts === "invalid" || (typeof pts === "number" && !Number.isInteger(pts))) e.points_raw = t("err_integer");
  if (card.expiry && !isValidIsoDate(card.expiry)) e.expiry = t("err_date");
  if (card.kind === "voucher") {
    const bal = parseNumber(balanceRaw);
    if (bal === "invalid" || (typeof bal === "number" && bal < 0)) e.balance_raw = t("err_number");
    if (!/^[A-Za-z]{3}$/.test(card.currency.trim())) e.currency = t("err_currency");
  }
  if (card.logo_domain && !isValidDomain(card.logo_domain)) e.logo_domain = t("err_domain");
  if (card.visibility === "shared" && card.shared_with.length === 0) e.shared_with = t("err_share");
  return e;
}
