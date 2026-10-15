import { expect, test, type Locator, type Page } from '@playwright/test';
import { defaultProviderHomes } from '../../src/provider-settings';

type Input = 'keyboard' | 'command';
type Direction = 'up' | 'down' | 'left' | 'right';
const rowIds = ['trending-movies', 'trending-shows', 'movies', 'shows'];
const counts: Record<string, number> = { 'trending-movies': 12, 'trending-shows': 2, movies: 16, shows: 3 };
const home = (page: Page) => page.getByRole('dialog', { name: 'Netflix home', exact: true });
const row = (page: Page, id: string) => home(page).locator(`[data-provider-row="${id}"]`);
const cards = (page: Page, id: string) => row(page, id).locator('.tvl-home-row-card');
const activeId = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.focusId || '');
const stop = (id: string) => id.startsWith('provider-item:') ? id.split(':').slice(0, 2).join(':') : id;

async function input(page: Page, kind: Input, command: Direction | 'select'): Promise<void> {
  if (kind === 'keyboard') {
    await page.keyboard.press(command === 'select' ? 'Enter' : `Arrow${command[0].toUpperCase()}${command.slice(1)}`);
  } else {
    await page.evaluate(command => document.activeElement!.dispatchEvent(new CustomEvent('command', {
      bubbles: true, cancelable: true, detail: { command }
    })), command);
  }
}

async function fixture(page: Page, grid = false): Promise<void> {
  const settings = defaultProviderHomes();
  settings.providers = [settings.providers[0]];
  for (const config of settings.providers[0].rows) config.collectionId = `directional-${config.id}`;
  if (grid) settings.providers[0].rows.find(config => config.id === 'movies')!.collectionId = '';
  await page.addInitScript(settings => {
    localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`, JSON.stringify(settings));
  }, settings);
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const api=window.TvItemLayoutDemo.api, collection=api.getCollectionItems.bind(api), provider=api.getProviderItems.bind(api);
      const counts=${JSON.stringify(counts)};
      const item=(row,index)=>({Id:'directional-'+row+'-'+index,Type:row.includes('shows')?'Series':'Movie',
        Name:index%3===1?'A remarkably long title about a journey through distant lands and the people who found their way home, chapter '+index:'Title '+index,
        ProductionYear:2025,RunTimeTicks:60000000000});
      api.getCollectionItems=async id=>id.startsWith('directional-')
        ?Array.from({length:counts[id.slice(12)]||0},(_,i)=>item(id.slice(12),i+1)):collection(id);
      api.getProviderItems=async(id,query)=>{
        if(id!=='netflix'||query.type!=='Movie')return provider(id,query);
        const items=Array.from({length:125},(_,i)=>item('movies',i+1));
        return {Items:items.slice(query.startIndex||0,(query.startIndex||0)+(query.limit||60)),TotalRecordCount:125,
          Pending:0,Total:125,UpdatedAt:null,Status:'ready',Region:'BR'};
      };
    })();` });
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/?featured=0&providers=1&layout=tv#/home?cinemaProvider=netflix${grid ? '&cinemaRow=movies' : ''}`);
  if (grid) await expect(cards(page, 'movies')).toHaveCount(60);
  else for (const id of rowIds) await expect(cards(page, id)).toHaveCount(counts[id]);
}

async function focusAndReveal(target: Locator): Promise<void> {
  await target.evaluate(node => {
    (node as HTMLElement).focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

for (const kind of ['keyboard', 'command'] as const) {
  test(`TV provider ${kind}: Down and Up visit every row before returning to the header`, async ({ page }) => {
    await fixture(page);
    const feature = home(page).locator('[data-focus-id="provider-feature"]');
    await focusAndReveal(feature);
    const expected = ['provider-feature', ...rowIds.flatMap(id => [`provider-all:${id}`, `provider-item:${id}`])];
    const visited = [await activeId(page)];
    for (const next of expected.slice(1)) {
      await input(page, kind, 'down');
      await expect.poll(async () => stop(await activeId(page))).toBe(next);
      visited.push(await activeId(page));
    }
    expect(await home(page).locator('.tvl-provider-content').evaluate(node => node.scrollTop)).toBeGreaterThan(500);
    await input(page, kind, 'down');
    expect(await activeId(page)).toBe(visited[visited.length - 1]);
    for (const previous of visited.slice(0, -1).reverse()) {
      await input(page, kind, 'up');
      await expect.poll(() => activeId(page)).toBe(previous);
    }
    await input(page, kind, 'up');
    await expect(home(page).locator('.tvl-provider-nav :focus')).toHaveCount(1);
  });
}

test('TV provider rails retain their selected card across short rows and keep View all reachable', async ({ page }) => {
  await fixture(page);
  for (const [longId, shortId] of [['trending-movies', 'trending-shows'], ['movies', 'shows']]) {
    const longCards = cards(page, longId);
    await focusAndReveal(longCards.first());
    for (let index = 1; index < counts[longId]; index++) await input(page, 'keyboard', 'right');
    await expect(longCards.last()).toBeFocused();
    expect(await row(page, longId).locator('.tvl-home-row-cards').evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    await input(page, 'keyboard', 'right'); await expect(longCards.last()).toBeFocused();
    const lastId = await activeId(page);
    const all = home(page).locator(`[data-focus-id="provider-all:${shortId}"]`);
    await input(page, 'keyboard', 'down'); await expect(all).toBeFocused();
    await input(page, 'keyboard', 'down');
    await expect.poll(async () => stop(await activeId(page))).toBe(`provider-item:${shortId}`);
    await input(page, 'command', 'up'); await expect(all).toBeFocused();
    await input(page, 'command', 'up'); await expect.poll(() => activeId(page)).toBe(lastId);
    expect(await longCards.last().evaluate(node => {
      const artwork = node.querySelector('.tvl-home-row-art')!.getBoundingClientRect();
      const rail = node.closest('.tvl-home-row-cards')!.getBoundingClientRect();
      return artwork.left >= rail.left && artwork.right <= rail.right;
    })).toBe(true);
  }
});

async function visualRows(page: Page): Promise<string[][]> {
  return cards(page, 'movies').evaluateAll(nodes => {
    const bands: { top: number; ids: string[] }[] = [];
    for (const node of nodes) {
      const top = node.closest('.tvl-home-row-entry')!.getBoundingClientRect().top;
      let band = bands.find(candidate => Math.abs(candidate.top - top) < 3);
      if (!band) { band = { top, ids: [] }; bands.push(band); }
      band.ids.push((node as HTMLElement).dataset.focusId!);
    }
    return bands.map(band => band.ids);
  });
}

test('TV provider paginated grids move one visual row at a time with uneven captions', async ({ page }) => {
  await fixture(page, true);
  const grid = cards(page, 'movies');
  expect(await grid.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().height))).size)).toBeGreaterThan(1);
  const bands = await visualRows(page);
  expect(bands.length).toBeGreaterThan(5);
  const target = (id: string) => home(page).locator(`[data-focus-id="${id}"]`);
  const middle = Math.floor(bands.length / 2);
  // Different caption heights within one grid row must not turn Up into Left.
  for (const id of bands[middle].slice(0, 3)) {
    await focusAndReveal(target(id)); await input(page, 'keyboard', 'up');
    expect(bands[middle - 1]).toContain(await activeId(page));
    await input(page, 'keyboard', 'down'); await expect(target(id)).toBeFocused();
  }
  await focusAndReveal(target(bands[bands.length - 1][0]));
  for (let index = bands.length - 2; index >= 0; index--) {
    await input(page, 'keyboard', 'up'); expect(bands[index]).toContain(await activeId(page));
  }
  for (let index = 1; index < bands.length; index++) {
    await input(page, 'command', 'down'); expect(bands[index]).toContain(await activeId(page));
  }
  const more = home(page).getByRole('button', { name: 'Load more', exact: true });
  await input(page, 'command', 'down'); await expect(more).toBeFocused();
  await input(page, 'command', 'select'); await expect(grid).toHaveCount(120);
  await expect(more).toBeFocused();
  const expanded = await visualRows(page);
  await input(page, 'keyboard', 'up'); expect(expanded[expanded.length - 1]).toContain(await activeId(page));
  await input(page, 'keyboard', 'up'); expect(expanded[expanded.length - 2]).toContain(await activeId(page));
  await input(page, 'keyboard', 'down'); expect(expanded[expanded.length - 1]).toContain(await activeId(page));
  await input(page, 'keyboard', 'down'); await expect(more).toBeFocused();
  await input(page, 'keyboard', 'select'); await expect(grid).toHaveCount(125);
  await expect(more).toBeHidden(); await expect(grid.nth(120)).toBeFocused();
});

test('TV movie library arrows stay in their visual row and column despite unequal metadata captions', async ({ page }) => {
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      window.TvItemLayoutDemo.api.getMovies=async()=>({
        items:Array.from({length:24},(_,index)=>({Id:'directional-library-'+index,Name:'Library title '+index,Type:'Movie',
          ...(index%2?{ProductionYear:2025,OfficialRating:'PG'}:{})})),total:24,nextStartIndex:24
      });
    })();` });
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/?featured=0&layout=tv#/movies?topParentId=library-movies&tab=0');
  const library = page.getByRole('dialog', { name: 'Movies', exact: true });
  const items = library.locator('[data-movie-item]');
  await expect(items).toHaveCount(24);
  expect(await items.evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().height))).size)).toBeGreaterThan(1);
  const bands = await items.evaluateAll(nodes => {
    const rows: { top: number; ids: string[] }[] = [];
    for (const node of nodes) {
      const top = node.closest('.tvl-library-entry')!.getBoundingClientRect().top;
      let band = rows.find(row => Math.abs(row.top - top) < 3);
      if (!band) { band = { top, ids: [] }; rows.push(band); }
      band.ids.push((node as HTMLElement).dataset.focusId!);
    }
    return rows.map(row => row.ids);
  });
  expect(bands.length).toBeGreaterThan(3);
  const target = (id: string) => library.locator(`[data-focus-id="${id}"]`);
  await focusAndReveal(target(bands[2][1]));
  await input(page, 'keyboard', 'up'); await expect(target(bands[1][1])).toBeFocused();
  await input(page, 'command', 'down'); await expect(target(bands[2][1])).toBeFocused();
  await input(page, 'keyboard', 'left'); await expect(target(bands[2][0])).toBeFocused();
  await input(page, 'keyboard', 'left'); await expect(target(bands[2][0])).toBeFocused();
  await input(page, 'command', 'right'); await expect(target(bands[2][1])).toBeFocused();
  await input(page, 'command', 'down'); await expect(target(bands[3][1])).toBeFocused();
});
