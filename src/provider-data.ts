import { orderHomeItems } from './home-collection-settings';
import { providerBrand, type ProviderBrandId } from './provider-brands';
import { defaultProviderConfig, type ProviderRow, type ProviderHomeConfig } from './provider-settings';
import type { Item, MediaApi } from './types';

export type ProviderItemsQuery = {
  type: 'Movie' | 'Series' | 'Mixed'; watchlist?: boolean; startIndex?: number; limit?: number;
  sort?: 'title' | 'title-desc' | 'newest' | 'oldest';
};
export type ProviderItemsPage = {
  Items: Item[]; TotalRecordCount: number; Pending: number; Total: number;
  UpdatedAt: string | null; Status: 'ready' | 'refreshing' | 'unavailable'; Region: 'BR';
  MissingIds?: number; FailedIds?: number;
};
export type ProviderRowResult = {
  items: Item[]; total: number; pending: number; totalToCheck: number;
  status: 'ready' | 'refreshing' | 'unavailable'; sourceLabel: string; sourceUrl?: string;
  missingSource?: boolean; updatedAt?: string | null; missingIds?: number; failedIds?: number;
};

export class ProviderDataError extends Error {
  constructor(readonly kind: 'stale' | 'invalid', message: string) { super(message); }
}

const CACHE_MS = 30_000;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const invalid = () => new ProviderDataError('invalid', 'Jellyfin returned invalid provider items. Try again.');
const itemIdentity = (id: string): string => /^[\da-f]{32}$|^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.replace(/-/g, '').toLowerCase() : id;

/** Keep native collection rank order, dropping duplicates and non-playable entries. */
function playableItems(items: Item[], type?: 'Movie' | 'Series'): Item[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (!item || typeof item.Id !== 'string' || !item.Id || typeof item.Name !== 'string'
      || (type ? item.Type !== type : item.Type !== 'Movie' && item.Type !== 'Series')
      || item.LocationType === 'Virtual' || item.IsMissing || item.IsVirtualItem || item.IsPlaceHolder || item.PlayAccess === 'None') return false;
    const identity = itemIdentity(item.Id);
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}

/** Catalogue membership combines server-matched availability with supported
 * studio affiliations. Chart collections remain separate, explicitly chosen subsets. */
export class ProviderData {
  private disposed = false;
  private generation = 0;
  private readonly serverId: string | undefined;
  private readonly userId: string | undefined;
  private readonly cache = new Map<string, { expires: number; items: Item[] }>();
  private readonly pending = new Map<string, Promise<Item[]>>();
  private readonly cataloguePending = new Map<string, Promise<ProviderItemsPage>>();

  constructor(private readonly api: MediaApi) {
    this.serverId = api.serverId; this.userId = api.userId;
  }

  private current(generation: number): void {
    if (this.disposed || generation !== this.generation || this.api.serverId !== this.serverId || this.api.userId !== this.userId
      || this.api.homeCollections && !this.api.homeCollections.isCurrent() || this.api.providerHomes && !this.api.providerHomes.isCurrent())
      throw new ProviderDataError('stale', 'The provider page changed. Reopen it for the current Jellyfin account.');
  }

  private collectionItems(key: string, request: () => Promise<Item[]>, generation: number): Promise<Item[]> {
    this.current(generation);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.items);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = Promise.resolve().then(() => { this.current(generation); return request(); }).then(items => {
      this.current(generation);
      if (!Array.isArray(items)) throw invalid();
      this.cache.set(key, { expires: Date.now() + CACHE_MS, items: items.slice() });
      return items;
    }).finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise); return promise;
  }

  async load(provider: ProviderBrandId | ProviderHomeConfig, row: ProviderRow, startIndex = 0, limit = 60, preview = false): Promise<ProviderRowResult> {
    const generation = this.generation; this.current(generation);
    if (typeof provider === 'string' && !providerBrand(provider)) throw invalid();
    const config = typeof provider === 'string' ? defaultProviderConfig(provider) : provider;
    const start = Number.isFinite(startIndex) ? Math.max(0, Math.floor(startIndex)) : 0;
    const size = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 60;
    const type = row.source === 'movies' || row.source === 'trending-movies' ? 'Movie'
      : row.source === 'shows' || row.source === 'trending-shows' ? 'Series' : undefined;
    const collectionId = row.collectionId.trim();
    const watchlist = row.source === 'watchlist';
    if (watchlist || !collectionId && (row.source === 'movies' || row.source === 'shows')) {
      const includesDisney = (watchlist ? [...config.movieProviderIds, ...config.showProviderIds]
        : type === 'Movie' ? config.movieProviderIds : config.showProviderIds).includes(337);
      const sourceLabel = includesDisney ? 'Disney studios · Disponibilidade de streaming (Brasil)' : 'Disponibilidade de streaming (Brasil) · JustWatch';
      const sourceUrl = 'https://www.justwatch.com/br';
      if (preview ? !this.api.previewProviderItems : !this.api.getProviderItems) return { items: [], total: 0, pending: 0, totalToCheck: 0, status: 'unavailable', sourceLabel, sourceUrl };
      const query: ProviderItemsQuery = { type: watchlist ? 'Mixed' : type!, ...(watchlist ? { watchlist: true } : {}), startIndex: start, limit: size, sort: row.itemSort === 'collection' ? 'title' : row.itemSort };
      const key = `${preview ? JSON.stringify(config) : config.id}:${query.type}:${!!query.watchlist}:${query.sort}:${start}:${size}`;
      let promise = this.cataloguePending.get(key);
      if (!promise) {
        promise = Promise.resolve().then(() => { this.current(generation); return preview ? this.api.previewProviderItems!(config, query) : this.api.getProviderItems!(config.id, query); });
        this.cataloguePending.set(key, promise);
      }
      let page: ProviderItemsPage;
      try { page = await promise; }
      finally { if (this.cataloguePending.get(key) === promise) this.cataloguePending.delete(key); }
      this.current(generation);
      if (!page || page.Region !== 'BR' || !Array.isArray(page.Items) || !count(page.TotalRecordCount) || !count(page.Pending) || !count(page.Total)
        || !['ready', 'refreshing', 'unavailable'].includes(page.Status) || (page.UpdatedAt !== null && typeof page.UpdatedAt !== 'string')
        || page.MissingIds !== undefined && !count(page.MissingIds) || page.FailedIds !== undefined && !count(page.FailedIds)) throw invalid();
      return { items: playableItems(page.Items, type), total: page.TotalRecordCount, pending: page.Pending, totalToCheck: page.Total,
        status: page.Status, sourceLabel, sourceUrl, updatedAt: page.UpdatedAt, missingIds: page.MissingIds, failedIds: page.FailedIds };
    }

    if (!collectionId && (row.source === 'trending-movies' || row.source === 'trending-shows')) {
      const sourceLabel = 'Em Alta · Popularidade TMDB (Brasil)';
      const sourceIds = type === 'Movie' ? config.movieProviderIds : config.showProviderIds;
      if (!sourceIds.length || (preview ? !this.api.previewProviderTrending : !this.api.getProviderTrending)) {
        return { items: [], total: 0, pending: 0, totalToCheck: 0, status: 'unavailable', sourceLabel, missingSource: true };
      }
      const sourceUrl = 'https://www.themoviedb.org';
      const key = `trending:${preview ? JSON.stringify(config) : config.id}:${type}:${size}`;
      let promise = this.cataloguePending.get(key);
      if (!promise) {
        promise = Promise.resolve().then(() => {
          this.current(generation);
          return preview ? this.api.previewProviderTrending!(config, type!, size)
            : this.api.getProviderTrending!(config.id, type!, size);
        });
        this.cataloguePending.set(key, promise);
      }
      let page: ProviderItemsPage;
      try { page = await promise; }
      finally { if (this.cataloguePending.get(key) === promise) this.cataloguePending.delete(key); }
      this.current(generation);
      if (!page || page.Region !== 'BR' || !Array.isArray(page.Items) || !count(page.TotalRecordCount) || !count(page.Pending) || !count(page.Total)
        || !['ready', 'refreshing', 'unavailable'].includes(page.Status) || (page.UpdatedAt !== null && typeof page.UpdatedAt !== 'string')
        || page.MissingIds !== undefined && !count(page.MissingIds) || page.FailedIds !== undefined && !count(page.FailedIds)) throw invalid();
      const items = orderHomeItems(playableItems(page.Items, type), { itemSort: row.itemSort, itemOrder: [] });
      return {
        items,
        total: page.TotalRecordCount,
        pending: page.Pending,
        totalToCheck: page.Total,
        status: page.Status,
        sourceLabel,
        sourceUrl,
        updatedAt: page.UpdatedAt,
        missingIds: page.MissingIds,
        failedIds: page.FailedIds
      };
    }

    const sourceLabel = 'Selected Jellyfin collection';
    // Collection identity is saved in the row, never rediscovered from a name.
    // A rename, daily/weekly suffix or another similarly named chart cannot change it.
    if (!collectionId) return { items: [], total: 0, pending: 0, totalToCheck: 0, status: 'unavailable', sourceLabel, missingSource: true };
    const raw = await this.collectionItems(`items:${collectionId}`, () => this.api.getCollectionItems(collectionId), generation);
    this.current(generation);
    const ordered = orderHomeItems(playableItems(raw, type), { itemSort: row.itemSort, itemOrder: [] });
    return { items: ordered.slice(start, start + size), total: ordered.length, pending: 0, totalToCheck: 0,
      status: 'ready', sourceLabel };
  }

  invalidate(): void {
    this.generation++; this.cache.clear(); this.pending.clear(); this.cataloguePending.clear();
  }
  destroy(): void { this.disposed = true; this.invalidate(); }
}
