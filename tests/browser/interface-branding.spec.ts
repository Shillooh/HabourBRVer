import { expect, test, type Page } from '@playwright/test';
import { defaultLoadingScreen } from '../../src/loading-settings';

const editor = (page: Page) => page.getByRole('dialog', { name: 'Loading screen settings', exact: true });
const editorTitle = (page: Page) => editor(page).locator('.tvl-wordmark[data-tvl-brand]');
const loginTitle = (page: Page) => page.locator('#loginPage>.padded-left');
const settingsTitle = (page: Page) => page.locator('.tvl-settings-providers [data-tvl-brand]');

/** A native session adapter, with a fresh identity captured for every API.
 * The held read deliberately returns its original owner's response even after
 * a switch, so the production controller/store must reject it themselves. */
async function fixture(page: Page, options: { hold?: boolean; title?: string } = {}) {
  await page.route('**/dist/demo.js', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\n(() => {
      const original = window.TvItemLayoutDemo.api;
      const state = window.__branding = {
        user: 'demo', server: 'fixture-server', reads: [], writes: [], pending: [],
        hold: ${!!options.hold}, values: { 'fixture-server:demo': ${JSON.stringify({ ...defaultLoadingScreen(), brandText: options.title ?? 'Family cinema' })} }
      };
      state.activate = (user, server = 'fixture-server') => {
        state.user = user; state.server = server;
        window.ApiClient = { getCurrentUserId: () => state.user, serverId: () => state.server,
          getUser: async id => ({ Id: id, Policy: { IsAdministrator: false } }) };
        if(!user) { delete window.TvItemLayoutDemo; return; }
        const owner = server + ':' + user;
        window.TvItemLayoutDemo = { api: { ...original, userId: user, serverId: server,
          loadingScreen: { isCurrent: () => state.user === user && state.server === server,
            load: async () => {
              state.reads.push(owner);
              const settings = structuredClone(state.values[owner] || ${JSON.stringify(defaultLoadingScreen())});
              if(state.hold) await new Promise(resolve => state.pending.push({ owner, resolve }));
              return { Revision: 'current', Settings: settings };
            }, save: async settings => {
              state.writes.push(owner); state.values[owner] = structuredClone(settings);
              return { Revision: 'saved', Settings: structuredClone(settings) };
            }
          }
        }, initialItem: 'series-north' };
      };
      state.login = () => {
        document.querySelector('#loginPage')?.remove();
        const root = document.createElement('main'); root.id = 'loginPage';
        root.innerHTML = '<div class="padded-left padded-right padded-bottom-page"><div class="visualLoginForm"><h1>Who is watching?</h1><div id="divUsers"><button class="card"><div class="cardBox"><div class="cardScalable"><div class="cardImageContainer" style="height:160px;display:grid;place-items:center;font-size:64px">F</div></div><div class="cardText">Family</div></div></button></div></div></div>';
        document.body.append(root);
        const style = document.createElement('style');
        style.textContent = '.tvl-login-native > .demo-native-page,.tvl-login-native > .demo-switcher{display:none!important}';
        document.head.append(style);
        document.querySelectorAll('.demo-native-page,.demo-switcher').forEach(node => node.classList.add('hide'));
      };
      if(sessionStorage.getItem('branding-signed-out')) { state.activate(''); state.login(); }
      else state.activate('demo');
    })();` });
  });
}

async function loadingSettings(page: Page) {
  await page.goto('/?featured=0&layout=desktop#/mypreferencesmenu?cinemaLoading=1');
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
}

async function saveTitle(page: Page, title: string) {
  await editor(page).getByLabel('Title', { exact: true }).fill(title);
  await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor(page).getByRole('status')).toContainText('Saved');
}

async function navigate(page: Page, hash: string) {
  await page.evaluate(hash => { location.hash = hash; }, hash);
}

async function signOut(page: Page, hash = '/login?serverid=fixture-server') {
  await page.evaluate(hash => {
    const state = (window as any).__branding;
    sessionStorage.setItem('branding-signed-out', '1'); state.activate(''); state.login();
    location.hash = hash; window.TvItemLayout!.refresh();
  }, hash);
  await expect(page.locator('body')).toHaveClass(/tvl-login-native/);
}

test('saving the title updates the open header, settings heading and streaming-services heading', async ({ page }) => {
  await fixture(page); await loadingSettings(page);
  await expect(editorTitle(page)).toHaveText('Family cinema');
  await saveTitle(page, 'Our movie nights');
  await expect(editorTitle(page)).toHaveText('Our movie nights');
  await navigate(page, '/mypreferencesmenu');
  await expect(settingsTitle(page)).toHaveText('Our movie nights');
  await page.getByRole('link', { name: 'Streaming services Provider homes and rows' }).click();
  await expect(page.locator('.tvl-provider-settings-eyebrow[data-tvl-brand]')).toHaveText('PERSONALISE Our movie nights');
});

test('draft text and Restore defaults never change the interface until saved, and Cancel discards them', async ({ page }) => {
  await fixture(page);
  await page.goto('/?featured=0&layout=desktop#/mypreferencesmenu');
  await page.getByRole('link', { name: 'Loading screen Animation and custom text' }).click();
  await expect(editor(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await editor(page).getByLabel('Title', { exact: true }).fill('Uncommitted title');
  await expect(editor(page).locator('.tvl-loading-settings-preview .tvl-home-loading-brand')).toHaveText('Uncommitted title');
  await expect(editorTitle(page)).toHaveText('Family cinema');
  await editor(page).getByRole('button', { name: 'Restore defaults', exact: true }).click();
  await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('HarbourBR');
  await expect(editorTitle(page)).toHaveText('Family cinema');
  await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settingsTitle(page)).toHaveText('Family cinema');
  expect(await page.evaluate(() => (window as any).__branding.writes)).toEqual([]);
});

test('an explicitly empty saved title hides the whole wordmark, including prefixes and the login gap', async ({ page }) => {
  await fixture(page); await loadingSettings(page); await saveTitle(page, '');
  await expect(editorTitle(page)).toBeHidden();
  await navigate(page, '/mypreferencesmenu'); await expect(settingsTitle(page)).toBeHidden();
  await page.getByRole('link', { name: 'Streaming services Provider homes and rows' }).click();
  await expect(page.locator('.tvl-provider-settings-eyebrow[data-tvl-brand]')).toBeHidden();
  await signOut(page);
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', '');
  expect(await loginTitle(page).evaluate(node => getComputedStyle(node, '::before').display)).toBe('none');
  expect(await loginTitle(page).evaluate(node => getComputedStyle(node, '::before').marginBottom)).toBe('0px');
});

test('title content is literal text in interface labels and the signed-out login heading', async ({ page }) => {
  const text = '<img src=x onerror=alert(1)> "Cinema"';
  await fixture(page); await loadingSettings(page); await saveTitle(page, text);
  await expect(editorTitle(page)).toHaveText(text);
  await expect(editorTitle(page).locator('img')).toHaveCount(0);
  await signOut(page);
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', text);
  await expect(loginTitle(page).locator('img')).toHaveCount(0);
  const content = await loginTitle(page).evaluate(node => getComputedStyle(node, '::before').content);
  expect(content).toContain('<img src=x onerror=alert(1)>');
});

test('the confirmed login title survives sign-out and reload, with route server taking precedence over the old client', async ({ page }) => {
  await fixture(page); await loadingSettings(page); await saveTitle(page, 'Home cinema');
  await signOut(page);
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'Home cinema');
  await page.reload(); await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'Home cinema');
  await page.evaluate(() => localStorage.setItem('jellyfin-cinema.interface-title.v1:other-server', JSON.stringify('Other cinema')));
  await navigate(page, '/login?serverId=other-server');
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'Other cinema');
  await navigate(page, '/login?serverid=unknown-server');
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'HarbourBR');
  await navigate(page, '/login?serverid=fixture-server');
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'Home cinema');
  await page.screenshot({ path: '/tmp/screenharbour-custom-title-login.png' });
  await navigate(page, '/selectserver');
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', 'HarbourBR');
});

test('account switches use the new account cache immediately and discard the outgoing delayed response', async ({ page }) => {
  await page.addInitScript(settings => {
    localStorage.setItem('jellyfin-cinema.loading-screen.v1:fixture-server:demo', JSON.stringify({ ...settings, brandText: 'Parents cached' }));
    localStorage.setItem('jellyfin-cinema.loading-screen.v1:fixture-server:kids', JSON.stringify({ ...settings, brandText: 'Kids cached' }));
  }, defaultLoadingScreen());
  await fixture(page, { hold: true, title: 'Parents server' });
  await page.goto('/?featured=0&layout=desktop#/mypreferencesmenu');
  await expect(settingsTitle(page)).toHaveText('Parents cached');
  await expect.poll(() => page.evaluate(() => (window as any).__branding.reads)).toEqual(['fixture-server:demo']);
  await page.evaluate(() => {
    const state = (window as any).__branding;
    state.values['fixture-server:kids'] = { ...state.values['fixture-server:demo'], brandText: 'Kids server' };
    state.activate('kids'); window.TvItemLayout!.refresh();
  });
  await expect(settingsTitle(page)).toHaveText('Kids cached');
  await page.evaluate(() => {
    const state = (window as any).__branding;
    state.pending.filter((entry: any) => entry.owner === 'fixture-server:demo').forEach((entry: any) => entry.resolve());
  });
  await expect(settingsTitle(page)).toHaveText('Kids cached');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jellyfin-cinema.loading-screen.v1:fixture-server:demo')!))).toMatchObject({ brandText: 'Parents cached' });
  await page.evaluate(() => {
    const state = (window as any).__branding; state.hold = false;
    state.pending.filter((entry: any) => entry.owner === 'fixture-server:kids').forEach((entry: any) => entry.resolve());
  });
  await expect(settingsTitle(page)).toHaveText('Kids server');
});

test('the initial Home request supplies the brand without a duplicate settings read', async ({ page }) => {
  await fixture(page);
  await page.goto('/?featured=0&layout=desktop#/home');
  await expect.poll(() => page.evaluate(() => (window as any).__branding.reads)).toEqual(['fixture-server:demo']);
  await expect(page.locator('#homeTab')).not.toHaveClass(/tvl-home-initial-loading/);
  await navigate(page, '/mypreferencesmenu');
  await expect(settingsTitle(page)).toHaveText('Family cinema');
  expect(await page.evaluate(() => (window as any).__branding.reads)).toEqual(['fixture-server:demo']);
});

test('a newer title saved in another tab survives a delayed older Home settings reply', async ({ page }) => {
  await page.addInitScript(settings => localStorage.setItem('jellyfin-cinema.loading-screen.v1:fixture-server:demo', JSON.stringify(settings)),
    { ...defaultLoadingScreen(), brandText: 'Original title' });
  await fixture(page, { hold: true, title: 'Original title' });
  await page.goto('/?featured=0&layout=desktop#/home');
  await expect.poll(() => page.evaluate(() => (window as any).__branding.pending.length)).toBe(1);
  await page.evaluate(async settings => {
    const key = 'jellyfin-cinema.loading-screen.v1:fixture-server:demo';
    const oldValue = localStorage.getItem(key); const newValue = JSON.stringify(settings);
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue, storageArea: localStorage, url: location.href }));
    const state = (window as any).__branding; state.hold = false;
    state.pending.splice(0).forEach((entry: any) => entry.resolve());
    // Give the completed read and its cache/notification continuations a full
    // render opportunity before checking that the newer value survived.
    for (let frame = 0; frame < 2; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, { ...defaultLoadingScreen(), brandText: 'Saved in other tab' });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('jellyfin-cinema.loading-screen.v1:fixture-server:demo')!))).toMatchObject({ brandText: 'Saved in other tab' });
  await navigate(page, '/mypreferencesmenu');
  await expect(settingsTitle(page)).toHaveText('Saved in other tab');
});

test('the profile chooser preserves custom title casing and maximum-length titles fit narrow views', async ({ page }) => {
  await fixture(page); await loadingSettings(page);
  const longTitle = 'Cinema'.repeat(10);
  await saveTitle(page, longTitle);
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const title = editorTitle(page); await expect(title).toHaveText(longTitle);
    const bounds = await title.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  await navigate(page, '/mypreferencesmenu?cinemaProviders=1');
  for (const width of [800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const title = page.locator('.tvl-provider-settings-eyebrow[data-tvl-brand]');
    await expect(title).toHaveText('PERSONALISE ' + longTitle);
    expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  await navigate(page, '/home');
  await expect(page.getByRole('region', { name: 'My Media', exact: true }).getByRole('button', { name: 'Movies', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).Dashboard = { logout() {}, navigate(route: string) { location.hash = '/' + route; } };
    const button = document.createElement('button'); button.className = 'headerUserButton'; button.textContent = 'Choose profile';
    document.querySelector('.skinHeader')!.append(button);
  });
  await page.getByRole('button', { name: 'Choose profile', exact: true }).click();
  const profileTitle = page.getByRole('dialog', { name: 'Who’s watching?', exact: true }).locator('[data-tvl-brand]');
  await expect(profileTitle).toHaveText(longTitle); await expect(profileTitle).toHaveCSS('text-transform', 'none');
  expect(await profileTitle.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.keyboard.press('Escape');
  await signOut(page);
  await expect(loginTitle(page)).toHaveAttribute('data-tvl-title', longTitle);
  expect(await loginTitle(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
});
