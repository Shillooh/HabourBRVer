import type { Item, MediaApi } from './types';
import { button } from './dom';
import { currentUserAccount, isCurrentUserAdministrator, sameUserAccount, type CurrentUserAccount } from './current-user-policy';
import { isDesktopLayout } from './layout';

type NativeContainer = HTMLDivElement & { attachedCallback?: () => void; notifyRefreshNeeded?: () => void };
type NativeDialog = HTMLElement & { close?: () => void };
const sameId = (left: string | undefined | null, right: string) => !!left && left.replace(/-/g, '').toLowerCase() === right.replace(/-/g, '').toLowerCase();
const supported = new Set(['Movie', 'Series', 'Season', 'Episode', 'MusicAlbum', 'MusicArtist', 'Audio', 'Playlist', 'BoxSet', 'Video', 'Recording', 'MusicVideo']);
const dialogs = () => Array.from(document.querySelectorAll<NativeDialog>('.dialogContainer .dialog, dialog'));

/** Use the native items-container shortcut boundary, not private webpack IDs.
 * Jellyfin's shortcuts.js resolves the real item and opens itemContextMenu;
 * its editors, refresh choices and confirmation dialogs retain their own APIs.
 * Audited jellyfin-web v12.0/v10.11.0 components/shortcuts.js. */
export async function dispatchNativeItemMenu(item: Item, serverId: string, anchor: HTMLElement,
  current: () => boolean, updated: () => void): Promise<() => void> {
  if (!current()) throw new DOMException('Esta página de mídia foi fechada.', 'AbortError');
  if (!item.Id || !serverId || !supported.has(item.Type || '')) throw new Error('Este item não possui menu de gerenciamento.');
  const create = document.createElement as unknown as (tag: string, extension: string) => NativeContainer;
  let host: NativeContainer;
  try { host = create.call(document, 'div', 'emby-itemscontainer'); }
  catch { host = document.createElement('div'); }
  host.setAttribute('is', 'emby-itemscontainer'); host.dataset.tvlAdminBridge = '';
  host.setAttribute('aria-hidden', 'true'); host.dataset.contextmenu = 'false'; host.dataset.multiselect = 'false';
  const bounds = anchor.getBoundingClientRect();
  Object.assign(host.style, { position: 'fixed', top: `${bounds.top}px`, left: `${bounds.left}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, opacity: '0', pointerEvents: 'none' });
  const card = document.createElement('button'); card.type = 'button'; card.tabIndex = -1; card.className = 'itemAction';
  card.dataset.id = item.Id; card.dataset.type = item.Type || ''; card.dataset.serverid = serverId;
  card.dataset.isfolder = String(!!item.IsFolder || ['Series', 'Season', 'MusicAlbum', 'MusicArtist', 'Playlist', 'BoxSet'].includes(item.Type || ''));
  if (item.MediaType) card.dataset.mediatype = item.MediaType;
  card.dataset.action = 'menu'; card.dataset.playoptions = 'false';
  card.style.width = '100%'; card.style.height = '100%'; host.append(card); document.body.append(host);
  const remove = () => host.remove();
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!current()) throw new DOMException('Esta página de mídia foi fechada.', 'AbortError');
    // The native menu calls this after metadata/images/identify edits. The
    // bridge owns no media results, so refresh only its current themed view.
    host.notifyRefreshNeeded = () => { if (current()) updated(); };
    const dispatch = () => { const event = new MouseEvent('click', { bubbles: true, cancelable: true }); card.dispatchEvent(event); return event.defaultPrevented; };
    let handled = false;
    if (typeof host.attachedCallback === 'function') {
      host.addEventListener('click', event => event.stopPropagation()); handled = dispatch();
    } else {
      const nativeHosts = Array.from(document.querySelectorAll<HTMLElement>('.itemsContainer')).filter(node => node !== host
        && !node.closest('#tv-layout, .tvl-home-collection-row, .tvl-home-editor, [data-tvl-admin-bridge], [data-tvl-playback-bridge]')
        && Array.from(node.querySelectorAll<HTMLElement>('[data-id][data-serverid]')).some(card => sameId(card.dataset.serverid, serverId)));
      for (const native of nativeHosts) {
        if (!current()) throw new DOMException('Esta página de mídia foi fechada.', 'AbortError');
        native.append(host);
        const stop = (event: Event) => event.stopPropagation(); native.addEventListener('click', stop);
        try { handled = dispatch(); } finally { native.removeEventListener('click', stop); }
        if (handled) break;
      }
    }
    if (!handled) throw new Error('O menu nativo do item não está disponível.');
    return remove;
  } catch (error) { remove(); throw error; }
}

/** A view-scoped gate. Neither cached policy nor an outgoing account can show
 * management actions, and clicking always checks the current policy again. */
export class AdminItemActions {
  private account: CurrentUserAccount | null = currentUserAccount();
  private buttons = new Set<HTMLButtonElement>();
  private allowed = false;
  private disposed = false;
  private checking = false;
  private revision = 0;
  private opening = false;
  private pendingControl?: HTMLButtonElement;
  private bridge?: () => void;
  private nativeDialogs = new Set<NativeDialog>();
  private beforeDialogs = new Set<NativeDialog>();
  private observer: MutationObserver;
  private dialogObserver?: MutationObserver;
  private openTimer?: number;
  private cleanupTimer?: number;

  constructor(private api: MediaApi, private root: HTMLElement, private options: {
    openNative?: (item: Item) => void; updated?: () => void; announce?: (message: string) => void
  } = {}) {
    this.observer = new MutationObserver(() => {
      if (!this.current()) { this.allowed = false; this.sync(); this.closeNative(); }
      else if (!this.allowed) void this.check();
    });
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    this.observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('focus', this.onFocus);
    void this.check();
  }
  private current(): boolean {
    return !this.disposed && isDesktopLayout() && sameUserAccount(this.account)
      && (!this.api.userId || sameId(this.api.userId, this.account!.userId))
      && (!this.api.serverId || sameId(this.api.serverId, this.account!.serverId));
  }
  private onFocus = (): void => { void this.check(); };
  private sync(): void {
    for (const control of this.buttons) {
      if (!control.isConnected && this.root.isConnected) { this.buttons.delete(control); continue; }
      control.hidden = !this.allowed || !this.current();
    }
  }
  private async check(): Promise<boolean> {
    if (this.checking || !this.current()) { if (!this.current()) { this.allowed = false; this.sync(); } return false; }
    this.checking = true;
    try {
      this.allowed = await isCurrentUserAdministrator(this.account) && this.current(); this.sync();
      if (!this.allowed) this.closeNative();
      return this.allowed;
    }
    finally { this.checking = false; }
  }
  button(item: Item, label = 'Mais'): HTMLButtonElement {
    const control = button(label, '', 'tvl-admin-item', () => { void this.open(item, control); });
    control.prepend(document.createTextNode('⋯ '));
    control.setAttribute('aria-label', `Gerenciar ${item.Name}`); control.setAttribute('aria-haspopup', 'dialog');
    control.dataset.adminItem = item.Id; control.dataset.focusId = `manage:${item.Id}`;
    control.hidden = !supported.has(item.Type || '') || !this.allowed || !this.current();
    if (supported.has(item.Type || '')) this.buttons.add(control);
    return control;
  }
  private async open(item: Item, control: HTMLButtonElement): Promise<void> {
    if (this.opening || !this.current() || !control.isConnected) return;
    this.closeNative();
    this.opening = true; this.pendingControl = control; control.disabled = true; control.setAttribute('aria-busy', 'true');
    const revision = ++this.revision;
    const current = () => revision === this.revision && this.current() && control.isConnected && this.root.isConnected;
    try {
      if (!await isCurrentUserAdministrator(this.account) || !current()) { this.allowed = false; this.sync(); return; }
      this.beforeDialogs = new Set(dialogs());
      this.dialogObserver = new MutationObserver(() => this.trackDialogs());
      this.dialogObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open'] });
      this.bridge = await dispatchNativeItemMenu(item, this.api.serverId || this.account!.serverId, control, current, () => this.options.updated?.());
      this.trackDialogs();
      // Handled only confirms dispatch. If this client cannot load the native
      // menu, reveal its original item page instead of leaving a dead control.
      if (!this.nativeDialogs.size) this.openTimer = window.setTimeout(() => { if (current() && !this.nativeDialogs.size) this.fallback(item, false); }, 2_000);
    } catch (error) {
      if (current() && !(error instanceof DOMException && error.name === 'AbortError')) this.fallback(item);
    } finally { if (this.nativeDialogs.size || !this.dialogObserver) this.releaseOpening(); }
  }
  private releaseOpening(): void {
    if (this.pendingControl) { this.pendingControl.disabled = false; this.pendingControl.removeAttribute('aria-busy'); }
    this.pendingControl = undefined; this.opening = false;
  }
  private trackDialogs(): void {
    for (const dialog of dialogs()) if (!this.beforeDialogs.has(dialog)) {
      this.nativeDialogs.add(dialog);
      if (!dialog.classList.contains('tvl-admin-native-dialog')) dialog.classList.add('tvl-admin-native-dialog');
      if (!this.current()) this.closeDialog(dialog);
    }
    for (const dialog of this.nativeDialogs) if (!dialog.isConnected) this.nativeDialogs.delete(dialog);
    if (this.nativeDialogs.size) {
      this.releaseOpening();
      window.clearTimeout(this.openTimer); window.clearTimeout(this.cleanupTimer);
      if (!document.body.classList.contains('tvl-admin-native')) document.body.classList.add('tvl-admin-native');
    } else if (document.body.classList.contains('tvl-admin-native')) {
      // Native action sheets close before asynchronously loading their editor.
      // Keep the handover themed, then release the bridge after that flow ends.
      window.clearTimeout(this.cleanupTimer);
      this.cleanupTimer = window.setTimeout(() => { if (!this.nativeDialogs.size) this.closeNative(); }, 2_000);
    }
  }
  private closeDialog(dialog: NativeDialog): void {
    if (!dialog.isConnected) return;
    const close = dialog.querySelector<HTMLElement>('.btnCancel, .btnCloseActionSheet, .btnClose, .btnCloseDialog');
    if (close) close.click();
    else if (typeof dialog.close === 'function') dialog.close();
    else {
      // Desktop action sheets have no Cancel button. Their native backdrop
      // handler runs dialogHelper.close, including history/focus cleanup.
      const backdrop = dialog.closest('.dialogContainer');
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  }
  private closeNative(): void {
    this.releaseOpening();
    window.clearTimeout(this.openTimer); window.clearTimeout(this.cleanupTimer); this.dialogObserver?.disconnect(); this.dialogObserver = undefined;
    for (const dialog of this.nativeDialogs) this.closeDialog(dialog);
    this.nativeDialogs.clear(); this.bridge?.(); this.bridge = undefined;
    if (document.body.classList.contains('tvl-admin-native')) document.body.classList.remove('tvl-admin-native');
  }
  private fallback(item: Item, openMenu = true): void {
    this.closeNative();
    if (this.current() && this.options.openNative) {
      const account = this.account!;
      this.options.openNative(item);
      // Original detail loading can lag behind the route. Match the item before
      // opening More; never click a cached page's previous-item button.
      if (openMenu) void openOriginalItemMenu(item, account);
    }
    else this.options.announce?.('O menu de itens do Jellyfin não está disponível neste cliente.');
  }
  destroy(): void {
    this.disposed = true; this.revision++; this.observer.disconnect(); window.removeEventListener('focus', this.onFocus);
    this.closeNative(); this.buttons.clear();
  }
}

async function openOriginalItemMenu(item: Item, account: CurrentUserAccount): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isDesktopLayout() || !sameUserAccount(account)) return;
    const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
    if (path !== 'details' || !sameId(new URLSearchParams(query).get('id'), item.Id)) return;
    const page = Array.from(document.querySelectorAll<HTMLElement>('.itemDetailPage')).find(page =>
      !page.closest('.hide,[hidden],.tvl-native-hidden') && Array.from(page.querySelectorAll<HTMLElement>('.btnUserRating[data-id],.btnPlaystate[data-id]')).some(control => sameId(control.dataset.id, item.Id)));
    const more = page?.querySelector<HTMLButtonElement>('.btnMoreCommands:not(.hide):not([hidden]):not(:disabled)');
    if (more) { more.click(); return; }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}
