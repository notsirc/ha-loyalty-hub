// §16.3: list order shared by the panel (lh-list-view) and the Lovelace card ("Automatic" mode):
// base order (habits, or the manual order of §15.5), then "Near you" groups, favorites, the rest.
import type { CardGroup } from "./groups";
import { sortByHabits } from "./habits";
import type { Card, UserPrefs } from "./types";

/** §15.5 manual_order: cards sorted by `manual_order` (missing ids at the end by created_at). */
export function sortManual(cards: Card[], order: string[] | undefined): Card[] {
  const pos = new Map((order ?? []).map((id, i) => [id, i]));
  return [...cards].sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9)
    || (a.created_at || "").localeCompare(b.created_at || "") || a.name.localeCompare(b.name));
}

/** Base order of the list: manual (feature on and chosen) or habits. */
export function baseOrder(cards: Card[], prefs: UserPrefs | null | undefined, manualOn: boolean): Card[] {
  return manualOn ? sortManual(cards, prefs?.manual_order) : sortByHabits(cards);
}

/** Splits entries (already in base order) into Near you / Favorites / the rest, keeping their order. */
export function sections<T extends { group: CardGroup }>(
  entries: T[], isNear: (c: Card) => boolean,
): { near: T[]; favs: T[]; rest: T[] } {
  const near = entries.filter((e) => e.group.cards.some(isNear));
  const others = entries.filter((e) => !near.includes(e));
  const favs = others.filter((e) => e.group.cards.some((c) => c.favorite));
  const rest = others.filter((e) => !favs.includes(e));
  return { near, favs, rest };
}
