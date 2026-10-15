// Capture the injected bundle URL while it executes. This preserves Jellyfin's
// base path and the Pages project path without sending art requests elsewhere.
const scriptSource = typeof document !== 'undefined'
  ? (document.currentScript as HTMLScriptElement | null)?.src || '' : '';
const tvArtwork = new Set([
  'halloween-photoreal.webp', 'halloween-nightmare.webp', 'christmas-photoreal.webp',
  'halloween-nightmare-door.webp', 'halloween-nightmare-frame.webp',
  'christmas-photoreal-door.webp', 'christmas-photoreal-frame.webp',
]);
export function resolveSeasonalAssetUrl(filename: string, script: string, base: string, tv = false): string {
  // Smaller TV textures reduce both image decoding and GPU memory. Keep the
  // original artwork available to desktop clients and existing cached URLs.
  if (tv && tvArtwork.has(filename)) filename = filename.replace(/\.webp$/, '-tv.webp');
  const source = new URL(script || 'dist/jellyfin-tv-layout.js', base);
  const injected = /\/TvItemLayout\/ClientScript$/i.test(source.pathname);
  const url = new URL(injected ? `SeasonalAsset/${filename}` : `../assets/seasonal/${filename}`, source);
  url.searchParams.set('v', source.searchParams.get('v') || '1.0.0.0');
  return url.href;
}
export function seasonalAssetUrl(filename: string): string {
  const tv = document.documentElement.classList.contains('layout-tv') || document.body?.classList.contains('layout-tv');
  return resolveSeasonalAssetUrl(filename, scriptSource, document.baseURI, tv);
}
