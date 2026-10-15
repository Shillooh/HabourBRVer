import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCustomProvider } from '../src/provider-settings.ts';
import { createJellyfinApi } from '../src/api';
import type { Item, ItemUserData } from '../src/types';

const saved = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown): void {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

function client(overrides: Record<string, unknown> = {}) {
  const value = {
    getCurrentUserId: () => 'user-a', serverId: () => 'server-a',
    getItem: async (_user: string, id: string) => ({ Id: id, Name: id, Type: 'Movie' }),
    ...overrides
  };
  global('ApiClient', value);
  return createJellyfinApi()!;
}

test('trailer actions send current playback identity and save the advertised film server-side', async () => {
  const urls: { path: string; query?: unknown }[] = [];
  const writes: Record<string, unknown>[] = [];
  const expected = { PlayingItemId: 'trailer', PlaylistItemId: 'intro-2' };
  const advertised = { ...expected, Movie: { Id: 'advertised-film', Name: 'The Other Shore' }, InWatchlist: false };
  const api = client({
    getUrl: (path: string, query?: unknown) => { urls.push({ path, query }); return path; },
    getJSON: async () => advertised,
    ajax: async (request: Record<string, unknown>) => { writes.push(request); return { ...advertised, InWatchlist: true, WatchlistId: 'private-watchlist' }; }
  });
  assert.deepEqual(await api.getTrailerActions!(expected), advertised);
  const saved = await api.addTrailerToWatchlist!({ ...expected, MovieId: 'queued-feature', UserId: 'another-user' } as typeof expected);
  assert.equal(saved.Movie?.Id, 'advertised-film');
  assert.equal(saved.InWatchlist, true);
  assert.deepEqual(urls, [
    { path: 'TvItemLayout/TrailerActions', query: { playingItemId: 'trailer', playlistItemId: 'intro-2' } },
    { path: 'TvItemLayout/TrailerActions/Watchlist', query: undefined }
  ]);
  assert.deepEqual(writes, [{ type: 'POST', url: 'TvItemLayout/TrailerActions/Watchlist', data: JSON.stringify(expected), contentType: 'application/json', dataType: 'json' }]);
});

test('trailer results cannot acknowledge another trailer, queue occurrence, or an unconfirmed save', async () => {
  const expected = { PlayingItemId: 'trailer', PlaylistItemId: 'intro-2' };
  const valid = { ...expected, Movie: { Id: 'advertised', Name: 'Advertised film' }, InWatchlist: true, WatchlistId: 'private-watchlist' };
  for (const response of [undefined, {}, { ...valid, PlayingItemId: 'feature' }, { ...valid, PlaylistItemId: 'intro-1' },
    { ...valid, PlaylistItemId: undefined }, { ...valid, Movie: {} }, { ...valid, Movie: null }, { ...valid, WatchlistId: undefined },
    { ...valid, InWatchlist: 'true' }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => response, ajax: async () => response });
    await assert.rejects(api.getTrailerActions!(expected), /invalid trailer or watchlist/i);
    await assert.rejects(api.addTrailerToWatchlist!(expected), /invalid trailer or watchlist/i);
  }
  const api = client({ getUrl: (path: string) => path, getJSON: async () => null, ajax: async () => ({ ...valid, InWatchlist: false }) });
  assert.equal(await api.getTrailerActions!(expected), null);
  await assert.rejects(api.addTrailerToWatchlist!(expected), /invalid trailer or watchlist/i);
});

test('unmapped trailers remain skippable without inventing a watchlist target', async () => {
  const response = { PlayingItemId: 'trailer', Movie: null, InWatchlist: false };
  const api = client({ getUrl: (path: string) => path, getJSON: async () => response });
  assert.deepEqual(await api.getTrailerActions!({ PlayingItemId: 'trailer' }), response);
});

test('trailer metadata, watchlist reads and writes reject changed accounts and servers', async () => {
  for (const method of ['getTrailerDetails', 'getTrailerActions', 'addTrailerToWatchlist'] as const) {
    for (const change of ['user', 'server']) {
      let user = 'user-a', server = 'server-a', requests = 0;
      let finish!: (value: unknown) => void;
      const pending = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
      const api = client({ getCurrentUserId: () => user, serverId: () => server, getUrl: (path: string) => path, getJSON: pending, ajax: pending });
      const result = api[method]!({ PlayingItemId: 'trailer' });
      if (change === 'user') user = 'user-b'; else server = 'server-b';
      finish({ PlayingItemId: 'trailer', Movie: { Id: 'advertised', Name: 'Film' }, InWatchlist: true, WatchlistId: 'list' });
      await assert.rejects(result, /account changed/i);
      await assert.rejects(api[method]!({ PlayingItemId: 'trailer' }), /account changed/i);
      assert.equal(requests, 1);
    }
  }
});

test('trailer metadata uses current playback identity without requiring cinema actions', async () => {
  const expected = { PlayingItemId: 'trailer', PlaylistItemId: 'standalone-1' };
  const details = { ...expected, Movie: { Id: 'advertised-film', Name: 'Mayday' } };
  const urls: { path: string; query?: unknown }[] = [];
  const api = client({
    getUrl: (path: string, query?: unknown) => { urls.push({ path, query }); return path; },
    getJSON: async (path: string) => path.endsWith('TrailerDetails') ? details : null,
  });
  assert.deepEqual(await api.getTrailerDetails!({ ...expected, MovieId: 'queued-feature', UserId: 'other-user' } as typeof expected), details);
  assert.equal(await api.getTrailerActions!(expected), null);
  assert.deepEqual(urls[0], { path: 'TvItemLayout/TrailerDetails', query: { playingItemId: 'trailer', playlistItemId: 'standalone-1' } });
});

test('trailer metadata rejects malformed mappings and mismatched current playback identity', async () => {
  const expected = { PlayingItemId: 'trailer', PlaylistItemId: 'standalone-1' };
  const valid = { ...expected, Movie: { Id: 'advertised-film', Name: 'Mayday' } };
  for (const response of [undefined, {}, { ...valid, PlayingItemId: 'other' }, { ...valid, PlaylistItemId: 'other' },
    { ...valid, Movie: {} }, { ...valid, Movie: undefined }, { ...valid, Movie: { Id: 'film', Name: '' } }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => response });
    await assert.rejects(api.getTrailerDetails!(expected), /invalid trailer/i);
  }
  for (const response of [null, { ...expected, Movie: null }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => response });
    assert.deepEqual(await api.getTrailerDetails!(expected), response);
  }
});

test('watchlist failures report stale playback and denied access without retrying writes', async () => {
  for (const [status, error] of [[409, /trailer has changed/i], [403, /sign in/i], [422, /rename one in playlists/i], [500, /unable to save your watchlist/i]] as const) {
    let writes = 0;
    const api = client({ getUrl: (path: string) => path, ajax: async () => { writes++; throw { status }; } });
    await assert.rejects(api.addTrailerToWatchlist!({ PlayingItemId: 'trailer' }), error);
    assert.equal(writes, 1);
  }
});
const episode = (id: string, index: number, extra: Partial<Item> = {}): Item => ({
  Id: id, Name: id, Type: 'Episode', SeriesId: 'show', SeasonId: 'season',
  ParentIndexNumber: 1, IndexNumber: index, ...extra
});

test('watched changes use native played methods and preserve server user data', async () => {
  const calls: { method: string; user: string; id: string; date?: Date }[] = [];
  const played = { ItemId: 'movie', Played: true, PlaybackPositionTicks: 0, PlayedPercentage: 100,
    IsFavorite: true, PlayCount: 4, LastPlayedDate: '2026-09-27T11:00:00Z', Key: 'shared-key' };
  const unplayed = { ...played, Played: false, PlayedPercentage: 0, PlayCount: 0, LastPlayedDate: null };
  const api = client({
    markPlayed: async (user: string, id: string, date: Date) => { calls.push({ method: 'played', user, id, date }); return played; },
    markUnplayed: async (user: string, id: string) => { calls.push({ method: 'unplayed', user, id }); return unplayed; },
    getItem: async () => { throw new Error('The write response is authoritative; no extra item request is needed.'); }
  });
  const before = Date.now();
  assert.equal(await api.setPlayed!('movie', true), played);
  assert.equal(await api.setPlayed!('movie', false), unplayed);
  assert.deepEqual(calls.map(({ date, ...call }) => call), [
    { method: 'played', user: 'user-a', id: 'movie' }, { method: 'unplayed', user: 'user-a', id: 'movie' }
  ]);
  assert.ok(calls[0].date instanceof Date && calls[0].date.getTime() >= before && calls[0].date.getTime() <= Date.now());
  assert.equal(calls[1].date, undefined);
});

test('watched results accept equivalent item IDs and preserve server state instead of assuming the requested value', async () => {
  const id = 'aabbccdd-1122-3344-5566-778899aabbcc';
  const result = { ItemId: id.replace(/-/g, '').toUpperCase(), Played: false, PlaybackPositionTicks: 900, PlayedPercentage: null,
    UnplayedItemCount: 2, IsFavorite: true };
  const api = client({ markPlayed: async () => result });
  assert.equal(await api.setPlayed!(id, true), result);
});

test('invalid or unrelated watched responses cannot report a successful update', async () => {
  for (const result of [null, undefined, 'true', [], {}, { Played: 'true' }, { Played: true, ItemId: 'other' },
    { Played: true, ItemId: 1 }]) {
    const api = client({ markPlayed: async () => result, markUnplayed: async () => result });
    await assert.rejects(api.setPlayed!('movie', true), /invalid watched status/i);
    await assert.rejects(api.setPlayed!('movie', false), /invalid watched status/i);
  }
});

test('account, client, server and sign-out changes reject stale watched results and further writes', async () => {
  for (const change of ['account', 'replace', 'server', 'sign-out']) {
    let user = 'user-a'; let server = 'server-a'; let writes = 0;
    let resolve!: (data: ItemUserData) => void;
    const api = client({ getCurrentUserId: () => user, serverId: () => server,
      markPlayed: () => { writes++; return new Promise<ItemUserData>(done => { resolve = done; }); },
      markUnplayed: async () => { writes++; return { Played: false }; }
    });
    const pending = api.setPlayed!('movie', true);
    if (change === 'account') user = 'user-b';
    else if (change === 'replace') client();
    else if (change === 'server') server = 'server-b';
    else global('ApiClient', undefined);
    resolve({ ItemId: 'movie', Played: true, PlaybackPositionTicks: 0 });
    await assert.rejects(pending, /account changed/i);
    await assert.rejects(api.setPlayed!('movie', true), /account changed/i);
    await assert.rejects(api.setPlayed!('movie', false), /account changed/i);
    assert.equal(writes, 1);
  }
});

test('watched write failures keep actionable access and missing-item errors', async () => {
  for (const [status, message] of [[401, /sign in/i], [403, /access/i], [404, /no longer available/i]] as const) {
    const api = client({ markPlayed: async () => { throw { status }; }, markUnplayed: async () => { throw { statusCode: status }; } });
    await assert.rejects(api.setPlayed!('movie', true), message);
    await assert.rejects(api.setPlayed!('movie', false), message);
  }
  const failure = new Error('The Jellyfin server is unavailable.');
  const api = client({ markPlayed: async () => { throw failure; } });
  await assert.rejects(api.setPlayed!('movie', true), (error: unknown) => error === failure);
});

test('collection writes use native endpoints and fresh collection permissions', async () => {
  const requests: { type: string; url: string; dataType?: string }[] = [];
  let allowed = true;
  const api = client({
    getUrl: (path: string, query?: Record<string, string>) => `${path}${query ? '?' + new URLSearchParams(query) : ''}`,
    getJSON: async (url: string) => { assert.equal(url, 'Users/user-a'); return { Id:'user-a', Policy:{ EnableCollectionManagement:allowed } }; },
    ajax: async (request: typeof requests[number]) => { requests.push(request); return { Id:'new-collection' }; }
  });
  assert.equal(await api.canManageCollections!(), true);
  await api.addToCollection!('collection-a', 'movie-a');
  assert.deepEqual(requests[0], { type:'POST', url:'Collections/collection-a/Items?ids=movie-a' });
  assert.deepEqual(await api.createCollection!('  Sea & Sky  ', 'show-a'), { Id:'new-collection', Name:'Sea & Sky', Type:'BoxSet' });
  assert.deepEqual(requests[1], { type:'POST', url:'Collections?name=Sea+%26+Sky&ids=show-a', dataType:'json' });
  allowed = false;
  await assert.rejects(api.addToCollection!('collection-a', 'movie-a'), /not allowed/i);
  assert.equal(requests.length, 2);
});

test('collection management honours administrator policy and fails closed for invalid users', async () => {
  for (const policy of [{ IsAdministrator:true }, { EnableCollectionManagement:true }, { IsAdministrator:false, EnableCollectionManagement:false }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => ({ Id:'user-a', Policy:policy }) });
    assert.equal(await api.canManageCollections!(), policy.IsAdministrator === true || policy.EnableCollectionManagement === true);
  }
  for (const user of [null, {}, {Id:'other',Policy:{IsAdministrator:true}}, {Id:'user-a'}]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => user });
    await assert.rejects(api.canManageCollections!(), /permissions/i);
  }
});

test('collection permission changes or account switches cannot dispatch stale writes', async () => {
  let user = 'user-a'; let writes = 0;
  const api = client({ getCurrentUserId: () => user, getUrl: (path: string) => path,
    getJSON: async () => { user = 'user-b'; return {Id:'user-a',Policy:{IsAdministrator:true}}; },
    ajax: async () => { writes++; }
  });
  await assert.rejects(api.addToCollection!('collection', 'item'), /account changed/i);
  assert.equal(writes, 0);
});

test('collection changes invalidate cached membership and preserve actionable failures', async () => {
  let member = false; let writes = 0; let failure: unknown;
  const api = client({ getUrl: (path: string) => path,
    getJSON: async () => ({Id:'user-a',Policy:{EnableCollectionManagement:true}}),
    getItems: async (_user: string, query: Record<string, unknown>) => ({ Items: query.ParentId
      ? member ? [{Id:'item',Name:'Item',Type:'Movie'}] : [] : [{Id:'collection',Name:'Collection',Type:'BoxSet'}] }),
    ajax: async () => { writes++; if (failure) throw failure; member = true; return {Id:'created'}; }
  });
  assert.deepEqual(await api.getCollections('item'), []);
  await api.addToCollection!('collection', 'item');
  assert.deepEqual((await api.getCollections('item')).map(item=>item.Id), ['collection']);
  failure = {status:403};
  await assert.rejects(api.addToCollection!('collection','item'), /not allowed to manage collections/i);
  failure = {status:404};
  await assert.rejects(api.addToCollection!('collection','item'), /no longer available/i);
  await assert.rejects(api.createCollection!('   ','item'), /collection name/i);
  assert.equal(writes, 3);
});

test('activation requires a signed-in Jellyfin client', () => {
  global('ApiClient', undefined);
  assert.equal(createJellyfinApi(), null);
  global('ApiClient', { getCurrentUserId: () => '' });
  assert.equal(createJellyfinApi(), null);
});

test('adapter exposes the active Jellyfin server identity for native detail navigation', () => {
  assert.equal(client().serverId, 'server-a');
  assert.equal(client({ serverId: () => 'server-b' }).serverId, 'server-b');
  for (const serverId of [undefined, () => '', () => '   ', () => null]) {
    assert.equal(client({ serverId }).serverId, undefined);
  }
});

test('playback context uses the authenticated plugin endpoint and rejects malformed or stale responses', async () => {
  let currentUser = 'user-a';
  let result: unknown = { PlayingItemId: 'intro', PlaylistItemId: 'queue-1', Queue: [{Id:'intro'}, {Id:'feature'}, null] };
  const api = client({ getCurrentUserId: () => currentUser, getUrl: (path: string) => path,
    getJSON: async (path: string) => { assert.equal(path, 'TvItemLayout/PlaybackContext'); return result; } });
  assert.equal(api.userId, 'user-a');
  assert.deepEqual((await api.getPlaybackContext!())?.Queue, [{Id:'intro'}, {Id:'feature'}]);
  result = null; assert.equal(await api.getPlaybackContext!(), null);
  result = { PlayingItemId:'movie', Queue: {} };
  await assert.rejects(api.getPlaybackContext!(), /invalid playback/i);
  currentUser = 'user-b';
  await assert.rejects(api.getPlaybackContext!(), /account changed/i);
});

test('disc artwork uses its own tag and does not mistake a poster for disc art', () => {
  const api = client({ getImageUrl: (id: string, options: unknown) => JSON.stringify({ id, options }) });
  assert.equal(api.image({Id:'item', Name:'Item', ImageTags:{Primary:'poster'}}, 'disc'), null);
  assert.deepEqual(JSON.parse(api.image({Id:'item', Name:'Item', ImageTags:{Disc:'disc'}}, 'disc')!),
    {id:'item', options:{type:'Disc',tag:'disc',maxWidth:700,quality:90}});
});

test('poster artwork prefers Primary without changing landscape thumbnail selection', () => {
  const api = client({ getImageUrl: (_id: string, options: {type: string}) => options.type });
  const item = {Id:'collection',Name:'Collection',ImageTags:{Primary:'poster',Thumb:'thumb'},BackdropImageTags:['backdrop']};
  assert.equal(api.image(item,'poster'), 'Primary');
  assert.equal(api.image(item,'thumb'), 'Thumb');
  assert.equal(api.image({...item,ImageTags:{Thumb:'thumb'}},'poster'), 'Thumb');
  assert.equal(api.image({...item,ImageTags:{}},'poster'), 'Backdrop');
});

test('movie pages send real scoped filters and retain the raw continuation offset', async () => {
  let requestedUser = '';
  let query: Record<string, unknown> = {};
  const api = client({ getItems: async (user: string, options: Record<string, unknown>) => {
    requestedUser = user; query = options;
    return { Items: [
      { Id: 'movie', Name: 'Movie', Type: 'Movie' },
      { Id: 'missing', Name: 'Missing', Type: 'Movie', IsMissing: true },
      { Id: 'blocked', Name: 'Blocked', Type: 'Movie', PlayAccess: 'None' },
      { Id: 'show', Name: 'Show', Type: 'Series' }
    ], TotalRecordCount: 25 };
  } });
  const page = await api.getMovies({ parentId: 'films', search: '  Moon  ', letter: 'm', genreId: 'genre', favorite: true, startIndex: 10, limit: 20 });
  assert.deepEqual(page, { items: [{ Id: 'movie', Name: 'Movie', Type: 'Movie' }], total: 25, nextStartIndex: 14 });
  assert.equal(requestedUser, 'user-a');
  assert.equal(query.ParentId, 'films');
  assert.equal(query.SearchTerm, 'Moon');
  assert.equal(query.NameStartsWith, 'M');
  assert.equal(query.GenreIds, 'genre');
  assert.equal(query.IsFavorite, true);
  assert.equal(query.IncludeItemTypes, 'Movie');
  assert.equal(query.IsMissing, false);
  assert.equal(query.CollapseBoxSetItems, false);
  assert.equal(query.Recursive, true);
  assert.equal(query.StartIndex, 10);
  assert.equal(query.Limit, 20);
  assert.equal(query.EnableTotalRecordCount, true);
});

test('movie pagination bounds requests, maps # to the server alphabet filter, and clears inactive filters', async () => {
  const queries: Record<string, unknown>[] = [];
  const api = client({ getItems: async (_user: string, query: Record<string, unknown>) => {
    queries.push(query);
    return { Items: [], TotalRecordCount: 0 };
  } });
  assert.deepEqual(await api.getMovies({ startIndex: -8, limit: 10000, letter: '#', favorite: false, search: ' ' }), { items: [], total: 0, nextStartIndex: 0 });
  assert.equal(queries[0].StartIndex, 0);
  assert.equal(queries[0].Limit, 100);
  assert.equal(queries[0].NameLessThan, 'A');
  for (const key of ['ParentId', 'IsFavorite', 'SearchTerm', 'NameStartsWith', 'GenreIds']) assert.ok(!(key in queries[0]));
  await api.getMovies({ startIndex: NaN, limit: Infinity });
  assert.equal(queries[1].Limit, 60);
  assert.equal(queries[1].StartIndex, 0);
  assert.ok(!('NameLessThan' in queries[1]));
  await assert.rejects(api.getMovies({ letter: 'Any letter' }), /choose a letter/i);
  assert.equal(queries.length, 2);
});

test('movie pages reject malformed or stalled totals rather than inventing a page count', async () => {
  for (const result of [
    { Items: [], TotalRecordCount: -1 },
    { Items: [], TotalRecordCount: NaN },
    { Items: [], TotalRecordCount: 1.5 },
    { Items: [] },
    { Items: [], TotalRecordCount: 10 },
    { Items: [{ Id: 'movie', Name: 'Movie', Type: 'Movie' }], TotalRecordCount: 0 }
  ]) {
    const api = client({ getItems: async () => result });
    await assert.rejects(api.getMovies({}), /incomplete movie page/i);
  }
  const beyondEnd = client({ getItems: async () => ({ Items: [], TotalRecordCount: 3 }) });
  assert.deepEqual(await beyondEnd.getMovies({ startIndex: 60 }), { items: [], total: 3, nextStartIndex: 60 });
});

test('movie genres paginate within the selected library', async () => {
  const requests: { user: string; query: Record<string, unknown> }[] = [];
  const api = client({ getGenres: async (user: string, query: Record<string, unknown>) => {
    requests.push({ user, query });
    return query.StartIndex === 0
      ? { Items: [{ Id: 'drama', Name: 'Drama', Type: 'Genre' }], TotalRecordCount: 2 }
      : { Items: [{ Id: 'mystery', Name: 'Mystery', Type: 'Genre' }], TotalRecordCount: 2 };
  } });
  assert.deepEqual((await api.getMovieGenres('film-library')).map(item => item.Name), ['Drama', 'Mystery']);
  assert.deepEqual(requests.map(({ query }) => query.StartIndex), [0, 1]);
  assert.ok(requests.every(({ user, query }) => user === 'user-a' && query.ParentId === 'film-library' && query.IncludeItemTypes === 'Movie'));
});

test('movie suggestions preserve native recommendation categories, recent items and user progress', async () => {
  const urls = new Map<string, Record<string, unknown>>();
  const movies = (id: string) => [{ Id: id, Name: id, Type: 'Movie' }];
  let resumeQuery: Record<string, unknown> = {};
  const api = client({
    getItems: async (user: string, query: Record<string, unknown>) => {
      assert.equal(user, 'user-a'); resumeQuery = query;
      return { Items: [{ ...movies('resume')[0], UserData: { PlaybackPositionTicks: 600 } }] };
    },
    getUrl: (path: string, query: Record<string, unknown>) => { urls.set(path, query); return path; },
    getJSON: async (path: string) => path.endsWith('/Latest') ? movies('latest') : [
      { RecommendationType: 'SimilarToRecentlyPlayed', BaselineItemName: 'The Shore', Items: movies('watched') },
      { RecommendationType: 'SimilarToLikedItem', BaselineItemName: 'The Trail', Items: movies('liked') },
      { RecommendationType: 'HasLikedDirector', BaselineItemName: 'Ada Voss', Items: movies('director') },
      { RecommendationType: 'HasActorFromRecentlyPlayed', BaselineItemName: 'Romy Bell', Items: movies('actor') },
      { RecommendationType: 'FutureCategory', BaselineItemName: 'Unknown reason', Items: movies('other') },
      { RecommendationType: 'SimilarToLikedItem', BaselineItemName: 'Empty', Items: [] }
    ]
  });
  const sections = await api.getMovieSuggestions('library');
  assert.deepEqual(sections.map(section => section.title), [
    'Continue watching', 'Recently added', 'Because you watched The Shore', 'Because you like The Trail',
    'Directed by Ada Voss', 'Starring Romy Bell', 'Recommended for you'
  ]);
  assert.equal(sections[0].items[0].UserData?.PlaybackPositionTicks, 600);
  assert.equal(resumeQuery.ParentId, 'library');
  assert.equal(resumeQuery.Filters, 'IsResumable');
  assert.equal(resumeQuery.CollapseBoxSetItems, false);
  assert.ok(urls.has('Users/user-a/Items/Latest'));
  assert.equal(urls.get('Movies/Recommendations')?.UserId, 'user-a');
  assert.ok([...urls.values()].every(query => query.ParentId === 'library'));
});

test('suggestions preserve honest empty results and surface malformed or failed native reads', async () => {
  const base = {
    getItems: async () => ({ Items: [] }), getUrl: (path: string) => path,
    getJSON: async () => []
  };
  assert.deepEqual(await client(base).getMovieSuggestions(), []);
  const malformed = client({ ...base, getJSON: async (path: string) => path.endsWith('/Latest') ? [] : [{ Items: null }] });
  await assert.rejects(malformed.getMovieSuggestions(), /invalid recommended movie list/i);
  const failed = client({ ...base, getJSON: async () => { throw { status: 503 }; } });
  await assert.rejects(failed.getMovieSuggestions(), /could not load/i);
});

test('movie catalogue requests cannot return data after an account change', async () => {
  let user = 'user-a';
  const api = client({
    getCurrentUserId: () => user,
    getItems: async () => { user = 'user-b'; return { Items: [], TotalRecordCount: 0 }; }
  });
  await assert.rejects(api.getMovies({ parentId: 'library' }), /account changed/i);
});

test('TV catalogue requests apply series filters, library scope and raw pagination offsets', async () => {
  const requests: { user: string; query: Record<string, unknown> }[] = [];
  const api = client({ getItems: async (user: string, query: Record<string, unknown>) => {
    requests.push({ user, query });
    return { Items: [
      { Id: 'series', Name: 'Series', Type: 'Series' },
      { Id: 'movie', Name: 'Movie', Type: 'Movie' },
      { Id: 'virtual', Name: 'Virtual show', Type: 'Series', IsVirtualItem: true },
      { Id: 'blocked', Name: 'Blocked show', Type: 'Series', PlayAccess: 'None' }
    ], TotalRecordCount: 14 };
  } });
  const page = await api.getShows({ parentId: 'tv-library', search: '  North  ', letter: 'n',
    favorite: true, genreId: 'mystery', startIndex: 10, limit: 20 });
  assert.deepEqual(page, { items: [{ Id: 'series', Name: 'Series', Type: 'Series' }], total: 14, nextStartIndex: 14 });
  assert.equal(requests[0].user, 'user-a');
  assert.deepEqual(requests[0].query, {
    IncludeItemTypes: 'Series', Recursive: true, IsMissing: false, CollapseBoxSetItems: false,
    SortBy: 'SortName,ProductionYear', SortOrder: 'Ascending', ParentId: 'tv-library',
    SearchTerm: 'North', NameStartsWith: 'N', GenreIds: 'mystery', IsFavorite: true,
    Fields: 'Overview,Genres', EnableImages: true, EnableImageTypes: 'Primary,Thumb,Backdrop,Logo',
    EnableUserData: true, EnableTotalRecordCount: true, StartIndex: 10, Limit: 20
  });
});

test('TV pagination bounds requests, maps # and rejects incomplete pages', async () => {
  let query: Record<string, unknown> = {};
  const api = client({ getItems: async (_user: string, options: Record<string, unknown>) => {
    query = options; return { Items: [], TotalRecordCount: 0 };
  } });
  assert.deepEqual(await api.getShows({ letter: '#', favorite: false, search: ' ', startIndex: -1, limit: 1000 }),
    { items: [], total: 0, nextStartIndex: 0 });
  assert.equal(query.NameLessThan, 'A');
  assert.equal(query.StartIndex, 0); assert.equal(query.Limit, 100);
  for (const key of ['IsFavorite', 'NameStartsWith', 'SearchTerm', 'ParentId']) assert.ok(!(key in query));
  await assert.rejects(api.getShows({ letter: 'invalid' }), /choose a letter/i);
  const incomplete = client({ getItems: async () => ({ Items: [], TotalRecordCount: 10 }) });
  await assert.rejects(incomplete.getShows({}), /incomplete TV show page/i);
});

test('TV genres paginate with the selected series library scope', async () => {
  const requests: { user: string; query: Record<string, unknown> }[] = [];
  const api = client({ getGenres: async (user: string, query: Record<string, unknown>) => {
    requests.push({ user, query });
    return query.StartIndex === 0
      ? { Items: [{ Id: 'drama', Name: 'Drama', Type: 'Genre' }], TotalRecordCount: 2 }
      : { Items: [{ Id: 'documentary', Name: 'Documentary', Type: 'Genre' }], TotalRecordCount: 2 };
  } });
  assert.deepEqual((await api.getShowGenres('tv-library')).map(item => item.Name), ['Drama', 'Documentary']);
  assert.deepEqual(requests.map(({ query }) => query.StartIndex), [0, 1]);
  assert.ok(requests.every(({ user, query }) => user === 'user-a' && query.ParentId === 'tv-library'
    && query.IncludeItemTypes === 'Series' && query.EnableTotalRecordCount === true));
});

test('TV suggestions use native scoped progress, next-up and latest episode sources', async () => {
  const queries: Record<string, unknown>[] = [];
  const api = client({
    getItems: async (user: string, query: Record<string, unknown>) => {
      assert.equal(user, 'user-a'); queries.push(query);
      return { Items: [episode('resume', 2, { UserData: { PlaybackPositionTicks: 123 } }),
        episode('missing', 3, { IsMissing: true }), { Id: 'film', Name: 'Film', Type: 'Movie' }] };
    },
    getNextUpEpisodes: async (query: Record<string, unknown>) => {
      queries.push(query); return { Items: [episode('next', 4), episode('orphan', 1, { SeriesId: undefined })] };
    },
    getUrl: (path: string, query: Record<string, unknown>) => {
      assert.equal(path, 'Users/user-a/Items/Latest'); queries.push(query); return path;
    },
    getJSON: async () => [
      { Id: 'grouped', Name: 'Grouped latest series', Type: 'Series', ChildCount: 3 },
      episode('latest', 5), { Id: 'movie', Name: 'Movie', Type: 'Movie' },
      episode('blocked', 6, { PlayAccess: 'None' })
    ]
  });
  const sections = await api.getShowSuggestions('tv-library');
  assert.deepEqual(sections.map(section => [section.title, section.items.map(item => item.Id)]), [
    ['Continue watching', ['resume']], ['Next up', ['next']], ['Recently added', ['grouped', 'latest']]
  ]);
  assert.equal(sections[0].items[0].UserData?.PlaybackPositionTicks, 123);
  assert.equal(sections[1].items[0].SeriesId, 'show');
  assert.equal(queries[0].IncludeItemTypes, 'Episode');
  assert.equal(queries[0].Filters, 'IsResumable');
  assert.equal(queries[1].UserId, 'user-a');
  assert.equal(queries[1].Limit, 24);
  assert.equal(queries[2].IncludeItemTypes, 'Episode');
  assert.equal(queries[2].Limit, 30);
  assert.ok(queries.every(query => query.ParentId === 'tv-library' && query.EnableUserData === true));
});

test('TV suggestions retain honest empty results and fail on invalid or failed native reads', async () => {
  const base = { getItems: async () => ({ Items: [] }), getNextUpEpisodes: async () => ({ Items: [] }),
    getUrl: (path: string) => path, getJSON: async () => [] };
  assert.deepEqual(await client(base).getShowSuggestions(), []);
  await assert.rejects(client({ ...base, getJSON: async () => ({ Items: [] }) }).getShowSuggestions(), /invalid TV suggestions/i);
  await assert.rejects(client({ ...base, getNextUpEpisodes: async () => ({ Items: null }) }).getShowSuggestions(), /invalid next episode list/i);
  await assert.rejects(client({ ...base, getItems: async () => { throw { status: 403 }; } }).getShowSuggestions(), /sign in/i);
});

test('TV queries and suggestions cannot return data after the Jellyfin account changes', async () => {
  let user = 'user-a';
  const listing = client({ getCurrentUserId: () => user,
    getItems: async () => { user = 'user-b'; return { Items: [], TotalRecordCount: 0 }; } });
  await assert.rejects(listing.getShows({}), /account changed/i);
  user = 'user-a';
  let finish: (value: unknown[]) => void = () => {};
  const suggestions = client({ getCurrentUserId: () => user,
    getItems: async () => ({ Items: [] }), getNextUpEpisodes: async () => ({ Items: [] }),
    getUrl: (path: string) => path, getJSON: () => new Promise(resolve => { finish = resolve; }) });
  const pending = suggestions.getShowSuggestions('tv-library');
  user = 'user-b'; finish([]);
  await assert.rejects(pending, /account changed/i);
});

test('episodes retain every available page while excluding missing and blocked entries', async () => {
  const requests: { series: string; query: Record<string, unknown> }[] = [];
  const api = client({ getEpisodes: async (series: string, query: Record<string, unknown>) => {
    requests.push({ series, query });
    return query.StartIndex === 0 ? { Items: [episode('second', 2), episode('missing', 3, { IsMissing: true })], TotalRecordCount: 5 }
      : { Items: [episode('first', 1), episode('second', 2), episode('blocked', 4, { PlayAccess: 'None' })], TotalRecordCount: 5 };
  } });
  assert.deepEqual((await api.getEpisodes('show', 'season')).map(item => item.Id), ['first', 'second']);
  assert.deepEqual(requests.map(request => request.query.StartIndex), [0, 2]);
  assert.ok(requests.every(({ series, query }) => series === 'show' && query.UserId === 'user-a' && query.SeasonId === 'season' && query.EnableUserData === true));
});

test('a repeated episode page fails instead of hanging or silently truncating a show', async () => {
  let requests = 0;
  const api = client({ getEpisodes: async () => {
    requests++;
    return { Items: [episode('one', 1)], TotalRecordCount: 3 };
  } });
  await assert.rejects(api.getEpisodes('show', 'season'), /repeated.*episode/i);
  assert.equal(requests, 2);
});

test('prematurely empty and malformed lists remain errors rather than empty-library states', async () => {
  const incomplete = client({ getEpisodes: async () => ({ Items: [], TotalRecordCount: 2 }) });
  await assert.rejects(incomplete.getEpisodes('show', 'season'), /incomplete/i);
  const malformed = client({ getSeasons: async () => ({ TotalRecordCount: 0 }) });
  await assert.rejects(malformed.getSeasons('show'), /invalid.*season/i);
  const empty = client({ getSeasons: async () => ({ Items: [] }) });
  assert.deepEqual(await empty.getSeasons('show'), []);
});

test('containing collections use paginated direct membership, not an item parent or an Ids query', async () => {
  const requests: { user: string; query: Record<string, unknown> }[] = [];
  const box = (id: string): Item => ({ Id: id, Name: id, Type: 'BoxSet', ImageTags: { Primary: 'art' } });
  const api = client({ getItems: async (user: string, query: Record<string, unknown>) => {
    requests.push({ user, query });
    if (!query.ParentId) return query.StartIndex === 0
      ? { Items: [box('first'), box('unrelated')], TotalRecordCount: 4 }
      : { Items: [box('second'), { Id: 'not-a-collection', Name: 'Movie', Type: 'Movie' }], TotalRecordCount: 4 };
    if (query.ParentId === 'first') return query.StartIndex === 0
      ? { Items: [{ Id: 'other', Name: 'Other', Type: 'Movie' }], TotalRecordCount: 2 }
      : { Items: [{ Id: 'target', Name: 'Target', Type: 'Movie' }], TotalRecordCount: 2 };
    if (query.ParentId === 'second') return { Items: [{ Id: 'target', Name: 'Target', Type: 'Series' }], TotalRecordCount: 1 };
    return { Items: [], TotalRecordCount: 0 };
  } });
  const collections = await api.getCollections('target');
  assert.deepEqual(collections.map(item => item.Id), ['first', 'second']);
  assert.equal(collections[0].ImageTags?.Primary, 'art');
  assert.ok(requests.every(({ user, query }) => user === 'user-a' && !('Ids' in query)));
  const lists = requests.filter(({ query }) => !query.ParentId);
  assert.deepEqual(lists.map(({ query }) => query.StartIndex), [0, 2]);
  assert.ok(lists.every(({ query }) => query.IncludeItemTypes === 'BoxSet' && query.Recursive === true));
  const members = requests.filter(({ query }) => query.ParentId);
  assert.ok(members.every(({ query }) => query.ParentId !== 'target' && query.Recursive === false && query.CollapseBoxSetItems === false));
  assert.deepEqual(members.filter(({ query }) => query.ParentId === 'first').map(({ query }) => query.StartIndex), [0, 1]);
  const count = requests.length;
  assert.deepEqual(await api.getCollections('target'), collections);
  assert.equal(requests.length, count, 'successful membership is cached for this detail view');
});

test('collection scans stop after a match and normalize Jellyfin UUID formats', async () => {
  const compact = 'abcdef1234567890abcdef1234567890';
  const dashed = 'ABCDEF12-3456-7890-ABCD-EF1234567890';
  let membershipRequests = 0;
  const api = client({ getItems: async (_user: string, query: Record<string, unknown>) => {
    if (!query.ParentId) return { Items: [{ Id: 'collection', Name: 'Collection', Type: 'BoxSet' }], TotalRecordCount: 1 };
    membershipRequests++;
    assert.equal(query.StartIndex, 0);
    return { Items: [{ Id: dashed, Name: 'Target', Type: 'Series' }], TotalRecordCount: 2000 };
  } });
  assert.deepEqual((await api.getCollections(compact)).map(item => item.Id), ['collection']);
  assert.deepEqual((await api.getCollections(dashed)).map(item => item.Id), ['collection']);
  assert.equal(membershipRequests, 1);
});

test('collection browser retains every page and applies the native library scope', async () => {
  const queries:Record<string,unknown>[]=[];
  const api=client({getItems:async(user:string,query:Record<string,unknown>)=>{
    assert.equal(user,'user-a');queries.push(query);
    return query.StartIndex===0
      ? {Items:[{Id:'coast',Name:'Coast',Type:'BoxSet'}],TotalRecordCount:2}
      : {Items:[{Id:'mountains',Name:'Mountains',Type:'BoxSet'}],TotalRecordCount:2};
  }});
  assert.deepEqual((await api.getCollectionList('movie-library')).map(item=>item.Id),['coast','mountains']);
  assert.deepEqual(queries.map(query=>query.StartIndex),[0,1]);
  assert.ok(queries.every(query=>query.ParentId==='movie-library'&&query.IncludeItemTypes==='BoxSet'&&query.Recursive===true));
});

test('collection contents preserve mixed and nested members without collapsing or flattening them', async () => {
  const queries:Record<string,unknown>[]=[];
  const api=client({getItems:async(_user:string,query:Record<string,unknown>)=>{
    queries.push(query);
    return query.StartIndex===0
      ? {Items:[{Id:'movie',Name:'Movie',Type:'Movie'},{Id:'nested',Name:'Nested',Type:'BoxSet'}],TotalRecordCount:5}
      : {Items:[{Id:'show',Name:'Show',Type:'Series'},{Id:'track',Name:'Track',Type:'Audio'},{Id:'missing',Name:'Missing',IsMissing:true}],TotalRecordCount:5};
  }});
  assert.deepEqual((await api.getCollectionItems('collection')).map(item=>item.Id),['movie','nested','show','track']);
  assert.ok(queries.every(query=>query.ParentId==='collection'&&query.Recursive===false&&query.CollapseBoxSetItems===false&&!query.IncludeItemTypes&&!query.Ids));
});

test('collection contents retain the server configured display order across pages', async () => {
  const releaseOrder = [
    {Id:'z-first',Name:'Z first released',Type:'Movie',PremiereDate:'1980-01-01'},
    {Id:'a-second',Name:'A second released',Type:'Movie',PremiereDate:'2000-01-01'},
    {Id:'m-third',Name:'M last released',Type:'Movie',PremiereDate:'2020-01-01'}
  ];
  const requests: Record<string,unknown>[] = [];
  const api = client({ getItems: async (_user: string, query: Record<string,unknown>) => {
    requests.push(query);
    // BoxSet already returns its DisplayOrder; a request sort would override it.
    const ordered = query.SortBy === 'SortName' ? [...releaseOrder].sort((a,b)=>a.Name.localeCompare(b.Name)) : releaseOrder;
    const start = Number(query.StartIndex);
    return { Items:ordered.slice(start,start+2), TotalRecordCount:3 };
  } });
  assert.deepEqual((await api.getCollectionItems('release-ordered')).map(item=>item.Id), ['z-first','a-second','m-third']);
  assert.deepEqual(requests.map(query=>query.StartIndex), [0,2]);
  assert.ok(requests.every(query=>!('SortBy' in query)&&!('SortOrder' in query)));
});

test('a failed collection read does not return or cache a partial membership list', async () => {
  let fail = true;
  let lists = 0;
  const api = client({ getItems: async (_user: string, query: Record<string, unknown>) => {
    if (!query.ParentId) {
      lists++;
      return { Items: ['first', 'second'].map(id => ({ Id: id, Name: id, Type: 'BoxSet' })), TotalRecordCount: 2 };
    }
    if (query.ParentId === 'second' && fail) throw new Error('Collection is unavailable');
    return { Items: [{ Id: 'target', Name: 'Target' }], TotalRecordCount: 1 };
  } });
  await assert.rejects(api.getCollections('target'), /collection is unavailable/i);
  fail = false;
  assert.deepEqual((await api.getCollections('target')).map(item => item.Id), ['first', 'second']);
  assert.equal(lists, 2);
});

test('collection pagination stops if the signed-in account changes during a member request', async () => {
  let user = 'user-a';
  let memberRequests = 0;
  const api = client({
    getCurrentUserId: () => user,
    getItems: async (_user: string, query: Record<string, unknown>) => {
      if (!query.ParentId) return { Items: [{ Id: 'collection', Name: 'Collection', Type: 'BoxSet' }], TotalRecordCount: 1 };
      memberRequests++;
      user = 'user-b';
      return { Items: [{ Id: 'other', Name: 'Other' }], TotalRecordCount: 2 };
    }
  });
  await assert.rejects(api.getCollections('target'), /account changed/i);
  assert.equal(memberRequests, 1);
});

test('collection membership requests use bounded concurrency', async () => {
  let active = 0;
  let peak = 0;
  let inspected = 0;
  const api = client({ getItems: async (_user: string, query: Record<string, unknown>) => {
    if (!query.ParentId) return {
      Items: Array.from({ length: 9 }, (_, index) => ({ Id: `collection-${index}`, Name: 'Collection', Type: 'BoxSet' })),
      TotalRecordCount: 9
    };
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    inspected++; active--;
    return { Items: [], TotalRecordCount: 0 };
  } });
  assert.deepEqual(await api.getCollections('target'), []);
  assert.equal(inspected, 9);
  assert.ok(peak > 1 && peak <= 4, `expected between two and four concurrent requests, got ${peak}`);
});

test('channels paginate, retain programme data, and sort channel numbers numerically', async () => {
  const requests: Record<string, unknown>[] = [];
  const programme = { Id: 'programme', Name: 'News', Type: 'Program' };
  const api = client({ getLiveTvChannels: async (query: Record<string, unknown>) => {
    requests.push(query);
    return query.StartIndex === 0
      ? { Items: [{ Id: 'ten', Name: 'Ten', Type: 'TvChannel', ChannelNumber: '10' }], TotalRecordCount: 2 }
      : { Items: [{ Id: 'two', Name: 'Two', Type: 'TvChannel', ChannelNumber: '2', CurrentProgram: programme }], TotalRecordCount: 2 };
  } });
  const channels = await api.getChannels();
  assert.deepEqual(channels.map(item => item.Id), ['two', 'ten']);
  assert.equal(channels[0].CurrentProgram, programme);
  assert.ok(requests.every(query => query.AddCurrentProgram === true && query.UserId === 'user-a'));
  assert.deepEqual(requests.map(query => query.StartIndex), [0, 1]);
});

test('guide includes currently airing programmes and bounds downloads to one day', async () => {
  const requests: Record<string, unknown>[] = [];
  const before = Date.now();
  const api = client({ getLiveTvPrograms: async (query: Record<string, unknown>) => {
    requests.push(query);
    return query.StartIndex === 0
      ? { Items: [{ Id: 'later', Name: 'Later', StartDate: '2026-09-22T13:00:00Z' }], TotalRecordCount: 2 }
      : { Items: [{ Id: 'now', Name: 'Now', StartDate: '2026-09-22T12:00:00Z' }], TotalRecordCount: 2 };
  } });
  assert.deepEqual((await api.getPrograms('channel')).map(item => item.Id), ['now', 'later']);
  const cutoff = Date.parse(String(requests[0].MaxStartDate));
  assert.ok(cutoff >= before + 86_400_000 && cutoff <= Date.now() + 86_400_000);
  assert.equal(requests[0].MaxStartDate, requests[1].MaxStartDate);
  assert.ok(requests.every(query => query.ChannelIds === 'channel' && query.HasAired === false && !('MinStartDate' in query)));
});

test('account changes invalidate in-flight results and prevent subsequent favorite writes', async () => {
  let user = 'user-a';
  let resolveItem!: (item: Item) => void;
  let writes = 0;
  const api = client({
    getCurrentUserId: () => user,
    getItem: () => new Promise<Item>(resolve => { resolveItem = resolve; }),
    updateFavoriteStatus: async () => { writes++; }
  });
  const pending = api.getItem('movie');
  user = 'user-b';
  resolveItem({ Id: 'movie', Name: 'Movie' });
  await assert.rejects(pending, /account changed/i);
  await assert.rejects(api.setFavorite('movie', true), /account changed/i);
  assert.equal(writes, 0);
});

test('replaced clients, server switches and sign-out invalidate pending reads and writes', async () => {
  for (const change of ['replace', 'server', 'sign-out']) {
    let serverId = 'server-a';
    let resolveItem!: (item: Item) => void;
    let writes = 0;
    const api = client({
      serverId: () => serverId,
      getItem: () => new Promise<Item>(resolve => { resolveItem = resolve; }),
      updateFavoriteStatus: async () => { writes++; }
    });
    const pending = api.getItem('movie');
    if (change === 'replace') client();
    else if (change === 'server') serverId = 'server-b';
    else global('ApiClient', undefined);
    resolveItem({ Id: 'movie', Name: 'Old item' });
    await assert.rejects(pending, /account changed/i);
    await assert.rejects(api.setFavorite('movie', true), /account changed/i);
    assert.equal(writes, 0);
  }
});

test('access and missing-item failures have actionable messages', async () => {
  for (const [status, message] of [[401, /sign in/i], [403, /access/i], [404, /no longer available/i]] as const) {
    const api = client({ getItem: async () => { throw { status }; } });
    await assert.rejects(api.getItem('movie'), message);
  }
  const api = client({ getItem: async () => ({ Id: 'different', Name: 'Other movie' }) });
  await assert.rejects(api.getItem('movie'), /requested media/i);
});

test('missing optional images and empty next-up remain valid states', async () => {
  const images: { id: string; query: Record<string, unknown> }[] = [];
  const api = client({
    getNextUpEpisodes: async () => ({ Items: [] }),
    getImageUrl: (id: string, query: Record<string, unknown>) => { images.push({ id, query }); return '/image'; }
  });
  assert.equal(await api.getNextEpisode('show'), null);
  assert.equal(api.image({ Id: 'movie', Name: 'Movie' }, 'logo'), null);
  assert.equal(api.image({ Id: 'ep', Name: 'Episode', ParentBackdropItemId: 'show', ParentBackdropImageTags: ['tag'] }, 'backdrop'), '/image');
  assert.equal(images[0].id, 'show');
  assert.equal(images[0].query.type, 'Backdrop');
});

function nativePage(identity: string | (() => string), options: { routeId?: string; hiddenButton?: boolean; expectedSelector?: string } = {}) {
  let clicked = 0;
  const button = {
    disabled: false, hidden: !!options.hiddenButton,
    classList: { contains: () => false }, click: () => { clicked++; }
  };
  global('location', { hash: `#/details?id=${options.routeId || 'movie'}`, pathname: '/', search: '' });
  global('document', {
    body: {},
    querySelectorAll: () => [{
      hidden: false, classList: { contains: () => false },
      querySelector: (selector: string) => selector.includes('[data-id]')
        ? { dataset: { id: typeof identity === 'function' ? identity() : identity } }
        : options.expectedSelector && selector !== options.expectedSelector ? null : button
    }],
    createElement: () => { throw new Error('No playback bridge in this fixture'); }
  });
  return () => clicked;
}

test('current movie uses native Play only after native item identity has caught up', async () => {
  const clicks = nativePage('movie');
  const api = client();
  await api.play({ Id: 'movie', Name: 'Movie', Type: 'Movie' }, 0, () => true);
  assert.equal(clicks(), 1);
});

test('stale native details, another route, and unavailable native buttons cannot report successful dispatch', async () => {
  const movie: Item = { Id: 'movie', Name: 'Movie', Type: 'Movie' };
  for (const scenario of [{ id: 'previous' }, { id: 'movie', routeId: 'other' }, { id: 'movie', hiddenButton: true }]) {
    const clicks = nativePage(scenario.id, scenario);
    const api = client();
    await assert.rejects(api.play(movie, 0, () => true), /Playback could not start in this client/i);
    assert.equal(clicks(), 0);
  }
});

test('closed pages, unavailable media, and future programmes never dispatch playback', async () => {
  const clicks = nativePage('movie');
  const api = client();
  await assert.rejects(api.play({ Id: 'movie', Name: 'Movie', Type: 'Movie' }, 0, () => false), { name: 'AbortError' });
  await assert.rejects(api.play({ Id: 'movie', Name: 'Movie', Type: 'Movie', PlayAccess: 'None' }, 0, () => true), /not available/i);
  await assert.rejects(api.play({
    Id: 'programme', Name: 'Future', Type: 'Program', ChannelId: 'channel',
    StartDate: new Date(Date.now() + 60_000).toISOString(), EndDate: new Date(Date.now() + 120_000).toISOString()
  }, 0, () => true), /not currently live/i);
  assert.equal(clicks(), 0);
});

function bridgePage(options: { handled?: boolean; registered?: boolean } = {}) {
  const commands: { command: unknown; data: Record<string, string> }[] = [];
  const containers: BridgeElement[] = [];
  class BridgeElement {
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    isConnected = false;
    removed = false;
    parent?: BridgeElement;
    attachedCallback?: () => void;
    setAttribute() { /* Attributes do not affect the command contract in this fixture. */ }
    appendChild(child: BridgeElement) { child.parent = this; }
    addEventListener() { /* Native command handling is emulated by dispatchEvent. */ }
    dispatchEvent(event: CustomEvent) {
      commands.push({ command: event.detail.command, data: { ...this.dataset } });
      if (options.handled !== false) event.preventDefault();
      return !event.defaultPrevented;
    }
    remove() { this.isConnected = false; this.removed = true; }
  }
  global('location', { hash: '#/details?id=movie', pathname: '/', search: '' });
  global('document', {
    querySelectorAll: () => [],
    body: { appendChild: (element: BridgeElement) => { element.isConnected = true; } },
    createElement: (_tag: string, extension?: string) => {
      const element = new BridgeElement();
      if (extension === 'emby-itemscontainer') {
        if (options.registered !== false) element.attachedCallback = () => {};
        containers.push(element);
      }
      return element;
    }
  });
  return { commands, containers };
}

const movie: Item = { Id: 'movie', Name: 'Movie', Type: 'Movie' };

test('audio, albums and recorded videos use native playback metadata and remove the temporary bridge', async () => {
  for (const type of ['Audio', 'MusicAlbum', 'Video']) {
    const bridge = bridgePage();
    await client().play({Id:'media', Name:'Media', Type:type}, 120, () => true);
    assert.deepEqual(bridge.commands, [{ command:'play', data:{id:'media', type,
      mediatype:type === 'Video' ? 'Video' : 'Audio', serverid:'server-a', isfolder:type === 'MusicAlbum' ? 'true' : 'false', positionticks:'120'} }]);
    assert.ok(bridge.containers.every(container => container.removed));
  }
});

test('movie trailers use the native Trailer control for local and remote sources', async () => {
  for (const metadata of [{ LocalTrailerCount: 1 }, { LocalTrailerCount: 0, RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=abc' }] }]) {
    const clicks = nativePage('movie', { expectedSelector: '.btnPlayTrailer' });
    const api = client({ getLocalTrailers: async () => { throw new Error('Native trailer should own source selection'); } });
    await api.playTrailer({ ...movie, ...metadata }, () => true);
    assert.equal(clicks(), 1);
  }
});

test('remote trailer waits for the native item identity before clicking its Trailer control', async () => {
  let nativeIdentity = 'previous-movie';
  const clicks = nativePage(() => nativeIdentity, { expectedSelector: '.btnPlayTrailer' });
  const pending = client().playTrailer({ ...movie, LocalTrailerCount: 0, RemoteTrailers: [{ Url: 'https://www.youtube.com/watch?v=abc' }] }, () => true);
  assert.equal(clicks(), 0);
  nativeIdentity = 'movie';
  await pending;
  assert.equal(clicks(), 1);
});

test('local trailer fallback fetches with the active user and plays the actual trailer from its start', async () => {
  const bridge = bridgePage();
  const requests: string[][] = [];
  const api = client({ getLocalTrailers: async (user: string, id: string) => {
    requests.push([user, id]);
    return [
      { Id: 'missing-trailer', Type: 'Trailer', IsMissing: true },
      { Id: 'movie', Type: 'Trailer' },
      { Id: 'trailer', Name: 'Official trailer', Type: 'Trailer', UserData: { PlaybackPositionTicks: 8000 } }
    ];
  } });
  await api.playTrailer({ ...movie, LocalTrailerCount: 2 }, () => true);
  assert.deepEqual(requests, [['user-a', 'movie']]);
  assert.equal(bridge.commands.length, 1);
  assert.deepEqual(bridge.commands[0], {
    command: 'play', data: { id: 'trailer', type: 'Trailer', mediatype: 'Video', serverid: 'server-a', isfolder: 'false', positionticks: '0' }
  });
  assert.ok(bridge.containers.every(container => container.removed));
});

test('unavailable, malformed, and denied trailers produce useful errors without playback', async () => {
  const bridge = bridgePage();
  await assert.rejects(client().playTrailer({ ...movie, LocalTrailerCount: 0, RemoteTrailers: [] }, () => true), /no trailer is available/i);
  await assert.rejects(client({ getLocalTrailers: async () => [] }).playTrailer(movie, () => true), /no playable trailer/i);
  await assert.rejects(client({ getLocalTrailers: async () => ({ Items: [] }) }).playTrailer(movie, () => true), /invalid trailer list/i);
  await assert.rejects(client({ getLocalTrailers: async () => { throw { status: 403 }; } }).playTrailer(movie, () => true), /sign in/i);
  assert.equal(bridge.commands.length, 0);
});

test('remote metadata never dispatches the local-only playtrailer shortcut or opens an external URL', async () => {
  const bridge = bridgePage();
  let externalOpens = 0;
  global('window', { open: () => { externalOpens++; } });
  const api = client({ getLocalTrailers: async () => { throw new Error('Known remote-only movie must not fetch local trailers'); } });
  await assert.rejects(api.playTrailer({ ...movie, LocalTrailerCount: 0, RemoteTrailers: [{ Url: 'javascript:alert(1)' }] }, () => true), /Trailer playback is unavailable in this client/i);
  assert.equal(bridge.commands.length, 0);
  assert.equal(externalOpens, 0);
});

test('trailer dispatch does not succeed when the registered playback bridge is unavailable or unhandled', async () => {
  for (const options of [{ registered: false }, { handled: false }]) {
    const bridge = bridgePage(options);
    const api = client({ getLocalTrailers: async () => [{ Id: 'trailer', Type: 'Trailer' }] });
    await assert.rejects(api.playTrailer(movie, () => true), /Trailer playback could not start in this client/i);
    assert.ok(bridge.containers.every(container => container.removed));
  }
});

test('page cancellation and account changes during trailer lookup prevent dispatch', async () => {
  for (const changeAccount of [false, true]) {
    const bridge = bridgePage();
    let user = 'user-a';
    let current = true;
    let resolveTrailers!: (items: Item[]) => void;
    const api = client({
      getCurrentUserId: () => user,
      getLocalTrailers: () => new Promise<Item[]>(resolve => { resolveTrailers = resolve; })
    });
    const pending = api.playTrailer(movie, () => current);
    if (changeAccount) user = 'user-b';
    else current = false;
    resolveTrailers([{ Id: 'trailer', Name: 'Trailer', Type: 'Trailer' }]);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(bridge.commands.length, 0);
    assert.equal(bridge.containers.length, 0);
  }
});

test('closed pages and inaccessible movies cannot click native Trailer controls', async () => {
  const clicks = nativePage('movie', { expectedSelector: '.btnPlayTrailer' });
  const api = client();
  await assert.rejects(api.playTrailer(movie, () => false), { name: 'AbortError' });
  await assert.rejects(api.playTrailer({ ...movie, PlayAccess: 'None' }, () => true), /not available/i);
  await assert.rejects(api.playTrailer({ ...movie, Type: 'Episode' }, () => true), /movie is not available/i);
  assert.equal(clicks(), 0);
});


test('custom catalogue and draft preview use authenticated endpoints with bounded queries and validated drafts', async () => {
  let current = 'user-a';
  const calls: { type?: string; url: string; data?: string }[] = [];
  const data = { Items: [{ Id: 'film', Name: 'Film', Type: 'Movie' }], TotalRecordCount: 1, Pending: 0, Total: 1, Status: 'ready', Region: 'BR', UpdatedAt: null };
  const api = client({ getCurrentUserId: () => current,
    getUrl: (path: string, query: Record<string, string> = {}) => path + '?' + new URLSearchParams(query),
    getJSON: async (url: string) => { calls.push({ url }); return data; },
    ajax: async (request: { type: string; url: string; data: string }) => { calls.push(request); return data; } });
  const draft = { ...defaultCustomProvider('custom-public'), movieProviderIds: [38], offerTypes: ['free' as const] };
  await api.getProviderItems!(draft.id, { type: 'Movie', startIndex: -2, limit: 200 });
  assert.match(calls[0].url, /^TvItemLayout\/Providers\/custom-public\/Items\?type=Movie&startIndex=0&limit=100&sort=title$/);
  await api.previewProviderItems!(draft, { type: 'Movie', limit: 8 });
  assert.equal(calls[1].type, 'POST'); assert.match(calls[1].url, /Providers\/Preview\?mediaType=Movie/); assert.deepEqual(JSON.parse(calls[1].data!), draft);
  await assert.rejects(api.previewProviderItems!({ ...draft, logoUrl: 'https://user:password@example.com/image' }, { type: 'Movie' }), /invalid/i);
  await assert.rejects(api.getProviderItems!('../private', { type: 'Movie' }), /Unknown/); assert.equal(calls.length, 2);
  current = 'user-b'; await assert.rejects(api.previewProviderItems!(draft, { type: 'Movie' }), /account changed/i); assert.equal(calls.length, 2);
});

test('named streaming service directory uses the authenticated endpoint and separate BR lists', async () => {
  const requests: string[] = [];
  const data = { Region: 'BR', Movies: [{ Id: 591, Name: 'NOW Cinema' }], Shows: [{ Id: 39, Name: 'NOW' }] };
  const api = client({ getUrl: (path: string) => path, getJSON: async (url: string) => { requests.push(url); return data; } });
  assert.equal(await api.getProviderDirectory!(), data);
  assert.deepEqual(requests, ['TvItemLayout/Providers/Catalogue']);
});

test('named service directory rejects foreign, malformed and unbounded entries', async () => {
  const valid = { Region: 'BR', Movies: [{ Id: 8, Name: 'Netflix' }], Shows: [] };
  for (const value of [null, {}, { ...valid, Region: 'US' }, { ...valid, Shows: null },
    ...[null, {}, { Id: 0, Name: 'Invalid' }, { Id: 1000001, Name: 'Invalid' }, { Id: 1.5, Name: 'Invalid' },
      { Id: 8, Name: '' }, { Id: 8, Name: '  ' }, { Id: 8, Name: 'Bad\nname' }, { Id: 8, Name: 'a'.repeat(121) }]
      .map(entry => ({ ...valid, Movies: [entry] })),
    { ...valid, Movies: [...valid.Movies, ...valid.Movies] },
    { ...valid, Shows: Array.from({ length: 2001 }, (_, index) => ({ Id: index + 1, Name: 'Service' })) }
  ]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => value });
    await assert.rejects(api.getProviderDirectory!(), /invalid streaming service list/i);
  }
});

test('named service directory rejects responses after account changes and preserves unavailable errors', async () => {
  let user = 'user-a'; let resolve!: (value: unknown) => void; let calls = 0;
  const api = client({ getCurrentUserId: () => user, getUrl: (path: string) => path,
    getJSON: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const request = api.getProviderDirectory!(); user = 'user-b';
  resolve({ Region: 'BR', Movies: [], Shows: [] });
  await assert.rejects(request, /account changed/i);
  await assert.rejects(api.getProviderDirectory!(), /account changed/i);
  assert.equal(calls, 1);
  const unavailable = client({ getUrl: (path: string) => path, getJSON: async () => { throw { status: 503 }; } });
  await assert.rejects(unavailable.getProviderDirectory!(), /connection/i);
});

test('Watchlist browsing sends bounded typed library filters and preserves raw paging after inaccessible items', async () => {
  const urls: { path: string; query?: unknown }[] = [];
  const api = client({ getUrl: (path: string, query?: unknown) => { urls.push({ path, query }); return path; },
    getJSON: async () => ({ Items: [{ Id: 'film', Name: 'Film', Type: 'Movie' }, { Id: 'hidden', Name: 'Hidden', Type: 'Movie', IsPlaceHolder: true }], StartIndex: 0, TotalRecordCount: 3 }) });
  const result = await api.getWatchlist!({ type: 'Movie', parentId: 'library', search: '  sea  ', letter: ' a ', genreId: 'drama', limit: 200, startIndex: -4 });
  assert.deepEqual(urls, [{ path: 'TvItemLayout/Watchlist', query: { type: 'Movie', parentId: 'library', searchTerm: 'sea', letter: 'A', genreId: 'drama', limit: 100, startIndex: 0, sort: 'title' } }]);
  assert.deepEqual(result.items.map(item => item.Id), ['film']); assert.equal(result.nextStartIndex, 2); assert.equal(result.total, 3);
});

test('Watchlist browsing rejects malformed pages, wrong media types and invalid filters before fetching', async () => {
  const movie = { Id: 'film', Name: 'Film', Type: 'Movie' };
  for (const data of [null, {}, { Items: [movie], StartIndex: 1, TotalRecordCount: 1 }, { Items: [movie], StartIndex: 0, TotalRecordCount: 0 },
    { Items: [], StartIndex: 0, TotalRecordCount: 2 }, { Items: [movie], StartIndex: 0, TotalRecordCount: 1.5 },
    { Items: [{ ...movie, Type: 'Series' }], StartIndex: 0, TotalRecordCount: 1 }, { Items: [{ ...movie, Id: '' }], StartIndex: 0, TotalRecordCount: 1 },
    { Items: [movie, movie], StartIndex: 0, TotalRecordCount: 2 }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => data });
    await assert.rejects(api.getWatchlist!({ type: 'Movie', limit: 1 }), /invalid watchlist page/i);
  }
  let calls = 0;
  const api = client({ getUrl: (path: string) => path, getJSON: async () => { calls++; return {}; } });
  await assert.rejects(api.getWatchlist!({ type: 'Episode' as 'Movie' }), /invalid watchlist filter/i);
  await assert.rejects(api.getWatchlist!({ letter: 'AB' }), /invalid watchlist filter/i); assert.equal(calls, 0);
});

test('Watchlist writes use POST and DELETE and only confirmed saved states dispatch account-scoped changes', async () => {
  const events: unknown[] = [], requests: Record<string, unknown>[] = [];
  const target = new EventTarget(); global('window', target);
  target.addEventListener('tvl-watchlist-change', event => events.push((event as CustomEvent).detail));
  const id = 'aabbccdd-1122-3344-5566-778899aabbcc';
  const api = client({ getUrl: (path: string) => path, getJSON: async () => ({ ItemId: id.replace(/-/g, '').toUpperCase(), InWatchlist: false }),
    ajax: async (request: Record<string, unknown>) => { requests.push(request); return { ItemId: id, InWatchlist: request.type === 'POST' }; } });
  assert.equal((await api.getWatchlistState!(id)).InWatchlist, false);
  assert.equal((await api.setWatchlist!(id, true)).InWatchlist, true);
  assert.equal((await api.setWatchlist!(id, false)).InWatchlist, false);
  assert.deepEqual(requests, ['POST', 'DELETE'].map(type => ({ type, url: `TvItemLayout/Watchlist/${id}`, dataType: 'json' })));
  assert.deepEqual(events, [true, false].map(InWatchlist => ({ serverId: 'server-a', userId: 'user-a', ItemId: id, InWatchlist })));
});

test('Watchlist membership and writes cannot acknowledge another item or a false save', async () => {
  const target = new EventTarget(); global('window', target); let changes = 0;
  target.addEventListener('tvl-watchlist-change', () => changes++);
  for (const data of [null, {}, { ItemId: 'other', InWatchlist: true }, { ItemId: 'film', InWatchlist: 'true' }]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => data, ajax: async () => data });
    await assert.rejects(api.getWatchlistState!('film'), /invalid watchlist information/i);
    await assert.rejects(api.setWatchlist!('film', true), /invalid watchlist information/i);
  }
  const api = client({ getUrl: (path: string) => path, ajax: async () => ({ ItemId: 'film', InWatchlist: false }) });
  await assert.rejects(api.setWatchlist!('film', true), /invalid watchlist information/i); assert.equal(changes, 0);
});

test('Watchlist APIs reject results after an account or server change and never publish stale saves', async () => {
  const target = new EventTarget(); global('window', target); let changes = 0;
  target.addEventListener('tvl-watchlist-change', () => changes++);
  for (const method of ['getWatchlist', 'getWatchlistState', 'setWatchlist'] as const) for (const changed of ['user', 'server']) {
    let user = 'user-a', server = 'server-a', requests = 0; let finish!: (data: unknown) => void;
    const pending = () => { requests++; return new Promise(resolve => { finish = resolve; }); };
    const api = client({ getCurrentUserId: () => user, serverId: () => server, getUrl: (path: string) => path, getJSON: pending, ajax: pending });
    const invoke = () => method === 'getWatchlist' ? api.getWatchlist!() : method === 'getWatchlistState' ? api.getWatchlistState!('film') : api.setWatchlist!('film', true);
    const response = invoke(); if (changed === 'user') user = 'user-b'; else server = 'server-b';
    finish(method === 'getWatchlist' ? { Items: [], StartIndex: 0, TotalRecordCount: 0 } : { ItemId: 'film', InWatchlist: true });
    await assert.rejects(response, /account changed/i); await assert.rejects(invoke(), /account changed/i); assert.equal(requests, 1);
  }
  assert.equal(changes, 0);
});

test('Watchlist write failures expose denied access, missing titles and duplicate private playlists without retries', async () => {
  for (const [status, expected] of [[401, /sign in/i], [403, /access/i], [404, /no longer available/i], [422, /rename one in playlists/i], [500, /unable to update/i]] as const) {
    let calls = 0;
    const api = client({ getUrl: (path: string) => path, ajax: async () => { calls++; throw { status }; } });
    await assert.rejects(api.setWatchlist!('film', true), expected); assert.equal(calls, 1);
  }
});

test('Home exclusions read resolved view and physical library IDs afresh for the current account', async () => {
  const calls: { path: string; query?: unknown }[] = [];
  const music = '7E64E319-657A-9516-EC78-490DA03EDCCB';
  const playlistView = '03e69facd973b23e36355c45ba598e6b';
  const playlistFolder = '1071671E-7BFF-A053-2E93-0DEBEE501D2E';
  const musicId = music.replace(/-/g, '').toLowerCase(), folderId = playlistFolder.replace(/-/g, '').toLowerCase();
  let exclusions: unknown = [music, playlistView, playlistFolder, musicId];
  const api = client({ getUrl: (path: string, query?: unknown) => { calls.push({ path, query }); return path; },
    getJSON: async () => ({ UserId: 'user-a', ExcludedLibraryIds: exclusions }) });
  assert.deepEqual(await api.getHomeLibraryExclusions!(), [musicId, playlistView, folderId]);
  exclusions = [music]; assert.deepEqual(await api.getHomeLibraryExclusions!(), [musicId]);
  exclusions = []; assert.deepEqual(await api.getHomeLibraryExclusions!(), []);
  assert.deepEqual(calls, Array(3).fill({ path: 'TvItemLayout/HomeLibraryExclusions', query: undefined }));
});

test('Home exclusions reject malformed mappings and results from another account', async () => {
  const invalidLists = [undefined, 'music', null, [null], [1], [''], ['not-a-library-id'], ['a'.repeat(200)]];
  const malformed = invalidLists.map(ExcludedLibraryIds => ({ UserId: 'user-a', ExcludedLibraryIds }));
  for (const response of [null, {}, [], { UserId: 'user-b', ExcludedLibraryIds: [] }, ...malformed]) {
    const api = client({ getUrl: (path: string) => path, getJSON: async () => response });
    await assert.rejects(api.getHomeLibraryExclusions!(), /invalid Home/);
  }
  for (const change of ['user', 'server']) {
    let user = 'user-a', server = 'server-a', resolve!: (value: unknown) => void;
    const api = client({ getCurrentUserId: () => user, serverId: () => server, getUrl: (path: string) => path,
      getJSON: () => new Promise(done => { resolve = done; }) });
    const pending = api.getHomeLibraryExclusions!();
    if (change === 'user') user = 'user-b'; else server = 'server-b';
    resolve({ UserId: 'user-a', ExcludedLibraryIds: [] });
    await assert.rejects(pending, /account changed/);
  }
});
