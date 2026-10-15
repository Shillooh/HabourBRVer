import { el } from './dom';
import { providerBrand } from './provider-brands';
import type { ProviderHomeConfig } from './provider-settings';

export function providerAppearance(config: ProviderHomeConfig): { id: string; name: string; logo: string; accent: string } {
  const brand = providerBrand(config.id);
  let customLogo = '';
  // Drafts may be incomplete or invalid: never request a credential-bearing URL
  // just because it has been typed into the editor's live preview.
  if (config.logoUrl.length <= 2048 && /^https?:\/\//i.test(config.logoUrl) && !/\s/.test(config.logoUrl)) {
    try { const url = new URL(config.logoUrl); if (url.hostname && !url.username && !url.password) customLogo = url.href; } catch { /* Show the local fallback. */ }
  }
  return { id: config.id, name: config.name.trim() || brand?.name || 'New service',
    logo: config.logoUrl ? customLogo : brand?.logo || '', accent: /^#[0-9a-f]{6}$/i.test(config.accent) ? config.accent : '#e50914' };
}

/** Keep both custom services and unavailable remote artwork recognisable. */
export function providerLogo(config: ProviderHomeConfig, className = ''): HTMLElement {
  const appearance = providerAppearance(config);
  const mark = el('span', `tvl-provider-logo ${className}`.trim());
  mark.setAttribute('aria-hidden', 'true');
  const fallback = el('span', 'tvl-provider-monogram', appearance.name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase());
  mark.append(fallback);
  if (appearance.logo) {
    const image = el('img'); image.alt = ''; image.draggable = false;
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { fallback.hidden = true; image.hidden = false; });
    image.addEventListener('error', () => { image.remove(); fallback.hidden = false; });
    image.hidden = true; image.src = appearance.logo; mark.append(image);
  }
  return mark;
}
