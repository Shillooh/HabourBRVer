import { loadingAnimation } from './loading-animation';
import { createLoadingScreenStore, type LoadingScreenStore } from './loading-settings-store';
import type { Item, MediaApi } from './types';
import { button, el, replace } from './dom';
import { emptyHomeCollections, orderHomeItems, homeCollectionTabs, homeTabLabel, activeHomeRows, shuffleHomeItems, type HomeCollectionRow } from './home-collection-settings';
import { createHomeCollectionStore, type HomeCollectionStore } from './home-collection-store';
import { nativeHomeRows, rememberHomeRows } from './home-row-placement';
import { decorateSeasonalRow, refreshSeasonalBackdrop, refreshSeasonalDate, suspendSeasonalRow, resumeSeasonalRow } from './home-seasonal-appearance';
import { scrollSeasonalSelectionIntoView, seasonalNavigationTop, settleSeasonalSelection } from './home-seasonal-motion';
import { dailyAdvent } from './home-advent';
import { homeRowCard } from './home-row-card';
import { homeRowTabs } from './home-row-tabs';
import { HomeReadiness } from './home-readiness';
import { HomeChannelArtwork, clearHomeChannelArtwork } from './home-channel-artwork';
import { createProviderHomesStore, type ProviderHomesStore } from './provider-settings-store';
import type { ProviderHomesSettings, ProviderId } from './provider-settings';
import { providerHomeRow } from './provider-home';
import { attachRowScrollButtons } from './home-row-scroll';
import { isDesktopLayout } from './layout';
import { getAllWatchlistItems, subscribeWatchlist } from './watchlist';
import { HomeLibraryVisibility, homeLibraryExcludedClass } from './home-library-visibility';
import { restoreHomeItemAnchor, type HomeItemAnchor } from './home-return-position';

type RenderedRow = { row: Pick<HomeCollectionRow, 'id' | 'placement'>; element: HTMLElement; reconcileSource: () => Promise<void>; identity?: string; dispose?: () => void };
type StagedRows = { revision: number; inputRevision: number; sourceRevision?: number; sections?: RenderedRow[]; error?: HTMLElement; retry?: boolean };
type CollectionItems = { promise: Promise<Item[]>; fingerprint?: string; value?: Item[] };
type HomeSnapshot = { key: string; collections?: Item[]; items: Map<string, { value: Item[]; fingerprint: string }>; sources: Map<string, string>; watchlistShown: Map<string, number>; watchlist?: { value: Item[]; fingerprint: string } };
// Reuse successful data, never DOM handlers or promises owned by a disposed view.
// Only the last account is retained, in memory, until sign-out/server change.
let lastHome: HomeSnapshot | undefined;
let lastHomeExclusions: { key: string; ids: string[] } | undefined;
export function clearHomeSession(): void { lastHome = undefined; lastHomeExclusions = undefined; clearHomeChannelArtwork(); }

// Native Home is DOM-cached. Its controller can attempt Back restoration while
// the initial row batch is masked, so remember its last native target by account.
const nativeReturnFocus = new WeakMap<HTMLElement, { key: string; element: HTMLElement }>();
type NativeScroller = HTMLElement & { getScrollPosition?(): number; scrollToPosition?(position: number, immediate: boolean): void };
type PositionRow = { key: string; elements: NativeScroller[] };
type HomePosition = {
  vertical: { element: HTMLElement; top: number; left: number }[];
  rows: Map<string, { left: number; position?: number }[]>;
  focusId?: string; nativeFocus?: HTMLElement;
  anchor?: HomeItemAnchor;
};
// Session-only, bounded and account-scoped. Native node references are checked
// again on return; custom rows are resolved by their stable saved identifiers.
const homePositions = new Map<string, HomePosition>();
const homeItemVisitKey = 'jellyfinCinemaHomeItemVisit';
let homeItemVisitSequence = 0;


function showingHome(host = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab')): boolean {
  // Home and Favourites share a route/controller. A body-level status must
  // follow the actual selected tab, even while hidden Home rows keep loading.
  return host ? !host.closest('.hide,[hidden],[aria-hidden="true"]') && host.getClientRects().length > 0
    : new URLSearchParams(location.hash.split('?')[1] || '').get('tab') !== '1';
}

/** Insert owned rows between native Home rows without moving or rebuilding them. */
export class HomeCollections {
  private root = el('div', 'tvl-home-collections');
  private sections: RenderedRow[] = [];
  private staged?: StagedRows;
  private preparing?: StagedRows;
  private selectedSources = new Map<string, string>();
  private sourceRevision = 0;
  private displayedRevision = 0;
  private readiness = new HomeReadiness(() => this.attach());
  private channelArtwork: HomeChannelArtwork;
  private libraryVisibility = new HomeLibraryVisibility();
  private exclusionsReady = false;
  private exclusionsRequest?: Promise<void>;
  private exclusionsRefreshPending = false;
  private lastExclusionsRead = 0;
  private settings = emptyHomeCollections();
  private seasonalTimer?: number;
  private activeRowIds = '';
  // Per Home visit, not persisted: refreshing metadata must not reshuffle the
  // row underneath the user. Back from a row item continues the same visit.
  private shuffledOrders = new Map<string, string[]>();
  private itemReturn?: { home: string; token: string; position?: HomePosition };
  private key: string;
  private store: HomeCollectionStore;
  private syncing = false;
  private lastSync = 0;
  private syncTimer?: number;
  private observer: MutationObserver;
  private placementStyle = el('div').style;
  private disposed = false;
  private suspended = false;
  private pendingRender = false;
  private visit = 0;
  private attachFrame?: number;
  private resumeAppearance = false;
  private nativeContent: { element: HTMLElement; populated: boolean }[] = [];
  private revision = 0;
  private inputRevision = 0;
  private renderRetry = false;
  private items = new Map<string, CollectionItems>();
  private collections?: Item[];
  private collectionRequest?: Promise<Item[]>;
  private itemRefresh?: Promise<boolean>;
  private watchlist?: CollectionItems;
  private watchlistShown = new Map<string, number>();
  private removeWatchlist: () => void;
  private lastWatchlistSync = 0;
  private warmReturn = false;
  private initialRefreshPending = false;
  private refreshFrame?: number;
  private refreshTimer?: number;
  private providers: ProviderHomesSettings;
  private providerStore: ProviderHomesStore;
  private initialSettingsReady = false;
  private initialPaint = false;
  private loadingHost?: HTMLElement;
  private previousBusy: string | null = null;
  private loadingStatus: HTMLElement;
  private loadingStore: LoadingScreenStore;
  private loadingTimer?: number;
  private restoreFrame?: number;
  private restoreTimer?: number;
  private returnAnchor?: { home: string; host: HTMLElement; target: HTMLElement; cards: HTMLElement | null; position: HomeItemAnchor;
    inputRevision: number; width: number; height: number; observer?: ResizeObserver };
  private captureFrame?: number;
  private positionToRestore?: HomePosition;
  private nativePositionToRestore?: HomePosition;
  private lastPosition?: HomePosition;
  private positionRowCache?: { host: HTMLElement; rows: PositionRow[] };
  private accountIdentity: string;
  private providerSyncing = false;
  private providerLastSync = 0;
  private providerRefreshPending = false;

  private activeRows(): HomeCollectionRow[] {
    return activeHomeRows(this.settings, this.api.getSeasonalDate?.());
  }

  constructor(private api: MediaApi, private navigate: (id: string) => void, private restoreFocus?: string,
    private openProvider?: (id: ProviderId) => void) {
    this.store = createHomeCollectionStore(api); this.key = this.store.key; this.settings = this.store.cached;
    this.loadingStore = createLoadingScreenStore(api);
    const loadingSettings = this.loadingStore.cached;
    this.loadingStatus = loadingAnimation(loadingSettings);
    // Never delay Home for its animation preferences. The account cache is
    // immediate; a fresh server choice can update a still-visible first load.
    void this.loadingStore.load().then(settings => {
      if (this.disposed || JSON.stringify(settings) === JSON.stringify(loadingSettings)) return;
      const next = loadingAnimation(settings);
      this.loadingStatus.replaceWith(next); this.loadingStatus = next;
    }).catch(() => { /* Retain the account's cached animation during outages. */ });
    const exclusions = lastHomeExclusions?.key === this.key ? lastHomeExclusions.ids : undefined;
    this.exclusionsReady = !api.getHomeLibraryExclusions || !!exclusions;
    if (exclusions) this.libraryVisibility.setExclusions(exclusions);
    this.providerStore = createProviderHomesStore(api); this.providers = this.providerStore.cached;
    const cached = lastHome?.key === this.key ? lastHome : undefined;
    if (cached) {
      this.warmReturn = true; this.initialRefreshPending = true; this.collections = cached.collections || [];
      this.selectedSources = new Map(cached.sources);
      this.watchlistShown = new Map(cached.watchlistShown);
      if (cached.watchlist) this.watchlist = { ...cached.watchlist, promise: Promise.resolve(cached.watchlist.value) };
      for (const [id, entry] of cached.items) this.items.set(id, { ...entry, promise: Promise.resolve(entry.value) });
    }
    this.initialSettingsReady = this.warmReturn || !this.store.synced && !this.providerStore.synced;
    this.accountIdentity = JSON.stringify([api.serverId, api.userId]);
    this.removeWatchlist = subscribeWatchlist(api, () => {
      this.watchlist = undefined;
      if (!this.activeRows().some(row => row.kind === 'watchlist')) return;
      const active = document.activeElement as HTMLElement | null;
      if (this.owns(active)) this.restoreFocus = active?.dataset.focusId;
      void this.render();
    });
    this.channelArtwork = new HomeChannelArtwork(api);
    this.positionToRestore = homePositions.get(this.key);
    if (this.warmReturn) this.nativePositionToRestore = this.positionToRestore;
    if (!this.warmReturn) {
      if (showingHome()) document.body.append(this.loadingStatus);
      this.loadingTimer = window.setTimeout(() => { if (!this.loadingHost) this.loadingStatus.remove(); }, 3_500);
    }
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('command', this.onCommand, true);
    window.addEventListener('pointerdown', this.onPointer, true);
    window.addEventListener('focusin', this.rememberNativeFocus, true);
    window.addEventListener('scroll', this.queuePositionCapture, true);
    window.addEventListener('click', this.rememberPosition, true);
    window.addEventListener('wheel', this.onWheel, { capture: true, passive: true });
    window.addEventListener('storage', this.onProviderStorage);
    window.addEventListener('tvl-provider-settings-changed', this.onProviderSaved);
    window.addEventListener('focus', this.onVisible); document.addEventListener('visibilitychange', this.onVisible);
    document.addEventListener('viewshow', this.onNativeShow, true);
    this.observer = new MutationObserver(records => {
      // Native row order can change without replacing a node. Ignore scroller
      // transform updates so animated TV focus does not keep reattaching rows.
      if (records.some(record => {
        const target = record.target as Element;
        if (record.attributeName === 'style') {
          if (!target.matches('.verticalSection, .ec-root, .homeSectionsContainer, #homeTab')) return false;
          const style = target.getAttribute('style');
          if (record.oldValue === style) return false;
          // Seasonal focus temporarily disables native smooth scrolling, then
          // restores it in the same turn. These writes cannot move a Home row.
          // Parse declarations so CSS values containing semicolons stay intact.
          const structural = (value: string | null): string => {
            this.placementStyle.cssText = value || '';
            this.placementStyle.removeProperty('scroll-behavior');
            return this.placementStyle.cssText;
          };
          return structural(record.oldValue) !== structural(style);
        }
        if (record.attributeName === 'class' && target.closest('.tvl-home-collection-row')) {
          // Opening a door or expanding a focused seasonal row changes its
          // appearance, not its insertion point or saved scroller identity.
          // Keep observing every other class change, including visibility.
          const structural = (value: string) => value.split(/\s+/).filter(name => name
            && !/^tvl-seasonal-(?:focused|expanded|item-open|reveal-active)$/.test(name)).sort().join(' ');
          return structural(record.oldValue || '') !== structural(target.getAttribute('class') || '');
        }
        return true;
      })) this.queueAttach();
    });
    this.observe();
    this.attach(); void this.render(); void this.refreshLibraryExclusions(true);
    if (this.store.synced || this.providerStore.synced || this.api.getWatchlist || this.api.getHomeLibraryExclusions) {
      this.syncTimer = window.setInterval(this.onVisible, 60_000);
    }
    if (!this.warmReturn && (this.store.synced || this.providerStore.synced)) void this.loadInitialSettings();
  }

  private observe(): void {
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['class', 'hidden', 'style', 'aria-busy'] });
  }
  private queueAttach(): void {
    if (this.disposed || this.suspended || this.attachFrame !== undefined) return;
    this.attachFrame = requestAnimationFrame(() => { this.attachFrame = undefined; this.attach(); });
  }

  /** Native Jellyfin keeps Home mounted behind other routes. Retain the same
   * bounded set of cards and decoded artwork, but do no Home work off-route. */
  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.rememberPosition(); this.rememberNativeFocus();
    this.suspended = true; this.observer.disconnect(); this.channelArtwork.suspend();
    this.sections.forEach(section => suspendSeasonalRow(section.element));
    window.clearInterval(this.syncTimer); window.clearTimeout(this.seasonalTimer); window.clearTimeout(this.refreshTimer);
    this.cancelReturnScroll();
    for (const frame of [this.attachFrame, this.restoreFrame, this.captureFrame, this.refreshFrame]) if (frame !== undefined) cancelAnimationFrame(frame);
    this.attachFrame = this.restoreFrame = this.captureFrame = this.refreshFrame = this.refreshTimer = undefined;
    this.releaseInitialHome();
  }

  resume(): void {
    if (this.disposed || !this.suspended) return;
    const origin = this.itemReturn;
    this.itemReturn = undefined;
    const continuing = !!origin && origin.home === location.hash && history.state?.[homeItemVisitKey] === origin.token;
    if (continuing) {
      const state = { ...history.state }; delete state[homeItemVisitKey];
      history.replaceState(state, '', location.href);
    } else { this.visit++; this.shuffledOrders.clear(); }
    this.suspended = false; this.warmReturn = true; this.inputRevision = 0;
    this.positionToRestore = this.nativePositionToRestore = continuing ? origin.position || this.lastPosition : this.lastPosition;
    this.initialRefreshPending = true; this.providerRefreshPending = true;
    this.resumeAppearance = true;
    const host = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab');
    const available = ({ element, populated }: { element: HTMLElement; populated: boolean }): boolean => {
      if (!host?.contains(element) || populated && !element.childElementCount) return false;
      for (let node: HTMLElement | null = element; node && node !== host; node = node.parentElement) {
        if (node.hidden || node.classList.contains('hide') || node.style.display === 'none') return false;
      }
      return true;
    };
    // A populated cached native Home can refresh its progress in place. Only
    // an actual native rebuild needs the first-load visibility/readiness gate.
    const rebuilt = !this.initialPaint || !this.root.isConnected || this.root.parentElement !== host
      || this.nativeContent.some(entry => !available(entry));
    if (rebuilt) {
      this.initialPaint = false; this.readiness.destroy(); this.readiness = new HomeReadiness(() => this.attach());
      this.staged ||= { revision: this.revision, inputRevision: 0, sections: this.sections };
    }
    this.observe(); this.channelArtwork.resume();
    const rows = this.activeRows();
    if (this.pendingRender || JSON.stringify(rows.map(row => row.id)) !== this.activeRowIds
      || !continuing && rows.some(row => row.shuffle && !dailyAdvent(row))) void this.render();
    else this.scheduleSeasonCheck();
    this.attach();
    if (this.store.synced || this.providerStore.synced || this.api.getWatchlist || this.api.getHomeLibraryExclusions) {
      this.syncTimer = window.setInterval(this.onVisible, 60_000);
    }
  }

  private openRowItem(itemId: string, card: HTMLElement): void {
    if (this.disposed || this.suspended) return;
    this.rememberPosition();
    // Mark the actual Home history entry, not the film's detail URL. The same
    // film can appear in several rows/tabs or be opened from another library.
    // Explicit card identity also covers pointer activation without focus.
    const token = `${Date.now()}:${++homeItemVisitSequence}`;
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    history.replaceState({ ...state, [homeItemVisitKey]: token }, '', location.href);
    const rect = card.getBoundingClientRect();
    this.itemReturn = { home: location.hash, token,
      position: this.lastPosition && { ...this.lastPosition, focusId: card.dataset.focusId, nativeFocus: undefined,
        anchor: { top: rect.top, left: rect.left } } };
    this.navigate(itemId);
  }

  private refreshAfterPaint(): void {
    if (!this.initialRefreshPending || this.refreshFrame !== undefined || this.refreshTimer !== undefined) return;
    // Let the cached page paint before competing with native Home/Featured for
    // connections. A return visit never needs these reads to render its rows.
    this.refreshFrame = requestAnimationFrame(() => {
      this.refreshFrame = undefined;
      this.refreshTimer = window.setTimeout(() => {
        this.refreshTimer = undefined;
        if (this.disposed || this.suspended) return;
        this.initialRefreshPending = false;
        void this.loadInitialSettings();
      }, 100);
    });
  }

  /** Fetch both preferences in parallel and publish a single initial row set.
   * Cached members may already be loading, but cannot appear before a fresh
   * device knows which provider and collection rows belong to this account. */
  private async loadInitialSettings(): Promise<void> {
    const readProviders = this.providerStore.synced || this.providerRefreshPending;
    this.providerRefreshPending = false;
    this.syncing = this.store.synced; this.providerSyncing = readProviders;
    this.lastSync = this.providerLastSync = Date.now();
    await Promise.all([
      this.store.load().then(settings => {
        if (this.disposed) return;
        const changed = JSON.stringify(settings) !== JSON.stringify(this.settings); this.settings = settings;
        if (changed) void this.render();
      }).catch(() => {}).finally(() => { this.syncing = false; }),
      readProviders ? this.providerStore.load().then(settings => {
        if (this.disposed) return;
        const changed = JSON.stringify(settings) !== JSON.stringify(this.providers); this.providers = settings;
        if (changed) void this.render();
      }).catch(() => {}).finally(() => {
        this.providerSyncing = false;
        if (this.providerRefreshPending) return this.refreshProviders(true);
      }) : Promise.resolve(),
      this.warmReturn ? this.refreshCollectionData().then(changed => { if (changed && !this.disposed) void this.render(); }) : Promise.resolve(),
      this.warmReturn ? this.refreshLibraryExclusions(true) : Promise.resolve()
    ]);
    if (this.disposed) return;
    this.initialSettingsReady = true; this.attach();
  }

  private holdInitialHome(host: HTMLElement): void {
    if (this.initialPaint) return;
    if (this.loadingHost !== host) {
      this.releaseInitialHome(); this.loadingHost = host; this.previousBusy = host.getAttribute('aria-busy');
      host.setAttribute('aria-busy', 'true');
    }
    if (!host.classList.contains('tvl-home-initial-loading')) host.classList.add('tvl-home-initial-loading');
    // A native page can be transformed or scrolled. Its fixed descendants are
    // not viewport-fixed, so the animation always belongs directly to body.
    if (this.warmReturn || !showingHome(host)) this.loadingStatus.remove();
    else if (this.loadingStatus.parentElement !== document.body) document.body.append(this.loadingStatus);
  }
  private releaseInitialHome(): void {
    const host = this.loadingHost;
    if (host) {
      host.classList.remove('tvl-home-initial-loading');
      if (host.getAttribute('aria-busy') === 'true') {
        if (this.previousBusy === null) host.removeAttribute('aria-busy'); else host.setAttribute('aria-busy', this.previousBusy);
      }
    }
    this.loadingStatus.remove(); this.loadingHost = undefined; window.clearTimeout(this.loadingTimer);
  }

  private rememberNativeFocus = (): void => {
    if (this.suspended) return;
    const host = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab');
    const active = document.activeElement;
    if (host && active instanceof HTMLElement && host.contains(active)
      && !active.closest('.tvl-home-collection-row, .tvl-home-provider-row, .tvl-home-collections')) {
      nativeReturnFocus.set(host, { key: this.key, element: active });
    }
    this.queuePositionCapture();
  };

  private positionRows(host: HTMLElement, anchors?: ReturnType<typeof nativeHomeRows>): PositionRow[] {
    if (!anchors && this.positionRowCache?.host === host) return this.positionRowCache.rows;
    const rows = [...(anchors || nativeHomeRows(host)).map(row => ({ key: row.key,
      elements: Array.from(row.element.querySelectorAll<NativeScroller>('.emby-scroller, .itemsContainer')) })),
    ...this.sections.map(section => ({ key: `owned:${section.row.id}`,
      elements: Array.from(section.element.querySelectorAll<NativeScroller>('.tvl-home-row-cards')) }))];
    this.positionRowCache = { host, rows }; return rows;
  }
  private rememberPosition = (): void => {
    if (this.captureFrame !== undefined) { cancelAnimationFrame(this.captureFrame); this.captureFrame = undefined; }
    const host = this.root.parentElement;
    if (this.disposed || this.suspended || !this.initialPaint || !host || !/^#\/?home(?:\/?\?|\/?$)/i.test(location.hash)
      || JSON.stringify([this.api.serverId, this.api.userId]) !== this.accountIdentity
      || this.api.homeCollections && !this.api.homeCollections.isCurrent() || this.api.providerHomes && !this.api.providerHomes.isCurrent()
      || host.closest('.hide,[hidden]') || !host.getClientRects().length || getComputedStyle(host).visibility === 'hidden') return;
    const owners = new Set<HTMLElement>();
    if (document.scrollingElement instanceof HTMLElement) owners.add(document.scrollingElement);
    // Capturing every ancestor is cheap and also covers a container that has
    // just become scrollable. Testing each computed overflow on every focus
    // forces style work; restoring zero on a non-scroller is harmless.
    for (let element: HTMLElement | null = host; element; element = element.parentElement) {
      owners.add(element);
    }
    const active = document.activeElement as HTMLElement | null;
    this.lastPosition = {
      vertical: [...owners].map(element => ({ element, top: element.scrollTop, left: element.scrollLeft })),
      rows: new Map(this.positionRows(host).map(({ key, elements }) => [key, elements.map(element => {
        const position = element.getScrollPosition?.(); return { left: element.scrollLeft, ...(Number.isFinite(position) ? { position } : {}) };
      })])),
      focusId: active && host.contains(active) ? active.dataset.focusId : undefined,
      nativeFocus: active && host.contains(active) && !this.owns(active) ? active : undefined
    };
  };
  private restorePosition(host: HTMLElement): void {
    const saved = this.positionToRestore;
    if (!saved || this.displayedRevision !== this.revision || !showingHome(host)) return;
    const active = document.activeElement;
    if (this.inputRevision || active !== document.body && !host.contains(active)) { this.positionToRestore = undefined; return; }
    let target = saved.focusId ? Array.from(host.querySelectorAll<HTMLElement>('[data-focus-id]')).find(node => node.dataset.focusId === saved.focusId)
      : saved.nativeFocus?.isConnected && host.contains(saved.nativeFocus) ? saved.nativeFocus : undefined;
    // Native viewshow can arrive before the shared row-readiness mask lifts.
    // Keep the exact origin pending until its card can actually receive focus.
    if (target && (target.closest('.hide,[hidden]') || !target.getClientRects().length
      || getComputedStyle(target).visibility === 'hidden')) return;
    this.positionToRestore = undefined;
    if (target && !target.matches(':disabled')) target.focus({ preventScroll: true });
    const apply = () => {
      const rows = this.positionRows(host);
      const owners = new Set([...saved.vertical.map(entry => entry.element), ...rows.flatMap(row => row.elements), document.documentElement, document.body]);
      const styles = Array.from(owners).map(node => ({ node, value: node.style.getPropertyValue('scroll-behavior'), priority: node.style.getPropertyPriority('scroll-behavior') }));
      // Set every owner first: native/theme !important smooth-scroll rules can
      // otherwise start a second animation while saved offsets are applied.
      styles.forEach(({ node }) => node.style.setProperty('scroll-behavior', 'auto', 'important'));
      try {
        for (const { key, elements } of rows) elements.forEach((element, index) => {
          const position = saved.rows.get(key)?.[index]; if (!position) return;
          if (position.position !== undefined && element.scrollToPosition) element.scrollToPosition(position.position, true);
          element.scrollLeft = position.left;
        });
        for (const { element, top, left } of saved.vertical) if (element.isConnected) {
          element.scrollTop = top; element.scrollLeft = left;
        }
        // A fresh visit or a changed collection can move a shuffled item. Keep
        // its current horizontal position visible instead of relying on its slot.
        const rowId = target?.closest<HTMLElement>('[data-home-row]')?.dataset.homeRow;
        const cards = target?.closest<HTMLElement>('.tvl-home-row-cards');
        if (target && cards && this.activeRows().some(row => row.id === rowId && row.shuffle)) {
          const item = target.getBoundingClientRect(), strip = cards.getBoundingClientRect();
          if (item.left < strip.left + 8) cards.scrollLeft += item.left - strip.left - 8;
          else if (item.right > strip.right - 8) cards.scrollLeft += item.right - strip.right + 8;
        }
      } finally {
        styles.forEach(({ node, value, priority }) => {
          if (value) node.style.setProperty('scroll-behavior', value, priority);
          else node.style.removeProperty('scroll-behavior');
        });
      }
      if (target && saved.anchor) restoreHomeItemAnchor(target, saved.anchor);
    };
    apply();
    // Repeat after the browser's immediate Back scroll restoration.
    const inputRevision = this.inputRevision;
    if (this.restoreFrame !== undefined) cancelAnimationFrame(this.restoreFrame);
    this.restoreFrame = requestAnimationFrame(() => {
      this.restoreFrame = undefined;
      if (!this.disposed && !this.suspended && inputRevision === this.inputRevision
        && (document.activeElement === document.body || host.contains(document.activeElement))) apply();
    });
    if (target && saved.anchor) {
      this.holdReturnAnchor(host, target, saved.anchor);
      return;
    }
    // Jellyfin queues a 270ms scroll for its temporary native focus. Returning
    // focus to a custom scroller does not cancel that animation. Seasonal focus
    // handlers are suspended during restoration, so their entry correction
    // cannot help here. Settle once after native scrolling, without refocusing
    // or undoing navigation, pointer input or wheel scrolling made meanwhile.
    window.clearTimeout(this.restoreTimer);
    this.restoreTimer = window.setTimeout(() => {
      this.restoreTimer = undefined;
      if (this.disposed || this.suspended || !showingHome(host)) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !host.contains(active)) return;
      if (inputRevision !== this.inputRevision) {
        // Left/Right during the return keeps the new card and horizontal offset.
        // Only finish aligning that same scene; other input cancels this timer.
        const cards = target?.closest('.tvl-home-row-cards');
        if (!cards || active.closest('.tvl-home-row-cards') !== cards) return;
      } else {
        if (saved.focusId ? active.dataset.focusId !== saved.focusId : active !== target) return;
        target = active; // Background metadata can replace the same logical card.
        apply();
      }
      if (active.closest('.tvl-seasonal-row .tvl-home-row-card')) {
        const settledInput = this.inputRevision;
        settleSeasonalSelection(() => !this.disposed && !this.suspended && settledInput === this.inputRevision
          && document.activeElement === active && showingHome(host));
      }
    }, 350);
  }
  private holdReturnAnchor(host: HTMLElement, target: HTMLElement, position: HomeItemAnchor): void {
    this.cancelReturnScroll();
    const guard = this.returnAnchor = { home: location.hash, host, target, position, cards: target.closest<HTMLElement>('.tvl-home-row-cards'),
      inputRevision: this.inputRevision, width: window.innerWidth, height: window.innerHeight, observer: undefined as ResizeObserver | undefined };
    // Native scrolling starts on its first animation frame, which can be late
    // on a TV. Follow actual scroll/layout events instead of guessing its end
    // from a wall-clock delay. No work runs on frames without a change.
    if (typeof ResizeObserver === 'function') {
      guard.observer = new ResizeObserver(this.queuePositionCapture);
      guard.observer.observe(host);
      host.querySelectorAll('.sections,.homeSectionsContainer').forEach(node => guard.observer!.observe(node));
    }
    this.restoreTimer = window.setTimeout(() => { this.correctReturnAnchor(); this.cancelReturnScroll(); }, 5_000);
  }
  private correctReturnAnchor(): void {
    const guard = this.returnAnchor;
    if (!guard || this.disposed || this.suspended) return;
    if (location.hash !== guard.home) { this.cancelReturnScroll(); return; }
    if (!showingHome(guard.host)) return;
    if (window.innerWidth !== guard.width || window.innerHeight !== guard.height) { this.cancelReturnScroll(); return; }
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !guard.host.contains(active)) return;
    const horizontal = guard.inputRevision === this.inputRevision;
    if (horizontal) {
      if (active !== guard.target && (!guard.target.dataset.focusId || active.dataset.focusId !== guard.target.dataset.focusId)) return;
      guard.target = active; guard.cards = active.closest<HTMLElement>('.tvl-home-row-cards');
    } else if (!guard.cards || active.closest('.tvl-home-row-cards') !== guard.cards) {
      this.cancelReturnScroll(); return;
    }
    if (active.closest('.hide,[hidden]') || !active.getClientRects().length || getComputedStyle(active).visibility === 'hidden') return;
    // Left/Right keeps the newly selected item and its horizontal scroll; only
    // the same row's vertical position remains protected from native movement.
    restoreHomeItemAnchor(active, guard.position, horizontal);
  }
  private cancelReturnScroll(): void {
    window.clearTimeout(this.restoreTimer); this.restoreTimer = undefined;
    this.returnAnchor?.observer?.disconnect(); this.returnAnchor = undefined;
  }
  private queuePositionCapture = (): void => {
    if (this.suspended) return;
    if (this.captureFrame !== undefined) return;
    this.captureFrame = requestAnimationFrame(() => { this.captureFrame = undefined; this.correctReturnAnchor(); this.rememberPosition(); });
  };
  private onNativeShow = (event: Event): void => {
    if (this.suspended) return;
    const host = this.root.parentElement, page = event.target;
    if (!host || !(page instanceof HTMLElement) || !page.contains(host)) return;
    if (showingHome(host)) void this.refreshSettings(true);
    if (!this.nativePositionToRestore) return;
    const saved = this.nativePositionToRestore; this.nativePositionToRestore = undefined;
    // Jellyfin unhides its cached view, then auto-focuses it before viewshow.
    // Restore once after that native step; real input always takes priority.
    if (!this.inputRevision && showingHome(host)) { this.positionToRestore = saved; this.restorePosition(host); }
  };
  private onWheel = (): void => { if (this.suspended) return; this.cancelReturnScroll(); this.inputRevision++; this.positionToRestore = undefined; };

  private onVisible = (event?: Event): void => {
    // Returning to an open Home must not be skipped by the polling throttle.
    if (document.visibilityState !== 'hidden') void this.refreshSettings(!!event);
  };
  private onProviderStorage = (event: StorageEvent): void => {
    if (event.storageArea === localStorage && event.key === this.providerStore.key) void this.refreshProviders(true);
  };
  private onProviderSaved = (event: Event): void => {
    const account = (event as CustomEvent).detail;
    if (account && account.serverId === this.api.serverId && account.userId === this.api.userId) void this.refreshProviders(true);
  };
  private async refreshProviders(force: boolean): Promise<void> {
    if (this.suspended) { this.providerRefreshPending ||= force; return; }
    if (this.initialRefreshPending) { this.providerRefreshPending ||= force; return; }
    if (this.disposed || JSON.stringify([this.api.serverId, this.api.userId]) !== this.accountIdentity
      || !force && (!this.providerStore.synced || Date.now() - this.providerLastSync < 5_000)) return;
    // A save may finish while the initial/polling read is still in flight.
    // Queue another read so that older response cannot swallow the notification.
    if (this.providerSyncing) { this.providerRefreshPending ||= force; return; }
    this.providerRefreshPending = false;
    this.providerSyncing = true; this.providerLastSync = Date.now();
    let changed = false;
    try {
      const settings = await this.providerStore.load();
      if (this.disposed) return;
      changed ||= JSON.stringify(settings) !== JSON.stringify(this.providers);
      this.providers = settings;
    } catch { /* Home keeps its account-scoped cache when sync is unavailable. */ }
    finally { this.providerSyncing = false; }
    if (this.disposed) return;
    // Do not leave a confirmed save waiting behind collection artwork fetches.
    if (this.providerRefreshPending) void this.refreshProviders(true);
    if (changed) await this.render();
  }
  async refreshSettings(force = false): Promise<void> {
    if (this.disposed || this.suspended) return;
    this.refreshSeasons();
    void this.refreshLibraryExclusions(force);
    if (this.initialRefreshPending) { this.providerRefreshPending ||= force; return; }
    void this.refreshProviders(force);
    if (!this.store.synced && this.activeRows().some(row => row.kind === 'watchlist') && (force || Date.now() - this.lastWatchlistSync >= 5_000)) {
      this.lastWatchlistSync = Date.now();
      if (await this.refreshWatchlist() && !this.disposed) await this.render();
    }
    if (this.disposed || !this.store.synced || this.syncing || !force && Date.now() - this.lastSync < 5_000) return;
    this.syncing = true; this.lastSync = Date.now();
    try {
      const settings = await this.store.load(); if (this.disposed) return;
      const settingsChanged = JSON.stringify(settings) !== JSON.stringify(this.settings);
      this.settings = settings;
      const membersChanged = await this.refreshItems();
      if (this.disposed || !this.api.homeCollections?.isCurrent()) return;
      if (settingsChanged || membersChanged || this.renderRetry) {
        const active = document.activeElement as HTMLElement | null;
        if (this.owns(active)) this.restoreFocus = active?.dataset.focusId;
        await this.render(true);
      }
    } catch {
      // Background sync stays quiet on Home and preserves the last loaded rows.
      // The editor still reports load/save failures so unsaved edits are clear.
    } finally { this.syncing = false; }
  }

  private refreshLibraryExclusions(force = false): Promise<void> {
    if (this.exclusionsRequest) { this.exclusionsRefreshPending ||= force; return this.exclusionsRequest; }
    if (this.disposed || this.suspended || !this.api.getHomeLibraryExclusions || !force && Date.now() - this.lastExclusionsRead < 5_000) return Promise.resolve();
    this.lastExclusionsRead = Date.now();
    const current = () => !this.disposed && !this.suspended && JSON.stringify([this.api.serverId, this.api.userId]) === this.accountIdentity
      && (!this.api.homeCollections || this.api.homeCollections.isCurrent());
    const request = this.api.getHomeLibraryExclusions().then(ids => {
      if (!current()) return;
      lastHomeExclusions = { key: this.key, ids: ids.slice() };
      this.libraryVisibility.setExclusions(ids);
    }).catch(() => {
      // Keep known exclusions through a transient error. A first-time failure
      // leaves native Home usable and retries when it regains focus.
    }).finally(() => {
      if (this.exclusionsRequest === request) this.exclusionsRequest = undefined;
      if (current()) {
        this.exclusionsReady = true; this.attach();
        if (this.exclusionsRefreshPending) { this.exclusionsRefreshPending = false; void this.refreshLibraryExclusions(true); }
      }
    });
    this.exclusionsRequest = request; return request;
  }

  private refreshSeasons = (): void => {
    if (this.disposed || this.suspended) return;
    this.sections.forEach(section => refreshSeasonalDate(section.element));
    const ids = JSON.stringify(this.activeRows().map(row => row.id));
    if (ids !== this.activeRowIds) void this.render();
    else this.scheduleSeasonCheck();
  };
  private scheduleSeasonCheck(): void {
    window.clearTimeout(this.seasonalTimer);
    if (!this.settings.rows.some(row => row.kind === 'seasonal')) return;
    const now = new Date();
    const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    // Use local calendar dates, including DST. Visibility/focus also rechecks
    // after a sleeping TV wakes, without waiting for a server settings request.
    this.seasonalTimer = window.setTimeout(this.refreshSeasons, nextDay.getTime() - now.getTime() + 50);
  }

  private displayItems(items: Item[], row: HomeCollectionRow, sourceId: string): Item[] {
    if (!row.shuffle || dailyAdvent(row)) return items;
    const key = JSON.stringify([row.id, sourceId]);
    const previous = this.shuffledOrders.get(key) || [];
    const byId = new Map(items.map(item => [item.Id, item]));
    const retained = previous.filter(id => byId.has(id));
    const seen = new Set(retained);
    const order = [...retained, ...shuffleHomeItems(items.filter(item => !seen.has(item.Id))).map(item => item.Id)];
    this.shuffledOrders.set(key, order);
    return order.map(id => byId.get(id)!);
  }

  private collectionItems(id: string): Promise<Item[]> {
    let cached = this.items.get(id);
    if (!cached) {
      const entry: CollectionItems = { promise: this.api.getCollectionItems(id).then(items => {
        entry.fingerprint = JSON.stringify(items); entry.value = items; return items;
      }).catch(error => { if (this.items.get(id) === entry) this.items.delete(id); throw error; }) };
      this.items.set(id, entry); cached = entry;
    }
    return cached.promise;
  }

  private watchlistItems(): Promise<Item[]> {
    if (!this.watchlist) {
      const entry: CollectionItems = { promise: getAllWatchlistItems(this.api).then(items => {
        entry.fingerprint = JSON.stringify(items); entry.value = items; return items;
      }).catch(error => { if (this.watchlist === entry) this.watchlist = undefined; throw error; }) };
      this.watchlist = entry;
    }
    return this.watchlist.promise;
  }
  private async refreshWatchlist(): Promise<boolean> {
    if (!this.activeRows().some(row => row.kind === 'watchlist')) return false;
    const before = this.watchlist;
    try {
      const items = await getAllWatchlistItems(this.api);
      if (this.disposed || this.watchlist !== before || JSON.stringify([this.api.serverId, this.api.userId]) !== this.accountIdentity) return false;
      const fingerprint = JSON.stringify(items);
      if (fingerprint === before?.fingerprint) return false;
      this.watchlist = { promise: Promise.resolve(items), value: items, fingerprint }; return true;
    } catch { return false; }
  }

  private collectionList(refresh = false): Promise<Item[]> {
    if (!refresh && this.collections) return Promise.resolve(this.collections);
    if (this.collectionRequest) return this.collectionRequest;
    const request = Promise.resolve().then(() => this.api.getCollectionList()).then(items => {
      if (!this.disposed) this.collections = items;
      return items;
    }).finally(() => { if (this.collectionRequest === request) this.collectionRequest = undefined; });
    this.collectionRequest = request; return request;
  }
  private async refreshCollectionData(): Promise<boolean> {
    const before = JSON.stringify(this.collections);
    const [listChanged, membersChanged] = await Promise.all([
      // A first row may have been added on another device while Home was away.
      // Fetch alongside preferences even when the old settings had no rows.
      this.collectionList(true).then(items => JSON.stringify(items) !== before).catch(() => false),
      this.refreshItems()
    ]);
    return listChanged && this.activeRows().length > 0 || membersChanged;
  }

  private refreshItems(): Promise<boolean> {
    // Focus/visibility events may arrive while the initial background batch is
    // still running. Join it instead of creating another pair of workers.
    if (!this.itemRefresh) {
      const refresh = this.refreshItemsBatch().finally(() => { if (this.itemRefresh === refresh) this.itemRefresh = undefined; });
      this.itemRefresh = refresh;
    }
    return this.itemRefresh;
  }
  private async refreshItemsBatch(): Promise<boolean> {
    // Membership and source order can change without a settings revision (for
    // example after SmartLists refreshes). Revalidate visited sources quietly;
    // keep successful data during failures and leave unchanged DOM/focus alone.
    const sources = new Set(this.activeRows().filter(row => row.kind === 'items').flatMap(row => homeCollectionTabs(row).map(tab => tab.collectionId)));
    let changed = false;
    const pending = Array.from(this.items).filter(([id, entry]) => {
      if (!sources.has(id)) { this.items.delete(id); return false; }
      return entry.fingerprint !== undefined;
    });
    // A user can visit many collection tabs. Revalidating all of them at once
    // saturates the server's connection pool; reserve capacity for navigation.
    const current = () => !this.disposed && !this.suspended && JSON.stringify([this.api.serverId, this.api.userId]) === this.accountIdentity
      && (!this.api.homeCollections || this.api.homeCollections.isCurrent());
    const refreshNext = async () => {
      while (pending.length && current()) {
        const [id, entry] = pending.shift()!;
        try {
          const items = await this.api.getCollectionItems(id);
          if (!current() || this.items.get(id) !== entry) continue;
          const fingerprint = JSON.stringify(items);
          if (fingerprint === entry.fingerprint) continue;
          this.items.set(id, { promise: Promise.resolve(items), fingerprint, value: items }); changed = true;
        } catch { /* Keep the last successfully loaded members until a later poll. */ }
      }
    };
    const [, , watchlistChanged] = await Promise.all([refreshNext(), refreshNext(), this.refreshWatchlist()]);
    return changed || watchlistChanged;
  }

  private attach(): void {
    if (this.disposed || this.suspended) return;
    // Membership/visibility/native order may have changed. Between attachments
    // key, focus and scroll events only need the existing scroller references.
    this.positionRowCache = undefined;
    const host = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab');
    if (!host) return;
    this.libraryVisibility.sync(host);
    const excludedFocus = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>(`.${homeLibraryExcludedClass}`) : null;
    if (excludedFocus) {
      const visible = Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]'))
        .filter(node => !node.closest(`.hide,[hidden],.${homeLibraryExcludedClass}`) && node.getClientRects().length > 0
          && getComputedStyle(node).visibility !== 'hidden');
      this.focus(visible.find(node => !!(excludedFocus.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) || visible[visible.length - 1]);
    }
    this.holdInitialHome(host);
    let staged = this.staged;
    if (staged?.sections && staged.sourceRevision !== this.sourceRevision) {
      void this.prepare(staged); staged = undefined;
    }
    const initialRowsReady = this.initialSettingsReady && this.exclusionsReady && !!staged && staged.revision === this.revision;
    // Cached content skips network waits, not native layout settlement: reveal
    // every row together, even when Jellyfin rebuilds its Home during Back.
    if (!this.readiness.update(host, this.initialPaint || initialRowsReady, this.warmReturn)) return;
    if (this.root.parentElement !== host) host.append(this.root);
    let focusId: string | undefined;
    let focusRow: string | undefined;
    let movedFocus: HTMLElement | undefined;
    if (staged && staged.revision === this.revision) {
      this.staged = undefined;
      if (staged.sections) {
        const active = document.activeElement as HTMLElement | null;
        focusId = this.owns(active) ? active?.dataset.focusId : staged.inputRevision === this.inputRevision ? this.restoreFocus : undefined;
        if (this.owns(active)) focusRow = active?.closest<HTMLElement>('[data-home-row]')?.dataset.homeRow;
        this.restoreFocus = undefined;
        const positions = new Map(this.sections.map(section => [section.row.id, section.element.querySelector<HTMLElement>('.tvl-home-row-cards')?.scrollLeft || 0]));
        this.sections.forEach(section => { if (!staged.sections!.includes(section)) { section.dispose?.(); section.element.remove(); } });
        this.sections = staged.sections; this.displayedRevision = staged.revision;
        this.renderRetry = !!staged.retry;
        for (const section of this.sections) {
          const cards = section.element.querySelector<HTMLElement>('.tvl-home-row-cards');
          if (cards) cards.dataset.restoreScroll = String(positions.get(section.row.id) || 0);
        }
        const ids = new Set(this.sections.map(section => section.row.id));
        for (const id of this.selectedSources.keys()) if (!ids.has(id)) this.selectedSources.delete(id);
      }
      // An error keeps the mounted rows, including focused end-position rows.
      // Only replace status children; clearing root would detach those rows.
      for (const child of Array.from(this.root.children)) if (!this.sections.some(section => section.element === child)) child.remove();
      if (staged.error) this.root.append(staged.error);
    }
    const anchors = nativeHomeRows(host);
    rememberHomeRows(this.key, anchors);
    // Process backwards so rows that share an insertion point keep their order.
    const nextAt = new Map<HTMLElement, HTMLElement>();
    for (const { row, element } of this.sections.slice().reverse()) {
      const anchor = row.placement === 'start' ? anchors[0] : anchors.find(anchor => anchor.key === row.placement);
      const point = anchor?.element || this.root;
      const target = nextAt.get(point) || anchor?.element;
      const parent = target?.parentElement || this.root;
      // DOM adjacency alone is insufficient in a CSS-ordered native Home.
      // Share the anchor's order so insertBefore is also visually before it.
      const order = anchor ? getComputedStyle(anchor.element).order : '';
      if (element.style.order !== order) element.style.order = order;
      if (target) {
        if (element.parentElement !== parent || element.nextElementSibling !== target) {
          if (element.contains(document.activeElement)) movedFocus = document.activeElement as HTMLElement;
          parent.insertBefore(element, target);
        }
      } else if (element.parentElement !== parent || element !== parent.lastElementChild) {
        if (element.contains(document.activeElement)) movedFocus = document.activeElement as HTMLElement;
        parent.append(element);
      }
      refreshSeasonalBackdrop(element);
      nextAt.set(point, element);
      const cards = element.querySelector<HTMLElement>('.tvl-home-row-cards');
      if (cards?.dataset.restoreScroll !== undefined) { cards.scrollLeft = Number(cards.dataset.restoreScroll); delete cards.dataset.restoreScroll; }
    }
    this.positionRows(host, anchors);
    if (showingHome(host)) this.nativeContent = Array.from(host.querySelectorAll<HTMLElement>('.sections .itemsContainer, .homeSectionsContainer .itemsContainer, .homeLibraryButton, .sections .centerMessage'))
      .filter(element => !element.closest('.tvl-home-collection-row,.tvl-home-provider-row,.hide,[hidden]'))
      .map(element => ({ element, populated: element.childElementCount > 0 }));
    // Commit and position every owned row before revealing either row family.
    // Readiness has a bounded fallback, so an unavailable source cannot trap Home.
    const firstPaint = !this.initialPaint;
    this.initialPaint = true; this.releaseInitialHome();
    if ((focusId || focusRow) && !(document.activeElement instanceof HTMLElement && document.activeElement.isConnected
      && this.owns(document.activeElement) && document.activeElement.dataset.focusId === focusId)) {
      const target = this.sections.flatMap(section => Array.from(section.element.querySelectorAll<HTMLElement>('[data-focus-id]'))).find(node => node.dataset.focusId === focusId);
      const retainedRow = this.sections.find(section => section.row.id === focusRow)?.element;
      const nearby = Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]'))
        .filter(node => !node.closest('.hide, [hidden]') && node.getClientRects().length > 0);
      this.focus(target || retainedRow?.querySelector<HTMLElement>('[aria-selected="true"]') || retainedRow?.querySelector<HTMLElement>('button')
        || nearby.find(node => !retainedRow || !!(retainedRow.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) || nearby[nearby.length - 1]);
    }
    else if (movedFocus?.isConnected) this.focus(movedFocus);
    else if (firstPaint && !this.inputRevision && document.activeElement === document.body) {
      const saved = nativeReturnFocus.get(host);
      const usable = (node: HTMLElement): boolean => !node.closest('.hide,[hidden]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
      const target = saved?.key === this.key && saved.element.isConnected && host.contains(saved.element) && usable(saved.element)
        ? saved.element : undefined;
      // Preserve native Back restoration before TV's first-control fallback;
      // neither path takes focus from a header control or subsequent user input.
      const first = !target && !isDesktopLayout() ? Array.from(host.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]')).find(usable) : undefined;
      (target || first)?.focus({ preventScroll: true });
    }
    this.restorePosition(host);
    if (this.resumeAppearance && showingHome(host)) {
      this.resumeAppearance = false;
      this.sections.forEach(section => { resumeSeasonalRow(section.element); refreshSeasonalDate(section.element); });
    }
    this.correctReturnAnchor();
    this.refreshAfterPaint();
  }

  private async prepare(staged: StagedRows): Promise<void> {
    if (this.preparing === staged) return;
    this.preparing = staged;
    try {
      // The old rows stay usable while members for a newly selected source load.
      // Reconcile again if the user changes tabs during that asynchronous work.
      while (!this.disposed && this.staged === staged && staged.revision === this.revision) {
        const sourceRevision = this.sourceRevision;
        await Promise.all(staged.sections!.map(section => section.reconcileSource()));
        if (this.disposed || this.staged !== staged || staged.revision !== this.revision) return;
        if (sourceRevision === this.sourceRevision) {
          staged.sourceRevision = sourceRevision; this.attach(); return;
        }
      }
    } finally { if (this.preparing === staged) this.preparing = undefined; }
  }

  private focus(node?: HTMLElement, horizontal = false): void {
    node?.focus({ preventScroll: true });
    if (node && !scrollSeasonalSelectionIntoView(node, !horizontal)) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  private owns(node: Element | null): boolean { return !!node && this.sections.some(section => section.element.contains(node)); }
  private move(direction: string): boolean {
    const active = document.activeElement as HTMLElement;
    const host = this.root.parentElement;
    if (!host?.contains(active) || active.matches('input,textarea,select') || active.closest('.ec-root')) return false;
    const candidates = (group: HTMLElement) => Array.from(group.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]'));
    const usable = (node: HTMLElement) => !node.matches(':disabled') && !node.closest('.hide,[hidden]')
      && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    if (direction === 'left' || direction === 'right') {
      if (!this.owns(active)) return false;
      // Horizontal movement cannot cross rows. Avoid measuring every native
      // and collection row for each remote repeat while sliding one strip.
      const group = active.closest<HTMLElement>('.focuscontainer-x');
      if (!group || group.querySelector('.focuscontainer-x')) return false;
      const current = candidates(group), index = current.indexOf(active);
      if (index < 0) return false;
      // Membership is read fresh, but only the next usable neighbour needs a
      // layout/style check. Measuring all 60 posters makes every remote repeat
      // pay for offscreen items, even when moving just one place.
      const step = direction === 'right' ? 1 : -1;
      for (let next = index + step; next >= 0 && next < current.length; next += step) {
        if (usable(current[next])) { this.focus(current[next], true); break; }
      }
      return true;
    }
    const groups = Array.from(host.querySelectorAll<HTMLElement>('.focuscontainer-x, .ec-root'))
      .filter(group => !group.querySelector('.focuscontainer-x') && candidates(group).some(usable))
      // Native navigation uses screen geometry. Follow that same row order at
      // custom/native boundaries even when another plugin reorders native DOM.
      .map(group => ({ group, top: seasonalNavigationTop(group) }))
      .sort((a, b) => a.top - b.top).map(({ group }) => group);
    const groupIndex = groups.findIndex(group => group.contains(active));
    if (groupIndex < 0) return false;
    const current = candidates(groups[groupIndex]), activeIndex = current.indexOf(active);
    if (activeIndex < 0 || !usable(active)) return false;
    // Preserve the visible column without measuring posters after either
    // selection. Only a shorter destination needs a scan to its final item.
    const index = current.slice(0, activeIndex).filter(usable).length;
    const next = groups[groupIndex + (direction === 'down' ? 1 : -1)];
    if (!this.owns(active) && !this.owns(next)) return false;
    if (next) {
      const sameRow = active.closest('.tvl-home-collection-row') === next.closest('.tvl-home-collection-row');
      if (sameRow && next.classList.contains('tvl-home-source-tabs')) this.focus(next.querySelector<HTMLElement>('[aria-selected="true"]') || undefined);
      else {
        const targetIndex = sameRow && groups[groupIndex].classList.contains('tvl-home-source-tabs') ? 0 : index;
        let target: HTMLElement | undefined, visibleIndex = 0;
        for (const node of candidates(next)) if (usable(node)) {
          target = node;
          if (visibleIndex++ === targetIndex) break;
        }
        this.focus(target);
      }
    }
    return !!next;
  }
  private onKey = (event: KeyboardEvent): void => {
    if (this.suspended) return;
    this.inputRevision++;
    const direction: Record<string, string> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) this.cancelReturnScroll();
    // Arrow, focus and scroll events share one snapshot per frame. Activation,
    // Back and shortcuts still save synchronously before native routing runs.
    if (direction[event.key] && !event.altKey && !event.ctrlKey && !event.metaKey) this.queuePositionCapture();
    else this.rememberPosition();
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (direction[event.key] && this.move(direction[event.key])) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private onCommand = (event: Event): void => {
    if (this.suspended) return;
    this.inputRevision++;
    const command = (event as CustomEvent).detail?.command?.toLowerCase();
    if (!['left', 'right'].includes(command)) this.cancelReturnScroll();
    if (['left', 'right', 'up', 'down'].includes(command)) this.queuePositionCapture(); else this.rememberPosition();
    if (['left', 'right', 'up', 'down'].includes(command) && this.move(command)) { event.preventDefault(); event.stopImmediatePropagation(); }
    else if (this.owns(document.activeElement) && ['select', 'enter', 'ok'].includes(command)) {
      event.preventDefault(); event.stopImmediatePropagation(); (document.activeElement as HTMLElement).click();
    }
  };
  private onPointer = (): void => { if (this.suspended) return; this.cancelReturnScroll(); this.rememberPosition(); this.inputRevision++; };
  private current(revision: number): boolean { return !this.disposed && (revision === this.revision || revision === this.displayedRevision); }
  private removeInactiveRows(rows: HomeCollectionRow[]): void {
    const ids = new Set(rows.map(row => row.id));
    const expired = this.sections.filter(section => !section.element.classList.contains('tvl-home-provider-row') && !ids.has(section.row.id));
    if (!expired.length) return;
    const active = document.activeElement as HTMLElement | null;
    const focused = expired.find(section => active && section.element.contains(active));
    const controls = focused ? Array.from(this.root.parentElement?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],[tabindex="0"]') || [])
      .filter(node => !expired.some(section => section.element.contains(node)) && !node.closest('.hide,[hidden]') && node.getClientRects().length > 0) : [];
    const next = focused && (controls.find(node => !!(focused.element.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) || controls[controls.length - 1]);
    // Do not leave yesterday's rows visible while tomorrow's source loads.
    expired.forEach(section => { section.dispose?.(); section.element.remove(); this.selectedSources.delete(section.row.id); });
    this.sections = this.sections.filter(section => !expired.includes(section));
    this.positionRowCache = undefined;
    if (next) this.focus(next);
  }
  private async render(refreshList = false): Promise<void> {
    if (this.disposed) return;
    if (this.suspended) { this.pendingRender = true; return; }
    this.pendingRender = false;
    const revision = ++this.revision;
    const rows = this.activeRows();
    this.activeRowIds = JSON.stringify(rows.map(row => row.id));
    this.scheduleSeasonCheck();
    const inputRevision = this.inputRevision;
    this.staged = undefined;
    this.removeInactiveRows(rows);
    const providerIdentity = JSON.stringify(this.providers);
    const existingProvider = this.sections.find(section => section.row.id === 'provider-homes:brands' && section.identity === providerIdentity);
    const providerElement = !existingProvider && this.openProvider ? providerHomeRow(this.providers, this.openProvider, this.api) : null;
    const providerRows: RenderedRow[] = existingProvider ? [existingProvider] : providerElement ? [{ row: { id: 'provider-homes:brands', placement: this.providers.placement },
      element: providerElement, identity: providerIdentity, reconcileSource: async () => {} }] : [];
    if (!rows.length) { this.staged = { revision, inputRevision, sections: providerRows }; this.attach(); return; }
    try {
      const available = new Map((rows.some(row => row.kind !== 'watchlist') ? await this.collectionList(refreshList) : []).map(item => [item.Id, item]));
      if (this.disposed || revision !== this.revision) return;
      if (this.suspended) { this.pendingRender = true; return; }
      const rendered = await Promise.all(rows.map(row => {
        const identity = this.rowIdentity(row, available);
        return this.sections.find(section => section.row.id === row.id && section.identity === identity) || this.section(row, available, revision);
      }));
      if (this.disposed || revision !== this.revision) return;
      if (this.suspended) { this.pendingRender = true; return; }
      this.staged = { revision, inputRevision, sections: [...providerRows, ...rendered.filter((row): row is RenderedRow => row !== null)] }; this.attach();
    } catch {
      if (this.disposed || revision !== this.revision) return;
      this.renderRetry = true;
      const error = el('div', 'tvl-home-row-status'); error.setAttribute('role', 'status');
      error.append(el('p', '', 'Não foi possível carregar as fileiras da Página Inicial.'), button('Tentar novamente', '', '', () => { void this.render(true); }));
      this.staged = { revision, inputRevision, error, retry: true,
        sections: [...providerRows, ...this.sections.filter(section => rows.some(row => row.id === section.row.id))] }; this.attach();
    }
  }

  private rowIdentity(row: HomeCollectionRow, available: Map<string, Item>): string {
    return JSON.stringify([row, row.shuffle && !dailyAdvent(row) ? this.visit : 0,
      row.collectionIds.map(id => available.get(id)),
      row.kind === 'watchlist' ? this.watchlist?.fingerprint : row.kind === 'items'
        ? homeCollectionTabs(row).map(tab => [available.get(tab.collectionId), this.items.get(tab.collectionId)?.fingerprint]) : null]);
  }

  private async section(row: HomeCollectionRow, available: Map<string, Item>, revision: number): Promise<RenderedRow | null> {
    let alive = true;
    let rendered: RenderedRow | undefined;
    // Reused rows keep their own handlers across unrelated render revisions.
    const current = () => {
      if (this.suspended) { this.pendingRender = true; if (rendered) rendered.identity = undefined; return false; }
      return alive && !this.disposed && (this.current(revision) || this.sections.some(row => row.element === section));
    };
    const chosen = row.collectionIds.map(id => available.get(id)).filter((item): item is Item => !!item);
    const title = row.title || (row.kind === 'watchlist' ? 'Minha Lista' : row.kind === 'collections' ? 'Coleções' : chosen[0]?.Name || 'Coleção');
    const section = el('section', 'verticalSection tvl-home-collection-row');section.dataset.homeRow = row.id;
    section.setAttribute('aria-label', title);
    const header = el('div', 'tvl-home-row-header');
    header.append(el('h2', 'tvl-home-row-title', title));
    const cards = el('div', 'tvl-home-row-cards focuscontainer-x');cards.setAttribute('role', 'list');
    attachRowScrollButtons(header, cards);
    section.append(header);
    if (row.appearance) {
      // Jellyfin queues its own TV focus animation after focusin. Seasonal
      // cards already position both axes, so opt out through its scroller
      // contract instead of letting native card centering move the scene.
      cards.dataset.scrollModeX = 'custom'; cards.dataset.scrollModeY = 'custom';
    }
    const tabs = homeCollectionTabs(row);
    const tabbed = row.kind === 'items' && !!row.tabs?.length;
    const prefix = `tvl-home-${encodeURIComponent(row.id)}`;
    const focusPrefix = (tabId: string) => `home-tab:${encodeURIComponent(row.id)}:${encodeURIComponent(tabId)}:`;
    const tabFocusId = (tabId: string) => `home-source:${encodeURIComponent(row.id)}:${encodeURIComponent(tabId)}`;
    let selected = tabs.find(tab => tab.id === this.selectedSources.get(row.id))
      || tabs.find(tab => this.restoreFocus?.startsWith(focusPrefix(tab.id)) || this.restoreFocus === tabFocusId(tab.id)) || tabs[0];
    this.selectedSources.set(row.id, selected.id);
    let sourceRevision = 0;
    let strip: HTMLElement | undefined;
    const panel = el('div');
    if (tabbed) {
      strip = homeRowTabs(tabs.map(tab => ({ id: tab.id, label: homeTabLabel(tab, available.get(tab.collectionId)) })), selected.id, id => {
        const tab = tabs.find(tab => tab.id === id); if (!tab || !current()) return;
        this.selectedSources.set(row.id, id); this.sourceRevision++;
        selected = tab;
        strip!.querySelectorAll<HTMLElement>('[data-source-tab]').forEach(control => {
          const active = control.dataset.sourceTab === id; control.setAttribute('aria-selected', String(active)); control.tabIndex = active ? 0 : -1;
        });
        void renderItems();
      }, prefix);
      strip.querySelectorAll<HTMLElement>('[data-source-tab]').forEach(control => { control.dataset.focusId = tabFocusId(control.dataset.sourceTab!); });
      section.append(strip);
      panel.id = `${prefix}-items`; panel.setAttribute('role', 'tabpanel');
    }
    panel.append(cards); section.append(panel);
    const renderItems = async (): Promise<void> => {
      const currentSource = ++sourceRevision, source = selected;
      const collection = available.get(source.collectionId);
      replace(cards); cards.scrollLeft = 0; cards.removeAttribute('aria-busy');
      if (tabbed) panel.setAttribute('aria-labelledby', `${prefix}-tab-${encodeURIComponent(source.id)}`);
      if (row.kind !== 'watchlist' && (row.kind === 'items' ? !collection : !chosen.length)) {
        cards.append(el('p', 'tvl-home-row-status', 'Nenhuma coleção acessível selecionada.')); return;
      }
      cards.setAttribute('aria-busy', 'true');
      cards.append(el('p', 'tvl-home-row-status', row.kind === 'watchlist' ? 'Carregando Minha Lista…' : 'Carregando coleção…'));
      try {
        const ordered = row.kind === 'watchlist' ? orderHomeItems(await this.watchlistItems(), row) : row.kind === 'items' ? orderHomeItems(await this.collectionItems(collection!.Id), source) : chosen;
        if (!current() || currentSource !== sourceRevision) return;
        const items = this.displayItems(ordered, row, row.kind === 'items' ? source.collectionId : row.kind);
        replace(cards);
        let shown = 0;
        const more = button('Mostrar mais da Minha Lista', 'grid', '', () => {
          const next = shown; more.remove(); appendItems();
          cards.querySelector<HTMLElement>(`[data-watchlist-index="${next}"]`)?.focus();
        });
        const appendItems = (limit = 60) => {
          for (const [offset, item] of items.slice(shown, shown + limit).entries()) {
            const index = shown + offset;
            const entry = el('div', 'tvl-home-row-entry'); entry.setAttribute('role', 'listitem');
            const card = homeRowCard(this.api, item, row.ranked ? index + 1 : undefined, () => this.openRowItem(item.Id, card), row, index);
            card.dataset.focusId = tabbed ? `${focusPrefix(source.id)}${encodeURIComponent(item.Id)}` : `home:${row.id}:${item.Id}`;
            if (row.kind === 'watchlist') card.dataset.watchlistIndex = String(index);
            entry.append(card); cards.append(entry);
          }
          shown = Math.min(items.length, shown + limit);
          if (row.kind === 'watchlist') this.watchlistShown.set(row.id, shown);
          if (row.kind === 'watchlist' && shown < items.length) { more.dataset.focusId = `home:${row.id}:more`; cards.append(more); }
        };
        const restore = this.restoreFocus || this.positionToRestore?.focusId;
        if (row.kind === 'items' && row.shuffle && !dailyAdvent(row) && restore && items.length > 60) {
          const restoredIndex = items.findIndex(item => restore === (tabbed ? `${focusPrefix(source.id)}${encodeURIComponent(item.Id)}` : `home:${row.id}:${item.Id}`));
          // Keep Back's selected card reachable in the bounded Home preview,
          // even if this visit's shuffle placed it in the full-collection tail.
          if (restoredIndex >= 60) {
            items.splice(59, 0, items.splice(restoredIndex, 1)[0]);
            this.shuffledOrders.set(JSON.stringify([row.id, source.collectionId]), items.map(item => item.Id));
          }
        }
        const focusedIndex = row.kind === 'watchlist' ? items.findIndex(item => restore === `home:${row.id}:${item.Id}`) : -1;
        appendItems(Math.max(60, row.kind === 'watchlist' ? this.watchlistShown.get(row.id) || 0 : 0, Math.ceil((focusedIndex + 1) / 60) * 60));
        if (!items.length && row.kind !== 'watchlist') cards.append(el('p', 'tvl-home-row-status', 'Esta coleção está vazia.'));
        if (row.kind === 'items' && items.length > 60) {
          const full = button('Ver coleção completa', 'grid', '', () => this.navigate(collection!.Id));
          if (tabbed) full.dataset.focusId = `${focusPrefix(source.id)}full-collection`;
          cards.append(full);
        }
      } catch {
        if (!current() || currentSource !== sourceRevision) return;
        // Home only shows Watchlist when it has cards. The editor retains its
        // empty/error feedback; regular background refreshes retry this source.
        if (row.kind === 'watchlist') { replace(cards); return; }
        replace(cards, el('p', 'tvl-home-row-status', 'Não foi possível carregar esta coleção.'), button('Tentar novamente', '', '', () => {
          const focused = cards.contains(document.activeElement);
          const inputRevision = this.inputRevision;
          const pending = renderItems(), retrySource = sourceRevision;
          void pending.then(() => {
            if (focused && current() && retrySource === sourceRevision && inputRevision === this.inputRevision && document.activeElement === document.body)
              this.focus(cards.querySelector<HTMLElement>('button') || strip?.querySelector<HTMLElement>('[aria-selected="true"]') || undefined);
          });
        }));
      } finally {
        if (current() && currentSource === sourceRevision) {
          cards.removeAttribute('aria-busy');
          if (rendered) rendered.identity = this.rowIdentity(row, available);
        }
      }
    };
    // A newly added source must not block the already-loaded rows on return.
    const pending = renderItems();
    if (!this.warmReturn || this.initialPaint || row.kind !== 'items' || this.items.get(selected.collectionId)?.value) await pending;
    if (row.kind === 'watchlist' && !cards.querySelector('.tvl-home-row-card')) return null;
    const dispose = decorateSeasonalRow(section, cards, row);
    rendered = { row, element: section, identity: this.rowIdentity(row, available), dispose: () => { alive = false; dispose(); }, reconcileSource: async () => {
      const source = tabs.find(tab => tab.id === this.selectedSources.get(row.id)) || tabs[0];
      if (source.id === selected.id) return;
      selected = source;
      strip?.querySelectorAll<HTMLElement>('[data-source-tab]').forEach(control => {
        const active = control.dataset.sourceTab === source.id; control.setAttribute('aria-selected', String(active)); control.tabIndex = active ? 0 : -1;
      });
      await renderItems();
    } };
    return rendered;
  }

  destroy(): void {
    this.itemReturn = undefined;
    if (this.initialPaint && this.displayedRevision > 0 && JSON.stringify([this.api.serverId, this.api.userId]) === this.accountIdentity
      && (!this.api.homeCollections || this.api.homeCollections.isCurrent()) && (!this.api.providerHomes || this.api.providerHomes.isCurrent())) {
      const items: HomeSnapshot['items'] = new Map();
      for (const [id, entry] of this.items) if (entry.value && entry.fingerprint !== undefined) items.set(id, { value: entry.value, fingerprint: entry.fingerprint });
      lastHome = { key: this.key, collections: this.collections, items, sources: new Map(this.selectedSources), watchlistShown: new Map(this.watchlistShown),
        watchlist: this.watchlist?.value && this.watchlist.fingerprint !== undefined ? { value: this.watchlist.value, fingerprint: this.watchlist.fingerprint } : undefined };
    }
    this.rememberPosition();
    if (this.lastPosition) {
      homePositions.set(this.key, this.lastPosition);
      if (homePositions.size > 20) homePositions.delete(homePositions.keys().next().value!);
    }
    this.rememberNativeFocus();
    this.disposed = true; this.revision++; this.observer.disconnect();
    this.positionRowCache = undefined;
    this.channelArtwork.destroy(); this.libraryVisibility.destroy(); this.loadingStore.destroy(); this.removeWatchlist();
    this.staged = undefined; this.readiness.destroy(); this.releaseInitialHome();
    this.store.destroy(); this.providerStore.destroy(); window.clearInterval(this.syncTimer); window.clearTimeout(this.seasonalTimer); window.removeEventListener('focus', this.onVisible);
    document.removeEventListener('visibilitychange', this.onVisible);
    document.removeEventListener('viewshow', this.onNativeShow, true);
    window.removeEventListener('storage', this.onProviderStorage);
    window.removeEventListener('tvl-provider-settings-changed', this.onProviderSaved);
    window.removeEventListener('keydown', this.onKey, true); window.removeEventListener('command', this.onCommand, true);
    window.removeEventListener('pointerdown', this.onPointer, true);
    window.removeEventListener('focusin', this.rememberNativeFocus, true);
    window.removeEventListener('scroll', this.queuePositionCapture, true); window.removeEventListener('click', this.rememberPosition, true);
    window.removeEventListener('wheel', this.onWheel, true); if (this.restoreFrame !== undefined) cancelAnimationFrame(this.restoreFrame);
    if (this.captureFrame !== undefined) cancelAnimationFrame(this.captureFrame);
    if (this.attachFrame !== undefined) cancelAnimationFrame(this.attachFrame);
    if (this.refreshFrame !== undefined) cancelAnimationFrame(this.refreshFrame);
    window.clearTimeout(this.refreshTimer);
    this.cancelReturnScroll();
    this.sections.forEach(section => { section.dispose?.(); section.element.remove(); }); this.sections = []; this.root.remove();
  }
}
