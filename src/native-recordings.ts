type RecordingPage = 'recordings' | 'schedule' | 'series' | 'series-detail';

/** Skin Jellyfin's DVR controls in place. Native controllers retain their data,
 * permission checks, confirmations, focus management and input listeners. */
export class NativeRecordingsTheme {
  private enabled = false;
  private disposed = false;
  private hash = '';
  private selectedTab: number | undefined;

  constructor() {
    window.addEventListener('hashchange', this.refresh);
    window.addEventListener('popstate', this.refresh);
    document.addEventListener('tabchange', this.tabChanged, true);
  }

  update(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    this.refresh();
  }

  private toggle(name: string, enabled: boolean): void {
    if (document.body.classList.contains(name) !== enabled) document.body.classList.toggle(name, enabled);
  }

  private page(): RecordingPage | undefined {
    const [path, query = ''] = location.hash.replace(/^#[!/]*/, '').split('?');
    const params = new URLSearchParams(query);
    if (/^details\/?$/i.test(path) && params.get('seriesTimerId') && !params.has('id')) return 'series-detail';
    if (!/^livetv\/?$/i.test(path)) return;
    const tab = this.selectedTab ?? Number(params.get('tab') || '0');
    return tab === 3 ? 'recordings' : tab === 4 ? 'schedule' : tab === 5 ? 'series' : undefined;
  }

  private refresh = (): void => {
    if (this.disposed) return;
    if (this.hash !== location.hash) {
      this.hash = location.hash;
      this.selectedTab = undefined;
    }
    const page = this.enabled ? this.page() : undefined;
    // CSS selectors also cover pages/dialogs that Jellyfin inserts later.
    this.toggle('tvl-recordings-ready', this.enabled);
    this.toggle('tvl-recordings-native', !!page);
    if (page) {
      if (document.body.dataset.tvlRecordingPage !== page) document.body.dataset.tvlRecordingPage = page;
    } else if (document.body.hasAttribute('data-tvl-recording-page')) document.body.removeAttribute('data-tvl-recording-page');
  };

  private tabChanged = (event: Event): void => {
    if (!this.enabled || !/^#\/?livetv\/?(?:\?|$)/i.test(location.hash)) return;
    const target = event.target;
    // MainTabsManager switches these panels without changing the URL. Ignore
    // nested tabs and other plugins' tabchange events on the same page.
    if (!(target instanceof HTMLElement) || !target.closest('.skinHeader .headerTabs')) return;
    const tab = Number((event as CustomEvent).detail?.selectedTabIndex);
    if (!Number.isInteger(tab) || tab < 0 || tab > 5) return;
    if (this.hash !== location.hash) { this.hash = location.hash; this.selectedTab = undefined; }
    this.selectedTab = tab;
    this.refresh();
  };

  destroy(): void {
    if (this.disposed) return;
    this.update(false);
    this.disposed = true;
    window.removeEventListener('hashchange', this.refresh);
    window.removeEventListener('popstate', this.refresh);
    document.removeEventListener('tabchange', this.tabChanged, true);
  }
}
