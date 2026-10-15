import { providerBrands, type ProviderBrandId } from './provider-brands';

export const providerRowSources = ['movies', 'shows', 'trending-movies', 'trending-shows', 'collection', 'watchlist'] as const;
export const providerItemSorts = ['collection', 'title', 'title-desc', 'newest', 'oldest'] as const;
export type ProviderRowSource = typeof providerRowSources[number];
export type ProviderItemSort = typeof providerItemSorts[number];
export type ProviderRow = { id: string; title: string; source: ProviderRowSource; collectionId: string; enabled: boolean; ranked: boolean; itemSort: ProviderItemSort };
export type ProviderId = string;
export const providerOfferTypes = ['flatrate', 'free', 'ads'] as const;
export type ProviderOfferType = typeof providerOfferTypes[number];
const legacyProviderIds = ['netflix', 'prime', 'max', 'globoplay', 'disney', 'crunchyroll', 'apple', 'paramount', 'now', 'discovery', 'wetv', 'brasilparalelo', 'viki'];
const broadcastProviderIds: readonly ProviderBrandId[] = ['discovery', 'wetv', 'brasilparalelo'];
export const retiredProviderIds = ['now', 'bbc', 'itvx', 'channel4'] as const;
export type ProviderHomeConfig = { id: ProviderId; name: string; logoUrl: string; accent: string; movieProviderIds: number[]; showProviderIds: number[]; offerTypes: ProviderOfferType[]; enabled: boolean; hero: boolean; rows: ProviderRow[] };
export type ProviderHomesSettings = { version: 2; enabled: boolean; title: string; placement: string; tileScale: number; showNames: boolean; providers: ProviderHomeConfig[] };
export const maxProviders = 24;
export const maxProviderRows = 12;
export const maxProviderSettingsBytes = 128 * 1024 - 1024;

export const defaultHomeProviderIds: ProviderBrandId[] = [
  'netflix', 'prime', 'max', 'globoplay', 'disney', 'crunchyroll', 'apple', 'viki'
];

export function defaultProviderRows(): ProviderRow[] {
  return [
    { id: 'trending-movies', title: 'Filmes em Alta', source: 'trending-movies', collectionId: '', enabled: true, ranked: true, itemSort: 'collection' },
    { id: 'trending-shows', title: 'Séries em Alta', source: 'trending-shows', collectionId: '', enabled: true, ranked: true, itemSort: 'collection' },
    { id: 'movies', title: 'Filmes', source: 'movies', collectionId: '', enabled: true, ranked: false, itemSort: 'title' },
    { id: 'shows', title: 'Séries', source: 'shows', collectionId: '', enabled: true, ranked: false, itemSort: 'title' }
  ];
}
export function validProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (providerBrands.some(brand => brand.id === value) || /^custom-[a-z0-9-]{1,57}$/.test(value));
}
export function defaultProviderConfig(id: ProviderBrandId): ProviderHomeConfig {
  const brand = providerBrands.find(brand => brand.id === id)!;
  const ids: Record<ProviderBrandId, number[]> = {
    netflix: [8, 175, 1796],
    prime: [119, 9, 2100],
    max: [1899],
    globoplay: [307],
    disney: [337],
    crunchyroll: [283],
    apple: [350],
    paramount: [531, 2303, 2304],
    discovery: [524],
    wetv: [623],
    brasilparalelo: [6265],
    viki: [344, 1390]
  };
  return {
    id, name: brand.name, logoUrl: '', accent: brand.accent, movieProviderIds: [...ids[id]],
    showProviderIds: [...ids[id]], offerTypes: ['flatrate'], enabled: true, hero: true,
    rows: defaultProviderRows()
  };
}
export function defaultCustomProvider(id: string): ProviderHomeConfig {
  if (!validProviderId(id) || !id.startsWith('custom-')) throw new Error('ID de serviço personalizado inválido.');
  return { id, name: 'Novo serviço', logoUrl: '', accent: '#e50914', movieProviderIds: [], showProviderIds: [], offerTypes: ['flatrate'], enabled: true, hero: true, rows: [] };
}
export function defaultProviderHomes(): ProviderHomesSettings {
  return { version: 2, enabled: true, title: 'Serviços de Streaming', placement: 'start', tileScale: 100, showNames: true,
    providers: defaultHomeProviderIds.map(id => defaultProviderConfig(id)) };
}
export function providerHomesKey(server: string, user: string): string {
  return `jellyfin-cinema.provider-homes.v1:${encodeURIComponent(server)}:${encodeURIComponent(user)}`;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key));
const text = (value: unknown, max: number, nonempty = false): value is string => typeof value === 'string' && value.length <= max && (!nonempty || value.length > 0);
const invalid = () => new Error('Jellyfin returned invalid provider-home settings. Try again.');

const providerIds = (value: unknown): value is number[] => Array.isArray(value) && value.length <= 20
  && value.every(id => Number.isInteger(id) && id > 0 && id <= 1_000_000) && new Set(value).size === value.length;
const logoUrl = (value: unknown): value is string => {
  if (!text(value, 2048)) return false;
  if (value === '') return true;
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return false;
  try { const url = new URL(value); return !!url.hostname && !url.username && !url.password; } catch { return false; }
};

/** Reject malformed snapshots in full. Version 1 is upgraded only in memory;
 * reading an older account never writes new defaults or loses its row choices. */
export function parseProviderHomes(value: unknown): ProviderHomesSettings {
  if (!record(value) || (value.version !== 1 && value.version !== 2)) throw invalid();
  const legacy = value.version === 1;
  if (!keys(value, legacy ? ['version', 'enabled', 'title', 'placement', 'providers']
    : ['version', 'enabled', 'title', 'placement', 'tileScale', 'showNames', 'providers'])
    || typeof value.enabled !== 'boolean' || !text(value.title, 80) || !text(value.placement, 240)
    || !(['start', 'end'].includes(value.placement) || (value.placement.startsWith('native:') && value.placement.length > 7))
    || !Array.isArray(value.providers) || value.providers.length > (legacy ? legacyProviderIds.length : maxProviders)
    || !legacy && (!Number.isInteger(value.tileScale) || (value.tileScale as number) < 70 || (value.tileScale as number) > 150 || typeof value.showNames !== 'boolean')) throw invalid();
  const seen = new Set<string>();
  const providers: ProviderHomeConfig[] = [];
  for (const provider of value.providers) {
    if (!record(provider)) throw invalid();
    if (typeof provider.id === 'string' && (retiredProviderIds as readonly string[]).includes(provider.id)) continue;
    if (!keys(provider, legacy ? ['id', 'enabled', 'hero', 'rows']
      : ['id', 'name', 'logoUrl', 'accent', 'movieProviderIds', 'showProviderIds', 'offerTypes', 'enabled', 'hero', 'rows'])
      || !validProviderId(provider.id) || legacy && !legacyProviderIds.includes(provider.id) || seen.has(provider.id)
      || typeof provider.enabled !== 'boolean' || typeof provider.hero !== 'boolean'
      || !Array.isArray(provider.rows) || provider.rows.length > maxProviderRows
      || !legacy && (!text(provider.name, 80, true) || !provider.name.trim() || !logoUrl(provider.logoUrl)
        || !text(provider.accent, 7) || !/^#[0-9a-f]{6}$/i.test(provider.accent)
        || !providerIds(provider.movieProviderIds) || !providerIds(provider.showProviderIds)
        || !Array.isArray(provider.offerTypes) || provider.offerTypes.length < 1 || provider.offerTypes.length > 3
        || new Set(provider.offerTypes).size !== provider.offerTypes.length || !provider.offerTypes.every(type => providerOfferTypes.includes(type)))) throw invalid();
    seen.add(provider.id);
    const rowIds = new Set<string>();
    const rows: ProviderRow[] = provider.rows.map(row => {
      if (!record(row) || !keys(row, ['id', 'title', 'source', 'collectionId', 'enabled', 'ranked', 'itemSort'])
        || !text(row.id, 100, true) || rowIds.has(row.id) || !text(row.title, 80) || !text(row.collectionId, 199)
        || !providerRowSources.includes(row.source as ProviderRowSource) || !providerItemSorts.includes(row.itemSort as ProviderItemSort)
        || typeof row.enabled !== 'boolean' || typeof row.ranked !== 'boolean') throw invalid();
      rowIds.add(row.id);
      return { id: row.id, title: row.title, source: row.source as ProviderRowSource, collectionId: row.collectionId,
        enabled: row.enabled, ranked: row.ranked, itemSort: row.itemSort as ProviderItemSort };
    });
    const config = legacy ? defaultProviderConfig(provider.id as ProviderBrandId) : {
      id: provider.id, name: provider.name as string, logoUrl: provider.logoUrl as string, accent: provider.accent as string,
      movieProviderIds: [...provider.movieProviderIds as number[]], showProviderIds: [...provider.showProviderIds as number[]], offerTypes: [...provider.offerTypes as ProviderOfferType[]]
    };
    providers.push({ ...config, enabled: provider.enabled, hero: provider.hero, rows });
  }
  if (legacy && providers.length) providers.push(...broadcastProviderIds.map(id => defaultProviderConfig(id)));
  if (!providers.length && value.providers.length > 0) providers.push(...defaultHomeProviderIds.map(id => defaultProviderConfig(id)));
  const title = value.title === 'Streaming services' ? 'Serviços de Streaming' : value.title;
  const settings: ProviderHomesSettings = { version: 2, enabled: value.enabled, title, placement: value.placement,
    tileScale: legacy ? 100 : value.tileScale as number, showNames: legacy ? true : value.showNames as boolean, providers };
  if (new TextEncoder().encode(JSON.stringify(settings)).length > maxProviderSettingsBytes) throw invalid();
  return settings;
}
export function cloneProviderHomes(settings: ProviderHomesSettings): ProviderHomesSettings { return parseProviderHomes(settings); }
