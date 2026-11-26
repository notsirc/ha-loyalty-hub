// §11.6: ordering by usage habits. `card.usage` has 42 counters = 7 days (Monday = 0) x 6 slots of 4 h.
// The browser's local time picks the current slot (the server fills the counters with HA's time zone).
import type { Card } from "./types";

export const SLOTS_PER_DAY = 6;

/** Index of the current day/slot pair in `usage` (Monday = 0, slot = hour // 4). */
export function currentSlot(now: Date = new Date()): { day: number; slot: number } {
  return { day: (now.getDay() + 6) % 7, slot: Math.floor(now.getHours() / 4) };
}

/** usage[day*6+slot] + 0.5 x the adjacent slots of the same day. */
export function habitScore(card: Pick<Card, "usage">, now: Date = new Date()): number {
  const u = card.usage;
  if (!Array.isArray(u) || u.length < 7 * SLOTS_PER_DAY) return 0;
  const { day, slot } = currentSlot(now);
  const at = (s: number) => {
    if (s < 0 || s >= SLOTS_PER_DAY) return 0;
    const v = Number(u[day * SLOTS_PER_DAY + s]);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  return at(slot) + 0.5 * (at(slot - 1) + at(slot + 1));
}

/** Favorites first, then habit score, then use_count, then name. */
export function sortByHabits(cards: Card[], now: Date = new Date()): Card[] {
  const scores = new Map(cards.map((c) => [c.id, habitScore(c, now)]));
  return [...cards].sort((a, b) =>
    Number(!!b.favorite) - Number(!!a.favorite)
    || (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0)
    || (b.use_count ?? 0) - (a.use_count ?? 0)
    || a.name.localeCompare(b.name));
}
