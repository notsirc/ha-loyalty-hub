// §12.6: panel history (Android back button, Safari swipe). Pure helpers + a thin wrapper on
// window.history. The path always stays the panel path, so Home Assistant keeps the panel open.

export type PanelView = "list" | "detail" | "form" | "settings" | "trash";

export const HISTORY_KEY = "loyaltyHub";

/** What one history entry of the panel describes. `depth` = panel entries below this one. */
export interface PanelState {
  view: PanelView;
  /** detail/form: the card (form: null = new card). */
  cardId: string | null;
  /** detail: cashier overlay open. */
  cashier: boolean;
  /** trash: entry to focus. */
  trashId?: string | null;
  /** §15.3 detail: tab (card id) shown in the group of `cardId`; null/absent = `cardId` itself. */
  tab?: string | null;
  depth: number;
}

/** A screen of the panel (a history entry without its position). */
export type PanelScreen = Omit<PanelState, "depth">;

const VIEWS: readonly PanelView[] = ["list", "detail", "form", "settings", "trash"];

export const listState = (): PanelState => ({
  view: "list", cardId: null, cashier: false, trashId: null, tab: null, depth: 0,
});

/** §15.3: card shown by a detail screen (its tab, or the card it was opened on). */
export const shownCard = (s: PanelScreen | null): string | null => (s ? s.tab ?? s.cardId ?? null : null);

/** Validates the panel part of a `history.state`; null when absent or malformed. */
export function readPanelState(state: unknown): PanelState | null {
  if (!state || typeof state !== "object") return null;
  const raw = (state as Record<string, unknown>)[HISTORY_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.view !== "string" || !VIEWS.includes(r.view as PanelView)) return null;
  const view = r.view as PanelView;
  const depth = typeof r.depth === "number" && Number.isInteger(r.depth) && r.depth >= 0 ? r.depth : 0;
  return {
    view,
    cardId: typeof r.cardId === "string" ? r.cardId : null,
    cashier: view === "detail" && r.cashier === true,
    trashId: typeof r.trashId === "string" ? r.trashId : null,
    tab: view === "detail" && typeof r.tab === "string" ? r.tab : null,
    depth: view === "list" ? 0 : depth,
  };
}

/** Same screen (ignores depth; detail: same card shown, whatever the tab history). */
export function sameScreen(a: PanelScreen | null, b: PanelScreen | null): boolean {
  if (!a || !b) return false;
  if (a.view !== b.view || a.cashier !== b.cashier) return false;
  if (a.view === "detail") return shownCard(a) === shownCard(b);
  return (a.cardId ?? null) === (b.cardId ?? null) && (a.view !== "trash" || (a.trashId ?? null) === (b.trashId ?? null));
}

/** Launch parameters of a link or notification (`?card=…&cashier=1`, `?trash=…&block=1`). */
export interface LaunchParams { cardId: string | null; cashier: boolean; trashId: string | null; block: boolean }

export function parseLaunch(search: string): LaunchParams {
  let p: URLSearchParams;
  try {
    p = new URLSearchParams(search);
  } catch {
    return { cardId: null, cashier: false, trashId: null, block: false };
  }
  const flag = (k: string) => { const v = p.get(k); return v === "1" || v === "true"; };
  const cardId = p.get("card") || null;
  const trashId = p.has("trash") ? p.get("trash") ?? "" : null;
  return { cardId, cashier: !!cardId && flag("cashier"), trashId, block: trashId !== null && flag("block") };
}

export const hasLaunch = (l: LaunchParams) => l.cardId !== null || l.trashId !== null;

/** States to push on top of the list base entry for a launch link (back → … → list). */
export function launchStates(l: LaunchParams): PanelScreen[] {
  if (l.trashId !== null) {
    return [{ view: "trash", cardId: null, cashier: false, trashId: l.trashId || null }];
  }
  if (l.cardId) {
    // §15.3: a card of a group opens the group on that tab.
    const detail = { view: "detail" as const, cardId: l.cardId, cashier: false, trashId: null, tab: l.cardId };
    return l.cashier ? [detail, { ...detail, cashier: true }] : [detail];
  }
  return [];
}

/** Thin wrapper around window.history; every call is best effort (sandboxed iframes may throw). */
export class PanelHistory {
  constructor(private readonly _win: Window = window) {}

  get current(): PanelState | null {
    try {
      return readPanelState(this._win.history.state);
    } catch {
      return null;
    }
  }

  /** Panel entries below the current one (0 = nothing of ours to go back to). */
  get depth(): number {
    return this.current?.depth ?? 0;
  }

  private _path(): string {
    return this._win.location.pathname;
  }

  /**
   * Replaces the current entry and drops the query (`?card=` …). Other state keys are not kept on
   * purpose: Home Assistant would reopen a stale dialog stored there when coming back to this entry.
   */
  replace(s: PanelScreen, depth = 0): void {
    try {
      this._win.history.replaceState({ [HISTORY_KEY]: { ...s, depth } }, "", this._path());
    } catch {
      /* ignore */
    }
  }

  /** Pushes a new panel entry on top of the current one. */
  push(s: PanelScreen): void {
    try {
      const depth = this.depth + 1;
      this._win.history.pushState({ [HISTORY_KEY]: { ...s, depth } }, "", this._path());
    } catch {
      /* ignore */
    }
  }

  /** One step back; returns false when there is no panel entry below (caller handles it). */
  back(): boolean {
    if (this.depth <= 0) return false;
    try {
      this._win.history.back();
      return true;
    } catch {
      return false;
    }
  }

  /** Back to the list base entry; returns false when already there or not possible. */
  home(): boolean {
    const d = this.depth;
    if (d <= 0) return false;
    try {
      this._win.history.go(-d);
      return true;
    } catch {
      return false;
    }
  }
}
