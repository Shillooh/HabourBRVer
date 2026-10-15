import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderData, ProviderDataError, type ProviderItemsPage } from '../src/provider-data.ts';
import { providerBrands } from '../src/provider-brands.ts';
import { defaultProviderConfig, defaultCustomProvider, type ProviderRow } from '../src/provider-settings.ts';
import type { Item, MediaApi } from '../src/types.ts';

const chartBrands = [...providerBrands];
const item = (Id: string, Type = 'Movie', Name = Id): Item => ({ Id, Name, Type });
const collection = (Id: string, Name: string): Item => item(Id, 'BoxSet', Name);
const row = (source: ProviderRow['source'], change: Partial<ProviderRow> = {}): ProviderRow => ({ id: source, title: source, source, collectionId: '', enabled: true, ranked: false, itemSort: 'collection', ...change });
const api = (change: Partial<MediaApi> = {}): MediaApi => ({ serverId: 'server', userId: 'alice', getCollectionList: async () => [], getCollectionItems: async () => [], ...change } as MediaApi);
const page = (Items: Item[], change: Partial<ProviderItemsPage> = {}): ProviderItemsPage => ({ Items, TotalRecordCount: Items.length, Pending: 0, Total: Items.length, UpdatedAt: null, Status: 'ready', Region: 'BR', ...change });
const ids = (result: { items: Item[] }) => result.items.map(item => item.Id);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const stale = (error: unknown) => error instanceof ProviderDataError && error.kind === 'stale';

test('full provider library and selected trending collection remain distinct sources without a catalogue fallback', async () => {
  const source = api({
    getProviderItems: async () => page([item('chart-hit'), item('older-film'), item('new-to-library')]),
    getCollectionList: async () => { throw new Error('Must not discover a chart by its name'); },
    getCollectionItems: async () => [item('chart-hit')]
  });
  const data = new ProviderData(source);
  assert.deepEqual(ids(await data.load('netflix', row('movies'))), ['chart-hit', 'older-film', 'new-to-library']);
  const trending = await data.load('netflix', row('trending-movies', { collectionId: 'chart' }));
  assert.deepEqual(ids(trending), ['chart-hit']); assert.equal(trending.sourceUrl, undefined);
  delete source.getProviderItems;
  const unavailable = await data.load('netflix', row('movies'));
  assert.deepEqual(unavailable.items, []); assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.missingSource, undefined);
});

test('catalogue queries isolate provider, media type, sort and page, while retaining partial indexing status', async () => {
  const calls: unknown[] = [];
  const data = new ProviderData(api({
    getProviderItems: async (provider, query) => {
      calls.push({ provider, query });
      return page([item(`${provider}-${query.type}`, query.type)], {
        TotalRecordCount: 82, Total: 430, Pending: 40, MissingIds: 3, FailedIds: 2, Status: 'refreshing', UpdatedAt: '2026-09-27T18:00:00Z'
      });
    },
    getCollectionList: async () => { throw new Error('Catalogue must not inspect chart collections'); }
  }));
  for (const provider of chartBrands) {
    for (const source of ['movies', 'shows'] as const) {
      const result = await data.load(provider.id, row(source, { itemSort: 'newest' }), 60, 20);
      assert.deepEqual(ids(result), [`${provider.id}-${source === 'movies' ? 'Movie' : 'Series'}`]);
      assert.equal(result.total, 82); assert.equal(result.totalToCheck, 430); assert.equal(result.pending, 40);
      assert.equal(result.missingIds, 3); assert.equal(result.failedIds, 2); assert.equal(result.status, 'refreshing');
      assert.equal(result.updatedAt, '2026-09-27T18:00:00Z'); assert.equal(result.sourceLabel, provider.id === 'disney' ? 'Disney studios · Disponibilidade de streaming (Brasil)' : 'Disponibilidade de streaming (Brasil) · JustWatch');
    }
  }
  assert.deepEqual(calls[0], { provider: 'netflix', query: { type: 'Movie', sort: 'newest', startIndex: 60, limit: 20 } });
  assert.deepEqual(calls[calls.length - 1], { provider: chartBrands[chartBrands.length - 1].id, query: { type: 'Series', sort: 'newest', startIndex: 60, limit: 20 } });
});

test('bound charts keep the saved rank order across filtering and pagination without collection discovery', async () => {
  let listReads = 0;
  const members = [item('rank-one', 'Movie', 'Zulu'), item('rank-two', 'Movie', 'Alpha'), item('rank-two'), item('not-film', 'Series'), item('rank-three')];
  const data = new ProviderData(api({
    getCollectionList: async () => { listReads++; return providerBrands.map(brand => collection(brand.id, `${brand.name} — Filmes em Alta (Brasil)`)); },
    getCollectionItems: async () => members
  }));
  for (const brand of chartBrands) {
    const bound = row('trending-movies', { collectionId: brand.id });
    const first = await data.load(brand.id, bound, 0, 2), second = await data.load(brand.id, bound, 2, 2);
    assert.deepEqual(ids(first), ['rank-one', 'rank-two']); assert.deepEqual(ids(second), ['rank-three']); assert.equal(first.total, 3);
  }
  assert.equal(listReads, 0); assert.deepEqual(members.map(member => member.Id), ['rank-one', 'rank-two', 'rank-two', 'not-film', 'rank-three']);
});

test('all bound movie and show charts retain media-specific ranks regardless of collection names', async () => {
  const charts = chartBrands.flatMap(brand => [
    collection(`${brand.id}-Movie`, `${brand.name} — Filmes em Alta (Brasil) [Smart]`),
    collection(`${brand.id}-Series`, `${brand.name} — Séries em Alta (Brasil) [Smart]`)
  ]);
  const reads: string[] = [];
  const data = new ProviderData(api({ getCollectionList: async () => charts, getCollectionItems: async id => {
    reads.push(id); const type = id.endsWith('-Movie') ? 'Movie' : 'Series';
    return [item(`${id}-first`, type, 'Zulu'), item(`${id}-second`, type, 'Alpha')];
  } }));
  for (const brand of chartBrands) for (const [source, type] of [['trending-movies', 'Movie'], ['trending-shows', 'Series']] as const) {
    const result = await data.load(brand.id, row(source, { collectionId: `${brand.id}-${type}` }));
    assert.deepEqual(ids(result), [`${brand.id}-${type}-first`, `${brand.id}-${type}-second`]);
    assert.equal(result.status, 'ready'); assert.equal(result.missingSource, undefined);
  }
  assert.equal(new Set(reads).size, chartBrands.length * 2);
});

test('unbound trending rows never guess a collection from exact, decorated, renamed or duplicate chart names', async () => {
  for (const names of [[], ['Netflix — Filmes em Alta (Brasil)'], ['Netflix — Filmes em Alta (Brasil) [Smart]'],
    ['Netflix — Filmes em Alta (Brasil) (Daily) [Smart]', 'Netflix — Filmes em Alta (Brasil) (Weekly) [Smart]'],
    ['Netflix — Filmes em Alta (Brasil)', 'Netflix — Filmes em Alta (Brasil)'], ['Meus filmes favoritos']]) {
    let listReads = 0, memberReads = 0;
    const data = new ProviderData(api({ getCollectionList: async () => { listReads++; return names.map((name, index) => collection(String(index), name)); },
      getCollectionItems: async () => { memberReads++; return [item('wrong-film')]; } }));
    for (const source of ['trending-movies', 'trending-shows'] as const) {
      const result = await data.load('netflix', row(source));
      assert.deepEqual(result.items, []); assert.equal(result.missingSource, true); assert.equal(result.status, 'unavailable');
      assert.equal(result.sourceUrl, undefined);
    }
    assert.equal(listReads, 0); assert.equal(memberReads, 0);
  }
});

test('saved collection IDs survive renames and duplicate names while a changed ID reads the newly selected collection', async () => {
  const names = [collection('daily-id', 'Daily films'), collection('weekly-id', 'Weekly films')];
  const reads: string[] = []; let listReads = 0;
  const data = new ProviderData(api({ getCollectionList: async () => { listReads++; return names; },
    getCollectionItems: async id => { reads.push(id); return [item(`${id}-first`), item(`${id}-second`)]; } }));
  const selected = row('trending-movies', { collectionId: 'weekly-id' });
  assert.deepEqual(ids(await data.load('netflix', selected)), ['weekly-id-first', 'weekly-id-second']);
  names.forEach(value => { value.Name = 'Netflix — Filmes em Alta (Brasil) (Daily) [Smart]'; });
  data.invalidate();
  assert.deepEqual(ids(await data.load('netflix', selected)), ['weekly-id-first', 'weekly-id-second']);
  assert.deepEqual(ids(await data.load('netflix', { ...selected, collectionId: 'daily-id' })), ['daily-id-first', 'daily-id-second']);
  assert.deepEqual(reads, ['weekly-id', 'weekly-id', 'daily-id']); assert.equal(listReads, 0);
});

test('a deleted bound collection reports its read failure without falling back to a similarly named collection', async () => {
  const reads: string[] = []; let listReads = 0;
  const data = new ProviderData(api({ getCollectionList: async () => { listReads++; return [collection('replacement', 'Netflix — Filmes em Alta (Brasil)')]; },
    getCollectionItems: async id => { reads.push(id); if (id === 'deleted-id') throw new Error('Collection not found'); return [item('replacement-film')]; } }));
  await assert.rejects(data.load('netflix', row('trending-movies', { collectionId: 'deleted-id' })), /Collection not found/);
  assert.deepEqual(reads, ['deleted-id']); assert.equal(listReads, 0);
  assert.deepEqual(ids(await data.load('netflix', row('trending-movies', { collectionId: 'replacement' }))), ['replacement-film']);
});

test('explicit collections keep native ordering, filter media type and deduplicate without pretending to be provider availability', async () => {
  const guid = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  const raw = [item('show', 'Series'), item('film'), item('episode', 'Episode'), item(guid), item(guid.replace(/-/g, '').toUpperCase()),
    item('a-b'), item('ab'), { ...item('missing'), IsMissing: true }, { ...item('denied'), PlayAccess: 'None' }, { ...item('virtual'), LocationType: 'Virtual' }];
  const data = new ProviderData(api({ getCollectionItems: async id => { assert.equal(id, 'chosen'); return raw; },
    getCollectionList: async () => { throw new Error('Explicit source must not depend on discovery'); },
    getProviderItems: async () => { throw new Error('Explicit collection must not load catalogue'); } }));
  const movies = await data.load('prime', row('movies', { collectionId: 'chosen' }));
  assert.deepEqual(ids(movies), ['film', guid, 'a-b', 'ab']); assert.equal(movies.sourceLabel, 'Selected Jellyfin collection'); assert.equal(movies.sourceUrl, undefined);
  assert.deepEqual(ids(await data.load('prime', row('shows', { collectionId: 'chosen' }))), ['show']);
  assert.deepEqual(ids(await data.load('prime', row('collection', { collectionId: 'chosen' }))), ['show', 'film', guid, 'a-b', 'ab']);
  assert.equal((await data.load('prime', row('collection'))).missingSource, true);
});

test('collection ordering is applied to all members before pagination, including stable year ties and absent years', async () => {
  const raw = [{ ...item('c', 'Movie', 'Charlie'), ProductionYear: 2024 }, { ...item('b', 'Movie', 'Beta'), ProductionYear: 2026 },
    item('z', 'Movie', 'Zulu'), { ...item('a', 'Movie', 'Alpha'), ProductionYear: 2026 }];
  const data = new ProviderData(api({ getCollectionItems: async () => raw }));
  const load = (itemSort: ProviderRow['itemSort'], start = 0) => data.load('disney', row('collection', { collectionId: 'chosen', itemSort }), start, 2);
  assert.deepEqual(ids(await load('title')), ['a', 'b']); assert.deepEqual(ids(await load('title', 2)), ['c', 'z']);
  assert.deepEqual(ids(await load('title-desc')), ['z', 'c']); assert.deepEqual(ids(await load('newest')), ['b', 'a']);
  assert.deepEqual(ids(await load('oldest')), ['c', 'b']); assert.deepEqual(raw.map(value => value.Id), ['c', 'b', 'z', 'a']);
});

test('empty bound collection reads are cached successfully then expire; invalidation refreshes their membership', async t => {
  let now = 1_000; t.mock.method(Date, 'now', () => now);
  let listReads = 0, memberReads = 0, members: Item[] = [];
  const data = new ProviderData(api({ getCollectionList: async () => { listReads++; return []; }, getCollectionItems: async () => { memberReads++; return members; } }));
  const bound = row('trending-movies', { collectionId: 'chart' });
  await data.load('netflix', bound); await data.load('netflix', bound);
  assert.equal(listReads, 0); assert.equal(memberReads, 1);
  now += 30_001;
  assert.deepEqual(ids(await data.load('netflix', bound)), []); assert.equal(listReads, 0); assert.equal(memberReads, 2);
  members = [item('new-film')]; await data.load('netflix', bound); assert.equal(memberReads, 2);
  data.invalidate(); assert.deepEqual(ids(await data.load('netflix', bound)), ['new-film']); assert.equal(listReads, 0); assert.equal(memberReads, 3);
});

test('failed bound collection membership is never cached as an empty success and can immediately retry', async () => {
  let listReads = 0, memberReads = 0;
  const data = new ProviderData(api({
    getCollectionList: async () => { listReads++; throw new Error('Collection discovery must not be used'); },
    getCollectionItems: async () => { if (++memberReads === 1) throw new Error('members offline'); return [item('found')]; }
  }));
  const bound = row('trending-movies', { collectionId: 'chart' });
  await assert.rejects(data.load('netflix', bound), /members offline/);
  assert.deepEqual(ids(await data.load('netflix', bound)), ['found']); assert.equal(listReads, 0); assert.equal(memberReads, 2);
});

test('concurrent collection rows and catalogue pages share only matching in-flight requests', async () => {
  let listReads = 0, memberReads = 0, catalogueReads = 0;
  const catalogue = deferred<ProviderItemsPage>();
  const data = new ProviderData(api({
    getCollectionList: async () => { listReads++; return [collection('chart', 'Netflix Filmes em Alta Brasil')]; },
    getCollectionItems: async () => { memberReads++; return [item('rank-one'), item('rank-two')]; },
    getProviderItems: async () => { catalogueReads++; return catalogue.promise; }
  }));
  const bound = row('trending-movies', { collectionId: 'chart' });
  const charts = await Promise.all([data.load('netflix', bound, 0, 1), data.load('netflix', bound, 1, 1)]);
  assert.equal(listReads, 0); assert.equal(memberReads, 1); assert.deepEqual(charts.map(ids), [['rank-one'], ['rank-two']]);
  const pages = [data.load('netflix', row('movies')), data.load('netflix', row('movies')), data.load('netflix', row('shows'))];
  await tick(); assert.equal(catalogueReads, 2); catalogue.resolve(page([item('film'), item('show', 'Series')]));
  assert.deepEqual((await Promise.all(pages)).map(ids), [['film'], ['film'], ['show']]);
  await data.load('netflix', row('movies')); assert.equal(catalogueReads, 3);
});

test('catalogue failures and malformed replies retry, while unavailable status retains already known items', async () => {
  let call = 0;
  const data = new ProviderData(api({ getProviderItems: async () => {
    if (++call === 1) throw new Error('catalogue offline');
    if (call === 2) return page([item('wrong-region')], { Region: 'US' as 'BR' });
    return page([item('known-film')], { Status: 'unavailable', Pending: 7, Total: 8 });
  } }));
  await assert.rejects(data.load('netflix', row('movies')), /catalogue offline/);
  await assert.rejects(data.load('netflix', row('movies')), error => error instanceof ProviderDataError && error.kind === 'invalid');
  const result = await data.load('netflix', row('movies')); assert.equal(result.status, 'unavailable'); assert.deepEqual(ids(result), ['known-film']); assert.equal(result.pending, 7);
});

test('invalidation rejects late reads without poisoning a newer request or its cached membership', async () => {
  const late = deferred<Item[]>(); let reads = 0;
  const data = new ProviderData(api({ getCollectionItems: async () => ++reads === 1 ? late.promise : [item('new')] }));
  const loading = data.load('netflix', row('collection', { collectionId: 'chosen' })); await tick(); data.invalidate();
  assert.deepEqual(ids(await data.load('netflix', row('collection', { collectionId: 'chosen' }))), ['new']);
  late.resolve([item('stale')]); await assert.rejects(loading, stale);
  assert.deepEqual(ids(await data.load('netflix', row('collection', { collectionId: 'chosen' }))), ['new']); assert.equal(reads, 2);
});

test('disposal and account changes reject late catalogue replies and prevent further requests or cached data exposure', async () => {
  for (const change of ['destroy', 'user', 'server', 'session'] as const) {
    const late = deferred<ProviderItemsPage>(); let requests = 0, current = true;
    const source = api({ getProviderItems: async () => { requests++; return late.promise; },
      providerHomes: { isCurrent: () => current, load: async () => ({ Revision: null, Settings: null }), save: async () => ({ Revision: null, Settings: null }) } });
    const data = new ProviderData(source), loading = data.load('netflix', row('movies'));
    await tick();
    if (change === 'destroy') data.destroy(); else if (change === 'user') source.userId = 'bob'; else if (change === 'server') source.serverId = 'other'; else current = false;
    late.resolve(page([item('private')])); await assert.rejects(loading, stale);
    await assert.rejects(data.load('netflix', row('movies')), stale); assert.equal(requests, 1);
  }
});

test('page bounds are finite integers and a cancelled queued request never reaches the API', async () => {
  const calls: unknown[] = [];
  const data = new ProviderData(api({ getProviderItems: async (_provider, query) => { calls.push(query); return page([]); } }));
  await data.load('apple', row('movies'), -4, Infinity);
  await data.load('apple', row('shows', { itemSort: 'title-desc' }), 2.8, 10_000);
  assert.deepEqual(calls, [{ type: 'Movie', startIndex: 0, limit: 60, sort: 'title' }, { type: 'Series', startIndex: 2, limit: 100, sort: 'title-desc' }]);
  const loading = data.load('apple', row('movies')); data.destroy(); await assert.rejects(loading, stale); assert.equal(calls.length, 2);
});


test('renaming a built-in service preserves its original chart source and rank order', async () => {
  const config = { ...defaultProviderConfig('netflix'), name: 'Family cinema' };
  const data = new ProviderData(api({ getCollectionList: async () => [collection('chart', 'Netflix — Filmes em Alta (Brasil) [Smart]')],
    getCollectionItems: async () => [item('zulu'), item('alpha')] }));
  assert.deepEqual(ids(await data.load(config, row('trending-movies', { collectionId: 'chart' }))), ['zulu', 'alpha']);
});

test('custom services use selected collections and do not invent automatic chart feeds', async () => {
  const config = defaultCustomProvider('custom-family');
  let reads = 0;
  const data = new ProviderData(api({ getCollectionItems: async () => { reads++; return [item('two'), item('one')]; } }));
  assert.deepEqual(ids(await data.load(config, row('collection', { collectionId: 'family' }))), ['two', 'one']);
  const missing = await data.load(config, row('trending-movies'));
  assert.equal(missing.missingSource, true); assert.equal(missing.sourceUrl, undefined); assert.equal(reads, 1);
});

test('unsaved catalogue previews use their exact draft and isolate source edits from pending requests', async () => {
  const first = deferred<ProviderItemsPage>(), second = deferred<ProviderItemsPage>();
  const calls: number[][] = [];
  const data = new ProviderData(api({ getProviderItems: async () => { throw new Error('Must not read the saved configuration'); },
    previewProviderItems: async config => { calls.push(config.movieProviderIds); return calls.length === 1 ? first.promise : second.promise; } }));
  const draft = { ...defaultCustomProvider('custom-free'), movieProviderIds: [38], offerTypes: ['free' as const] };
  const a = data.load(draft, row('movies'), 0, 8, true);
  const b = data.load({ ...draft, movieProviderIds: [103] }, row('movies'), 0, 8, true);
  await tick(); assert.deepEqual(calls, [[38], [103]]);
  second.resolve(page([item('channel4')])); first.resolve(page([item('bbc')]));
  assert.deepEqual(ids(await a), ['bbc']); assert.deepEqual(ids(await b), ['channel4']);
});

test('Watchlist rows request the mixed account Watchlist filtered by service and ignore collection overrides', async () => {
  const calls: unknown[] = [];
  const data = new ProviderData(api({
    getProviderItems: async (provider, query) => {
      calls.push({ provider, query });
      return page([item('film'), item('show', 'Series'), item('show', 'Series'), item('episode', 'Episode'), { ...item('blocked'), PlayAccess: 'None' }]);
    },
    getCollectionItems: async () => { throw new Error('A Watchlist cannot read a collection override'); }
  }));
  const result = await data.load('netflix', row('watchlist', { collectionId: 'stale-collection', itemSort: 'title-desc' }), 20, 15);
  assert.deepEqual(calls, [{ provider: 'netflix', query: { type: 'Mixed', watchlist: true, sort: 'title-desc', startIndex: 20, limit: 15 } }]);
  assert.deepEqual(ids(result), ['film', 'show']); assert.equal(result.status, 'ready');
});

test('Watchlist previews use the draft movie and show service choices and the server-side mixed sort', async () => {
  const config = { ...defaultCustomProvider('custom-family'), movieProviderIds: [591], showProviderIds: [39] };
  const calls: unknown[] = [];
  const data = new ProviderData(api({
    getProviderItems: async () => { throw new Error('Preview must use the unsaved service configuration'); },
    previewProviderItems: async (provider, query) => { calls.push({ provider, query }); return page([item('show', 'Series', 'Alpha'), item('movie', 'Movie', 'Bravo')]); }
  }));
  assert.deepEqual(ids(await data.load(config, row('watchlist'), 0, 8, true)), ['show', 'movie']);
  assert.deepEqual(calls, [{ provider: config, query: { type: 'Mixed', watchlist: true, sort: 'title', startIndex: 0, limit: 8 } }]);
});

test('Watchlist requests cannot reuse regular catalogue reads or an old account response', async () => {
  const response = deferred<ProviderItemsPage>(), calls: unknown[] = [];
  const source = api({ getProviderItems: async (_provider, query) => { calls.push(query); return response.promise; } });
  const data = new ProviderData(source);
  const loading = [data.load('netflix', row('movies')), data.load('netflix', row('watchlist')), data.load('netflix', row('watchlist'))];
  await tick(); assert.equal(calls.length, 2);
  source.userId = 'another-user'; response.resolve(page([item('private')]));
  for (const request of loading) await assert.rejects(request, stale);
});

test('trending rows automatically query TMDB popular items without collection when unconfigured', async () => {
  const calls: unknown[] = [];
  const data = new ProviderData(api({
    getProviderTrending: async (provider, type, limit) => {
      calls.push({ provider, type, limit });
      return page([item('tmdb-1', type, 'Rank 1'), item('tmdb-2', type, 'Rank 2')], { TotalRecordCount: 2 });
    }
  }));
  const movieResult = await data.load('netflix', row('trending-movies'), 0, 20);
  assert.deepEqual(ids(movieResult), ['tmdb-1', 'tmdb-2']);
  assert.equal(movieResult.sourceUrl, 'https://www.themoviedb.org');
  assert.equal(movieResult.sourceLabel, 'Em Alta · Popularidade TMDB (Brasil)');
  assert.equal(movieResult.status, 'ready');

  const showResult = await data.load('netflix', row('trending-shows'), 0, 15);
  assert.deepEqual(ids(showResult), ['tmdb-1', 'tmdb-2']);
  assert.deepEqual(calls, [
    { provider: 'netflix', type: 'Movie', limit: 20 },
    { provider: 'netflix', type: 'Series', limit: 15 }
  ]);
});

test('trending rows with manual collectionId override TMDB trending and read the collection', async () => {
  let trendingCalled = false;
  const data = new ProviderData(api({
    getProviderTrending: async () => { trendingCalled = true; return page([]); },
    getCollectionItems: async id => [item(`${id}-override-1`), item(`${id}-override-2`)]
  }));
  const result = await data.load('netflix', row('trending-movies', { collectionId: 'my-custom-chart' }));
  assert.deepEqual(ids(result), ['my-custom-chart-override-1', 'my-custom-chart-override-2']);
  assert.equal(trendingCalled, false);
  assert.equal(result.sourceLabel, 'Selected Jellyfin collection');
});

test('trending previews use previewProviderTrending with the draft provider configuration', async () => {
  const config = { ...defaultCustomProvider('custom-family'), movieProviderIds: [8] };
  const calls: unknown[] = [];
  const data = new ProviderData(api({
    previewProviderTrending: async (provider, type, limit) => {
      calls.push({ provider, type, limit });
      return page([item('preview-hit', type)]);
    }
  }));
  const result = await data.load(config, row('trending-movies'), 0, 8, true);
  assert.deepEqual(ids(result), ['preview-hit']);
  assert.deepEqual(calls, [{ provider: config, type: 'Movie', limit: 8 }]);
});
