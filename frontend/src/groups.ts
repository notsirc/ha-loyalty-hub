// §15.3: merged cards (groups). A per-user view computed in the browser: cards are never changed,
// the exceptions live in UserPrefs (grouping, group_split, group_links, group_tabs).
import { habitScore } from "./habits";
import { isNearby, type Position } from "./nearby";
import type { Card, GroupTabs, HomeAssistant, TabMode, UserPrefs } from "./types";
import { isArchived } from "./util";

export interface CardGroup {
  /** Group key (§15.3 rules); a single card uses `s:<id>`. */
  key: string;
  /** Tabs in display order (length 1 = a single card). */
  cards: Card[];
  mode: TabMode;
  /** §16.2: personal name of the group (groups of ≥ 2 cards only). */
  name?: string;
}

export const MAX_GROUP_IDS = 500;
export const MAX_GROUP_TABS = 200;
export const MAX_TAB_ORDER = 50;
export const MAX_GROUP_NAME = 30;

/** Lowercase, no accents, only letters and digits. */
export function normalizeName(name: string): string {
  return (name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const normDomain = (d: string) => d.trim().toLowerCase().replace(/^www\./, "");

/** Automatic key: `d:<domain>` or `n:<normalized name>`; null for vouchers and split cards. */
export function autoKey(card: Card, split: ReadonlySet<string>): string | null {
  if (card.kind === "voucher" || split.has(card.id)) return null;
  if (card.logo_domain) return `d:${normDomain(card.logo_domain)}`;
  const n = normalizeName(card.name);
  return n ? `n:${n}` : null;
}

/** Cards that may be grouped: not archived, not seen only through "admin sees everything". */
export const groupable = (c: Card) => !isArchived(c) && !c.admin_view;

const byCreated = (a: Card, b: Card) =>
  (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id);

/** Tab order: manual → saved order (missing ids at the end by created_at); auto → mine first, then created_at. */
export function orderTabs(cards: Card[], tabs: GroupTabs | undefined, userId: string | undefined): Card[] {
  const base = [...cards].sort(byCreated);
  if (tabs?.mode === "manual") {
    const pos = new Map((tabs.order ?? []).map((id, i) => [id, i]));
    return base.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || byCreated(a, b));
  }
  return base.sort((a, b) => Number(b.owner_id === userId) - Number(a.owner_id === userId) || byCreated(a, b));
}

/**
 * Splits the visible cards into groups (each card in exactly one CardGroup, singles included,
 * in the order of `cards`, a group at the position of its first card).
 * Archived and admin_view cards are always single. `grouping === false` → all single.
 */
export function computeGroups(cards: Card[], prefs: UserPrefs | null | undefined, userId?: string): CardGroup[] {
  const single = (c: Card): CardGroup => ({ key: `s:${c.id}`, cards: [c], mode: "auto" });
  if (prefs?.grouping === false) return cards.map(single);
  const split = new Set(prefs?.group_split ?? []);
  const eligible = cards.filter(groupable);
  const parent = new Map<string, string>(eligible.map((c) => [c.id, c.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y) !== r) {
      const n = parent.get(y)!;
      parent.set(y, r);
      y = n;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  const keys = new Map<string, string>();
  const firstByKey = new Map<string, string>();
  for (const c of eligible) {
    const k = autoKey(c, split);
    if (!k) continue;
    keys.set(c.id, k);
    const first = firstByKey.get(k);
    if (first) union(first, c.id);
    else firstByKey.set(k, c.id);
  }
  for (const pair of prefs?.group_links ?? []) {
    if (Array.isArray(pair) && parent.has(pair[0]) && parent.has(pair[1])) union(pair[0], pair[1]);
  }
  const sets = new Map<string, Card[]>();
  for (const c of eligible) {
    const r = find(c.id);
    const list = sets.get(r);
    if (list) list.push(c);
    else sets.set(r, [c]);
  }
  const groupByCard = new Map<string, CardGroup>();
  for (const members of sets.values()) {
    if (members.length < 2) continue;
    const autos = members.map((m) => keys.get(m.id)).filter((k): k is string => !!k).sort();
    const key = autos[0] ?? `c:${[...members].sort(byCreated)[0].id}`;
    const tabs = prefs?.group_tabs?.[key];
    const g: CardGroup = { key, cards: orderTabs(members, tabs, userId), mode: tabs?.mode === "manual" ? "manual" : "auto" };
    const name = prefs?.group_names?.[key];
    if (name) g.name = name;
    members.forEach((m) => groupByCard.set(m.id, g));
  }
  const out: CardGroup[] = [];
  const emitted = new Set<CardGroup>();
  for (const c of cards) {
    const g = groupByCard.get(c.id);
    if (!g) out.push(single(c));
    else if (!emitted.has(g)) {
      emitted.add(g);
      out.push(g);
    }
  }
  return out;
}

/** Group containing `cardId` (or undefined). */
export const groupOf = (groups: CardGroup[], cardId: string) =>
  groups.find((g) => g.cards.some((c) => c.id === cardId));

/** Tab label: short_name → owner name (if not mine) → position number. */
export function tabLabel(card: Card, index: number, userId: string | undefined): string {
  if (card.short_name?.trim()) return card.short_name.trim();
  if (card.owner_id !== userId && card.owner_name) return card.owner_name;
  return String(index + 1);
}

// ---- Last chosen tab on this device (per user + group; a convenience, may be lost) ----
const LAST_TAB_KEY = "loyalty_hub_last_tab";
function readLastTabs(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_TAB_KEY) || "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
export function rememberTab(userId: string | undefined, groupKey: string, cardId: string): void {
  try {
    const all = readLastTabs();
    const k = `${userId ?? ""}|${groupKey}`;
    delete all[k];
    all[k] = cardId;
    localStorage.setItem(LAST_TAB_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-300))));
  } catch {
    /* storage unavailable */
  }
}
const lastTab = (userId: string | undefined, groupKey: string) => readLastTabs()[`${userId ?? ""}|${groupKey}`];

/**
 * Tab opened for a group. manual → first. auto → 1) near exactly one card, 2) habit score,
 * 3) use_count, 4) last chosen on this device, 5) first. Ties skip to the next rule.
 */
export function pickTab(
  group: CardGroup,
  opts: { userId?: string; position?: Position | null; hass?: HomeAssistant; now?: Date } = {},
): Card {
  const cards = group.cards;
  if (cards.length === 1 || group.mode === "manual") return cards[0];
  if (opts.position) {
    const near = cards.filter((c) => isNearby(c, opts.position, opts.hass));
    if (near.length === 1) return near[0];
  }
  const best = (score: (c: Card) => number): Card | null => {
    let top: Card | null = null;
    let topScore = 0;
    let tie = false;
    for (const c of cards) {
      const s = score(c);
      if (s > topScore) {
        top = c;
        topScore = s;
        tie = false;
      } else if (s === topScore && s > 0) tie = true;
    }
    return top && !tie ? top : null;
  };
  const now = opts.now ?? new Date();
  const byHabit = best((c) => habitScore(c, now));
  if (byHabit) return byHabit;
  const byUse = best((c) => c.use_count ?? 0);
  if (byUse) return byUse;
  const last = lastTab(opts.userId, group.key);
  return cards.find((c) => c.id === last) ?? cards[0];
}

// ---- Prefs updates (pure; the caller sends prefs/set with the returned fields) ----
export type GroupPrefs = Pick<UserPrefs, "group_split" | "group_links" | "group_tabs" | "group_names">;

/** Drops ids that are no longer visible and applies the limits (call before saving). */
export function pruneGroupPrefs(prefs: GroupPrefs, visibleIds: ReadonlySet<string>): Required<GroupPrefs> {
  const tabs: Record<string, GroupTabs> = {};
  for (const [k, v] of Object.entries(prefs.group_tabs ?? {}).slice(-MAX_GROUP_TABS)) {
    tabs[k] = {
      mode: v.mode === "manual" ? "manual" : "auto",
      order: (v.order ?? []).filter((id) => visibleIds.has(id)).slice(0, MAX_TAB_ORDER),
    };
  }
  return {
    group_split: (prefs.group_split ?? []).filter((id) => visibleIds.has(id)).slice(-MAX_GROUP_IDS),
    group_links: (prefs.group_links ?? [])
      .filter((p) => visibleIds.has(p[0]) && visibleIds.has(p[1])).slice(-MAX_GROUP_IDS),
    group_tabs: tabs,
    group_names: Object.fromEntries(Object.entries(prefs.group_names ?? {}).slice(-MAX_GROUP_TABS)),
  };
}

/** "Separa": out of automatic grouping and out of every manual link. */
export function splitCard(prefs: GroupPrefs, cardId: string): GroupPrefs {
  const split = new Set(prefs.group_split ?? []);
  split.add(cardId);
  return {
    ...prefs,
    group_split: [...split],
    group_links: (prefs.group_links ?? []).filter((p) => p[0] !== cardId && p[1] !== cardId),
  };
}

/** "Unisci con…": links `cardId` with `targetId` (any card of the target group); a split card leaves group_split. */
export function linkCards(prefs: GroupPrefs, cardId: string, targetId: string): GroupPrefs {
  if (cardId === targetId) return prefs;
  const links = (prefs.group_links ?? []).filter((p) => !(p.includes(cardId) && p.includes(targetId)));
  links.push([cardId, targetId]);
  return { ...prefs, group_split: (prefs.group_split ?? []).filter((id) => id !== cardId), group_links: links };
}

/** Tab mode / order of one group. */
export function setGroupTabs(prefs: GroupPrefs, groupKey: string, tabs: GroupTabs): GroupPrefs {
  return {
    ...prefs,
    group_tabs: { ...(prefs.group_tabs ?? {}), [groupKey]: { mode: tabs.mode, order: tabs.order.slice(0, MAX_TAB_ORDER) } },
  };
}

/** §16.2 "Rinomina gruppo": empty name = name removed. */
export function setGroupName(prefs: GroupPrefs, groupKey: string, name: string): GroupPrefs {
  const names = { ...(prefs.group_names ?? {}) };
  const clean = name.trim().slice(0, MAX_GROUP_NAME);
  if (clean) names[groupKey] = clean;
  else delete names[groupKey];
  return { ...prefs, group_names: names };
}

/** First card of the group matching a predicate (search/filters open the group on it). */
export const firstMatching = (g: CardGroup, pred: (c: Card) => boolean) => g.cards.find(pred);
