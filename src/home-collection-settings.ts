import type { Item } from './types';

export const itemSorts = ['collection', 'title', 'title-desc', 'newest', 'oldest', 'custom'] as const;
export type HomeItemSort = typeof itemSorts[number];
export type HomeCollectionTab = { id: string; label: string; collectionId: string; itemSort: HomeItemSort; itemOrder: string[] };
export const maxHomeCollectionTabs = 6;
export const maxSeasonalRows = 12;
export type HomeCollectionSeason = { start: string; end: string };
export type HomeSeasonalArtStyle = 'classic' | 'storybook' | 'photoreal' | 'nightmare';
export type HomeSeasonalAppearance = { theme: 'halloween' | 'christmas'; background: 'none' | 'static' | 'parallax';
  expansion: 'none' | 'medium' | 'large' | 'fullscreen'; frame: boolean; reveal: 'none' | 'doors' | 'curtains' | 'shutters' | 'advent';
  /** Omission preserves focus-to-open behaviour; daily unlocking is always explicit. */
  adventUnlock?: 'focus' | 'daily';
  backgroundStyle?: HomeSeasonalArtStyle; frameStyle?: HomeSeasonalArtStyle; coverStyle?: HomeSeasonalArtStyle;
  rankStyle?: 'standard' | HomeSeasonalArtStyle };
export type HomeCollectionRow = { id: string; kind: 'collections' | 'items' | 'watchlist' | 'seasonal'; title: string; collectionIds: string[]; ranked: boolean;
  placement: string; itemSort: HomeItemSort; itemOrder: string[]; tabs?: HomeCollectionTab[]; children?: HomeCollectionRow[];
  season?: HomeCollectionSeason; shuffle?: boolean; appearance?: HomeSeasonalAppearance };
export type HomeCollectionSettings = { version: 1; rows: HomeCollectionRow[] };
export const emptyHomeCollections = (): HomeCollectionSettings => ({ version: 1, rows: [] });

export const defaultSeasonalAppearance = (theme: HomeSeasonalAppearance['theme']): HomeSeasonalAppearance =>
  ({ theme, background: 'static', expansion: 'medium', frame: true, reveal: 'none' });

/** A malformed decoration falls back to the ordinary row without hiding its collection. */
export function parseSeasonalAppearance(value: unknown): HomeSeasonalAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const appearance = value as Record<string, unknown>;
  const keys = ['theme', 'background', 'expansion', 'frame', 'reveal'];
  const styles = ['backgroundStyle', 'frameStyle', 'coverStyle'] as const;
  if (keys.some(key => !(key in appearance)) || Object.keys(appearance).some(key => !keys.includes(key) && !styles.includes(key as typeof styles[number]) && key !== 'rankStyle' && key !== 'adventUnlock')
    || styles.some(key => key in appearance && (!['classic', 'storybook', 'photoreal', 'nightmare'].includes(appearance[key] as string) || appearance.theme === 'christmas' && appearance[key] === 'nightmare'))
    || 'rankStyle' in appearance && (!['standard', 'classic', 'storybook', 'photoreal', 'nightmare'].includes(appearance.rankStyle as string) || appearance.theme === 'christmas' && appearance.rankStyle === 'nightmare')
    || appearance.reveal === 'advent' && appearance.theme !== 'christmas'
    || 'adventUnlock' in appearance && (appearance.reveal !== 'advent' || !['focus', 'daily'].includes(appearance.adventUnlock as string))
    || !['halloween', 'christmas'].includes(appearance.theme as string)
    || !['none', 'static', 'parallax'].includes(appearance.background as string)
    || !['none', 'medium', 'large', 'fullscreen'].includes(appearance.expansion as string)
    || typeof appearance.frame !== 'boolean' || !['none', 'doors', 'curtains', 'shutters', 'advent'].includes(appearance.reveal as string)) return undefined;
  const result: HomeSeasonalAppearance = { theme: appearance.theme as HomeSeasonalAppearance['theme'], background: appearance.background as HomeSeasonalAppearance['background'],
    expansion: appearance.expansion as HomeSeasonalAppearance['expansion'], frame: appearance.frame, reveal: appearance.reveal as HomeSeasonalAppearance['reveal'] };
  for (const key of styles) if (appearance[key]) result[key] = appearance[key] as HomeSeasonalArtStyle;
  if (appearance.rankStyle) result.rankStyle = appearance.rankStyle as HomeSeasonalAppearance['rankStyle'];
  if (appearance.adventUnlock) result.adventUnlock = appearance.adventUnlock as HomeSeasonalAppearance['adventUnlock'];
  return result;
}

/** Seasons recur annually. A leap reference year permits February 29 without accepting impossible dates. */
export function validSeasonDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}-\d{2}$/.test(value)) return false;
  const month = Number(value.slice(0, 2)), day = Number(value.slice(3));
  const date = new Date(2000, month - 1, day);
  return date.getFullYear() === 2000 && date.getMonth() === month - 1 && date.getDate() === day;
}

/** Inclusive dates use the viewer's local calendar, including seasons that cross New Year. */
export function isSeasonActive(season: HomeCollectionSeason | undefined, date = new Date()): boolean {
  if (!season || !validSeasonDate(season.start) || !validSeasonDate(season.end) || !Number.isFinite(date.getTime())) return false;
  const today = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return season.start <= season.end
    ? today >= season.start && today <= season.end
    : today >= season.start || today <= season.end;
}

/** A seasonal group occupies one configured position; only its currently visible rows enter the page. */
export function activeHomeRows(settings: HomeCollectionSettings, date = new Date()): HomeCollectionRow[] {
  return settings.rows.flatMap(row => row.kind === 'seasonal'
    ? (row.children || []).filter(child => child.kind !== 'seasonal' && isSeasonActive(child.season, date))
      .map(child => ({ ...child, placement: row.placement }))
    : [row]);
}

/** Keep preferences bounded and treat local storage as untrusted input. */
export function parseHomeCollections(value: unknown): HomeCollectionSettings {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('rows' in value) || !Array.isArray(value.rows)) return emptyHomeCollections();
  const seen = new Set<string>();
  const parseRow = (row: unknown, child = false): HomeCollectionRow | undefined => {
    if (!row || typeof row !== 'object' || !('kind' in row) || typeof row.kind !== 'string' || !['collections', 'items', 'watchlist', 'seasonal'].includes(row.kind) || !('id' in row) || typeof row.id !== 'string' || !row.id || seen.has(row.id.slice(0, 100))) return undefined;
    // A missing or invalid child schedule must never turn into a permanently visible Home row.
    if (child && (row.kind === 'seasonal' || !('season' in row) || !row.season || typeof row.season !== 'object' || !('start' in row.season) || !('end' in row.season) || !validSeasonDate(row.season.start) || !validSeasonDate(row.season.end))) return undefined;
    const source = row as Record<string, unknown>;
    const kind = row.kind as HomeCollectionRow['kind'];
    const placement = typeof source.placement === 'string' && (['start', 'end'].includes(source.placement) || source.placement.startsWith('native:')) ? source.placement.slice(0, 240) : 'end';
    seen.add(row.id.slice(0, 100));
    if (kind === 'seasonal') {
      const children = Array.isArray(source.children) ? source.children.slice(0, maxSeasonalRows).map(value => parseRow(value, true)).filter((value): value is HomeCollectionRow => !!value) : [];
      return { id: row.id.slice(0, 100), kind, title: '', collectionIds: [], ranked: false, placement, itemSort: 'collection', itemOrder: [], children };
    }
    const ids = Array.isArray(source.collectionIds) ? Array.from(new Set<string>(source.collectionIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length < 200))) : [];
    const itemOrder = Array.isArray(source.itemOrder) ? Array.from(new Set<string>(source.itemOrder.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length < 200))).slice(0, 2000) : [];
    const next: HomeCollectionRow = { id: row.id.slice(0, 100), kind, title: typeof source.title === 'string' ? source.title.trim().slice(0, 80) : '', collectionIds: kind === 'watchlist' ? [] : ids.slice(0, kind === 'items' ? 1 : 40), ranked: kind === 'items' && source.ranked === true,
      placement, itemSort: itemSorts.includes(source.itemSort as HomeItemSort) ? source.itemSort as HomeItemSort : 'collection', itemOrder };
    if (child) {
      const season = source.season as HomeCollectionSeason;
      next.season = { start: season.start, end: season.end };
      const appearance = parseSeasonalAppearance(source.appearance);
      if (appearance && (appearance.reveal !== 'advent' || kind === 'items')) next.appearance = appearance;
    }
    if (source.shuffle === true) next.shuffle = true;
    if (kind === 'items' && Array.isArray(source.tabs)) {
      const seenTabs = new Set<string>();
      const tabs: HomeCollectionTab[] = [];
      for (const tab of source.tabs.slice(0, maxHomeCollectionTabs)) {
        if (!tab || typeof tab.id !== 'string' || !tab.id || seenTabs.has(tab.id.slice(0, 100)) || typeof tab.collectionId !== 'string' || tab.collectionId.length >= 200) continue;
        seenTabs.add(tab.id.slice(0, 100));
        tabs.push({ id: tab.id.slice(0, 100), label: typeof tab.label === 'string' ? tab.label.trim().slice(0, 40) : '', collectionId: tab.collectionId,
          itemSort: itemSorts.includes(tab.itemSort) ? tab.itemSort : 'collection',
          itemOrder: Array.isArray(tab.itemOrder) ? Array.from(new Set<string>(tab.itemOrder.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length < 200))).slice(0, 2000) : [] });
      }
      if (tabs.length) {
        next.tabs = tabs;
        // Older clients can still display the first source as a single row.
        next.collectionIds = tabs[0].collectionId ? [tabs[0].collectionId] : [];
        next.itemSort = tabs[0].itemSort; next.itemOrder = tabs[0].itemOrder.slice();
      }
    }
    return next;
  };
  const rows = value.rows.slice(0, 12).map(row => parseRow(row)).filter((row): row is HomeCollectionRow => !!row);
  return { version: 1, rows };
}

/** Existing single-collection rows are also one source, without changing stored preferences. */
export function homeCollectionTabs(row: HomeCollectionRow): HomeCollectionTab[] {
  return row.tabs?.length ? row.tabs : [{ id: 'primary', label: '', collectionId: row.collectionIds[0] || '', itemSort: row.itemSort, itemOrder: row.itemOrder }];
}

export function homeTabLabel(tab: HomeCollectionTab, collection?: Item): string {
  return tab.label.trim() || collection?.Name || 'Coleção';
}

export function homeCollectionKey(server: string, user: string): string {
  return `jellyfin-cinema.home-collections.v1:${encodeURIComponent(server)}:${encodeURIComponent(user)}`;
}

/** Ordering is local to a Home row; never mutate shared Jellyfin collection metadata. */
export function orderHomeItems(items: Item[], row: Pick<HomeCollectionRow, 'itemSort' | 'itemOrder'>): Item[] {
  if (row.itemSort === 'collection') return items.slice();
  const positions = new Map(row.itemOrder.map((id, index) => [id, index]));
  return items.map((item, index) => ({ item, index })).sort((a, b) => {
    let comparison = 0;
    if (row.itemSort === 'custom') comparison = (positions.get(a.item.Id) ?? Infinity) - (positions.get(b.item.Id) ?? Infinity);
    else if (row.itemSort === 'title' || row.itemSort === 'title-desc') comparison = a.item.Name.localeCompare(b.item.Name, undefined, { numeric: true, sensitivity: 'base' }) * (row.itemSort === 'title-desc' ? -1 : 1);
    else {
      const ay = a.item.ProductionYear, by = b.item.ProductionYear;
      comparison = ay == null ? by == null ? 0 : 1 : by == null ? -1 : (ay - by) * (row.itemSort === 'newest' ? -1 : 1);
    }
    return (Number.isNaN(comparison) ? 0 : comparison) || a.index - b.index;
  }).map(entry => entry.item);
}

/** Shuffle the rendered copy without changing Jellyfin's collection or the user's saved ordering. */
export function shuffleHomeItems(items: Item[], random: () => number = Math.random): Item[] {
  const shuffled = items.slice();
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

// Outlined vector digits: artwork beside the poster, never a title prefix.
const digits = [
  'M42 5C15 5 5 27 5 70s10 65 37 65 37-22 37-65S69 5 42 5ZM42 31c9 0 12 12 12 39s-3 39-12 39-12-12-12-39 3-39 12-39Z',
  'M8 26 37 7h25v126H34V42L8 57Z',
  'M7 40C8 17 23 5 44 5c25 0 37 14 37 35 0 18-10 30-26 46l-21 22h48v25H5v-23l37-41c11-12 14-19 14-27 0-8-4-12-11-12-8 0-12 6-13 16Z',
  'M7 34C12 14 23 5 44 5c24 0 37 13 37 33 0 15-6 24-17 30 13 5 20 15 20 30 0 25-16 37-42 37-22 0-36-11-39-34l26-5c2 11 6 15 14 15 9 0 14-5 14-15 0-11-6-16-20-16h-8V57h8c13 0 18-5 18-15 0-8-4-13-12-13-7 0-11 5-13 13Z',
  'M43 7h31v77h12v25H74v24H48v-24H3V85Zm5 36L25 84h23Z',
  'M12 7h67v25H35l-2 22c5-3 10-4 16-4 22 0 35 16 35 42 0 27-16 43-41 43-23 0-37-12-40-34l27-5c1 10 6 15 13 15 10 0 15-7 15-19 0-12-5-19-14-19-6 0-11 3-14 9L7 76Z',
  'M74 15 62 36c-6-5-11-7-17-7-13 0-19 11-20 31 6-6 13-9 22-9 23 0 36 16 36 40 0 27-16 44-40 44C14 135 2 111 2 74 2 29 17 5 45 5c12 0 21 3 29 10ZM43 75c-10 0-15 6-15 17 0 12 5 18 15 18 9 0 14-6 14-18 0-11-5-17-14-17Z',
  'M4 7h79v22L42 133H13L54 33H4Z',
  'M43 5c24 0 38 13 38 33 0 13-6 23-16 29 13 7 20 17 20 31 0 23-17 37-42 37S1 121 1 98c0-14 7-24 20-31C11 61 5 51 5 38 5 18 19 5 43 5ZM43 29c-8 0-12 5-12 14s4 14 12 14 12-5 12-14-4-14-12-14ZM43 79c-10 0-15 6-15 16s5 16 15 16 15-6 15-16-5-16-15-16Z',
  'M12 125 24 104c6 5 11 7 17 7 13 0 19-11 20-31-6 6-13 9-22 9C16 89 3 73 3 49 3 22 19 5 43 5c29 0 41 24 41 61 0 45-15 69-43 69-12 0-21-3-29-10ZM43 29c-9 0-14 6-14 18 0 11 5 17 14 17 10 0 15-6 15-17 0-12-5-18-15-18Z'
];
/** Shared path geometry keeps standard and seasonal number images identical in size. */
export function rankArtwork(rank: number): { value: string; width: number; paths: string } {
  const value = String(Number.isFinite(rank) ? Math.max(1, Math.min(999, Math.floor(rank))) : 1);
  const paths = [...value].map((digit, index) => `<path transform="translate(${index * 87} 0)" d="${digits[Number(digit)]}"/>`).join('');
  return { value, width: value.length * 87, paths };
}
export function rankImage(rank: number): string {
  const { width, paths } = rankArtwork(rank);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 140"><g fill="#101116" stroke="#b8bbc6" stroke-width="2.5" fill-rule="evenodd" stroke-linejoin="round">${paths}</g></svg>`)}`;
}
