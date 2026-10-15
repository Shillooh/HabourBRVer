import { expect, test, type Page } from '@playwright/test';
import { defaultCustomProvider, defaultProviderConfig, defaultProviderHomes, type ProviderHomesSettings } from '../../src/provider-settings';
import type { ProviderDirectory } from '../../src/types';

const editor = (page: Page) => page.locator('.tvl-provider-settings');
const sidebar = (page: Page) => editor(page).locator('.tvl-provider-settings-sidebar');
const homePreview = (page: Page) => editor(page).getByRole('complementary', { name: 'Home services row preview', exact: true });
const servicePreview = (page: Page) => editor(page).getByRole('complementary', { name: 'Service tile preview', exact: true });
async function setup(page: Page, layout = 'desktop') {
  await page.addInitScript(settings => {
    const key = `jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(settings));
  }, defaultProviderHomes());
  await page.goto(`/?featured=0&layout=${layout}#/mypreferencesmenu?cinemaProviders=1`);
  await expect(editor(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
}
async function saved(page: Page): Promise<ProviderHomesSettings> {
  return page.evaluate(() => JSON.parse(localStorage.getItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`)!));
}
async function save(page: Page) {
  await editor(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('Saved');
}
async function sourceOptions(page: Page) {
  const details = editor(page).locator('.tvl-provider-advanced');
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator('summary').click();
}
const serviceDirectory: ProviderDirectory = {
  Region: 'BR',
  Movies: [{ Id: 8, Name: 'Netflix' }, { Id: 175, Name: 'Netflix Kids' }, { Id: 1796, Name: 'Netflix Standard with Ads' }, { Id: 9, Name: 'Prime Video' }, { Id: 337, Name: 'Disney+' }, { Id: 591, Name: 'NOW Cinema' }],
  Shows: [{ Id: 8, Name: 'Netflix' }, { Id: 175, Name: 'Netflix Kids' }, { Id: 1796, Name: 'Netflix Standard with Ads' }, { Id: 9, Name: 'Prime Video' }, { Id: 337, Name: 'Disney+' }, { Id: 39, Name: 'NOW Entertainment' }]
};
async function directoryFixture(page: Page, options: { hold?: boolean; fail?: boolean; directory?: ProviderDirectory } = {}) {
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const state=window.__serviceDirectory={hold:${!!options.hold},fail:${!!options.fail},calls:0,pending:[],value:${JSON.stringify(options.directory || serviceDirectory)},release(){this.hold=false;this.pending.splice(0).forEach(resolve=>resolve());}};
      window.TvItemLayoutDemo.api.getProviderDirectory=async()=>{state.calls++;if(state.hold)await new Promise(resolve=>state.pending.push(resolve));if(state.fail)throw new Error('Unavailable');return JSON.parse(JSON.stringify(state.value));};
    })();` });
  });
}

test('custom services save collection rows, artwork and ranking and open their own Home after reload', async ({ page }, info) => {
  await setup(page); await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click();
  await expect(editor(page).getByLabel('Service name', { exact: true })).toHaveValue('New service');
  const collection = editor(page).getByRole('combobox', { name: 'Collection', exact: true });
  await expect(collection).toBeVisible(); await expect(collection).toHaveValue('');
  expect((await collection.boundingBox())!.y).toBeLessThan((await editor(page).getByLabel('Logo URL', { exact: true }).boundingBox())!.y);
  await page.screenshot({ path: info.outputPath('new-service-collection-chooser.png') });
  await editor(page).getByLabel('Service name', { exact: true }).fill('Family cinema');
  await collection.selectOption('collection-coast');
  await expect(editor(page).getByLabel('Row title', { exact: true })).toHaveValue('Coastal Stories');
  const rowPreview = editor(page).getByRole('complementary', { name: 'Provider Home row preview', exact: true });
  await expect(rowPreview.locator('.tvl-home-row-caption')).toHaveText(['After the Tide', 'A Kind of Blue']);
  const image = new URL('/demo/assets/forest.jpg', page.url()).href;
  await editor(page).getByLabel('Logo URL', { exact: true }).fill(image);
  await editor(page).getByLabel('Accent colour', { exact: true }).fill('#aabbcc');
  await expect(sidebar(page).getByRole('button', { name: 'Family cinema', exact: true })).toBeVisible();
  await expect(servicePreview(page).getByRole('button', { name: 'Family cinema', exact: true })).toBeVisible();
  await expect(editor(page).getByRole('combobox', { name: 'Content', exact: true })).toHaveValue('collection');
  await editor(page).getByLabel('Row title', { exact: true }).fill('Family films');
  await editor(page).getByRole('combobox', { name: 'Item order', exact: true }).selectOption('title');
  await editor(page).getByLabel('Show rank artwork', { exact: true }).check();
  await save(page); const stored = (await saved(page)).providers.find(provider => provider.name === 'Family cinema')!;
  expect(stored).toMatchObject({ logoUrl: image, accent: '#aabbcc', movieProviderIds: [], showProviderIds: [], rows: [{ title: 'Family films', source: 'collection', collectionId: 'collection-coast', ranked: true, itemSort: 'title' }] });
  await page.reload(); await sidebar(page).getByRole('button', { name: 'Family cinema', exact: true }).click();
  await expect(editor(page).getByLabel('Logo URL', { exact: true })).toHaveValue(image);
  await expect(rowPreview.locator('.tvl-home-row-card')).toHaveCount(2);
  await collection.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('custom-service-editor.png') });
  await page.evaluate(() => { location.hash = '/home'; });
  await page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Family cinema', exact: true }).click();
  const home = page.getByRole('dialog', { name: 'Family cinema home', exact: true });
  await expect(home).toBeVisible(); await expect(home.getByRole('heading', { name: 'Family films', exact: true })).toBeVisible();
  await expect(home.locator('.tvl-home-row-card').first()).toHaveAttribute('aria-label', 'Rank 1: A Kind of Blue');
  expect(new URLSearchParams((await page.evaluate(() => location.hash)).split('?')[1]).get('cinemaProvider')).toBe(stored.id);
});

test('tile size and hidden name labels preview the actual Home tiles and persist with accessible names', async ({ page }) => {
  await setup(page); const size = editor(page).getByRole('slider', { name: 'Tile size', exact: true });
  const tile = homePreview(page).getByRole('button', { name: 'Netflix', exact: true });
  const initial = (await tile.boundingBox())!.width;
  await size.focus(); await page.keyboard.press('End'); await expect(size).toHaveValue('150');
  expect((await tile.boundingBox())!.width).toBeGreaterThan(initial * 1.35);
  await page.keyboard.press('Home'); await expect(size).toHaveValue('70');
  expect((await tile.boundingBox())!.width).toBeLessThan(initial * .8);
  await page.keyboard.press('ArrowRight'); await expect(size).toHaveValue('71');
  await editor(page).getByLabel('Show service names', { exact: true }).uncheck();
  await expect(tile.locator('.tvl-provider-tile-name')).toBeHidden(); await expect(tile).toHaveAccessibleName('Netflix');
  await save(page); expect(await saved(page)).toMatchObject({ tileScale: 71, showNames: false });
  await page.evaluate(() => { location.hash = '/home'; });
  const actual = page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Netflix', exact: true });
  await expect(actual).toBeVisible(); await expect(actual.locator('.tvl-provider-tile-name')).toBeHidden();
  await page.reload(); await expect(actual.locator('.tvl-provider-tile-name')).toBeHidden();
});

for (const synced of [false, true]) test(`saved tile sizes update an already-open ${synced ? 'account-synced' : 'preview'} Home tab without reload or focus`, async ({ page, context }) => {
  if (synced) {
    let snapshot = { Revision: 'initial', Settings: defaultProviderHomes() };
    await context.route('**/tile-settings-fixture', async route => {
      if (route.request().method() === 'PUT') snapshot = { Revision: 'saved', Settings: route.request().postDataJSON().Settings };
      await route.fulfill({ json: snapshot });
    });
    await context.route('**/dist/demo.js', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}\n(() => {
        const request=async(options)=>{const response=await fetch('/tile-settings-fixture',options);return response.json();};
        window.TvItemLayoutDemo.api.providerHomes={isCurrent:()=>true,load:()=>request(),save:(Settings,Revision)=>request({method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({Settings,Revision})})};
      })();` });
    });
  }
  await page.goto('/?featured=0&layout=desktop#/home');
  const actual = page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Netflix', exact: true });
  await expect(actual).toBeVisible();
  const width = () => actual.evaluate(node => node.getBoundingClientRect().width);
  const initial = await width();
  const settingsPage = await context.newPage();
  try {
    await setup(settingsPage);
    await page.evaluate(() => {
      const received = (event: StorageEvent) => {
        if (!event.key?.endsWith(':another-user')) return;
        document.body.dataset.foreignSettingsSeen = 'true'; window.removeEventListener('storage', received);
      };
      window.addEventListener('storage', received);
    });
    await settingsPage.evaluate(settings => {
      localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:another-user`, JSON.stringify({ ...settings, tileScale: 70 }));
    }, defaultProviderHomes());
    await expect(page.locator('body')).toHaveAttribute('data-foreign-settings-seen', 'true');
    expect(await width()).toBeCloseTo(initial, 0);
    const slider = editor(settingsPage).getByRole('slider', { name: 'Tile size', exact: true });
    await slider.focus(); await settingsPage.keyboard.press('End'); await expect(slider).toHaveValue('150');
    expect((await homePreview(settingsPage).getByRole('button', { name: 'Netflix', exact: true }).boundingBox())!.width).toBeCloseTo(initial * 1.5, 0);
    expect(await width()).toBeCloseTo(initial, 0);
    await save(settingsPage);
    // Do not focus/reload Home or advance its 60-second refresh timer: saving
    // in a sibling tab must resize the mounted row while it remains open.
    await expect.poll(width, { timeout: 2_000 }).toBeCloseTo(initial * 1.5, 0);
    await slider.focus(); await settingsPage.keyboard.press('Home'); await expect(slider).toHaveValue('70');
    expect(await width()).toBeCloseTo(initial * 1.5, 0);
    await save(settingsPage);
    await expect.poll(width, { timeout: 2_000 }).toBeCloseTo(initial * .7, 0);
  } finally { await settingsPage.close(); }
});

test('saved tile sizes reach the real Home row after Back and survive reload', async ({ page }) => {
  await page.goto('/?featured=0&layout=desktop#/home');
  const actual = page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Netflix', exact: true });
  await expect(actual).toBeVisible();
  const width = () => actual.evaluate(node => node.getBoundingClientRect().width);
  const initial = await width();
  await page.evaluate(() => { location.hash = '/mypreferencesmenu?cinemaProviders=1'; });
  await expect(editor(page).getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  await editor(page).getByRole('slider', { name: 'Tile size', exact: true }).focus();
  await page.keyboard.press('Home'); await save(page);
  await page.goBack(); await expect(actual).toBeVisible();
  await expect.poll(width).toBeCloseTo(initial * .7, 0);
  await page.reload(); await expect(actual).toBeVisible();
  await expect.poll(width).toBeCloseTo(initial * .7, 0);
});

test('a save during an older Home settings read queues a fresh read instead of keeping stale tile sizes', async ({ page, context }) => {
  let snapshot = { Revision: 'initial', Settings: defaultProviderHomes() }, reads = 0;
  let releaseOld!: () => void, readingOld!: () => void;
  const oldRead = new Promise<void>(resolve => { readingOld = resolve; });
  const release = new Promise<void>(resolve => { releaseOld = resolve; });
  await context.route('**/tile-settings-fixture', async route => {
    if (route.request().method() === 'PUT') snapshot = { Revision: 'saved', Settings: route.request().postDataJSON().Settings };
    else if (++reads === 1) {
      const oldSnapshot = structuredClone(snapshot); readingOld(); await release;
      return route.fulfill({ json: oldSnapshot });
    }
    await route.fulfill({ json: snapshot });
  });
  await context.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const request=async(options)=>{const response=await fetch('/tile-settings-fixture',options);return response.json();};
      window.TvItemLayoutDemo.api.providerHomes={isCurrent:()=>true,load:()=>request(),save:(Settings,Revision)=>request({method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({Settings,Revision})})};
    })();` });
  });
  await page.goto('/?featured=0&layout=desktop#/home'); await oldRead;
  const settingsPage = await context.newPage();
  try {
    await setup(settingsPage);
    await editor(settingsPage).getByRole('slider', { name: 'Tile size', exact: true }).focus();
    await settingsPage.keyboard.press('End'); await save(settingsPage);
    releaseOld();
    const actual = page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name: 'Netflix', exact: true });
    await expect.poll(() => reads, { timeout: 2_000 }).toBeGreaterThanOrEqual(3);
    await expect(actual).toBeVisible();
    await expect.poll(() => actual.evaluate(node => node.getBoundingClientRect().width), { timeout: 2_000 }).toBeCloseTo(360, 0);
  } finally { releaseOld(); await settingsPage.close(); }
});

test('TV range keys and remote commands adjust tile size while preserving control focus', async ({ page }) => {
  await setup(page, 'tv'); const size = editor(page).getByRole('slider', { name: 'Tile size', exact: true });
  await size.focus(); await page.keyboard.press('ArrowRight'); await expect(size).toHaveValue('101');
  await page.evaluate(() => document.activeElement!.dispatchEvent(new CustomEvent('command', { bubbles: true, cancelable: true, detail: { command: 'right' } })));
  await expect(size).toHaveValue('102'); await expect(size).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(size).not.toBeFocused();
  await editor(page).getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(size).toHaveValue('100'); expect((await saved(page)).tileScale).toBe(100);
});

test('built-in services are fully editable and Restore defaults resets only that service draft', async ({ page }) => {
  await directoryFixture(page); await setup(page); await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click();
  await editor(page).getByLabel('Service name', { exact: true }).fill('My Netflix');
  await editor(page).getByLabel('Accent colour', { exact: true }).fill('#112233');
  await editor(page).getByLabel('Show featured artwork', { exact: true }).uncheck();
  await sourceOptions(page); const films = editor(page).getByRole('group', { name: 'Film services', exact: true }), shows = editor(page).getByRole('group', { name: 'TV services', exact: true });
  await films.getByRole('button', { name: 'Clear film services', exact: true }).click();
  await films.getByRole('checkbox', { name: 'Netflix', exact: true }).check(); await films.getByRole('checkbox', { name: 'Prime Video', exact: true }).check();
  await shows.getByRole('button', { name: 'Clear TV services', exact: true }).click(); await shows.getByRole('checkbox', { name: 'Disney+', exact: true }).check();
  await editor(page).getByLabel('Include free titles', { exact: true }).check();
  await save(page); expect((await saved(page)).providers[0]).toMatchObject({ name: 'My Netflix', accent: '#112233', hero: false, movieProviderIds: [8, 9], showProviderIds: [337], offerTypes: ['flatrate', 'free'] });
  await editor(page).getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await expect(editor(page).getByLabel('Service name', { exact: true })).toHaveValue('Netflix');
  expect((await saved(page)).providers[0].name).toBe('My Netflix');
  await save(page); expect((await saved(page)).providers[0]).toEqual(defaultProviderConfig('netflix'));
});

test('named service searches keep film and TV catalogue selections separate and Cancel restores them', async ({ page }, info) => {
  await directoryFixture(page); await setup(page); await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click(); await sourceOptions(page);
  const films = editor(page).getByRole('group', { name: 'Film services', exact: true }), shows = editor(page).getByRole('group', { name: 'TV services', exact: true });
  await films.getByRole('textbox', { name: 'Search film services', exact: true }).fill('now');
  await expect(films.getByRole('checkbox', { name: 'NOW Cinema', exact: true })).toBeVisible();
  await expect(films.getByRole('checkbox', { name: 'Netflix', exact: true })).toBeHidden();
  await films.getByRole('checkbox', { name: 'NOW Cinema', exact: true }).check();
  await shows.getByRole('checkbox', { name: 'NOW Entertainment', exact: true }).check();
  expect((await saved(page)).providers[0]).toEqual(defaultProviderConfig('netflix'));
  await save(page); expect((await saved(page)).providers[0]).toMatchObject({ movieProviderIds: [8, 175, 1796, 591], showProviderIds: [8, 175, 1796, 39] });
  await sourceOptions(page); await films.getByRole('button', { name: 'Clear film services', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Cancel changes', exact: true }).click(); await sourceOptions(page);
  await expect(films.getByRole('checkbox', { name: 'NOW Cinema', exact: true })).toBeChecked();
  await expect(editor(page).getByText('Film provider IDs', { exact: true })).toHaveCount(0);
  await expect(editor(page).getByText('TV provider IDs', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await films.scrollIntoViewIfNeeded();
  expect(await editor(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('named-services-narrow.png') });
});

test('late service names preserve the draft, search focus and previously selected catalogue entries', async ({ page }) => {
  const settings = defaultProviderHomes(), custom = defaultCustomProvider('custom-archive'); custom.name = 'Archive'; custom.movieProviderIds = [999999]; custom.showProviderIds = [337]; settings.providers.push(custom);
  await page.addInitScript(settings => localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`, JSON.stringify(settings)), settings);
  await directoryFixture(page, { hold: true, directory: { ...serviceDirectory, Movies: [...serviceDirectory.Movies, { Id: 2100, Name: 'Prime Video with Ads' }, { Id: 999999, Name: 'Archive+' }] } });
  await setup(page); await sidebar(page).getByRole('button', { name: 'Archive', exact: true }).click(); await sourceOptions(page);
  const films = editor(page).getByRole('group', { name: 'Film services', exact: true });
  await expect(films.getByRole('checkbox', { name: 'Previously selected service', exact: true })).toBeChecked();
  await editor(page).getByLabel('Service name', { exact: true }).fill('My archive');
  const search = films.getByRole('textbox', { name: 'Search film services', exact: true }); await search.fill('prime');
  await films.getByRole('checkbox', { name: 'Prime Video', exact: true }).check(); await search.focus();
  await page.evaluate(() => { (window as any).__serviceDirectory.release(); });
  await expect(films.getByRole('checkbox', { name: 'Prime Video with Ads', exact: true })).toBeChecked();
  await expect(search).toHaveValue('prime'); await expect(search).toBeFocused();
  await expect(films.locator('.tvl-provider-service-selection')).toContainText('Archive+');
  await expect(editor(page).getByLabel('Service name', { exact: true })).toHaveValue('My archive');
  expect((await saved(page)).providers.find(provider => provider.id === custom.id)).toEqual(custom);
  await save(page); expect((await saved(page)).providers.find(provider => provider.id === custom.id)).toMatchObject({ name: 'My archive', movieProviderIds: [999999, 9, 2100], showProviderIds: [337] });
});

test('service directory retry retains preset edits and enforces the twenty-service limit by name', async ({ page }) => {
  const directory: ProviderDirectory = { Region: 'BR', Movies: Array.from({ length: 22 }, (_, index) => ({ Id: index + 1, Name: `Catalogue service ${String(index + 1).padStart(2, '0')}` })), Shows: serviceDirectory.Shows };
  await directoryFixture(page, { fail: true, directory }); await setup(page);
  await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click(); await editor(page).getByLabel('Service name', { exact: true }).fill('My selection'); await sourceOptions(page);
  const films = editor(page).getByRole('group', { name: 'Film services', exact: true });
  await films.getByRole('checkbox', { name: 'Netflix', exact: true }).check();
  await page.evaluate(() => { (window as any).__serviceDirectory.fail = false; });
  await editor(page).getByRole('button', { name: 'Retry service list', exact: true }).click();
  await expect(films.getByRole('checkbox', { name: 'Catalogue service 08', exact: true })).toBeChecked();
  await expect(editor(page).getByLabel('Service name', { exact: true })).toHaveValue('My selection');
  await films.getByRole('button', { name: 'Clear film services', exact: true }).click();
  for (let index = 1; index <= 20; index++) await films.getByRole('checkbox', { name: `Catalogue service ${String(index).padStart(2, '0')}`, exact: true }).check();
  await expect(films.getByRole('checkbox', { name: 'Catalogue service 21', exact: true })).toBeDisabled();
  await films.getByRole('checkbox', { name: 'Catalogue service 01', exact: true }).uncheck();
  await expect(films.getByRole('checkbox', { name: 'Catalogue service 21', exact: true })).toBeEnabled();
  await films.getByRole('checkbox', { name: 'Catalogue service 21', exact: true }).check();
  await save(page); expect((await saved(page)).providers.find(provider => provider.name === 'My selection')!.movieProviderIds).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
});

test('a partially selected built-in service can be removed at the limit while the directory is unavailable', async ({ page }) => {
  const settings = defaultProviderHomes(), remaining = Array.from({ length: 19 }, (_, index) => 900001 + index);
  settings.providers[0].movieProviderIds = [8, ...remaining];
  await page.addInitScript(settings => localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`, JSON.stringify(settings)), settings);
  await directoryFixture(page, { fail: true }); await setup(page);
  await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click(); await sourceOptions(page);
  const films = editor(page).getByRole('group', { name: 'Film services', exact: true }), netflix = films.getByRole('checkbox', { name: 'Netflix', exact: true });
  expect(await netflix.evaluate(node => (node as HTMLInputElement).indeterminate)).toBe(true);
  await netflix.click(); await expect(netflix).not.toBeChecked();
  expect(await netflix.evaluate(node => (node as HTMLInputElement).indeterminate)).toBe(false);
  await save(page); expect((await saved(page)).providers[0].movieProviderIds).toEqual(remaining);
});

test('Cancel reverses unsaved edits and removal; saved removal can restore a built-in service', async ({ page }) => {
  await setup(page); const baseline = await saved(page);
  await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Remove service', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Netflix', exact: true })).toHaveCount(0);
  await editor(page).getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Netflix', exact: true })).toBeVisible(); expect(await saved(page)).toEqual(baseline);
  await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click();
  await editor(page).getByLabel('Service name', { exact: true }).fill('Unsaved service');
  await editor(page).getByRole('button', { name: 'Cancel changes', exact: true }).click();
  await expect(sidebar(page).getByRole('button', { name: 'Unsaved service', exact: true })).toHaveCount(0); expect(await saved(page)).toEqual(baseline);
  await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Remove service', exact: true }).click(); await save(page);
  expect((await saved(page)).providers.some(provider => provider.id === 'netflix')).toBe(false);
  await editor(page).getByRole('button', { name: 'Add Netflix', exact: true }).click(); await save(page);
  expect((await saved(page)).providers.find(provider => provider.id === 'netflix')).toEqual(defaultProviderConfig('netflix'));
});

test('invalid service fields block Save with useful focus and preserve persisted settings', async ({ page }) => {
  const unsafeArtworkRequests: string[] = []; page.on('request', request => { if (request.url().includes('example.com')) unsafeArtworkRequests.push(request.url()); });
  await setup(page); const baseline = await saved(page); await sidebar(page).getByRole('button', { name: 'Netflix', exact: true }).click();
  const cases = [
    ['Service name', '   ', 'Netflix', 'Enter a service name.'],
    ['Logo URL', 'javascript:alert(1)', '', 'Use an HTTP or HTTPS image URL without a username or password.'],
    ['Logo URL', 'https://user:secret@example.com/logo.png', '', 'Use an HTTP or HTTPS image URL without a username or password.'],
    ['Accent colour', '#123', '#e50914', 'Use a six-digit colour such as #9fb8a8.']
  ];
  for (const [label, invalid, valid, message] of cases) {
    const input = editor(page).getByLabel(label, { exact: true }); await input.fill(invalid);
    await editor(page).getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(input).toBeFocused(); await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(editor(page).getByRole('status')).toHaveText(message); expect(await saved(page)).toEqual(baseline);
    await input.fill(valid);
  }
  await sourceOptions(page); await editor(page).getByLabel('Include subscription titles', { exact: true }).uncheck();
  await editor(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor(page).getByRole('status')).toHaveText('Choose at least one availability type.');
  await expect(editor(page).getByLabel('Include subscription titles', { exact: true })).toBeFocused(); expect(await saved(page)).toEqual(baseline);
  expect(unsafeArtworkRequests).toEqual([]);
});

test('custom artwork falls back to initials and the editor remains usable at TV and narrow widths', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 }); await setup(page, 'tv');
  await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click();
  await editor(page).getByLabel('Service name', { exact: true }).fill('Local stories');
  const preview = servicePreview(page); await expect(preview.locator('.tvl-provider-monogram')).toHaveText('LS');
  await editor(page).getByLabel('Logo URL', { exact: true }).fill(new URL('/missing-service-logo.png', page.url()).href);
  await expect(preview.locator('.tvl-provider-monogram')).toBeVisible();
  await expect(preview.locator('img')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('service-customization-tv.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await editor(page).getByLabel('Service name', { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => {
    const pane = document.querySelector('.tvl-provider-settings')!;
    return pane.scrollWidth <= pane.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1;
  })).toBe(true);
  await expect(editor(page).getByLabel('Service name', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('service-customization-narrow.png') });
});

test('new enabled collection rows require a collection while empty disabled draft rows can be saved', async ({ page }) => {
  await setup(page); await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Add collection row', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(editor(page).getByRole('combobox', { name: 'Collection', exact: true })).toBeFocused();
  await expect(editor(page).getByRole('status')).toHaveText('Choose a collection for “Collection” before saving.');
  await editor(page).getByLabel('Show this row', { exact: true }).uncheck(); await save(page);
  expect((await saved(page)).providers.find(provider => provider.id.startsWith('custom-'))!.rows[0]).toMatchObject({ source: 'collection', collectionId: '', enabled: false });
});

test('an eighty-character service name wraps without overflowing its tile or obscuring provider Back', async ({ page }, info) => {
  await setup(page); await sidebar(page).getByRole('button', { name: 'Add service', exact: true }).click();
  const name = 'W'.repeat(80); await editor(page).getByLabel('Service name', { exact: true }).fill(name); await save(page);
  await page.evaluate(() => { location.hash = '/home'; });
  for (const width of [1080, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const tile = page.locator('#homeTab .tvl-home-provider-row').getByRole('button', { name, exact: true });
    await tile.scrollIntoViewIfNeeded(); await expect(tile).toBeVisible(); await expect(tile).toHaveAccessibleName(name);
    expect(await tile.locator('.tvl-provider-tile-name').evaluate(node => {
      const title = node.getBoundingClientRect(), card = node.parentElement!.getBoundingClientRect();
      return node.scrollWidth <= node.clientWidth + 1 && title.left >= card.left - 1 && title.right <= card.right + 1;
    })).toBe(true);
    await tile.click(); const home = page.getByRole('dialog', { name: `${name} home`, exact: true });
    const back = home.getByRole('button', { name: 'Back', exact: true }), title = home.getByRole('heading', { name, exact: true });
    await expect(back).toBeVisible(); await expect(title).toBeVisible();
    const heading = (await title.boundingBox())!, button = (await back.boundingBox())!;
    expect(heading.x >= button.x + button.width || heading.y >= button.y + button.height || heading.y + heading.height <= button.y).toBe(true);
    expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    expect(await home.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`long-service-name-${width}.png`) });
    await back.click(); await expect(tile).toBeFocused();
  }
});

test('an existing empty service offers a collection directly and stays empty until a collection is chosen', async ({ page }) => {
  const settings=defaultProviderHomes(), custom=defaultCustomProvider('custom-existing-empty');custom.name='My archive';settings.providers.push(custom);
  await page.addInitScript(settings=>localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`,JSON.stringify(settings)),settings);
  await setup(page);await sidebar(page).getByRole('button',{name:'My archive',exact:true}).click();
  const collection=editor(page).getByRole('combobox',{name:'Collection',exact:true});
  await expect(collection).toBeVisible();await expect(collection).toHaveValue('');
  await save(page);expect((await saved(page)).providers.find(provider=>provider.id===custom.id)).toEqual(custom);
  await collection.selectOption('collection-wilderness');
  await expect(editor(page).getByLabel('Row title',{exact:true})).toHaveValue('Into the Wilderness');
  await expect(editor(page).getByRole('complementary',{name:'Provider Home row preview',exact:true}).locator('.tvl-home-row-card')).toHaveCount(3);
  expect((await saved(page)).providers.find(provider=>provider.id===custom.id)!.rows).toEqual([]);
  await save(page);expect((await saved(page)).providers.find(provider=>provider.id===custom.id)!.rows).toMatchObject([
    {title:'Into the Wilderness',source:'collection',collectionId:'collection-wilderness',enabled:true}
  ]);
});

test('additional collection rows start at the collection chooser and preserve a title edited by the user', async ({ page }) => {
  await setup(page);await sidebar(page).getByRole('button',{name:'Add service',exact:true}).click();
  await editor(page).getByRole('combobox',{name:'Collection',exact:true}).selectOption('collection-coast');
  await editor(page).getByRole('button',{name:'Add collection row',exact:true}).click();
  const collection=editor(page).getByRole('combobox',{name:'Collection',exact:true});
  await expect(collection).toBeFocused();await expect(collection).toHaveValue('');
  await collection.selectOption('collection-wilderness');
  const title=editor(page).getByLabel('Row title',{exact:true});await expect(title).toHaveValue('Into the Wilderness');
  await title.fill('Family adventures');await collection.selectOption('collection-coast');
  await expect(title).toHaveValue('Family adventures');await save(page);
  const rows=(await saved(page)).providers.find(provider=>provider.id.startsWith('custom-'))!.rows;
  expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({title:'Coastal Stories',collectionId:'collection-coast'});
  expect(rows[1]).toMatchObject({title:'Family adventures',collectionId:'collection-coast'});
});

test('opening and saving a configured custom service preserves its automatic rows, collection choices and named services', async ({ page }) => {
  const settings=defaultProviderHomes(), custom=defaultCustomProvider('custom-configured');
  custom.name='Configured service';custom.movieProviderIds=[8,9];custom.showProviderIds=[337];custom.offerTypes=['free','ads'];
  custom.rows=[
    {id:'automatic',title:'Automatic films',source:'movies',collectionId:'',enabled:true,ranked:false,itemSort:'newest'},
    {id:'hand-picked',title:'Hand picked',source:'collection',collectionId:'collection-coast',enabled:true,ranked:true,itemSort:'title'}
  ];settings.providers.push(custom);
  await page.addInitScript(settings=>localStorage.setItem(`jellyfin-cinema.provider-homes.v1:${encodeURIComponent(location.origin)}:demo`,JSON.stringify(settings)),settings);
  await directoryFixture(page);await setup(page);await sidebar(page).getByRole('button',{name:'Configured service',exact:true}).click();
  await expect(editor(page).getByRole('combobox',{name:'Content',exact:true})).toHaveValue('movies');
  await sourceOptions(page);const films=editor(page).getByRole('group',{name:'Film services',exact:true}),shows=editor(page).getByRole('group',{name:'TV services',exact:true});
  await expect(films.getByRole('checkbox',{name:'Netflix',exact:true})).toBeChecked();await expect(films.getByRole('checkbox',{name:'Prime Video',exact:true})).toBeChecked();
  await expect(shows.getByRole('checkbox',{name:'Disney+',exact:true})).toBeChecked();
  await editor(page).getByRole('button',{name:'Hand picked',exact:true}).click();
  await expect(editor(page).getByRole('combobox',{name:'Collection',exact:true})).toHaveValue('collection-coast');
  await expect(editor(page).getByRole('combobox',{name:'Item order',exact:true})).toHaveValue('title');
  await save(page);expect((await saved(page)).providers.find(provider=>provider.id===custom.id)).toEqual(custom);
});

for(const failure of [false,true])test(`collection choices recover from ${failure?'a failed request':'an empty library'} without discarding a custom service draft`,async({page})=>{
  await page.route('**/dist/demo.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:`${await response.text()}\n(()=>{
      const api=window.TvItemLayoutDemo.api,original=api.getCollectionList,state=window.__collectionChoices={ready:false};
      api.getCollectionList=async()=>{if(state.ready)return original();if(${failure})throw new Error('Collection choices unavailable');return [];};
    })();`});
  });
  await setup(page);await sidebar(page).getByRole('button',{name:'Add service',exact:true}).click();
  await editor(page).getByLabel('Service name',{exact:true}).fill('Unfinished service');
  const collection=editor(page).getByRole('combobox',{name:'Collection',exact:true});
  await expect(collection.locator('option[value="collection-coast"]')).toHaveCount(0);
  await page.evaluate(()=>{(window as any).__collectionChoices.ready=true;});
  await editor(page).getByRole('button',{name:'Refresh collections',exact:true}).click();
  await expect(collection.locator('option[value="collection-coast"]')).toHaveCount(1);
  await expect(editor(page).getByLabel('Service name',{exact:true})).toHaveValue('Unfinished service');
  await collection.selectOption('collection-coast');
  await expect(editor(page).getByRole('complementary',{name:'Provider Home row preview',exact:true}).locator('.tvl-home-row-card')).toHaveCount(2);
  expect((await saved(page)).providers.some(provider=>provider.name==='Unfinished service')).toBe(false);
});

async function heldCollectionRefresh(page: Page) {
  await page.route('**/dist/demo.js',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:`${await response.text()}\n(()=>{
      const api=window.TvItemLayoutDemo.api,collections=api.getCollectionList;
      const state=window.__heldCollectionRefresh={holdCollections:false,holdSave:false,pendingCollections:[],saveCalls:0,
        snapshot:{Revision:'initial',Settings:${JSON.stringify(defaultProviderHomes())}},
        releaseCollections(){this.holdCollections=false;this.pendingCollections.splice(0).forEach(resolve=>resolve());}};
      api.getCollectionList=async()=>{if(state.holdCollections)await new Promise(resolve=>state.pendingCollections.push(resolve));return collections();};
      api.providerHomes={isCurrent:()=>true,load:async()=>JSON.parse(JSON.stringify(state.snapshot)),save:async Settings=>{
        state.saveCalls++;if(state.holdSave)await new Promise(resolve=>{state.releaseSave=resolve;});
        state.snapshot={Revision:'saved',Settings};return JSON.parse(JSON.stringify(state.snapshot));
      }};
    })();`});
  });
  await setup(page);await sidebar(page).getByRole('button',{name:'Netflix',exact:true}).click();
}

test('finishing a collection refresh during Save keeps the rebuilt form disabled until the save is confirmed',async({page})=>{
  await heldCollectionRefresh(page);const baseline=await saved(page);
  await editor(page).getByLabel('Service name',{exact:true}).fill('Changed during refresh');
  await page.evaluate(()=>{const state=(window as any).__heldCollectionRefresh;state.holdCollections=true;state.holdSave=true;});
  await editor(page).getByRole('button',{name:'Refresh collections',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__heldCollectionRefresh.pendingCollections.length)).toBeGreaterThan(0);
  await editor(page).getByRole('button',{name:'Save changes',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as any).__heldCollectionRefresh.releaseSave)).toBe('function');
  const controls=editor(page).locator('.tvl-provider-settings-workspace input,.tvl-provider-settings-workspace select,.tvl-provider-settings-workspace button,.tvl-provider-settings-sidebar button');
  expect(await controls.evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>(node as HTMLInputElement).disabled))).toBe(true);
  expect(await saved(page)).toEqual(baseline);
  await page.evaluate(()=>(window as any).__heldCollectionRefresh.releaseCollections());
  await expect(editor(page).getByRole('button',{name:'Refresh collections',exact:true})).toBeDisabled();
  await expect(editor(page).getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  await expect(editor(page).getByRole('button',{name:'Cancel changes',exact:true})).toBeDisabled();
  expect(await controls.evaluateAll(nodes=>nodes.length>0&&nodes.every(node=>(node as HTMLInputElement).disabled))).toBe(true);
  expect(await saved(page)).toEqual(baseline);
  await page.evaluate(()=>(window as any).__heldCollectionRefresh.releaseSave());
  await expect(editor(page).getByRole('status')).toHaveText('Saved to your Jellyfin account.');
  await expect(editor(page).getByLabel('Service name',{exact:true})).toBeEnabled();
  await expect(editor(page).getByRole('button',{name:'Save changes',exact:true})).toBeEnabled();
  expect((await saved(page)).providers[0].name).toBe('Changed during refresh');
});

test('finishing a collection refresh preserves the field being edited and its unsaved service draft',async({page})=>{
  await heldCollectionRefresh(page);const baseline=await saved(page);
  await page.evaluate(()=>{(window as any).__heldCollectionRefresh.holdCollections=true;});
  await editor(page).getByRole('button',{name:'Refresh collections',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__heldCollectionRefresh.pendingCollections.length)).toBeGreaterThan(0);
  const name=editor(page).getByLabel('Service name',{exact:true});await name.fill('Still editing this service');await expect(name).toBeFocused();
  await page.evaluate(()=>(window as any).__heldCollectionRefresh.releaseCollections());
  await expect(editor(page).getByRole('button',{name:'Refresh collections',exact:true})).toBeEnabled();
  await expect(name).toBeFocused();await expect(name).toHaveValue('Still editing this service');
  expect(await saved(page)).toEqual(baseline);
});
