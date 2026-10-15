import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applySeasonalTitleFont, resolveSeasonalFontUrl } from '../src/home-seasonal-font';

test('seasonal fonts preserve Jellyfin base paths, injected versions and Pages project paths', () => {
  assert.equal(resolveSeasonalFontUrl('halloween-nightmare.woff2', 'https://media.test/jellyfin/TvItemLayout/ClientScript?v=content-hash', 'https://client.test/web/'),
    'https://media.test/jellyfin/TvItemLayout/SeasonalFont/halloween-nightmare.woff2?v=content-hash');
  assert.equal(resolveSeasonalFontUrl('christmas-storybook.woff2', 'https://demo.test/ScreenHarbour/dist/jellyfin-tv-layout.js', 'https://demo.test/ScreenHarbour/'),
    'https://demo.test/ScreenHarbour/assets/seasonal-fonts/christmas-storybook.woff2?v=1.0.0.0');
});

function fixture(load?: (value: string) => Promise<unknown>) {
  const faces: Array<{ dataset: Record<string, string>; textContent: string }> = [];
  const doc = {
    baseURI: 'https://demo.test/ScreenHarbour/',
    head: { append: (face: typeof faces[number]) => faces.push(face) },
    createElement: () => ({ dataset: {}, textContent: '' }),
    fonts: load ? { load } : undefined,
  };
  const properties: Record<string, string> = {};
  const element = { ownerDocument: doc, style: { setProperty: (name: string, value: string) => { properties[name] = value; } } } as unknown as HTMLElement;
  return { faces, element, properties };
}

test('fonts are requested lazily, share one face per document and resolve after the selected font is ready', async () => {
  const calls: string[] = [];
  let finish!: () => void;
  const f = fixture(value => { calls.push(value); return new Promise<void>(resolve => { finish = resolve; }); });
  assert.equal(f.faces.length, 0);
  const first = applySeasonalTitleFont(f.element, 'halloween', 'nightmare');
  const second = applySeasonalTitleFont(f.element, 'halloween', 'nightmare');
  assert.equal(first, second);
  assert.equal(f.faces.length, 1);
  assert.equal(calls.length, 1);
  assert.match(f.properties['--tvl-seasonal-title-font'], /Nosifer/);
  assert.match(f.faces[0].textContent, /assets\/seasonal-fonts\/halloween-nightmare\.woff2/);
  assert.doesNotMatch(f.faces[0].textContent, /googleapis|gstatic/);
  let ready = false; first.then(() => { ready = true; });
  await Promise.resolve(); assert.equal(ready, false);
  finish(); await first; assert.equal(ready, true);
});

test('all seven theme/style combinations choose a distinct locally bundled font', async () => {
  const f = fixture(() => Promise.resolve([]));
  for (const theme of ['halloween', 'christmas'] as const) {
    for (const style of ['classic', 'storybook', 'photoreal', ...(theme === 'halloween' ? ['nightmare'] as const : [])] as const) {
      await applySeasonalTitleFont(f.element, theme, style);
    }
  }
  assert.equal(f.faces.length, 7);
  assert.equal(new Set(f.faces.map(face => face.dataset.tvlSeasonalFont)).size, 7);
});

test('font failures and older clients without FontFaceSet never reject Home rendering', async () => {
  for (const load of [undefined, () => Promise.reject(new Error('offline')), () => { throw new Error('legacy'); }]) {
    const f = fixture(load);
    await applySeasonalTitleFont(f.element, 'christmas', 'classic');
    assert.equal(f.faces.length, 1);
    assert.match(f.faces[0].textContent, /font-display:swap/);
  }
});

test('every bundled font has its original WOFF2 bytes, recorded provenance and accompanying OFL license', () => {
  const root = new URL('../assets/seasonal-fonts/', import.meta.url);
  const sources = JSON.parse(readFileSync(new URL('SOURCES.json', root), 'utf8'));
  assert.equal(sources.fonts.length, 7);
  for (const font of sources.fonts) {
    const bytes = readFileSync(new URL(font.filename, root));
    assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
    assert.equal(bytes.length, font.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), font.sha256);
    assert.match(font.source, /^https:\/\/fonts\.gstatic\.com\//);
    const license = readFileSync(new URL(font.filename.replace('.woff2', '-OFL.txt'), root), 'utf8');
    assert.match(license, /SIL OPEN FONT LICENSE/);
    assert.match(license, /Copyright/);
  }
});
