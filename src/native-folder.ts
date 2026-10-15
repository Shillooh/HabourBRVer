import { el } from './dom';

/** Older recording libraries can remain ordinary mixed-content folders after
 * DVR moves to another library. Skin those native lists without relabelling
 * their contents as the current DVR or replacing their navigation/actions. */
export class NativeFolderTheme {
  private scope: string | null = null;
  private enabled = false;
  private folder?: { id: string; name: string; hash: string };
  private host?: HTMLElement;
  private heading?: HTMLElement;
  private observer?: MutationObserver;

  constructor() {
    window.addEventListener('hashchange', this.routeChanged);
    window.addEventListener('popstate', this.routeChanged);
  }

  update(enabled: boolean, scope: string | null): void {
    if (!enabled || scope !== this.scope) this.clear();
    this.enabled = enabled; this.scope = scope;
    this.routeChanged();
  }

  show(id: string, name: string): void {
    if (!this.enabled) return;
    this.clear();
    this.folder = { id, name, hash: location.hash };
    this.observer = new MutationObserver(this.sync);
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-parentid', 'class', 'hidden', 'style'] });
    this.sync();
  }

  private releaseHost(): void {
    this.heading?.remove(); this.heading = undefined;
    this.host?.classList.remove('tvl-folder-page'); this.host = undefined;
    if (document.body.classList.contains('tvl-folder-native')) document.body.classList.remove('tvl-folder-native');
  }

  private sync = (): void => {
    if (!this.folder || this.folder.hash !== location.hash) return;
    const host = Array.from(document.querySelectorAll<HTMLElement>('.itemsContainer[data-parentid]'))
      .filter(node => node.dataset.parentid === this.folder!.id)
      .map(node => node.closest<HTMLElement>('.libraryPage'))
      .find((page): page is HTMLElement => !!page && !page.closest('.hide,[hidden],.tvl-native-hidden')
        && !!page.getClientRects().length && getComputedStyle(page).display !== 'none' && getComputedStyle(page).visibility !== 'hidden');
    if (host === this.host && this.heading?.isConnected) return;
    this.releaseHost();
    if (!host) return;
    this.host = host;
    host.classList.add('tvl-folder-page'); document.body.classList.add('tvl-folder-native');
    const heading = el('header', 'tvl-folder-heading');
    heading.append(el('p', 'tvl-folder-eyebrow', 'BIBLIOTECA'), el('h1', '', this.folder.name));
    this.heading = heading; host.prepend(heading);
  };

  private routeChanged = (): void => {
    if (this.folder && this.folder.hash !== location.hash) this.clear();
  };

  clear(): void {
    this.observer?.disconnect(); this.observer = undefined;
    this.folder = undefined; this.releaseHost();
  }

  destroy(): void {
    this.clear(); this.enabled = false;
    window.removeEventListener('hashchange', this.routeChanged);
    window.removeEventListener('popstate', this.routeChanged);
  }
}
