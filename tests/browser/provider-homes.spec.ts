import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { defaultProviderHomes, providerHomesKey, type ProviderHomesSettings } from '../../src/provider-settings';
import { providerBrands } from '../../src/provider-brands';

const home = (page: Page) => page.locator('#indexPage #homeTab');
const services = (page: Page) => home(page).locator('.tvl-home-provider-row');
const providerHome = (page: Page) => page.locator('.tvl-provider-home');
const editor = (page: Page) => page.locator('.tvl-provider-settings');
const providerRow = (page: Page, id: string) => providerHome(page).locator(`[data-provider-row="${id}"]`);
const cards = (page: Page, id: string) => providerRow(page, id).locator('.tvl-home-row-card');
const names = (locator: Locator) => locator.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
const previewUrl = (layout = 'tv', hash = '/home') => `/?featured=0&providers=1&layout=${layout}#${hash}`;
async function remote(page: Page, command: string) {
  await page.evaluate(command => document.activeElement!.dispatchEvent(new CustomEvent('command', { bubbles: true, cancelable: true, detail: { command } })), command);
}
async function seed(page: Page, settings: ProviderHomesSettings) {
  await page.addInitScript(settings => {
    const key = `jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(settings));
  }, settings);
}
async function saved(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`) || 'null')) as Promise<ProviderHomesSettings>;
}
function boundProviderHomes(): ProviderHomesSettings {
  const settings = defaultProviderHomes();
  for (const provider of settings.providers) for (const row of provider.rows) {
    if (row.source === 'trending-movies' || row.source === 'trending-shows') row.collectionId = `provider-chart-${provider.id}-${row.source === 'trending-movies' ? 'movies' : 'shows'}`;
  }
  return settings;
}
async function openEditor(page: Page) {
  await page.evaluate(() => { location.hash = '/mypreferencesmenu?cinemaProviders=1'; });
  await expect(editor(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  return editor(page);
}
async function nativeSettings(page: Page) {
  await page.locator('.skinHeader').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#myPreferencesMenuPage .tvl-settings-provider-link')).toBeVisible();
}
async function noEditingButtons(locator: Locator, allowServiceEdit = false) {
  const editing = locator.getByRole('button', { name: /customi[sz]e|edit|save changes|add row|settings/i });
  if (allowServiceEdit) {
    await expect(locator.getByRole('button', { name: 'Edit service', exact: true })).toBeVisible();
    await expect(editing).toHaveCount(1);
  } else await expect(editing).toHaveCount(0);
}
async function noDataSourceReferences(locator: Locator) {
  await expect(locator).not.toContainText(/JustWatch|MDBList|TMDB|The Movie Database/i);
  await expect(locator.locator('a[href*="justwatch.com"],a[href*="mdblist.com"],a[href*="themoviedb.org"]')).toHaveCount(0);
  await expect(locator.locator('.tvl-provider-row-source,.tvl-provider-credit')).toHaveCount(0);
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const layout of ['desktop', 'tv']) {
  test(`${layout}: all nine branded Home tiles open distinct homes with catalogue rows and configured charts`, async ({ page }, info) => {
    await page.goto(previewUrl(layout));
    await expect(services(page).locator('.tvl-provider-tile')).toHaveCount(9);
    expect(await names(services(page).locator('.tvl-provider-tile'))).toEqual(providerBrands.map(brand => brand.name));
    await expect.poll(() => services(page).locator('img').evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
    await noEditingButtons(home(page));
    await page.screenshot({ path: info.outputPath(`provider-tiles-${layout}.png`) });
    for (const brand of providerBrands) {
      const selected = services(page).getByRole('button', { name: brand.name, exact: true });
      await selected.click();
      await expect(providerHome(page)).toHaveAttribute('aria-label', `${brand.name} home`);
      await expect(providerHome(page).getByRole('heading', { name: brand.name, exact: true })).toBeVisible();
      await expect(providerHome(page).locator('.tvl-provider-header-logo')).toBeVisible();
      await expect(providerHome(page).locator('.tvl-provider-identity')).toContainText('United Kingdom');
      await expect(cards(page, 'movies').first()).toBeVisible(); await expect(cards(page, 'shows').first()).toBeAttached();
      const charts = !['bbc', 'itvx', 'channel4'].includes(brand.id);
      if (charts) { await expect(cards(page, 'trending-movies').first()).toBeAttached(); await expect(cards(page, 'trending-shows').first()).toBeAttached(); }
      else { await expect(providerRow(page, 'trending-movies')).toHaveCount(0); await expect(providerRow(page, 'trending-shows')).toHaveCount(0); }
      const allFilms = await cards(page, 'movies').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')));
      const trending = await cards(page, 'trending-movies').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')));
      expect(allFilms.length).toBeGreaterThanOrEqual(trending.length); expect(trending.every(id => allFilms.includes(id))).toBe(true);
      if (brand.id === 'netflix') { expect(allFilms.length).toBe(4); expect(trending).toEqual(['movie-blue', 'movie-tide']); }
      await expect(providerRow(page, 'trending-movies').locator('.tvl-home-rank')).toHaveCount(trending.length);
      await expect(providerRow(page, 'movies').locator('.tvl-home-rank')).toHaveCount(0);
      await expect(providerHome(page).locator('.tvl-provider-feature-title')).toBeVisible();
      await noEditingButtons(providerHome(page), layout === 'desktop'); await noDataSourceReferences(providerHome(page)); await noPageOverflow(page);
      if (brand.id === 'netflix') await page.screenshot({ path: info.outputPath(`provider-home-${layout}.png`) });
      await page.keyboard.press('Escape'); await expect(selected).toBeFocused();
    }
  });
}

test('provider row waits for native Home readiness and remote arrows cross native, provider and collection row boundaries', async ({ page }) => {
  const settings = defaultProviderHomes(); settings.placement = 'native:next up:1'; await seed(page, settings);
  await page.addInitScript(() => localStorage.setItem(`jellyfin-cinema.home-collections.v1:${encodeURIComponent(location.origin)}:demo`, JSON.stringify({ version: 1, rows: [
    { id: 'weekend', kind: 'items', title: 'Weekend picks', collectionIds: ['collection-coast'], ranked: false, placement: 'native:next up:1' }
  ] })));
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: `${await response.text()}\n(() => {
      document.querySelector('#homeTab .sections .verticalSection').setAttribute('aria-busy','true');
      const read=window.TvItemLayoutDemo.api.getCollectionItems;window.__providerMembersLoaded=false;
      window.TvItemLayoutDemo.api.getCollectionItems=async id=>{const items=await read(id);window.__providerMembersLoaded=true;return items;};
    })();` });
  });
  await page.goto('/?featured=0&providers=1&homeSections=resume,nextup#/home');
  await expect.poll(() => page.evaluate(() => (window as any).__providerMembersLoaded)).toBe(true);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await expect(page.locator('body')).toHaveClass(/tvl-home/); await expect(services(page)).toHaveCount(0);
  await expect(home(page).locator('[data-home-row="weekend"]')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('#homeTab .sections .verticalSection')!.removeAttribute('aria-busy'));
  await expect(services(page)).toBeVisible();
  const previous = home(page).getByRole('region', { name: 'Continue watching', exact: true }).locator('.card').first();
  const netflix = services(page).getByRole('button', { name: 'Netflix', exact: true });
  const custom = home(page).locator('[data-home-row="weekend"] .tvl-home-row-card').first();
  const next = home(page).getByRole('region', { name: 'Next up', exact: true }).locator('.card').first();
  await previous.focus(); await remote(page, 'down'); await expect(netflix).toBeFocused();
  await remote(page, 'down'); await expect(custom).toBeFocused(); await remote(page, 'down'); await expect(next).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(custom).toBeFocused(); await page.keyboard.press('ArrowUp'); await expect(netflix).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(previous).toBeFocused();
});

test('last provider tile keeps its focus border inside the row with no visible horizontal scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await page.goto(previewUrl());
  const tiles = services(page).locator('.tvl-provider-tile'); await expect(tiles).toHaveCount(9); await tiles.first().focus();
  for (let step = 0; step < providerBrands.length - 1; step++) await remote(page, 'right');
  await expect(tiles.last()).toBeFocused();
  expect(await tiles.last().evaluate(node => {
    const row = node.closest('.tvl-home-row-cards')!, art = node.querySelector('.tvl-provider-tile-mark')!;
    const bounds = row.getBoundingClientRect(), box = art.getBoundingClientRect(), css = getComputedStyle(art), inset = parseFloat(css.outlineWidth) + parseFloat(css.outlineOffset);
    return box.right + inset <= bounds.right + 1 && box.left - inset >= bounds.left - 1;
  })).toBe(true);
  expect(await services(page).locator('.tvl-home-row-cards').evaluate(node => getComputedStyle(node, '::-webkit-scrollbar').display)).toBe('none');
  await noPageOverflow(page);
});

test('unconfigured trending rows do not discover a collection from its name', async ({ page }) => {
  await seed(page, defaultProviderHomes());
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const api=window.TvItemLayoutDemo.api; window.__providerChartReads={lists:0,members:0};
      api.getCollectionList=async()=>{window.__providerChartReads.lists++;return [{Id:'plausible',Name:'Netflix — Trending Movies (UK) (Daily) [Smart]',Type:'BoxSet'}];};
      api.getCollectionItems=async()=>{window.__providerChartReads.members++;return [await api.getItem('movie-tide')];};
    })();` });
  });
  await page.goto(previewUrl('tv', '/home?cinemaProvider=netflix'));
  await expect(cards(page, 'movies')).toHaveCount(4);
  for (const id of ['trending-movies', 'trending-shows']) {
    await expect(providerRow(page, id)).toContainText('Choose a collection for this row in Streaming services settings.');
    await expect(cards(page, id)).toHaveCount(0);
  }
  expect(await page.evaluate(() => (window as any).__providerChartReads)).toEqual({ lists: 0, members: 0 });
  await noEditingButtons(providerHome(page));
});

test('desktop service editing binds a chosen collection ID that survives collection renames and unavailable names', async ({ page }) => {
  await seed(page, defaultProviderHomes());
  await page.goto(previewUrl('desktop', '/home?cinemaProvider=paramount'));
  await expect(providerRow(page, 'trending-movies')).toContainText('Choose a collection');
  await providerHome(page).getByRole('button', { name: 'Edit service', exact: true }).click();
  await expect(page).toHaveURL(/cinemaProviders=1&cinemaService=paramount/);
  await expect(editor(page).getByLabel('Service name', { exact: true })).toHaveValue('Paramount+');
  await editor(page).getByRole('button', { name: 'Trending films', exact: true }).click();
  const selectedId = 'provider-chart-paramount-movies';
  await editor(page).getByRole('combobox', { name: 'Collection', exact: true }).selectOption({ label: 'Paramount+ — Trending Movies (UK)' });
  await editor(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('Saved');
  expect((await saved(page)).providers.find(provider => provider.id === 'paramount')!.rows.find(row => row.id === 'trending-movies')!.collectionId).toBe(selectedId);
  await editor(page).getByRole('button', { name: 'Back to service', exact: true }).click();
  await expect(providerHome(page)).toHaveAttribute('aria-label', 'Paramount+ home');
  const expected = ['movie-tide', 'movie-higher'];
  await expect(cards(page, 'trending-movies')).toHaveCount(2);
  expect(await cards(page, 'trending-movies').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.itemId))).toEqual(expected);

  await page.evaluate(() => {
    const api = window.TvItemLayoutDemo!.api, list = api.getCollectionList;
    api.getCollectionList = async (...args) => (await list(...args)).map(collection => ({ ...collection, Name: 'Renamed collection' }));
  });
  for (const namesUnavailable of [false, true]) {
    if (namesUnavailable) await page.evaluate(() => { window.TvItemLayoutDemo!.api.getCollectionList = async () => { throw new Error('Collection names unavailable'); }; });
    await providerHome(page).getByRole('button', { name: 'Back', exact: true }).click();
    await services(page).getByRole('button', { name: 'Paramount+', exact: true }).click();
    await expect(cards(page, 'trending-movies')).toHaveCount(2);
    expect(await cards(page, 'trending-movies').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.itemId))).toEqual(expected);
    expect((await saved(page)).providers.find(provider => provider.id === 'paramount')!.rows.find(row => row.id === 'trending-movies')!.collectionId).toBe(selectedId);
  }
});

async function largeCatalogue(page: Page) {
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const api=window.TvItemLayoutDemo.api, provider=api.getProviderItems.bind(api), getItem=api.getItem.bind(api);
      const item=index=>({Id:'provider-film-'+index,Name:'Provider film '+String(index).padStart(3,'0'),Type:'Movie',ProductionYear:2025,RunTimeTicks:60000000000});
      api.getProviderItems=async(id,query)=>{if(id!=='netflix'||query.type!=='Movie')return provider(id,query);const items=Array.from({length:125},(_,i)=>item(i+1));if(query.sort==='title-desc')items.reverse();return {Items:items.slice(query.startIndex||0,(query.startIndex||0)+(query.limit||60)),TotalRecordCount:125,Pending:0,Total:125,UpdatedAt:null,Status:'ready',Region:'GB'};};
      api.previewProviderItems=(config,query)=>api.getProviderItems(config.id,query);
      api.getItem=async id=>id.startsWith('provider-film-')?{...await getItem('movie-tide'),...item(Number(id.split('-').pop()))}:getItem(id);
    })();` });
  });
}
test('View all paginates a full catalogue and returns from native details to the selected item on a later page', async ({ page }) => {
  await largeCatalogue(page); await page.goto(previewUrl('tv', '/home?cinemaProvider=netflix'));
  await expect(cards(page, 'movies')).toHaveCount(40);
  await providerHome(page).getByRole('button', { name: 'View all Films', exact: true }).click();
  await expect(page).toHaveURL(/cinemaRow=movies/); await expect(providerHome(page).locator('.tvl-provider-hero')).toBeHidden();
  await expect(cards(page, 'movies')).toHaveCount(60); await providerHome(page).getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(cards(page, 'movies')).toHaveCount(120); await providerHome(page).getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(cards(page, 'movies')).toHaveCount(125); await expect(providerHome(page).getByRole('button', { name: 'Load more', exact: true })).toBeHidden();
  await noDataSourceReferences(providerHome(page));
  const selected = cards(page, 'movies').last(); await selected.click();
  await expect(page.getByRole('dialog', { name: 'Provider film 125 details', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(cards(page, 'movies')).toHaveCount(125); await expect(selected).toBeFocused();
  await noPageOverflow(page);
});

test('provider grids use geometric remote navigation and poster-only focus without crossing the page edge', async ({ page }) => {
  await largeCatalogue(page); await page.goto(previewUrl('tv', '/home?cinemaProvider=netflix&cinemaRow=movies'));
  await expect(cards(page, 'movies')).toHaveCount(60); const first = cards(page, 'movies').first(); await first.focus();
  await page.keyboard.press('ArrowRight'); await expect(cards(page, 'movies').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const location = await page.evaluate(() => {
    const active = document.activeElement!, all = Array.from(document.querySelectorAll('[data-provider-row="movies"] .tvl-home-row-card'));
    return { index: all.indexOf(active), box: active.getBoundingClientRect().toJSON(), first: all[1].getBoundingClientRect().toJSON() };
  });
  expect(location.index).toBeGreaterThan(1); expect(location.box.top).toBeGreaterThan(location.first.top);
  await page.keyboard.press('ArrowUp'); await expect(cards(page, 'movies').nth(1)).toBeFocused();
  await expect(cards(page, 'movies').nth(1).locator('.tvl-home-row-art')).toHaveCSS('outline-style', 'solid');
  await expect(cards(page, 'movies').nth(1)).toHaveCSS('outline-style', 'none');
  await noPageOverflow(page);
});

test('Settings owns provider editing; changes to service order, Home position, hero and ranked collection content survive reload', async ({ page }, info) => {
  await page.goto(previewUrl('desktop')); await expect(services(page)).toBeVisible(); await nativeSettings(page);
  await page.locator('#myPreferencesMenuPage .tvl-settings-provider-link').click();
  const settings = editor(page); await expect(settings.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await settings.getByLabel('Row title', { exact: true }).fill('My streaming services');
  await settings.getByRole('combobox', { name: 'Home position', exact: true }).selectOption('native:next up:1');
  await settings.getByLabel('Show Disney+', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Move Prime Video earlier', exact: true }).click();
  await settings.locator('.tvl-provider-settings-sidebar').getByRole('button', { name: 'Netflix', exact: true }).click();
  await settings.getByLabel('Show featured artwork', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Films', exact: true }).click();
  await settings.getByLabel('Row title', { exact: true }).fill('Family favourites');
  await settings.getByRole('combobox', { name: 'Collection override', exact: true }).selectOption('collection-coast');
  await settings.getByRole('combobox', { name: 'Item order', exact: true }).selectOption('title');
  await settings.getByLabel('Show rank artwork', { exact: true }).check();
  const preview = settings.getByRole('complementary', { name: 'Provider Home row preview', exact: true });
  await expect(preview.locator('.tvl-home-row-card').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
  await settings.locator('[data-provider-settings-focus="up:movies"]').click();
  await settings.locator('[data-provider-settings-focus="up:movies"]').click();
  await settings.getByRole('button', { name: 'Trending TV shows', exact: true }).click(); await settings.getByLabel('Show this row', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('Saved');
  const persisted = await saved(page); expect(persisted.providers.slice(0, 2).map(provider => provider.id)).toEqual(['prime', 'netflix']);
  expect(persisted.providers.find(provider => provider.id === 'disney')!.enabled).toBe(false);
  await settings.getByRole('button', { name: 'Family favourites', exact: true }).click();
  await settings.locator('.tvl-provider-row-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('provider-settings-desktop.png') });
  await page.evaluate(() => { location.hash = '/home'; }); await expect(services(page)).toHaveAttribute('aria-label', 'My streaming services');
  expect(await names(services(page).locator('.tvl-provider-tile'))).toEqual(['Prime Video', 'Netflix', 'Apple TV+', 'NOW', 'Paramount+', 'BBC iPlayer', 'ITVX', 'Channel 4']);
  expect(await services(page).evaluate(node => node.nextElementSibling?.querySelector('h2')?.textContent)).toBe('Next up');
  await services(page).getByRole('button', { name: 'Netflix', exact: true }).click();
  await expect(providerHome(page).locator('.tvl-provider-hero')).toBeHidden();
  await expect(providerHome(page).locator('.tvl-provider-row').first()).toHaveAttribute('aria-label', 'Family favourites');
  await expect(cards(page, 'movies').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
  await expect(providerRow(page, 'trending-shows')).toHaveCount(0); await noEditingButtons(providerHome(page), true);
  await page.reload(); await expect(cards(page, 'movies').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
  await expect(providerHome(page).locator('.tvl-provider-hero')).toBeHidden();
});

test('changing a large catalogue sort refreshes the preview from that end of the source, matching the saved Home row', async ({ page }) => {
  await largeCatalogue(page); await page.goto(previewUrl('desktop')); const settings = await openEditor(page);
  await settings.locator('.tvl-provider-settings-sidebar').getByRole('button', { name: 'Netflix', exact: true }).click();
  await settings.getByRole('button', { name: 'Films', exact: true }).click();
  const preview = settings.getByRole('complementary', { name: 'Provider Home row preview', exact: true });
  await expect(preview.locator('.tvl-home-row-card')).toHaveCount(8);
  await expect(preview.locator('.tvl-home-row-card').first()).toHaveAttribute('data-item-id', 'provider-film-1');
  await settings.getByRole('combobox', { name: 'Item order', exact: true }).selectOption('title-desc');
  await expect(preview.locator('.tvl-home-row-card').first()).toHaveAttribute('data-item-id', 'provider-film-125');
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('Saved');
  await page.evaluate(() => { location.hash = '/home?cinemaProvider=netflix'; });
  await expect(cards(page, 'movies').first()).toHaveAttribute('data-item-id', 'provider-film-125');
});

test('TV settings accept remote select changes; hiding the main services row persists and Settings remains reachable', async ({ page }) => {
  await seed(page, defaultProviderHomes()); await page.goto(previewUrl()); const settings = await openEditor(page);
  await settings.locator('.tvl-provider-settings-sidebar').getByRole('button', { name: 'Netflix', exact: true }).click();
  await settings.getByRole('button', { name: 'Films', exact: true }).click();
  const source = settings.getByRole('combobox', { name: 'Content', exact: true }); await source.focus(); await remote(page, 'down');
  await expect(source).toHaveValue('shows'); await expect(source).toBeFocused();
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
  expect((await saved(page)).providers[0].rows.find(row => row.id === 'movies')!.source).toBe('movies');
  await openEditor(page); await settings.getByLabel('Show streaming services on Home', { exact: true }).uncheck();
  await settings.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('Saved');
  await page.evaluate(() => { location.hash = '/home'; }); await expect(services(page)).toHaveCount(0);
  await page.reload(); await expect(home(page)).toBeVisible(); await expect(services(page)).toHaveCount(0);
  await nativeSettings(page); await page.locator('#myPreferencesMenuPage .tvl-settings-provider-link').click();
  await expect(settings.getByLabel('Show streaming services on Home', { exact: true })).not.toBeChecked();
});

type Snapshot = { Revision: string | null; Settings: ProviderHomesSettings | null };
class SettingsServer {
  copies = new Map<string, Snapshot>(); serial = 0; failGet = false;
  calls: { method: string; user: string }[] = [];
  snapshot(user: string): Snapshot { return structuredClone(this.copies.get(user) || { Revision: null, Settings: null }); }
}
// Exercise the shipped authenticated API/transport, rather than replacing its
// store with a local implementation. Server fixtures return only permitted media.
async function device(browser: Browser, server: SettingsServer, user: string, layout: 'desktop' | 'tv', renamedCollections = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage();
  await page.route('**/provider-fixture/TvItemLayout/ProviderHomes', async route => {
    const request = route.request(), account = request.headers()['x-fixture-user'], method = request.method(); server.calls.push({ method, user: account });
    if (method === 'GET' && server.failGet) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    const previous = server.snapshot(account);
    if (method === 'PUT') {
      const body = request.postDataJSON();
      if (body.Revision !== previous.Revision) return route.fulfill({ status: 409, json: { error: 'Changed elsewhere' } });
      server.copies.set(account, { Revision: String(++server.serial), Settings: body.Settings });
    }
    await route.fulfill({ status: 200, json: server.snapshot(account) });
  });
  await page.route('**/provider-fixture/TvItemLayout/Providers/*/Items?*', async route => {
    const query = new URL(route.request().url()).searchParams, account = route.request().headers()['x-fixture-user'];
    const isMovie = query.get('type') === 'Movie';
    const items = account === 'kids' ? [] : [{ Id: isMovie ? 'movie-tide' : 'series-north', Type: isMovie ? 'Movie' : 'Series', Name: isMovie ? 'After the Tide' : 'North of Nowhere' }];
    await route.fulfill({ json: { Items: items, TotalRecordCount: items.length, Total: items.length, Pending: 0, UpdatedAt: null, Status: 'ready', Region: 'BR' } });
  });
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const demo=window.TvItemLayoutDemo.api, user=${JSON.stringify(user)}, renamedCollections=${JSON.stringify(renamedCollections)};
      const request=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'content-type':'application/json','x-fixture-user':user}});if(!response.ok)throw {status:response.status};return response.json();};
      window.ApiClient={getCurrentUserId:()=>user,serverId:()=> 'provider-server',getUser:async id=>({Id:id,Policy:{IsAdministrator:false}}),getItem:(_user,id)=>demo.getItem(id),
        getItems:async(_user,query)=>{const items=user==='kids'?[]:query.IncludeItemTypes==='BoxSet'?(await demo.getCollectionList()).map(item=>renamedCollections&&item.Id.startsWith('provider-chart-')?{...item,Name:'A renamed collection'}:item):await demo.getCollectionItems(query.ParentId);return {Items:items.slice(query.StartIndex||0,(query.StartIndex||0)+(query.Limit||200)),TotalRecordCount:items.length};},
        getUrl:(path,query)=>'/provider-fixture/'+path+(query?'?'+new URLSearchParams(query):''),
        getJSON:url=>url.includes('TvItemLayout/HomeCollections')?Promise.resolve({Revision:null,Settings:null}):request(url),ajax:options=>request(options.url,{method:options.type,body:options.data}),
        getImageUrl:()=>'/demo/assets/ocean.jpg'};
      delete window.TvItemLayoutDemo; document.body.classList.replace('layout-tv','layout-${layout}');
    })();` });
  });
  return { page, context };
}

test('saved collection IDs populate movie and show charts across all six native provider homes after collection renames', async ({ browser }) => {
  const server = new SettingsServer(); server.copies.set('parents', { Revision: 'bound-charts', Settings: boundProviderHomes() });
  const client = await device(browser, server, 'parents', 'tv', true), page = client.page;
  try {
    await page.goto(previewUrl()); await expect(services(page).locator('.tvl-provider-tile')).toHaveCount(9);
    for (const brand of providerBrands.filter(brand => !['bbc', 'itvx', 'channel4'].includes(brand.id))) {
      await services(page).getByRole('button', { name: brand.name, exact: true }).click();
      await expect(cards(page, 'trending-movies')).toHaveCount(2); await expect(cards(page, 'trending-shows')).toHaveCount(2);
      await expect(cards(page, 'trending-movies').first()).toHaveAttribute('aria-label', /^Rank 1:/);
      await expect(cards(page, 'trending-shows').first()).toHaveAttribute('aria-label', /^Rank 1:/);
      await expect(cards(page, 'trending-movies').first()).toHaveAttribute('data-item-id', /^movie-/);
      await expect(cards(page, 'trending-shows').first()).toHaveAttribute('data-item-id', /^series-/);
      if (brand.id === 'netflix') {
        expect(await cards(page, 'trending-movies').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')))).toEqual(['movie-blue', 'movie-tide']);
        expect(await cards(page, 'trending-shows').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-item-id')))).toEqual(['series-signal', 'series-north']);
      }
      await expect(providerHome(page).getByText('Choose a collection for this row in Streaming services settings.', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(services(page).getByRole('button', { name: brand.name, exact: true })).toBeFocused();
    }
  } finally { await client.context.close(); }
});

test('saved provider preferences sync from desktop to a fresh TV while another account keeps its defaults and permitted media', async ({ browser }) => {
  const server = new SettingsServer(); const desktop = await device(browser, server, 'parents', 'desktop'), tv = await device(browser, server, 'parents', 'tv'), kids = await device(browser, server, 'kids', 'tv');
  try {
    await desktop.page.goto(previewUrl('desktop')); const settings = await openEditor(desktop.page);
    await settings.getByLabel('Row title', { exact: true }).fill('Family streaming'); await settings.getByLabel('Show Netflix', { exact: true }).uncheck();
    await settings.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(settings.getByRole('status')).toContainText('Saved to your Jellyfin account');
    await tv.page.goto(previewUrl()); await expect(services(tv.page)).toHaveAttribute('aria-label', 'Family streaming');
    await expect(services(tv.page).getByRole('button', { name: 'Netflix', exact: true })).toHaveCount(0);
    expect(server.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    await kids.page.goto(previewUrl()); await expect(services(kids.page)).toHaveAttribute('aria-label', 'Streaming services'); await expect(services(kids.page).locator('.tvl-provider-tile')).toHaveCount(9);
    await services(kids.page).getByRole('button', { name: 'Netflix', exact: true }).click(); await expect(providerRow(kids.page, 'movies')).toContainText('No matching titles');
    await expect(cards(kids.page, 'movies')).toHaveCount(0); await expect(providerRow(kids.page, 'trending-movies')).toContainText('Choose a collection for this row in Streaming services settings.');
    await noDataSourceReferences(providerHome(kids.page));
    expect(server.snapshot('kids').Settings).toBeNull(); expect(server.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    await services(tv.page).getByRole('button', { name: 'Prime Video', exact: true }).click(); await expect(cards(tv.page, 'movies')).toHaveCount(1);
  } finally { await Promise.all([desktop.context.close(), tv.context.close(), kids.context.close()]); }
});

test('503 settings reads retain this account’s cached provider row silently on Home without writing defaults', async ({ browser }) => {
  const server = new SettingsServer(), settings = defaultProviderHomes(); settings.title = 'Saved services'; settings.providers = settings.providers.slice(0, 2);
  server.copies.set('parents', { Revision: 'existing', Settings: settings }); const client = await device(browser, server, 'parents', 'tv');
  try {
    await client.page.goto(previewUrl()); await expect(services(client.page)).toHaveAttribute('aria-label', 'Saved services');
    await expect.poll(() => client.page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), providerHomesKey('provider-server', 'parents'))).toEqual(settings);
    server.failGet = true; const response = client.page.waitForResponse(response => response.url().includes('/TvItemLayout/ProviderHomes') && response.status() === 503);
    await client.page.reload(); await response; await expect(services(client.page)).toHaveAttribute('aria-label', 'Saved services');
    await expect(services(client.page).locator('.tvl-provider-tile')).toHaveCount(2);
    await expect(home(client.page).getByText(/could not sync|retry.*sync|changes have not been saved/i)).toHaveCount(0);
    expect(server.calls.every(call => call.method === 'GET')).toBe(true); await noEditingButtons(home(client.page));
  } finally { await client.context.close(); }
});

test('an already-open TV provider page adopts desktop edits while preserving its selected title', async ({ browser }) => {
  const server = new SettingsServer(); server.copies.set('parents', { Revision: 'bound-charts', Settings: boundProviderHomes() });
  const desktop = await device(browser, server, 'parents', 'desktop'), tv = await device(browser, server, 'parents', 'tv');
  try {
    await desktop.page.goto(previewUrl('desktop')); const settings = await openEditor(desktop.page);
    await tv.page.goto(previewUrl('tv', '/home?cinemaProvider=netflix'));
    await expect(cards(tv.page, 'shows')).toHaveCount(1);
    await expect(providerHome(tv.page).locator('.tvl-provider-feature-title')).toHaveText('A Kind of Blue');
    const selected = cards(tv.page, 'shows').first(); await selected.focus(); await selected.scrollIntoViewIfNeeded();
    await settings.locator('.tvl-provider-settings-sidebar').getByRole('button', { name: 'Netflix', exact: true }).click();
    await settings.getByLabel('Show featured artwork', { exact: true }).uncheck();
    await settings.getByRole('button', { name: 'Films', exact: true }).click();
    await settings.getByLabel('Row title', { exact: true }).fill('Family favourites');
    await settings.getByRole('combobox', { name: 'Collection override', exact: true }).selectOption('collection-coast');
    await settings.getByRole('combobox', { name: 'Item order', exact: true }).selectOption('title');
    await settings.getByLabel('Show rank artwork', { exact: true }).check();
    await settings.locator('[data-provider-settings-focus="up:movies"]').click();
    await settings.locator('[data-provider-settings-focus="up:movies"]').click();
    await settings.getByRole('button', { name: 'Trending TV shows', exact: true }).click();
    await settings.getByLabel('Show this row', { exact: true }).uncheck();
    await settings.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(settings.getByRole('status')).toContainText('Saved to your Jellyfin account');
    await tv.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(providerHome(tv.page).locator('.tvl-provider-row').first()).toHaveAttribute('aria-label', 'Family favourites');
    await expect(cards(tv.page, 'movies').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
    await expect(providerRow(tv.page, 'trending-shows')).toHaveCount(0);
    await expect(providerHome(tv.page).locator('.tvl-provider-hero')).toBeHidden();
    await expect(selected).toBeFocused();
    await expect(providerHome(tv.page).locator('.tvl-provider-nav')).toHaveCount(1);
    await noDataSourceReferences(providerHome(tv.page));
    await expect(providerHome(tv.page).locator('.tvl-provider-row-status').filter({ hasText: 'Loading…' })).toHaveCount(0);

    // A later device edit can turn the current provider off without a route change.
    const updated = server.snapshot('parents').Settings!; updated.providers[0].enabled = false;
    server.copies.set('parents', { Revision: 'disabled', Settings: updated });
    await tv.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(providerHome(tv.page)).toContainText('This provider home is turned off.');
    await expect(providerHome(tv.page).locator('.tvl-provider-row')).toHaveCount(0);
    await expect(providerHome(tv.page).locator('.tvl-provider-hero')).toBeEmpty();
    await expect(providerHome(tv.page).getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    expect(server.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
  } finally { await Promise.all([desktop.context.close(), tv.context.close()]); }
});

test('provider refresh ignores other-service edits and quietly survives settings failures without replacing focused rows', async ({ browser }) => {
  const server = new SettingsServer(), settings = defaultProviderHomes(); server.copies.set('parents', { Revision: 'first', Settings: settings });
  const client = await device(browser, server, 'parents', 'tv'), page = client.page;
  try {
    await page.clock.install(); await page.goto(previewUrl('tv', '/home?cinemaProvider=netflix'));
    await expect(cards(page, 'movies')).toHaveCount(1); await expect(cards(page, 'shows')).toHaveCount(1);
    await expect(providerHome(page).locator('.tvl-provider-feature-title')).toBeVisible();
    await cards(page, 'shows').first().focus(); await cards(page, 'shows').first().scrollIntoViewIfNeeded();
    const before = await providerRow(page, 'shows').evaluate(node => {
      (node as HTMLElement).dataset.sameRow = 'original'; return node.closest('.tvl-provider-content')!.scrollTop;
    });
    settings.providers.find(provider => provider.id === 'prime')!.hero = false;
    server.copies.set('parents', { Revision: 'prime-only', Settings: settings });
    const read = page.waitForResponse(response => response.url().endsWith('/TvItemLayout/ProviderHomes'));
    // The normal minute refresh reads settings even without leaving this page.
    await page.clock.runFor(60_100); await read;
    // Collection reads use the demo's latency timer; let the in-flight refresh
    // finish before simulating a separate return to the app.
    await page.clock.runFor(500);
    await expect(providerHome(page).locator('.tvl-provider-more:disabled')).toHaveCount(0);
    await expect(providerRow(page, 'shows')).toHaveAttribute('data-same-row', 'original');
    await expect(cards(page, 'shows').first()).toBeFocused();
    expect(await providerHome(page).locator('.tvl-provider-content').evaluate(node => node.scrollTop)).toBe(before);

    server.failGet = true;
    const failed = page.waitForResponse(response => response.url().endsWith('/TvItemLayout/ProviderHomes') && response.status() === 503);
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await failed;
    await page.clock.runFor(500);
    await expect(providerHome(page).locator('.tvl-provider-more:disabled')).toHaveCount(0);
    await expect(providerRow(page, 'shows')).toHaveAttribute('data-same-row', 'original');
    await expect(cards(page, 'shows').first()).toBeFocused();
    await expect(providerHome(page).getByText(/could not sync|retry.*sync|changes have not been saved/i)).toHaveCount(0);
    await expect(providerHome(page).locator('.tvl-provider-nav')).toHaveCount(1);
    await noDataSourceReferences(providerHome(page));

    server.failGet = false; settings.providers[0].hero = false;
    server.copies.set('parents', { Revision: 'netflix-update', Settings: settings });
    await page.clock.runFor(60_100);
    await expect(providerHome(page).locator('.tvl-provider-hero')).toBeHidden();
    await expect(cards(page, 'shows').first()).toBeFocused();
    expect(server.calls.every(call => call.method === 'GET')).toBe(true);
  } finally { await client.context.close(); }
});

test('a late catalogue page cannot repopulate a row after another device changes its source', async ({ browser }) => {
  const server = new SettingsServer(), settings = defaultProviderHomes();
  settings.providers[0].rows = settings.providers[0].rows.filter(row => row.id === 'movies');
  server.copies.set('parents', { Revision: 'catalogue', Settings: settings });
  const client = await device(browser, server, 'parents', 'tv'), page = client.page;
  let release!: () => void, requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), loading = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/provider-fixture/TvItemLayout/Providers/netflix/Items?*', async route => {
    const query = new URL(route.request().url()).searchParams, start = Number(query.get('startIndex') || 0), limit = Number(query.get('limit') || 60);
    if (start === 60) { requested(); await held; }
    const items = Array.from({ length: Math.min(limit, 125 - start) }, (_, index) => ({ Id: `catalogue-${start + index}`, Name: `Catalogue ${start + index}`, Type: 'Movie' }));
    await route.fulfill({ json: { Items: items, TotalRecordCount: 125, Total: 125, Pending: 0, UpdatedAt: null, Status: 'ready', Region: 'BR' } });
  });
  try {
    await page.goto(previewUrl('tv', '/home?cinemaProvider=netflix&cinemaRow=movies'));
    await expect(cards(page, 'movies')).toHaveCount(60);
    await providerHome(page).getByRole('button', { name: 'Load more', exact: true }).click(); await loading;
    settings.providers[0].rows[0].collectionId = 'collection-coast'; settings.providers[0].rows[0].ranked = true;
    server.copies.set('parents', { Revision: 'collection', Settings: settings });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(cards(page, 'movies')).toHaveCount(2);
    await expect(cards(page, 'movies').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
    const lateResponse = page.waitForResponse(response => response.url().includes('startIndex=60'));
    release(); await lateResponse;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(cards(page, 'movies')).toHaveCount(2);
    await expect(providerHome(page).getByRole('button', { name: 'Load more', exact: true })).toBeHidden();
    await expect(providerHome(page).getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    await noDataSourceReferences(providerHome(page));
    await expect(providerHome(page).getByText(/could not be loaded|could not refresh/)).toHaveCount(0);
  } finally { release(); await client.context.close(); }
});
