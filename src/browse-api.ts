import type { Item, ItemPage, LibraryQuery, SuggestionSection } from './types';

type Query = Record<string, string | number | boolean>;
type Result = { Items?: Item[]; TotalRecordCount?: number };
export type MusicKind = 'albums' | 'artists' | 'albumArtists' | 'songs' | 'playlists';
export type MusicQuery = LibraryQuery & { kind: MusicKind; artistId?: string; albumId?: string };
export type RecordingQuery = { parentId?: string; search?: string; status?: 'all' | 'active' | 'completed'; startIndex?: number; limit?: number };
export interface BrowseApi {
  getMusic(query: MusicQuery): Promise<ItemPage>;
  getMusicGenres(parentId?: string): Promise<Item[]>;
  getMusicSuggestions(parentId?: string): Promise<SuggestionSection[]>;
  getPlaylistItems(playlistId: string, query?: { startIndex?: number; limit?: number }): Promise<ItemPage>;
  getRecordings(query?: RecordingQuery): Promise<ItemPage>;
  isRecordingFolder?(id: string): Promise<boolean>;
}
export interface BrowseClient {
  getItems(userId: string, query: Query): Promise<Result>;
  getUrl(path: string, query?: Query): string;
  getJSON(url: string): Promise<unknown>;
}
type Read = <T>(action: () => Promise<T>) => Promise<T>;
const art: Query = { Fields: 'Overview,Genres', EnableImages: true,
  EnableImageTypes: 'Primary,Thumb,Backdrop', EnableUserData: true };
const available = (item: Item) => !!item?.Id && item.LocationType !== 'Virtual' && !item.IsMissing
  && !item.IsVirtualItem && !item.IsPlaceHolder && item.PlayAccess !== 'None';
const identity = (id: string) => /^[\da-f]{32}$|^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.replace(/-/g, '').toLowerCase() : id;
function items(value: unknown, label: string): Item[] {
  const result = value as Result | null;
  if (!result || !Array.isArray(result.Items)) throw new Error(`Jellyfin returned an invalid ${label} list. Try again.`);
  return result.Items.filter(item => item && typeof item.Id === 'string' && !!item.Id);
}
function bounds(query: { startIndex?: number; limit?: number }) {
  return { start: Number.isFinite(query.startIndex) ? Math.max(0, Math.min(2_147_483_647, Math.trunc(query.startIndex!))) : 0,
    limit: Number.isFinite(query.limit) ? Math.max(1, Math.min(100, Math.trunc(query.limit!))) : 48 };
}
function page(value: unknown, start: number, limit: number, label: string, accept = available): ItemPage {
  const found = items(value, label);
  const result = value as Result;
  const count = result.Items!.length;
  const total = result.TotalRecordCount;
  if (!Number.isSafeInteger(total) || total! < 0 || count > limit || count && total! < start + count || !count && start < total!) {
    throw new Error(`Jellyfin returned an incomplete ${label} page. Try again.`);
  }
  return { items: found.filter(accept), total: total!, nextStartIndex: start + count };
}
const musicTypes = ['MusicAlbum', 'MusicArtist', 'Audio'];

/** Uses existing authenticated ApiClient requests and the adapter's session guard. */
export function createBrowseApi(client: BrowseClient, userId: string, read: Read): BrowseApi {
  const json = (path: string, query: Query = {}) => read(() => client.getJSON(client.getUrl(path, query)));
  const latest = async (query: Query, label: string): Promise<Item[]> => {
    const result = await json(`Users/${encodeURIComponent(userId)}/Items/Latest`, { ...art, ...query });
    if (!Array.isArray(result)) throw new Error(`Jellyfin returned invalid ${label}. Try again.`);
    return items({ Items: result }, label).filter(available);
  };
  async function allPages(fetch: (start: number) => Promise<unknown>, label: string, accept = available): Promise<Item[]> {
    const unique = new Map<string, Item>();
    let start = 0;
    for (let index = 0; index < 100; index++) {
      const raw = await fetch(start);
      const batch = page(raw, start, 100, label, () => true);
      const before = unique.size;
      for (const item of batch.items) unique.set(item.Id, item);
      if (start > 0 && batch.items.length && before === unique.size) throw new Error(`Jellyfin repeated a ${label} page. Try again.`);
      if (batch.nextStartIndex >= batch.total) return [...unique.values()].filter(accept);
      if (batch.nextStartIndex <= start || before === unique.size) throw new Error(`Jellyfin repeated a ${label} page. Try again.`);
      start = batch.nextStartIndex;
    }
    throw new Error(`The ${label} list exceeded the browsing limit. Refine your library and try again.`);
  }
  return {
    getMusic: query => read(async () => {
      const { start, limit } = bounds(query);
      const letter = query.letter?.trim().toUpperCase();
      if (letter && !/^[A-Z#]$/.test(letter)) throw new Error('Choose a letter from A to Z, or #.');
      const options: Query = { ...art, UserId: userId, Recursive: true, EnableTotalRecordCount: true,
        StartIndex: start, Limit: limit, SortBy: query.albumId ? 'ParentIndexNumber,IndexNumber,SortName' : 'SortName', SortOrder: 'Ascending',
        // Native music playlists are global to the account, not children of a music library.
        ...(query.kind !== 'playlists' && (query.albumId || query.parentId) ? { ParentId: query.albumId || query.parentId! } : {}),
        ...(query.search?.trim() ? { SearchTerm: query.search.trim() } : {}),
        ...(query.favorite ? { IsFavorite: true } : {}),
        ...(query.genreId ? { GenreIds: query.genreId } : {}),
        ...(letter === '#' ? { NameLessThan: 'A' } : letter ? { NameStartsWith: letter } : {}) };
      const artists = query.kind === 'artists' || query.kind === 'albumArtists';
      if (!artists) {
        options.IncludeItemTypes = query.kind === 'playlists' ? 'Playlist' : query.kind === 'songs' ? 'Audio' : 'MusicAlbum';
        if (query.artistId) options.ContributingArtistIds = query.artistId;
      }
      const result = artists ? await json(query.kind === 'albumArtists' ? 'Artists/AlbumArtists' : 'Artists', options)
        : await client.getItems(userId, options);
      const type = artists ? 'MusicArtist' : query.kind === 'playlists' ? 'Playlist' : query.kind === 'songs' ? 'Audio' : 'MusicAlbum';
      return page(result, start, limit, 'music', item => item.Type === type && available(item));
    }),
    getPlaylistItems: (playlistId, query = {}) => read(async () => {
      if (!playlistId) throw new Error('Choose a playlist to browse.');
      const { start, limit } = bounds(query);
      // The playlist endpoint retains entry order and PlaylistItemId, including
      // repeated tracks. Sorting or deduplicating by media Id would lose entries.
      const result = await json(`Playlists/${encodeURIComponent(playlistId)}/Items`, {
        ...art, UserId: userId, StartIndex: start, Limit: limit
      });
      if (items(result, 'playlist').some(item => !item.PlaylistItemId)) throw new Error('Jellyfin returned an invalid playlist entry. Try again.');
      return page(result, start, limit, 'playlist');
    }),
    getMusicGenres: parentId => read(() => allPages(start => json('MusicGenres', { UserId: userId, IncludeItemTypes: 'MusicAlbum',
      ...(parentId ? { ParentId: parentId } : {}), SortBy: 'SortName', SortOrder: 'Ascending', StartIndex: start, Limit: 100,
      EnableTotalRecordCount: true }), 'music genre', item => ['Genre','MusicGenre'].includes(item.Type || ''))),
    getMusicSuggestions: parentId => read(async () => {
      const scope: Query = parentId ? { ParentId: parentId } : {};
      const options: Query = { ...art, ...scope, IncludeItemTypes: 'Audio', Recursive: true, Filters: 'IsPlayed',
        SortOrder: 'Descending', Limit: 12, EnableTotalRecordCount: false };
      const [recent, played, frequent] = await Promise.all([
        latest({ ...scope, IncludeItemTypes: 'Audio', Limit: 18 }, 'latest music'),
        read(() => client.getItems(userId, { ...options, SortBy: 'DatePlayed' })),
        read(() => client.getItems(userId, { ...options, SortBy: 'PlayCount' }))
      ]);
      return [
        { title: 'Adicionados recentemente', items: recent.filter(item => musicTypes.includes(item.Type || '')) },
        { title: 'Tocadas recentemente', items: items(played, 'recently played').filter(item => item.Type === 'Audio' && available(item)) },
        { title: 'Mais tocadas', items: items(frequent, 'frequently played').filter(item => item.Type === 'Audio' && available(item)) }
      ].filter(section => section.items.length);
    }),
    isRecordingFolder: id => read(async () => {
      if (!id) return false;
      // Recording libraries are ordinary CollectionFolders, with no distinctive
      // name/type. Use DVR's configured folder IDs instead of guessing by label.
      const folders = items(await json('LiveTv/Recordings/Folders', { UserId: userId }), 'recording folder');
      const ids = new Set(folders.map(folder => identity(folder.Id)));
      if (ids.has(identity(id))) return true;
      if (!ids.size) return false;
      const ancestors = await json(`Items/${encodeURIComponent(id)}/Ancestors`, { UserId: userId });
      if (!Array.isArray(ancestors)) throw new Error('Jellyfin returned invalid recording folder ancestry. Try again.');
      return items({ Items: ancestors }, 'recording folder ancestry').some(parent => ids.has(identity(parent.Id)));
    }),
    getRecordings: (query = {}) => read(async () => {
      const { start, limit } = bounds(query);
      const options: Query = { ...art, UserId: userId, EnableTotalRecordCount: true };
      const accept = (item: Item) => available(item) && ['Movie','Episode','Video','Recording'].includes(item.Type || '');
      // The DVR recordings endpoint has no ParentId filter. A library/subfolder
      // route must query its actual descendants instead of displaying all DVRs.
      const fetch = (offset: number, size: number) => query.parentId
        ? read(() => client.getItems(userId, { ...options, ParentId: query.parentId!, Recursive: true,
          IncludeItemTypes: 'Movie,Episode,Video', SortBy: 'DateCreated,SortName', SortOrder: 'Descending', StartIndex: offset, Limit: size }))
        : json('LiveTv/Recordings', { ...options, StartIndex: offset, Limit: size });
      const search = query.search?.trim().toLocaleLowerCase();
      // In 10.11/12, IsInProgress=true ignores Limit and filters AFTER StartIndex;
      // false does not exclude active recordings. Read active IDs once at zero,
      // then derive status filtering locally without losing or duplicating items.
      const getActive = async () => {
        const raw = await json('LiveTv/Recordings', { ...options, IsInProgress: true, StartIndex: 0 });
        const found = items(raw, 'active recording');
        const result = raw as Result;
        if (!Number.isSafeInteger(result.TotalRecordCount) || result.TotalRecordCount !== result.Items!.length
          || found.length !== result.Items!.length || new Set(found.map(item => item.Id)).size !== found.length) {
          throw new Error('Jellyfin returned an incomplete active recording list. Try again.');
        }
        return found.filter(accept).map(item => ({ ...item, IsInProgress: true }));
      };
      if (query.status === 'active' && !query.parentId) {
        const all = (await getActive()).filter(item => !search || `${item.Name} ${item.SeriesName || ''}`.toLocaleLowerCase().includes(search));
        const found = all.slice(start, start + limit);
        return { items: found, total: all.length, nextStartIndex: start + found.length };
      }
      if (!search && query.status !== 'completed' && query.status !== 'active') {
        const [result, active] = await Promise.all([fetch(start, limit), getActive()]);
        const activeIds = new Set(active.map(item => item.Id));
        const resultPage = page(result, start, limit, 'recording', accept);
        return { ...resultPage, items: resultPage.items.map(item => ({ ...item, IsInProgress: activeIds.has(item.Id) })) };
      }
      // LiveTv/Recordings also lacks SearchTerm. Search/completed totals require
      // the complete paginated recording list, not just the currently shown page.
      const [recordings, active] = await Promise.all([allPages(offset => fetch(offset, 100), 'recording', accept), getActive()]);
      const activeIds = new Set(active.map(item => item.Id));
      const all = recordings.filter(item => (query.status !== 'completed' || !activeIds.has(item.Id))
        && (query.status !== 'active' || activeIds.has(item.Id))
        && (!search || `${item.Name} ${item.SeriesName || ''}`.toLocaleLowerCase().includes(search)))
        .map(item => ({ ...item, IsInProgress: activeIds.has(item.Id) }));
      const found = all.slice(start, start + limit);
      return { items: found, total: all.length, nextStartIndex: start + found.length };
    })
  };
}
