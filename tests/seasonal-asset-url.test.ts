import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSeasonalAssetUrl, seasonalAssetUrl } from '../src/seasonal-asset-url';
import { parseSeasonalAppearance, defaultSeasonalAppearance } from '../src/home-collection-settings';

test('seasonal artwork follows the injected server base and its content version', () => {
  assert.equal(resolveSeasonalAssetUrl('halloween-nightmare.webp','https://media.test/jellyfin/TvItemLayout/ClientScript?v=1.0.0.0-hash','https://client.test/web/'),
    'https://media.test/jellyfin/TvItemLayout/SeasonalAsset/halloween-nightmare.webp?v=1.0.0.0-hash');
  assert.equal(resolveSeasonalAssetUrl('christmas-photoreal.webp','https://demo.test/ScreenHarbour/dist/jellyfin-tv-layout.js','https://demo.test/ScreenHarbour/'),
    'https://demo.test/ScreenHarbour/assets/seasonal/christmas-photoreal.webp?v=1.0.0.0');
});

test('TV selects smaller bundled artwork while preserving base paths and versions', () => {
  for (const name of ['halloween-photoreal', 'halloween-nightmare', 'christmas-photoreal',
    'halloween-nightmare-door', 'halloween-nightmare-frame', 'christmas-photoreal-door', 'christmas-photoreal-frame']) {
    assert.equal(resolveSeasonalAssetUrl(`${name}.webp`, 'https://media.test/jellyfin/TvItemLayout/ClientScript?v=1.0.0.0-hash', 'https://client.test/web/', true),
      `https://media.test/jellyfin/TvItemLayout/SeasonalAsset/${name}-tv.webp?v=1.0.0.0-hash`);
    assert.equal(resolveSeasonalAssetUrl(`${name}.webp`, 'https://demo.test/ScreenHarbour/dist/jellyfin-tv-layout.js', 'https://demo.test/ScreenHarbour/', true),
      `https://demo.test/ScreenHarbour/assets/seasonal/${name}-tv.webp?v=1.0.0.0`);
    assert.equal(resolveSeasonalAssetUrl(`${name}-tv.webp`, 'https://demo.test/ScreenHarbour/dist/jellyfin-tv-layout.js', 'https://demo.test/ScreenHarbour/', true),
      `https://demo.test/ScreenHarbour/assets/seasonal/${name}-tv.webp?v=1.0.0.0`);
  }
});

test('artwork selection follows the current TV mode on either the body or document element', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const classes = { html: new Set<string>(), body: new Set<string>() };
  const document = {
    baseURI: 'https://demo.test/ScreenHarbour/',
    documentElement: { classList: { contains: (name: string) => classes.html.has(name) } },
    body: { classList: { contains: (name: string) => classes.body.has(name) } },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  try {
    const source = () => new URL(seasonalAssetUrl('halloween-nightmare.webp')).pathname;
    assert.equal(source(), '/ScreenHarbour/assets/seasonal/halloween-nightmare.webp');
    classes.html.add('layout-tv');
    assert.equal(source(), '/ScreenHarbour/assets/seasonal/halloween-nightmare-tv.webp');
    classes.html.clear(); classes.body.add('layout-tv');
    assert.equal(source(), '/ScreenHarbour/assets/seasonal/halloween-nightmare-tv.webp');
    classes.body.clear(); classes.html.add('layout-desktop');
    assert.equal(source(), '/ScreenHarbour/assets/seasonal/halloween-nightmare.webp');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('independent art styles survive parsing, retain original defaults, and reject invalid selections', () => {
  const original=defaultSeasonalAppearance('halloween');
  assert.deepEqual(parseSeasonalAppearance(original),original);
  const styled={...original,reveal:'shutters',backgroundStyle:'nightmare',frameStyle:'photoreal',coverStyle:'storybook'} as const;
  assert.deepEqual(parseSeasonalAppearance(styled),styled);
  for(const key of ['backgroundStyle','frameStyle','coverStyle']) {
    assert.equal(parseSeasonalAppearance({...styled,[key]:'https://example.test/image'}),undefined);
    assert.equal(parseSeasonalAppearance({...styled,[key]:null}),undefined);
  }
  assert.equal(parseSeasonalAppearance({...styled,theme:'christmas'}),undefined);
  assert.deepEqual(parseSeasonalAppearance({...styled,theme:'christmas',backgroundStyle:'photoreal'}),{...styled,theme:'christmas',backgroundStyle:'photoreal'});
});
