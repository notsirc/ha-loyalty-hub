// §14.3: countries and shop lists (normalization, names, merge + dedupe, search).
import { loadShops, SHOP_COUNTRIES } from "./data/shops/index";
import {
  COUNTRY_OTHER, MAX_USER_COUNTRIES, SHOP_CATEGORIES, type CountryShop, type HouseholdShop, type LoyaltySettings,
  type ShopCategory, type UserPrefs,
} from "./types";

export { SHOP_COUNTRIES, SHOPS_UPDATED } from "./data/shops/index";

/** San Marino and Vatican City use the Italian list. */
const ALIASES: Record<string, string> = { sm: "it", va: "it" };

/** Lowercase code with a shop list, "other", or null if not usable. */
export function normalizeCountry(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.trim().toLowerCase();
  if (c === COUNTRY_OTHER) return COUNTRY_OTHER;
  if (!/^[a-z]{2}$/.test(c)) return null;
  const n = ALIASES[c] ?? c;
  return SHOP_COUNTRIES.includes(n) ? n : COUNTRY_OTHER;
}

/** The user's countries (max 2, distinct): prefs.countries, else the admin default. */
export function userCountries(prefs: UserPrefs | null | undefined, settings: LoyaltySettings | null | undefined): string[] {
  const raw = prefs?.countries?.length ? prefs.countries : [settings?.default_country ?? COUNTRY_OTHER];
  const out: string[] = [];
  for (const c of raw) {
    const n = normalizeCountry(c);
    if (n && !out.includes(n)) out.push(n);
  }
  return (out.length ? out : [COUNTRY_OTHER]).slice(0, MAX_USER_COUNTRIES);
}

/** Localized country name (Intl.DisplayNames), "other" → `otherLabel`. */
export function countryName(code: string, lang: string, otherLabel: string): string {
  if (code === COUNTRY_OTHER) return otherLabel;
  try {
    return new Intl.DisplayNames([lang, "en"], { type: "region" }).of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** Countries for a selector: those with a list, sorted by localized name, then "other". */
export function countryOptions(lang: string, otherLabel: string): { code: string; name: string }[] {
  const list = SHOP_COUNTRIES.map((code) => ({ code, name: countryName(code, lang, otherLabel) }));
  list.sort((a, b) => a.name.localeCompare(b.name, lang, { sensitivity: "base" }));
  return [...list, { code: COUNTRY_OTHER, name: otherLabel }];
}

/** Accent- and case-insensitive key. */
export function normName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Merged list of several countries, in the given order: same name + same domain → one entry
 * (the first country's), same name with different domains → one entry per domain (show the `cc`).
 */
export async function loadMergedShops(countries: string[]): Promise<CountryShop[]> {
  const lists = await Promise.all(countries.filter((c) => c !== COUNTRY_OTHER).map(async (cc) =>
    (await loadShops(cc)).map((s) => ({ ...s, cc }))));
  const seen = new Set<string>();
  const out: CountryShop[] = [];
  for (const list of lists) {
    for (const s of list) {
      const key = `${normName(s.name)}|${s.domain}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** All countries (for "Search in all countries"). */
export const loadAllShops = () => loadMergedShops([...SHOP_COUNTRIES]);

/** Names that appear with more than one domain: show "Name · CC" for them. */
export function ambiguousNames(shops: CountryShop[]): Set<string> {
  const domains = new Map<string, Set<string>>();
  for (const s of shops) {
    const k = normName(s.name);
    (domains.get(k) ?? domains.set(k, new Set()).get(k)!).add(s.domain);
  }
  return new Set([...domains].filter(([, d]) => d.size > 1).map(([k]) => k));
}

/** Shop matches the query (name or alias, accent/case-insensitive). Empty query → everything. */
export function shopMatches(s: { name: string; aliases?: string[] }, query: string): boolean {
  const q = normName(query);
  if (!q) return true;
  return normName(s.name).includes(q) || (s.aliases ?? []).some((a) => normName(a).includes(q));
}

/** Matches grouped by category, in the SHOP_CATEGORIES order; list order kept inside a group. */
export function groupByCategory(shops: CountryShop[], query: string, limit = 200): { category: ShopCategory; shops: CountryShop[] }[] {
  const groups = new Map<ShopCategory, CountryShop[]>();
  let n = 0;
  for (const s of shops) {
    if (n >= limit) break;
    if (!shopMatches(s, query)) continue;
    (groups.get(s.category) ?? groups.set(s.category, []).get(s.category)!).push(s);
    n++;
  }
  return SHOP_CATEGORIES.filter((c) => groups.has(c)).map((category) => ({ category, shops: groups.get(category)! }));
}

/** Household shops matching the query. */
export const filterHousehold = (shops: HouseholdShop[], query: string) => shops.filter((s) => shopMatches(s, query));

/** True if `name` is (case/accent-insensitively) the name of a listed shop. */
export function isListedName(shops: { name: string }[], name: string): boolean {
  const k = normName(name);
  return !!k && shops.some((s) => normName(s.name) === k);
}
