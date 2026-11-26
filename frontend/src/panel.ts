// Sidebar panel entry point: <loyalty-hub-panel> (registered by panel_custom).
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  ChangeBatcher, deleteCard, dismissInbox, getPrefs, getSettings, listCards, listInbox, listTrash, setPrefs,
  subscribeChanges,
} from "./api";
import { computeGroups, groupOf, type CardGroup } from "./groups";
import {
  PanelHistory, hasLaunch, launchStates, listState, parseLaunch, sameScreen, shownCard,
  type LaunchParams, type PanelScreen, type PanelView,
} from "./history";
import { ensureLanguage, getLanguage, makeT, resolveLanguage, type Translate } from "./i18n";
import { pruneLogoCache } from "./logo";
import { requestPosition, shouldRequestPosition, type Position } from "./nearby";
import { sharedStyles } from "./styles";
import type {
  BarcodeFormat, Card, EditableCard, HomeAssistant, InboxItem, LogoRefreshProgress, LoyaltySettings, TrashItem, UserPrefs,
} from "./types";
import { emptyCard } from "./types";
import { defineElement, fireEvent, userPriceSites } from "./util";
import { needsAdminNotice } from "./components/lh-admin-notice";
import type { TrashUpdate } from "./components/lh-trash-view";
import { featureErrorText } from "./components/lh-features-section";
import "./components/lh-list-view";
import "./components/lh-group-detail";
import "./components/lh-inbox-banner";
import "./components/lh-card-form";
import "./components/lh-settings-view";
import "./components/lh-trash-view";
import "./components/lh-trash-banner";
import "./components/lh-dialog";

const UNDO_MS = 5000;
const TRASH_RELOAD_MS = 250;

interface Toast { message: string; undoId?: string }

export class LoyaltyHubPanel extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) narrow = false;
  @property({ attribute: false }) route?: unknown;
  @property({ attribute: false }) panel?: unknown;
  @state() private _cards: Card[] = [];
  @state() private _loading = true;
  @state() private _error = "";
  @state() private _view: PanelView = "list";
  @state() private _selectedId: string | null = null;
  @state() private _editing: Card | null = null;
  @state() private _settings?: LoyaltySettings;
  /** §14.2: last progress of this user's logo/refresh_all (null = none seen in this session). */
  @state() private _logoRefresh: LogoRefreshProgress | null = null;
  @state() private _prefs: UserPrefs | null = null;
  @state() private _toast: Toast | null = null;
  /** §11.9: cards hidden while their deletion can still be undone. */
  @state() private _hidden: ReadonlySet<string> = new Set();
  /** §11.5: browser-only position for the "Near you" section. */
  @state() private _position: Position | null = null;
  /** §11.7: open the selected card in cashier mode. */
  @state() private _cashier = false;
  /** §12.8: trash entries visible to the user (null = not loaded yet). */
  @state() private _trash: TrashItem[] | null = null;
  @state() private _trashFocus: string | null = null;
  @state() private _trashBlock = false;
  /** §12.6: "Leave without saving?" dialog. */
  @state() private _leaveAsk = false;
  /** §15.4: cards created for / transferred to the user (banner above the list). */
  @state() private _inbox: InboxItem[] = [];
  /** §15.4: list restricted to the cards of an inbox row (null = all). */
  @state() private _inboxOnly: string[] | null = null;
  /** §15.5 find_by_code: "Add as a new card" fills the new card form once it is shown. */
  private _formPrefill: { code: string; format: BarcodeFormat | null } | null = null;
  private _pendingDeletes = new Map<string, number>();
  private _positionAsked = false;
  private _prefsLoaded = false;
  private _unsub: (() => Promise<void> | void) | null = null;
  private _subscribing = false;
  private _toastTimer?: number;
  private _trashTimer?: number;
  private _initialized = false;
  private _t: Translate = makeT();
  private _lang = "en";
  // ---- §12.6 history ----
  private _hist = new PanelHistory();
  private _basePath = "";
  /** Link/notification parameters waiting for the cards to be loaded. */
  private _pendingLaunch: LaunchParams | null = null;
  /** History entry to restore once the cards are loaded. */
  private _pendingScreen: PanelScreen | null = null;
  /** Next popstate leaves the form without asking (user already chose "Leave"). */
  private _discard = false;
  /** Next popstate must end on this screen (after saving the form). */
  private _popTarget: PanelScreen | null = null;
  // ---- §12.9 logo cache ----
  private _trashLoaded = false;
  private _pruneWanted = false;
  /** §12.5: targeted updates (debounced cards/get, full reload when needed). */
  private _batcher = new ChangeBatcher(
    () => this.hass, () => this._cards, (cards, full) => this._applyCards(cards, full), () => undefined,
  );

  static override styles = [sharedStyles, css`
    :host {
      display: block; min-height: 100vh; background: var(--primary-background-color);
      -webkit-tap-highlight-color: transparent;
    }
    .toolbar {
      position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 4px;
      height: var(--header-height, 56px); padding: 0 4px;
      background: var(--app-header-background-color, var(--primary-color));
      color: var(--app-header-text-color, var(--text-primary-color, #fff));
      border-bottom: var(--app-header-border-bottom, none);
      padding-top: env(safe-area-inset-top);
      box-sizing: content-box;
    }
    .toolbar .title {
      flex: 1; font-size: 20px; font-weight: 400; margin-left: 8px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .content { max-width: 960px; margin: 0 auto; padding: 16px 16px calc(96px + env(safe-area-inset-bottom)); }
    .fab {
      position: fixed; right: calc(16px + env(safe-area-inset-right)); bottom: calc(16px + env(safe-area-inset-bottom));
      width: 56px; height: 56px; border-radius: 16px; border: none; cursor: pointer; z-index: 3;
      background: var(--primary-color); color: var(--text-primary-color, #fff);
      box-shadow: 0 3px 8px rgba(0, 0, 0, 0.3); display: flex; align-items: center; justify-content: center;
    }
    .toast {
      position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(88px + env(safe-area-inset-bottom));
      background: var(--secondary-background-color, #323232); color: var(--primary-text-color);
      padding: 10px 18px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); z-index: 4;
      max-width: calc(100vw - 32px); display: flex; align-items: center; gap: 12px;
    }
    .toast.has-action { padding-right: 6px; }
    .toast .undo {
      border: none; background: transparent; color: var(--primary-color); font-weight: 500; cursor: pointer;
      min-height: 36px; padding: 0 12px; border-radius: 18px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .state { padding: 48px 16px; text-align: center; color: var(--secondary-text-color); }
  `];

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("location-changed", this._onLocation);
    window.addEventListener("popstate", this._onPop);
    window.addEventListener("pagehide", this._flushDeletes);
    this._basePath = location.pathname;
    const launch = parseLaunch(location.search);
    if (hasLaunch(launch)) {
      this._pendingLaunch = launch;
    } else {
      const cur = this._hist.current;
      // Back/forward from another page onto one of our entries: restore it; otherwise this is the base.
      if (cur && cur.view !== "list") this._pendingScreen = cur;
      else {
        this._hist.replace(listState(), 0);
        this._setList();
      }
    }
    this._processPending();
    if (this.hass) this._subscribe();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("location-changed", this._onLocation);
    window.removeEventListener("popstate", this._onPop);
    window.removeEventListener("pagehide", this._flushDeletes);
    this._flushDeletes();
    this._unsubscribe();
    this._batcher.cancel();
    clearTimeout(this._toastTimer);
    clearTimeout(this._trashTimer);
  }

  protected override willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("hass") && this.hass) {
      const lang = getLanguage(this.hass);
      if (lang !== this._lang || !this._initialized) {
        this._lang = lang;
        this._t = makeT(this.hass);
        // §14.5: the language file is a separate chunk; rebuild the translator once loaded.
        ensureLanguage(this.hass).then((loaded) => {
          if (loaded) { this._t = makeT(this.hass); this.requestUpdate(); }
        }, () => undefined);
      }
      if (!this._initialized) {
        this._initialized = true;
        this._loadCards();
        this._loadTrash();
        this._loadSettings();
        this._loadInbox();
        this._syncLanguage();
        this._subscribe();
      }
    }
  }

  private _loadSettings() {
    getSettings(this.hass).then((s) => { this._settings = s; }).catch(() => undefined);
  }

  /** §15.4: inbox items (older backend or error: no banner). */
  private async _loadInbox() {
    if (!this.hass) return;
    try {
      this._inbox = await listInbox(this.hass);
    } catch {
      this._inbox = [];
    }
    // Dismissed elsewhere (another device): the list shows everything again.
    if (!this._inbox.length) this._inboxOnly = null;
  }

  private async _dismissInbox() {
    this._inboxOnly = null;
    try {
      await dismissInbox(this.hass);
      this._inbox = [];
    } catch (err) {
      this._showToast(featureErrorText(this._t, err));
    }
  }

  /** §9: store the UI language in the user prefs so server notifications use it. */
  private async _syncLanguage() {
    const language = resolveLanguage(this.hass);
    try {
      const prefs = await getPrefs(this.hass);
      this._prefs = prefs ?? null;
      this._prefsLoaded = true;
      this._maybeLocate();
      if (prefs && prefs.language !== language) this._prefs = await setPrefs(this.hass, { language });
    } catch {
      /* older backend or offline: ignore */
    }
  }

  /**
   * §11.5: one position request when the panel opens, only if the user wants nearby cards, the
   * context is secure and at least one card has locations or zones. Errors are silent.
   */
  private async _maybeLocate() {
    if (this._positionAsked || !this._prefsLoaded || this._loading) return;
    if (!shouldRequestPosition(this._prefs, this._cards)) return;
    this._positionAsked = true;
    const pos = await requestPosition();
    if (pos && this._prefs?.nearby !== false) this._position = pos;
  }

  private _onPrefsChanged(prefs: UserPrefs) {
    const wasOn = this._prefs?.nearby !== false;
    this._prefs = prefs;
    if (prefs.nearby === false) {
      this._position = null;
    } else if (!wasOn) {
      // Turned on again from the settings: allow one new request.
      this._positionAsked = false;
      this._maybeLocate();
    }
  }

  // ---- Live updates (§12.5) ----
  private async _subscribe() {
    if (this._unsub || this._subscribing || !this.hass || !this.isConnected) return;
    this._subscribing = true;
    try {
      const unsub = await subscribeChanges(this.hass, (ids) => this._batcher.push(ids), () => this._scheduleTrash(),
        (p) => { this._logoRefresh = p; }, {
          onInbox: () => this._loadInbox(),
          onSettings: () => this._loadSettings(),
        });
      if (this.isConnected) this._unsub = unsub;
      else await unsub();
    } catch {
      /* backend not ready: live updates disabled */
    } finally {
      this._subscribing = false;
    }
  }

  private _unsubscribe() {
    const unsub = this._unsub;
    this._unsub = null;
    if (unsub) Promise.resolve().then(unsub).catch(() => undefined);
  }

  private async _loadCards() {
    try {
      this._cards = await listCards(this.hass);
      this._error = "";
      this._prune();
    } catch (err) {
      this._error = featureErrorText(this._t, err);
    } finally {
      this._loading = false;
    }
    this._checkSelected();
    this._processPending();
    this._maybeLocate();
  }

  private _applyCards(cards: Card[], full: boolean) {
    this._cards = cards;
    this._error = "";
    if (full) this._prune();
    this._checkSelected();
  }

  /**
   * The open card disappeared (deleted, no longer shared): another card of its group if one is left
   * (§15.3), otherwise back to the list.
   */
  private _checkSelected() {
    if (this._view !== "detail" || !this._selectedId || this._isVisible(this._selectedId)) return;
    const opened = this._hist.current?.cardId ?? null;
    const fallback = opened && this._isVisible(opened) ? opened : null;
    if (fallback) this._selectTab(fallback);
    else this._goHome();
  }

  /** §12.9: drop cached logos of cards that are gone; own trash entries are kept. */
  private _prune() {
    if (!this._trashLoaded) {
      this._pruneWanted = true;
      return;
    }
    this._pruneWanted = false;
    const own = (this._trash ?? []).filter((i) => i.is_own).map((i) => ({ id: i.card_id, logo: i.logo }));
    pruneLogoCache([...this._cards, ...own], this.hass.user?.id).catch(() => undefined);
  }

  // ---- Trash (§12.8) ----
  private async _loadTrash() {
    if (!this.hass) return;
    try {
      this._trash = await listTrash(this.hass);
      this._trashLoaded = true;
      if (this._pruneWanted && !this._loading) this._prune();
    } catch {
      // Older backend or error: an empty trash (no banner); the logo cache is not pruned.
      if (this._trash === null) this._trash = [];
    }
  }

  private _scheduleTrash(ms = TRASH_RELOAD_MS) {
    clearTimeout(this._trashTimer);
    this._trashTimer = window.setTimeout(() => this._loadTrash(), ms);
  }

  private _onTrashUpdate(d: TrashUpdate) {
    let next = [...(this._trash ?? [])];
    if (d.removeId) next = next.filter((i) => i.card_id !== d.removeId);
    for (const item of d.items ?? []) {
      const k = next.findIndex((x) => x.card_id === item.card_id);
      if (k >= 0) next[k] = item;
      else next.push(item);
    }
    this._trash = next;
    if (d.card) this._upsert(d.card);
    this._scheduleTrash();
  }

  private get _pendingRequests(): TrashItem[] {
    return (this._trash ?? []).filter((i) => i.is_own && i.request?.status === "pending");
  }

  private _openTrash(id?: string | null) {
    this._go({ view: "trash", cardId: null, cashier: false, trashId: id ?? null });
    this._scheduleTrash(0);
  }

  // ---- §12.6 history / navigation ----
  private _isVisible(id: string | null): boolean {
    return !!id && this._visibleCards.some((c) => c.id === id);
  }

  /** The screen currently shown. */
  private _screen(): PanelScreen {
    const v = this._view;
    const cur = this._hist.current;
    const opened = v === "detail" && cur?.view === "detail" ? cur.cardId : this._selectedId;
    return {
      view: v,
      cardId: v === "detail" ? opened : v === "form" ? this._editing?.id ?? null : null,
      cashier: v === "detail" && this._cashier,
      trashId: v === "trash" ? this._trashFocus : null,
      tab: v === "detail" ? this._selectedId : null,
    };
  }

  private _setList() {
    this._view = "list";
    this._selectedId = null;
    this._editing = null;
    this._cashier = false;
  }

  /** Shows a screen without touching the history (missing cards → list). */
  private _show(s: PanelScreen) {
    if (this._loading) {
      this._pendingScreen = s;
      return;
    }
    this._trashBlock = false;
    switch (s.view) {
      case "detail": {
        // §15.3: the tab chosen last (if still visible), otherwise the card the group was opened on.
        const shown = shownCard(s);
        const id = this._isVisible(shown) ? shown : this._isVisible(s.cardId) ? s.cardId : null;
        if (!id) { this._setList(); return; }
        this._selectedId = id;
        this._editing = null;
        this._cashier = s.cashier;
        this._view = "detail";
        return;
      }
      case "form": {
        const card = s.cardId ? this._visibleCards.find((c) => c.id === s.cardId) : null;
        if (s.cardId && !card) { this._setList(); return; }
        if (this._view !== "form" || this._editing?.id !== card?.id) this._editing = card ?? null;
        this._cashier = false;
        this._view = "form";
        return;
      }
      case "settings":
      case "trash":
        this._cashier = false;
        this._editing = null;
        this._trashFocus = s.view === "trash" ? s.trashId ?? null : null;
        this._view = s.view;
        if (s.view === "trash") this._scheduleTrash(0);
        return;
      default:
        this._setList();
    }
  }

  /** Opens a screen as a new history entry. */
  private _go(s: PanelScreen) {
    if (!sameScreen(this._hist.current, s)) this._hist.push(s);
    this._show(s);
  }

  /** Back to the list, dropping the panel entries above the base one. */
  private _goHome() {
    this._setList();
    if (!this._hist.home()) this._hist.replace(listState(), 0);
  }

  /** One step back in the history; without a panel entry below, old in-panel behavior. */
  private _back(discard: boolean) {
    this._discard = discard;
    if (this._hist.back()) return;
    this._discard = false;
    const s: PanelScreen = this._view === "form" && this._editing && this._isVisible(this._editing.id)
      ? { view: "detail", cardId: this._editing.id, cashier: false, trashId: null, tab: this._editing.id }
      : listState();
    this._hist.replace(s, 0);
    this._show(s);
  }

  private _formDirty(): boolean {
    const form = this.renderRoot?.querySelector("lh-card-form") as unknown as { dirty?: boolean } | null;
    return form?.dirty === true;
  }

  /** Toolbar arrow, `lh-back`, form cancel. */
  private _navBack() {
    if (this._view === "form" && this._formDirty()) {
      this._leaveAsk = true;
      return;
    }
    this._back(false);
  }

  private _leaveConfirmed() {
    this._leaveAsk = false;
    this._back(true);
  }

  private _onPop = () => {
    if (location.pathname !== this._basePath) return; // Home Assistant is leaving the panel
    const launch = parseLaunch(location.search);
    if (hasLaunch(launch)) {
      this._pendingLaunch = launch;
      this._processPending();
      return;
    }
    const target = this._popTarget;
    if (target) {
      this._popTarget = null;
      this._discard = false;
      if (!sameScreen(this._hist.current, target)) this._hist.push(target);
      this._show(target);
      return;
    }
    if (this._view === "form" && !this._discard && this._formDirty()) {
      // Put the form entry back and ask; "Leave" goes back again with _discard set.
      this._hist.push(this._screen());
      this._leaveAsk = true;
      return;
    }
    this._discard = false;
    this._leaveAsk = false;
    const s = this._hist.current;
    if (!s) {
      // An entry of someone else on the same path (e.g. a Home Assistant dialog): leave it alone.
      if (history.state != null) return;
      this._hist.replace(listState(), 0);
      this._show(listState());
      return;
    }
    this._show(s);
  };

  /** HA in-app navigation to `/loyalty-hub?card=…` or `?trash=…` while the panel is open. */
  private _onLocation = () => {
    if (location.pathname !== this._basePath) return;
    const launch = parseLaunch(location.search);
    if (!hasLaunch(launch)) return;
    this._pendingLaunch = launch;
    this._processPending();
  };

  private _processPending() {
    if (this._loading || !this.isConnected) return;
    const launch = this._pendingLaunch;
    if (launch) {
      this._pendingLaunch = null;
      this._pendingScreen = null;
      this._launch(launch);
      return;
    }
    const s = this._pendingScreen;
    if (s) {
      this._pendingScreen = null;
      this._show(s);
    }
  }

  /** §12.6: link/notification → list as base entry (query removed), then the requested view(s). */
  private _launch(l: LaunchParams) {
    this._hist.replace(listState(), 0);
    let last: PanelScreen = listState();
    for (const s of launchStates(l)) {
      if (s.view === "detail" && !this._isVisible(s.cardId)) break;
      this._hist.push(s);
      last = s;
    }
    this._show(last);
    if (last.view === "trash") this._trashBlock = l.block;
  }

  /** Opens a card; §15.3: inside its group, on that tab. */
  private _openCard(id: string) {
    this._go({ view: "detail", cardId: id, cashier: false, trashId: null, tab: id });
  }

  /** §15.3 `tab-changed`: another tab of the open group, without a new history entry. */
  private _selectTab(id: string) {
    if (this._view !== "detail" || !this._isVisible(id)) return;
    this._selectedId = id;
    const cur = this._hist.current;
    if (cur?.view === "detail") this._hist.replace({ ...cur, tab: id }, cur.depth);
  }

  private _openForm(card: Card | null) {
    this._editing = card;
    this._go({ view: "form", cardId: card?.id ?? null, cashier: false, trashId: null });
  }

  /**
   * §15.5 find_by_code: new card form with code and format already filled. The form has no
   * "initial data" property, so the full form is opened the same way the guided add does it
   * (`lh-full-form` on its <lh-guided-add>).
   */
  private async _openFormWithCode(code: string, format: BarcodeFormat | null) {
    this._formPrefill = { code, format };
    this._openForm(null);
    await this.updateComplete;
    const form = this.renderRoot.querySelector("lh-card-form") as (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
    await form?.updateComplete;
    const pre = this._formPrefill;
    this._formPrefill = null;
    if (!form || !pre || this._view !== "form" || this._editing) return;
    const data: EditableCard = { ...emptyCard(this._settings?.currency), code: pre.code, barcode_format: pre.format ?? "CODE_128" };
    const guided = form.shadowRoot?.querySelector("lh-guided-add");
    guided?.dispatchEvent(new CustomEvent("lh-full-form", { detail: { data, detected: pre.format } }));
  }

  private _onCashierOpened() {
    if (this._view !== "detail" || !this._selectedId) return;
    this._cashier = true;
    if (!this._hist.current?.cashier) this._hist.push({ ...this._screen(), cashier: true });
  }

  private _onCashierClosed() {
    this._cashier = false;
    // Closed with its own button (not with back): drop the cashier entry.
    if (this._hist.current?.cashier) this._back(true);
  }

  // ---- §11.9: delete with undo ----
  private _requestDelete(card: Card) {
    if (!card?.id || this._pendingDeletes.has(card.id)) return;
    this._hidden = new Set([...this._hidden, card.id]);
    this._goHome();
    const timer = window.setTimeout(() => this._commitDelete(card.id), UNDO_MS);
    this._pendingDeletes.set(card.id, timer);
    this._showToast(this._t("card_deleted"), { undoId: card.id, ms: UNDO_MS });
  }

  private _unhide(id: string) {
    const next = new Set(this._hidden);
    next.delete(id);
    this._hidden = next;
  }

  private _undoDelete(id: string) {
    const timer = this._pendingDeletes.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this._pendingDeletes.delete(id);
    this._unhide(id);
    this._toast = null;
    clearTimeout(this._toastTimer);
  }

  private async _commitDelete(id: string) {
    if (!this._pendingDeletes.delete(id)) return;
    if (this._toast?.undoId === id) this._toast = null;
    try {
      await deleteCard(this.hass, id);
      this._cards = this._cards.filter((c) => c.id !== id);
      this._unhide(id);
      this._scheduleTrash();
    } catch (err) {
      this._unhide(id);
      this._showToast(featureErrorText(this._t, err));
    }
  }

  /** Page closing (or panel removed): send the pending deletions right away. */
  private _flushDeletes = () => {
    if (!this._pendingDeletes.size || !this.hass) return;
    for (const [id, timer] of this._pendingDeletes) {
      clearTimeout(timer);
      deleteCard(this.hass, id).catch(() => undefined);
    }
    this._pendingDeletes.clear();
  };

  /** Cards without the ones waiting for their deletion (§11.9). */
  private get _visibleCards(): Card[] {
    return this._hidden.size ? this._cards.filter((c) => !this._hidden.has(c.id)) : this._cards;
  }

  private _upsert(card: Card) {
    const i = this._cards.findIndex((c) => c.id === card.id);
    const prev = i >= 0 ? this._cards[i] : undefined;
    const merged: Card = { ...card, can_edit: card.can_edit ?? prev?.can_edit ?? true,
      can_manage: card.can_manage ?? prev?.can_manage ?? true,
      admin_view: card.admin_view ?? prev?.admin_view ?? false,
      owner_name: card.owner_name ?? prev?.owner_name };
    this._cards = i >= 0 ? this._cards.map((c, j) => (j === i ? merged : c)) : [...this._cards, merged];
  }

  /** Saved: the form entry is replaced by the card detail (edit: back to it; new: list → detail). */
  private _onSaved(card: Card) {
    this._upsert(card);
    this._showToast(this._t("saved"));
    const target: PanelScreen = { view: "detail", cardId: card.id, cashier: false, trashId: null, tab: card.id };
    this._show(target);
    this._popTarget = target;
    if (!this._hist.back()) {
      this._popTarget = null;
      this._hist.replace(target, this._hist.depth);
    }
  }

  private _showToast(message: string, opts: { undoId?: string; ms?: number } = {}) {
    this._toast = { message, undoId: opts.undoId };
    clearTimeout(this._toastTimer);
    this._toastTimer = window.setTimeout(() => { this._toast = null; }, opts.ms ?? 3000);
  }

  private _title(): string {
    const t = this._t;
    switch (this._view) {
      case "detail": return this._visibleCards.find((c) => c.id === this._selectedId)?.name ?? t("app_title");
      case "form": return this._editing ? t("edit_card") : t("new_card");
      case "settings": return t("settings");
      case "trash": return t("trash_title");
      default: return t("app_title");
    }
  }

  /** §15.3: the group of the open card (a single card is a group of one). */
  private _groupOf(cards: Card[], card: Card): CardGroup {
    const groups = computeGroups(cards, this._prefs, this.hass?.user?.id);
    return groupOf(groups, card.id) ?? { key: `s:${card.id}`, cards: [card], mode: "auto" };
  }

  /** §10.2: admin settings with the price compare sites filtered by the user's prefs. */
  private get _userSettings(): LoyaltySettings | undefined {
    const s = this._settings;
    return s ? { ...s, price_compare: userPriceSites(s.price_compare, this._prefs) } : undefined;
  }

  private _renderContent() {
    const t = this._t;
    if (this._loading) return html`<div class="state">${t("loading")}</div>`;
    const cards = this._visibleCards;
    if (this._error && !this._cards.length && this._view === "list") {
      return html`<div class="state"><p>${this._error}</p>
        <button class="btn" @click=${() => { this._loading = true; this._loadCards(); }}>${t("retry")}</button></div>`;
    }
    switch (this._view) {
      case "detail": {
        const card = cards.find((c) => c.id === this._selectedId);
        if (!card) return nothing;
        return html`<lh-group-detail .hass=${this.hass} .t=${t} language=${this._lang} .settings=${this._userSettings}
          .prefs=${this._prefs} .cards=${cards} .group=${this._groupOf(cards, card)} .selectedId=${card.id}
          .cashier=${this._cashier} .position=${this._prefs?.nearby === false ? null : this._position}
          @tab-changed=${(e: CustomEvent<{ cardId: string }>) => this._selectTab(e.detail.cardId)}
          @prefs-changed=${(e: CustomEvent<{ prefs: UserPrefs }>) => this._onPrefsChanged(e.detail.prefs)}
          @cashier-opened=${() => this._onCashierOpened()}
          @cashier-closed=${() => this._onCashierClosed()}
          @edit-card=${(e: CustomEvent<{ card: Card }>) => this._openForm(e.detail.card)}
          @card-updated=${(e: CustomEvent<{ card: Card }>) => this._upsert(e.detail.card)}
          @card-deleted=${(e: CustomEvent<{ id: string }>) => {
            this._cards = this._cards.filter((c) => c.id !== e.detail.id);
            this._goHome();
          }}></lh-group-detail>`;
      }
      case "form":
        return html`<lh-card-form .hass=${this.hass} .t=${t} .card=${this._editing} .cards=${cards}
          language=${this._lang} .prefs=${this._prefs} .settings=${this._settings}
          @card-updated=${(e: CustomEvent<{ card: Card }>) => this._upsert(e.detail.card)}
          @lh-request-delete=${(e: CustomEvent<{ card: Card }>) => {
            e.stopPropagation();
            this._requestDelete(e.detail.card);
          }}
          @cancel=${() => this._navBack()}
          @saved=${(e: CustomEvent<{ card: Card }>) => this._onSaved(e.detail.card)}></lh-card-form>`;
      case "settings":
        return html`<lh-settings-view .hass=${this.hass} .t=${t} language=${this._lang} .cards=${cards}
          .trashCount=${this._trash ? this._trash.length : null} .logoRefresh=${this._logoRefresh}
          .liveSettings=${this._settings}
          @card-updated=${(e: CustomEvent<{ card: Card }>) => this._upsert(e.detail.card)}
          @logo-refresh-started=${(e: CustomEvent<{ progress: LogoRefreshProgress }>) => {
            this._logoRefresh = e.detail.progress;
          }}
          @settings-changed=${(e: CustomEvent<{ settings: LoyaltySettings }>) => { this._settings = e.detail.settings; }}
          @open-trash=${() => this._openTrash()}
          @prefs-changed=${(e: CustomEvent<{ prefs: UserPrefs }>) => this._onPrefsChanged(e.detail.prefs)}
          @cards-imported=${() => this._batcher.push(null)}></lh-settings-view>`;
      case "trash":
        return html`<lh-trash-view .hass=${this.hass} .t=${t} language=${this._lang} .items=${this._trash}
          .focusId=${this._trashFocus} .block=${this._trashBlock}
          @trash-update=${(e: CustomEvent<TrashUpdate>) => this._onTrashUpdate(e.detail)}></lh-trash-view>`;
      default:
        return html`
          <lh-trash-banner .items=${this._pendingRequests} .t=${t}
            @open-trash=${(e: CustomEvent<{ id?: string }>) => this._openTrash(e.detail?.id)}></lh-trash-banner>
          <lh-inbox-banner .items=${this._inbox} .t=${t} language=${this._lang} .activeIds=${this._inboxOnly}
            @inbox-show=${(e: CustomEvent<{ ids: string[] }>) => { this._inboxOnly = e.detail.ids; }}
            @inbox-dismiss=${() => this._dismissInbox()}></lh-inbox-banner>
          <lh-list-view .hass=${this.hass} .cards=${cards} .t=${t} .settings=${this._userSettings}
            .prefs=${this._prefs} .onlyIds=${this._inboxOnly}
            language=${this._lang} .position=${this._prefs?.nearby === false ? null : this._position}
            @open-card=${(e: CustomEvent<{ id: string }>) => this._openCard(e.detail.id)}
            @prefs-changed=${(e: CustomEvent<{ prefs: UserPrefs }>) => this._onPrefsChanged(e.detail.prefs)}
            @clear-only=${() => { this._inboxOnly = null; }}
            @add-with-code=${(e: CustomEvent<{ code: string; format: BarcodeFormat | null }>) =>
              this._openFormWithCode(e.detail.code, e.detail.format)}>
          </lh-list-view>`;
    }
  }

  protected override render() {
    if (!this.hass) return nothing;
    const t = this._t;
    const isList = this._view === "list";
    return html`
      <div class="toolbar">
        ${isList
          ? (this.narrow ? html`<button class="icon-btn" title=${t("menu")} aria-label=${t("menu")}
              @click=${() => fireEvent(this, "hass-toggle-menu")}><ha-icon icon="mdi:menu"></ha-icon></button>` : nothing)
          : html`<button class="icon-btn" title=${t("back")} aria-label=${t("back")} @click=${() => this._navBack()}>
              <ha-icon icon="mdi:arrow-left"></ha-icon></button>`}
        <div class="title">${this._title()}</div>
        ${isList ? html`<button class="icon-btn" title=${t("settings")} aria-label=${t("settings")}
          @click=${() => this._go({ view: "settings", cardId: null, cashier: false, trashId: null })}>
          <ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
      </div>
      <div class="content" @show-toast=${(e: CustomEvent<{ message: string }>) => this._showToast(e.detail.message)}
        @lh-back=${(e: Event) => { e.stopPropagation(); this._navBack(); }}>
        ${this._renderContent()}
      </div>
      ${isList && !this._loading ? html`<button class="fab" title=${t("add_card")} aria-label=${t("add_card")}
        @click=${() => this._openForm(null)}><ha-icon icon="mdi:plus"></ha-icon></button>`
        : nothing}
      ${this._renderToast()}
      ${this._renderLeaveDialog()}
      ${needsAdminNotice(this.hass, this._settings, this._prefs)
        ? html`<lh-admin-notice .hass=${this.hass} .t=${t}
            @admin-notice-accepted=${(e: CustomEvent<{ prefs: UserPrefs }>) => { this._prefs = e.detail.prefs; }}>
          </lh-admin-notice>`
        : nothing}
    `;
  }

  private _renderLeaveDialog() {
    const t = this._t;
    return html`<lh-dialog .open=${this._leaveAsk} heading=${t("leave_unsaved_title")} close-label=${t("close")}
      @closed=${() => { this._leaveAsk = false; }}>
      <p>${t("leave_unsaved_text")}</p>
      <button slot="actions" class="btn" @click=${() => { this._leaveAsk = false; }}>${t("leave_unsaved_stay")}</button>
      <button slot="actions" class="btn danger" @click=${() => this._leaveConfirmed()}>${t("leave_unsaved_exit")}</button>
    </lh-dialog>`;
  }

  private _renderToast() {
    const toast = this._toast;
    if (!toast) return nothing;
    const undoId = toast.undoId;
    return html`<div class="toast ${undoId ? "has-action" : ""}" role="status">
      <span>${toast.message}</span>
      ${undoId ? html`<button class="undo" @click=${() => this._undoDelete(undoId)}>${this._t("undo")}</button>`
        : nothing}
    </div>`;
  }
}

defineElement("loyalty-hub-panel", LoyaltyHubPanel);

declare global {
  interface HTMLElementTagNameMap { "loyalty-hub-panel": LoyaltyHubPanel }
}
