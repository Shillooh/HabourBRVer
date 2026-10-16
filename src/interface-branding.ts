import { el } from './dom';
import { defaultLoadingScreen, loadingScreenKey, maxLoadingSettingsBytes, parseLoadingScreen } from './loading-settings';
import { createLoadingScreenStore, subscribeLoadingScreen, type LoadingScreenStore } from './loading-settings-store';
import type { MediaApi } from './types';

const defaultTitle = defaultLoadingScreen().brandText;
let currentTitle = defaultTitle;
const loginKey = (server: string) => `jellyfin-cinema.interface-title.v1:${encodeURIComponent(server)}`;
function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function readLoginTitle(server: string): string {
  try {
    const raw = localStorage.getItem(loginKey(server));
    const title: unknown = raw && raw.length <= 400 ? JSON.parse(raw) : null;
    if (title === 'KiKoTV') return defaultTitle;
    return validTitle(title) ? title : defaultTitle;
  } catch { return defaultTitle; }
}
function rememberLoginTitle(server: string, title: string): void {
  try { localStorage.setItem(loginKey(server), JSON.stringify(title)); } catch { /* Branding remains usable without storage. */ }
}
function selectedServer(): string {
  const [path, query = ''] = location.hash.replace(/^#[!/]*/, '').split('?');
  // A server chooser has not selected a server. Never borrow the previous one's name.
  if (/^selectserver\/?$/i.test(path)) return location.origin;
  const params = new URLSearchParams(query);
  const routeServer = params.get('serverid') || params.get('serverId');
  if (routeServer) return routeServer;
  try {
    const client = (window as Window & { ApiClient?: { serverId?(): string } }).ApiClient;
    return client?.serverId?.() || location.origin;
  } catch { return location.origin; }
}
function renderLabel(node: HTMLElement, title: string): void {
  const effective = title === 'KiKoTV' ? defaultTitle : title;
  const value = effective ? `${node.dataset.tvlBrand || ''}${effective}` : '';
  if (node.textContent !== value) node.textContent = value;
  if (node.hidden !== !effective) node.hidden = !effective;
}

/** Explicit wordmark nodes only: media titles, form inputs and product errors
 * are never searched/replaced. textContent also keeps custom markup literal. */
export function brandLabel<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', prefix = ''): HTMLElementTagNameMap[K] {
  const node = el(tag, className); node.dataset.tvlBrand = prefix; renderLabel(node, currentTitle); return node;
}

export class InterfaceBranding {
  private key?: string;
  private server = '';
  private store?: LoadingScreenStore;
  private confirmed = false;
  private requested = false;
  private enabled = false;
  private disposed = false;
  private observer: MutationObserver;
  private unsubscribe: () => void;

  constructor() {
    const selector = '[data-tvl-brand], #loginPage > .padded-left';
    this.observer = new MutationObserver(records => {
      if (records.some(record => record.target instanceof Element && record.target.matches('[data-tvl-brand]')
        || Array.from(record.addedNodes).some(node => node instanceof Element && (node.matches(selector) || node.querySelector(selector))))) this.render();
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.unsubscribe = subscribeLoadingScreen((source, settings) => {
      if (this.disposed || !this.enabled || source.key !== this.key) return;
      // A newer confirmed read/save elsewhere supersedes our pending read.
      // Disposing it also prevents its late reply from overwriting local cache.
      if (source !== this.store) this.store?.destroy();
      this.confirmed = true; this.apply(settings.brandText);
      rememberLoginTitle(this.server, settings.brandText);
    });
    window.addEventListener('storage', this.onStorage);
  }

  update(api: MediaApi | null, enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    const server = api?.serverId || (api ? location.origin : selectedServer());
    const user = api && (api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous'));
    const key = enabled && api ? loadingScreenKey(server, user!) : undefined;
    if (this.key !== key || this.server !== server) {
      this.store?.destroy(); this.store = undefined;
      this.key = key; this.server = server; this.confirmed = false; this.requested = false;
      if (key && api) {
        this.store = createLoadingScreenStore(api);
        this.apply(this.store.cached.brandText);
        // This cache contains only previously confirmed settings, never drafts.
        try {
          const raw = localStorage.getItem(key);
          if (raw && raw.length <= maxLoadingSettingsBytes) rememberLoginTitle(server, parseLoadingScreen(JSON.parse(raw)).brandText);
        } catch { /* Unknown account settings must not replace the login cache. */ }
      } else this.apply(enabled ? readLoginTitle(server) : defaultTitle);
    } else if (!enabled) this.apply(defaultTitle);
    else if (!api) this.apply(readLoginTitle(server));
    // Home and the loading editor already fetch these same settings. Subscribe
    // to their results; a direct visit elsewhere needs one background read.
    const [path, query = ''] = location.hash.replace(/^#[!/]*/, '').split('?');
    const ownedRead = /^home\/?$/i.test(path) && !new URLSearchParams(query).has('cinemaProvider')
      || /^mypreferencesmenu\/?$/i.test(path) && new URLSearchParams(query).get('cinemaLoading') === '1';
    if (key && this.store && !this.confirmed && !this.requested && !ownedRead) {
      this.requested = true;
      void this.store.load().catch(() => { /* Retain this account's cached title while offline. */ });
    }
    this.render();
  }

  private apply(title: string): void {
    const effective = (title === 'KiKoTV' || !title) ? defaultTitle : title;
    currentTitle = effective;
    this.render();
  }
  private render(): void {
    if (this.disposed) return;
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-tvl-brand]'))) renderLabel(node, currentTitle);
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('#loginPage > .padded-left'))) {
      if (this.enabled) {
        if (node.dataset.tvlTitle !== currentTitle) node.dataset.tvlTitle = currentTitle;
      } else node.removeAttribute('data-tvl-title');
    }
  }
  private onStorage = (event: StorageEvent): void => {
    if (this.disposed || !this.enabled) return;
    if (this.key && event.key === this.key && event.newValue) {
      try {
        if (event.newValue.length > maxLoadingSettingsBytes) return;
        const title = parseLoadingScreen(JSON.parse(event.newValue)).brandText;
        this.store?.destroy(); this.confirmed = true; this.apply(title); rememberLoginTitle(this.server, title);
      } catch { /* Ignore malformed cross-tab cache changes. */ }
    } else if (!this.key && event.key === loginKey(this.server)) this.apply(readLoginTitle(this.server));
  };
  destroy(): void {
    this.store?.destroy(); this.unsubscribe(); this.observer.disconnect(); window.removeEventListener('storage', this.onStorage);
    this.enabled = false; currentTitle = defaultTitle; this.render(); this.disposed = true;
  }
}
