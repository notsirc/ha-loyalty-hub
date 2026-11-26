// UI translations (docs/ARCHITETTURA.md §9). One JSON file per language in ./translations;
// en.json is the reference and defines the key type.
// §14.5: only en.json is bundled; the other languages are separate chunks loaded on demand.
import en from "./translations/en.json";
import type { HomeAssistant } from "./types";

type RawKey = keyof typeof en;
type PluralSuffix = "zero" | "one" | "two" | "few" | "many" | "other";
type StripPlural<K> = K extends `${infer B}_${PluralSuffix}` ? B : K;
/** Translation keys; plural keys are referenced by their base name (e.g. "points"). */
export type I18nKey = StripPlural<RawKey> | RawKey;
type Dict = Record<string, string>;

/**
 * Available languages (tags as file names). Add a language = add a JSON file + an entry here
 * and in `importDict`.
 */
export const LANGUAGES = [
  "en", "it", "de", "nl", "sv", "da", "nb", "pl", "cs", "fr", "es", "pt", "ro", "fi", "hu", "el", "tr",
] as const;
const AVAILABLE = new Set<string>(LANGUAGES);
/** Tags that use another language file (Norwegian: HA uses "nb"). */
const LANGUAGE_ALIASES: Record<string, string> = { no: "nb", nn: "nb" };

/** Loaded dictionaries (en always). */
const DICTS: Record<string, Dict> = { en };
const loading = new Map<string, Promise<void>>();

async function importDict(lang: string): Promise<Dict> {
  switch (lang) {
    case "it": return (await import("./translations/it.json")).default;
    case "de": return (await import("./translations/de.json")).default;
    case "nl": return (await import("./translations/nl.json")).default;
    case "sv": return (await import("./translations/sv.json")).default;
    case "da": return (await import("./translations/da.json")).default;
    case "nb": return (await import("./translations/nb.json")).default;
    case "pl": return (await import("./translations/pl.json")).default;
    case "cs": return (await import("./translations/cs.json")).default;
    case "fr": return (await import("./translations/fr.json")).default;
    case "es": return (await import("./translations/es.json")).default;
    case "pt": return (await import("./translations/pt.json")).default;
    case "ro": return (await import("./translations/ro.json")).default;
    case "fi": return (await import("./translations/fi.json")).default;
    case "hu": return (await import("./translations/hu.json")).default;
    case "el": return (await import("./translations/el.json")).default;
    case "tr": return (await import("./translations/tr.json")).default;
    default: return en;
  }
}

/**
 * Loads the dictionary of the user's language (once). Resolves to true if it was just loaded,
 * so the caller can rebuild its translator (makeT falls back to English until then).
 */
export async function ensureLanguage(hass?: HomeAssistant): Promise<boolean> {
  const lang = resolveLanguage(hass);
  if (DICTS[lang]) return false;
  let p = loading.get(lang);
  if (!p) {
    p = importDict(lang).then((d) => { DICTS[lang] = d; }, () => { loading.delete(lang); });
    loading.set(lang, p);
  }
  await p;
  return !!DICTS[lang];
}

/** True when the user's language is ready (or is English). */
export const languageReady = (hass?: HomeAssistant): boolean => !!DICTS[resolveLanguage(hass)];

export type Translate = (key: I18nKey, vars?: Record<string, string | number>) => string;

function canonical(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.replace(/_/g, "-"))[0] ?? null;
  } catch {
    return null;
  }
}

/** Raw language tag selected by the user in HA (profile language). */
function hassTag(hass?: HomeAssistant): string {
  return canonical(hass?.locale?.language ?? hass?.language ?? "en") ?? "en";
}

/** Resolves the UI language with the chain: full tag (pt-BR) → base (pt) → en. */
export function resolveLanguage(hass?: HomeAssistant): string {
  const tag = hassTag(hass);
  if (AVAILABLE.has(tag)) return tag;
  const base = tag.split("-")[0].toLowerCase();
  const b = LANGUAGE_ALIASES[base] ?? base;
  if (AVAILABLE.has(b)) return b;
  return "en";
}

/**
 * Locale used for Intl (dates, numbers, currency). Uses the user's full tag when it belongs to
 * the resolved UI language (e.g. it-CH with Italian UI), otherwise the UI language itself.
 */
export function getLanguage(hass?: HomeAssistant): string {
  const ui = resolveLanguage(hass);
  const tag = hassTag(hass);
  const base = tag.split("-")[0].toLowerCase();
  return (LANGUAGE_ALIASES[base] ?? base) === ui.split("-")[0].toLowerCase() ? tag : ui;
}

export function makeT(hass?: HomeAssistant): Translate {
  const lang = resolveLanguage(hass);
  const dict: Dict = DICTS[lang] ?? en;
  const locale = getLanguage(hass);
  let rules: Intl.PluralRules | null = null;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    rules = null;
  }
  const lookup = (k: string): string | undefined => dict[k] ?? (en as Dict)[k];
  return (key, vars) => {
    let s: string | undefined;
    const count = vars?.count;
    if (typeof count === "number") {
      const cat = rules ? rules.select(count) : count === 1 ? "one" : "other";
      s = lookup(`${key}_${cat}`) ?? lookup(`${key}_other`);
    }
    s = s ?? lookup(key) ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        const val = k === "count" && typeof v === "number" ? formatNumber(v, locale) : String(v);
        s = s.split(`{${k}}`).join(val);
      }
    }
    return s;
  };
}

export function formatNumber(n: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(n);
  } catch {
    return String(n);
  }
}
