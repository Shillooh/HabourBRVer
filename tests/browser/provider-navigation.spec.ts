import { expect, test, type Page } from '@playwright/test';

const preview = (hash = '/home', layout = 'tv') => `/?featured=0&providers=1&layout=${layout}#${hash}`;
const provider = (page: Page) => page.getByRole('dialog', { name: 'Netflix home', exact: true });
const sections = (page: Page) => provider(page).getByRole('navigation', { name: 'Provider sections', exact: true });
const tile = (page: Page) => page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Netflix', exact: true });
const films = (page: Page) => provider(page).locator('[data-provider-row="movies"] .tvl-home-row-card');
const hash = (page: Page) => page.evaluate(() => location.hash);
async function section(page: Page, title: string, row?: string) {
  await sections(page).getByRole('button', { name: title, exact: true }).click();
  await expect(sections(page).getByRole('button', { name: title, exact: true })).toHaveAttribute('aria-current', 'page');
  expect(new URLSearchParams((await hash(page)).split('?')[1]).get('cinemaRow')).toBe(row || null);
}

for (const layout of ['desktop', 'tv']) {
  test(`${layout}: provider tabs share one history entry and Back restores main Home focus`, async ({ page }) => {
    await page.goto(preview('/home?serverId=cinema-server&tab=0', layout));
    // The overlay can mount during synchronous popstate, before the entry's
    // queued hashchange. Count only events from subsequent provider-tab edits.
    await page.evaluate(() => {
      (window as any).__providerEntrySettled = false;
      const entered = (event: HashChangeEvent) => {
        if (!new URL(event.newURL).hash.includes('cinemaProvider=netflix')) return;
        (window as any).__providerEntrySettled = true; window.removeEventListener('hashchange', entered);
      };
      window.addEventListener('hashchange', entered);
    });
    await tile(page).click(); await expect(provider(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__providerEntrySettled)).toBe(true);
    const before = await page.evaluate(() => {
      const state = { ...history.state, idx: 7, key: 'native-provider', usr: { transition: 'preserve' } };
      history.replaceState(state, '', location.href);
      (window as any).__providerRouteEvents = 0;
      window.addEventListener('hashchange', () => (window as any).__providerRouteEvents++);
      window.addEventListener('popstate', () => (window as any).__providerRouteEvents++);
      return { state, length: history.length };
    });
    await section(page, 'Films', 'movies');
    await section(page, 'TV shows', 'shows');
    await section(page, 'Trending films', 'trending-movies');
    await expect(provider(page).locator('[data-provider-row="trending-movies"] .tvl-home-row-card')).toHaveCount(2);
    await section(page, 'Home');
    await section(page, 'Home');
    expect(await page.evaluate(() => ({ state: history.state, length: history.length }))).toEqual(before);
    expect(await page.evaluate(() => (window as any).__providerRouteEvents)).toBe(0);
    expect(new URLSearchParams((await hash(page)).split('?')[1]).get('serverId')).toBe('cinema-server');
    if (layout === 'desktop') await provider(page).getByRole('button', { name: 'Back', exact: true }).click();
    else await page.evaluate(() => document.activeElement!.dispatchEvent(new CustomEvent('command', { bubbles: true, cancelable: true, detail: { command: 'back' } })));
    await expect(tile(page)).toBeFocused();
    expect(await hash(page)).toBe('#/home?serverId=cinema-server&tab=0');
    await expect(provider(page)).toHaveCount(0);
  });
}

test('browser Back skips provider tabs and Forward restores the selected section without adding entries', async ({ page }) => {
  await page.goto(preview()); await tile(page).click();
  await section(page, 'Films', 'movies'); await section(page, 'TV shows', 'shows');
  const length = await page.evaluate(() => history.length);
  await page.goBack(); await expect(tile(page)).toBeFocused(); expect(await hash(page)).toBe('#/home');
  await page.goForward(); await expect(sections(page).getByRole('button', { name: 'TV shows', exact: true })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.goBack(); await expect(tile(page)).toBeVisible(); expect(await hash(page)).toBe('#/home');
});

test('accepted Home URL aliases retain their originating entry across provider tabs and Back', async ({ page }) => {
  for (const origin of ['#home?serverId=cinema-server&tab=0', '#/Home/?serverId=cinema-server&tab=0']) {
    await page.goto(preview()); await expect(tile(page)).toBeVisible();
    // The native demo only renders its canonical path. Keep its Home fixture
    // mounted while exercising the aliases accepted by Cinema's route parser.
    await page.evaluate(origin => { history.replaceState(history.state, '', origin); window.TvItemLayout!.refresh(); }, origin);
    await tile(page).click(); await expect(provider(page)).toBeVisible();
    const length = await page.evaluate(() => history.length);
    await section(page, 'Films', 'movies'); await section(page, 'TV shows', 'shows');
    expect(await page.evaluate(() => history.length)).toBe(length);
    await page.goBack(); expect(await hash(page)).toBe(origin);
    await expect(provider(page)).toHaveCount(0);
  }
});

test('a direct provider link seeds main Home ahead of an unrelated page, preserves native state and survives reload', async ({ page }) => {
  await page.goto(preview('/mypreferencesmenu', 'desktop'));
  await page.addInitScript(() => {
    if (location.hash.includes('cinemaProvider') && !history.state?.jellyfinCinemaProviderVisit) {
      history.replaceState({ ...history.state, idx: 4, key: 'native-link', usr: { preserve: true } }, '', location.href);
    }
  });
  await page.goto(preview('/home?cinemaProvider=netflix&cinemaRow=movies&serverId=cinema-server'));
  await expect(films(page).first()).toBeVisible();
  const original = await page.evaluate(() => ({ length: history.length, state: history.state }));
  expect(original.state).toMatchObject({ idx: 5, usr: { preserve: true } });
  expect(original.state.key).not.toBe('native-link');
  await page.reload(); await expect(films(page).first()).toBeVisible();
  expect(await page.evaluate(() => ({ length: history.length, state: history.state }))).toEqual(original);
  await page.goBack(); await expect(tile(page)).toBeVisible();
  expect(await hash(page)).toBe('#/home?serverId=cinema-server');
  expect(await page.evaluate(() => history.state)).toEqual({ idx: 4, key: 'native-link', usr: { preserve: true } });
  await page.goForward(); await expect(films(page).first()).toBeVisible();
  expect(await page.evaluate(() => history.length)).toBe(original.length);
  await page.keyboard.press('Escape'); await expect(tile(page)).toBeVisible();
  expect(await hash(page)).toBe('#/home?serverId=cinema-server');
});

test('a direct provider entry uses main Home for remote Back even with no in-app origin', async ({ page }) => {
  await page.goto(preview('/home?cinemaProvider=netflix&cinemaRow=shows'));
  await expect(provider(page)).toBeVisible(); await page.keyboard.press('Escape');
  await expect(tile(page)).toBeVisible(); expect(await hash(page)).toBe('#/home');
});

test('details return to a later catalogue page and its focused item before provider Back goes Home', async ({ page }) => {
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const api=window.TvItemLayoutDemo.api, original=api.getProviderItems.bind(api), getItem=api.getItem.bind(api);
      const item=index=>({Id:'navigation-film-'+index,Name:'Navigation film '+String(index).padStart(3,'0'),Type:'Movie',ProductionYear:2025,RunTimeTicks:60000000000});
      api.getProviderItems=async(id,query)=>{if(id!=='netflix'||query.type!=='Movie')return original(id,query);const items=Array.from({length:125},(_,i)=>item(i+1));return {Items:items.slice(query.startIndex||0,(query.startIndex||0)+(query.limit||60)),TotalRecordCount:125,Pending:0,Total:125,UpdatedAt:null,Status:'ready',Region:'BR'};};
      api.getItem=async id=>id.startsWith('navigation-film-')?{...await getItem('movie-tide'),...item(Number(id.split('-').pop()))}:getItem(id);
    })();` });
  });
  await page.goto(preview()); await tile(page).click();
  await section(page, 'TV shows', 'shows'); await section(page, 'Films', 'movies');
  await expect(films(page)).toHaveCount(60);
  await provider(page).getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(films(page)).toHaveCount(120);
  const selected = films(page).last(); await selected.click();
  await expect(page.getByRole('dialog', { name: 'Navigation film 120 details', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(films(page)).toHaveCount(120); await expect(selected).toBeFocused();
  expect(await provider(page).locator('.tvl-provider-content').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(sections(page).getByRole('button', { name: 'Films', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape'); await expect(tile(page)).toBeFocused();
  expect(await hash(page)).toBe('#/home');
});
