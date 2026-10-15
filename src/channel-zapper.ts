import { el } from './dom';
import { isCinemaLayout } from './layout';
import { sameMediaId, visible, type ActivePlayback, type PlayerContext } from './player-context';
import type { Item, MediaApi } from './types';

type Direction = 1 | -1;
type Hop = { scope: string; route: string; from: ActivePlayback; channelId: string; cancelled: boolean; dispatched: boolean };
const scope = (api: MediaApi | null) => api ? JSON.stringify([api.serverId || '', api.userId || '']) : '';
const delay = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));
const channelId = (item: Item | null): string => item?.Type === 'TvChannel' ? item.Id : item?.Type === 'Program' ? item.ChannelId || '' : '';
const direction = (name: string | undefined): Direction | null => name?.toLowerCase() === 'channelup' ? 1 : name?.toLowerCase() === 'channeldown' ? -1 : null;
const keyDirection = (event: KeyboardEvent): Direction | null => direction(event.key) || direction(event.code) || (event.keyCode === 427 ? 1 : event.keyCode === 428 ? -1 : null);
const available = (item: Item) => item.Type === 'TvChannel' && !!item.Id && item.LocationType !== 'Virtual'
  && !item.IsMissing && !item.IsVirtualItem && !item.IsPlaceHolder && item.PlayAccess !== 'None';

/** Only handles channel events delivered by the host. PageUp/PageDown retain
 * Jellyfin's native chapter actions; LG does not document these as channel keys. */
export class ChannelZapper {
  private pending: Hop | null = null;
  private held = new Set<Direction>();
  private lastCommand = { direction: 0, time: 0 };
  private destroyed = false;
  private status = el('p', 'tvl-channel-status');
  private statusTimer: number | undefined;
  private stopContext: () => void;

  constructor(private context: PlayerContext, private getApi: () => MediaApi | null) {
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.stopContext = context.subscribe(this.sync);
    // Native keyboardNavigation is on window bubble; inputManager dispatches a
    // cancellable command before its queue-next/previous fallback. Capture both.
    window.addEventListener('keydown', this.keyDown, true);
    window.addEventListener('keyup', this.keyUp, true);
    window.addEventListener('command', this.command, true);
    window.addEventListener('hashchange', this.routeChange);
    window.addEventListener('popstate', this.routeChange);
    window.addEventListener('blur', this.blur);
  }
  private blocked(): boolean {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && (focused.isContentEditable || focused.closest('input, textarea, select, [role="textbox"]'))) return true;
    return Array.from(document.querySelectorAll<HTMLElement>('.dialogContainer .dialog.opened, dialog[open], [role="dialog"][aria-modal="true"], #tvEpisodePreview, #previewPopup'))
      .some(visible);
  }
  private active(): ActivePlayback | null {
    if (this.destroyed || !isCinemaLayout() || !/(?:^|\/)video\/?(?:\?|$)/i.test(location.hash.replace(/^#/, '') || location.pathname)) return null;
    const active = this.context.getSnapshot();
    return active && visible(active.video) && visible(active.osd) && !active.video.ended && !active.video.error ? active : null;
  }
  private eligible(): ActivePlayback | null {
    const active = this.active();
    return active && channelId(active.item) && !this.blocked() ? active : null;
  }
  private current(hop: Hop, beforeDispatch = false): boolean {
    if (this.destroyed || hop.cancelled || this.pending !== hop || scope(this.getApi()) !== hop.scope
      || location.hash !== hop.route || !isCinemaLayout() || this.blocked()) return false;
    const active = this.active();
    if (beforeDispatch) return !!active && active.key === hop.from.key && sameMediaId(channelId(active.item), hop.channelId);
    // Metadata can briefly be empty during native source replacement.
    return !active || !active.item || !!channelId(active.item);
  }
  private sync = (): void => {
    if (this.pending && !this.current(this.pending, !this.pending.dispatched)) this.pending.cancelled = true;
    if (!this.active() || this.blocked() || this.pending?.cancelled) this.status.remove();
  };
  private routeChange = (): void => {
    if (this.pending) this.pending.cancelled = true;
    this.held.clear(); this.status.remove();
  };
  private blur = (): void => { this.held.clear(); };
  private consume(event: Event): void { event.preventDefault(); event.stopImmediatePropagation(); }
  private keyDown = (event: KeyboardEvent): void => {
    const step = keyDirection(event);
    if (!step || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !this.eligible()) return;
    this.consume(event);
    if (event.repeat || this.held.has(step)) return;
    this.held.add(step); this.lastCommand = { direction: step, time: Date.now() };
    void this.hop(step);
  };
  private keyUp = (event: KeyboardEvent): void => {
    const step = keyDirection(event);
    if (step) this.held.delete(step);
  };
  private command = (event: Event): void => {
    const detail = (event as CustomEvent<{ command?: string; repeat?: boolean }>).detail;
    const step = direction(detail?.command);
    if (!step || event.defaultPrevented || !this.eligible()) return;
    this.consume(event);
    const now = Date.now(), repeated = detail?.repeat || this.held.has(step)
      || (this.lastCommand.direction === step && now - this.lastCommand.time < 400);
    // Command events have no release event. Require a quiet gap in a repeated
    // command stream, and keep tuning serialized even after that gap.
    this.lastCommand = { direction: step, time: now };
    if (!repeated) void this.hop(step);
  };
  private show(message: string, transient = false): void {
    window.clearTimeout(this.statusTimer);
    this.status.textContent = message;
    const fullscreen = document.fullscreenElement;
    const host = fullscreen instanceof HTMLElement && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    host.append(this.status);
    if (transient) this.statusTimer = window.setTimeout(() => this.status.remove(), 4000);
  }
  private async hop(step: Direction): Promise<void> {
    const from = this.eligible(), api = this.getApi();
    if (!from || !api || this.pending) return;
    const hop: Hop = { scope: scope(api), route: location.hash, from, channelId: channelId(from.item), cancelled: false, dispatched: false };
    this.pending = hop;
    try {
      const channels = (await api.getChannels()).filter(available).filter((item, index, all) => all.findIndex(other => sameMediaId(other.Id, item.Id)) === index);
      if (!this.current(hop, true)) return;
      const index = channels.findIndex(item => sameMediaId(item.Id, hop.channelId));
      if (index < 0 || channels.length < 2) { this.show('Nenhum outro canal disponível.', true); return; }
      // getChannels returns the permitted guide lineup in channel-number order.
      const target = channels[(index + step + channels.length) % channels.length];
      this.show(`Sintonizando ${target.ChannelNumber || target.Number || ''} ${target.Name}…`.replace('Sintonizando  ', 'Sintonizando '));
      hop.dispatched = true;
      await api.play(target, 0, () => this.current(hop, true));
      const started = Date.now();
      while (this.current(hop) && Date.now() - started < 20000) {
        this.context.refresh();
        const active = this.active();
        if (active && sameMediaId(channelId(active.item), target.Id) && !active.video.paused && active.video.readyState >= 2) {
          this.status.remove(); return;
        }
        if (active?.item && active.key !== from.key && !sameMediaId(channelId(active.item), target.Id)) { hop.cancelled = true; return; }
        await delay(100);
      }
      if (this.current(hop)) this.show('O canal não iniciou. Tente novamente.', true);
    } catch {
      if (this.current(hop)) this.show('Não foi possível mudar de canal. Tente novamente.', true);
    } finally {
      const stillCurrent = this.current(hop);
      if (this.pending === hop) this.pending = null;
      if (!stillCurrent) this.status.remove();
    }
  }
  destroy(): void {
    this.destroyed = true; if (this.pending) this.pending.cancelled = true;
    this.stopContext(); this.held.clear(); window.clearTimeout(this.statusTimer); this.status.remove();
    window.removeEventListener('keydown', this.keyDown, true); window.removeEventListener('keyup', this.keyUp, true);
    window.removeEventListener('command', this.command, true); window.removeEventListener('hashchange', this.routeChange);
    window.removeEventListener('popstate', this.routeChange); window.removeEventListener('blur', this.blur);
  }
}
