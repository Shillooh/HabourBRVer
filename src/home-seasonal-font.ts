import type { HomeSeasonalAppearance, HomeSeasonalArtStyle } from './home-collection-settings';

// Capture the bundle URL while it executes, before an asynchronously rendered
// row asks for its font. Never contact a third-party font service at runtime.
const scriptSource = typeof document !== 'undefined'
  ? (document.currentScript as HTMLScriptElement | null)?.src || '' : '';
type Font = { family: string; filename: string; weight: number };
const fonts: Record<string, Font> = {
  'halloween-classic': { family: 'Creepster', filename: 'halloween-classic.woff2', weight: 400 },
  'halloween-storybook': { family: 'Henny Penny', filename: 'halloween-storybook.woff2', weight: 400 },
  'halloween-photoreal': { family: 'IM Fell English SC', filename: 'halloween-photoreal.woff2', weight: 400 },
  'halloween-nightmare': { family: 'Nosifer', filename: 'halloween-nightmare.woff2', weight: 400 },
  'christmas-classic': { family: 'Berkshire Swash', filename: 'christmas-classic.woff2', weight: 400 },
  'christmas-storybook': { family: 'Snowburst One', filename: 'christmas-storybook.woff2', weight: 400 },
  'christmas-photoreal': { family: 'Cinzel Decorative', filename: 'christmas-photoreal.woff2', weight: 700 },
};
const pending = new WeakMap<Document, Map<string, Promise<void>>>();

export function resolveSeasonalFontUrl(filename: string, script: string, base: string): string {
  const source = new URL(script || 'dist/jellyfin-tv-layout.js', base);
  const injected = /\/TvItemLayout\/ClientScript$/i.test(source.pathname);
  const url = new URL(injected ? `SeasonalFont/${filename}` : `../assets/seasonal-fonts/${filename}`, source);
  url.searchParams.set('v', source.searchParams.get('v') || '1.0.0.0');
  return url.href;
}

/** Call when the seasonal row is nearby or focused; Home never awaits a font. */
export function applySeasonalTitleFont(element: HTMLElement, theme: HomeSeasonalAppearance['theme'], style: HomeSeasonalArtStyle = 'classic'): Promise<void> {
  const key = `${theme}-${style}`;
  const font = fonts[key] || fonts[`${theme}-classic`];
  const family = `ScreenHarbour ${font.family}`;
  const doc = element.ownerDocument;
  element.style.setProperty('--tvl-seasonal-title-font', `"${family}", Georgia, serif`);
  element.style.setProperty('--tvl-seasonal-title-weight', String(font.weight));
  let requested = pending.get(doc);
  if (!requested) { requested = new Map(); pending.set(doc, requested); }
  const existing = requested.get(font.filename);
  if (existing) return existing;

  const face = doc.createElement('style');
  face.dataset.tvlSeasonalFont = font.filename;
  const url = resolveSeasonalFontUrl(font.filename, scriptSource, doc.baseURI);
  face.textContent = `@font-face{font-family:"${family}";src:url(${JSON.stringify(url)}) format("woff2");font-style:normal;font-weight:${font.weight};font-display:swap;}`;
  doc.head.append(face);
  // Some legacy clients have no FontFaceSet. They still use @font-face and the
  // fallback immediately; a rejected download must never hold up navigation.
  let loaded: Promise<void>;
  try {
    loaded = doc.fonts?.load ? doc.fonts.load(`${font.weight} 16px "${family}"`).then(() => undefined, () => undefined) : Promise.resolve();
  } catch { loaded = Promise.resolve(); }
  requested.set(font.filename, loaded);
  return loaded;
}
