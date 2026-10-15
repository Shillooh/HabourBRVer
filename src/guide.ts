import type { Item, MediaApi } from './types';
import { button, el, icon, replace } from './dom';
import { isLive, plainText, playable, time } from './utils';
import { GUIDE_DURATION, GUIDE_MINUTE, guideSlots, nearestGuideSlot, type GuideSlot } from './guide-layout';

type GuideRow = { channel: Item; programs: Item[]; state: 'loading' | 'ready' | 'error'; request: number };
type Selection = { channelId: string; programId?: string };
type GuideOptions = { currentChannel?: Item; onPlay: (channel: Item) => void; onStatus: (message: string) => void; isCurrent: () => boolean };
const BATCH_SIZE = 16;
const WORKERS = 4;

export class HorizontalGuide {
  readonly element = el('main', 'tvl-epg');
  private detail = el('section', 'tvl-epg-detail');
  private scroll = el('div', 'tvl-epg-scroll');
  private footer = el('div', 'tvl-epg-footer');
  private rows: GuideRow[] = [];
  private channels: Item[] = [];
  private selection: Selection;
  private windowStart = Math.floor(Date.now() / (30 * GUIDE_MINUTE)) * 30 * GUIDE_MINUTE;
  private disposed = false;
  private revision = 0;
  private busy = false;
  private anchorTime = Date.now();
  private layoutObserver?: ResizeObserver;
  private contentScroller?: HTMLElement;
  private artworkScroll = () => this.setArtworkHeight();
  private resize = () => this.setWidth();

  constructor(private api: MediaApi, private options: GuideOptions) {
    this.selection = {channelId: options.currentChannel?.Id || ''};
    this.element.setAttribute('aria-label', 'Guia de programação da TV ao vivo');
    this.detail.setAttribute('aria-label', 'Programa selecionado');
    this.scroll.setAttribute('aria-label', 'Canais e grade de programação');
    this.element.append(this.detail, this.scroll, this.footer);
    window.addEventListener('resize', this.resize);
    if (typeof ResizeObserver !== 'undefined') {
      // The fixed artwork is outside layout, so changing its height cannot
      // resize these observed boxes or feed back into the observer.
      this.layoutObserver = new ResizeObserver(this.resize);
      for (const node of [this.element, this.detail, this.scroll]) this.layoutObserver.observe(node);
    }
  }

  async load(): Promise<void> {
    const header = this.element.previousElementSibling;
    if (header) this.layoutObserver?.observe(header);
    const scroller = this.element.parentElement || undefined;
    if (this.contentScroller !== scroller) {
      this.contentScroller?.removeEventListener('scroll', this.artworkScroll);
      this.contentScroller = scroller;
      this.contentScroller?.addEventListener('scroll', this.artworkScroll, {passive: true});
    }
    const revision = ++this.revision;
    this.busy = true;
    replace(this.detail, el('p', 'tvl-epg-message', 'Carregando seus canais e grade de programação…'));
    replace(this.scroll); replace(this.footer);
    try {
      const channels = await this.api.getChannels();
      if (!this.valid(revision)) return;
      this.channels = channels;
      // An optional channel anchor keeps it in the first bounded batch.
      // The main guide retains Jellyfin's channel order without an anchor.
      const current = channels.find(channel => channel.Id === this.options.currentChannel?.Id);
      const first = current ? [current, ...channels.filter(channel => channel.Id !== current.Id)] : channels;
      this.channels = first;
      this.rows = first.slice(0, BATCH_SIZE).map(channel => ({channel, programs: [], state: 'loading', request: 0}));
      if (!this.rows.length) {
        replace(this.detail, el('h2', '', 'Nenhum canal disponível'), el('p', 'tvl-epg-message', 'Verifique a configuração de TV ao Vivo no Jellyfin.'));
        this.busy = false; return;
      }
      this.selection = {channelId: this.rows[0]!.channel.Id};
      this.render();
      await this.fetchRows(this.rows, revision);
      if (!this.valid(revision)) return;
      this.busy = false;
      // Channel controls work while schedules load; keep any choice made then.
      const shouldFocus = document.activeElement === document.body || this.element.contains(document.activeElement);
      const selected = this.rows.find(row => row.channel.Id === this.selection.channelId) || this.rows[0]!;
      const currentSlot = nearestGuideSlot(this.slots(selected), Date.now());
      this.selection = {channelId: selected.channel.Id, programId: currentSlot?.item.Id};
      this.render();
      if (shouldFocus) this.focusSelection();
    } catch {
      if (!this.valid(revision)) return;
      this.busy = false;
      replace(this.detail, el('h2', '', 'Canais indisponíveis'), el('p', 'tvl-epg-message', 'Tente novamente para carregar o guia de TV.'),
        button('Tentar novamente', '', 'tvl-epg-retry', () => { void this.load(); }));
      this.detail.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
    }
  }

  async refresh(): Promise<void> {
    if (!this.valid() || this.busy || !this.rows.length) return;
    this.busy = true;
    const revision = this.revision;
    await this.fetchRows(this.rows, revision, true);
    if (!this.valid(revision)) return;
    this.busy = false;
    this.rebaseWindow();
    this.render();
  }

  move(direction: string): boolean {
    const focused = document.activeElement as HTMLElement | null;
    if (!focused || !this.element.contains(focused)) return false;
    const control = focused.closest<HTMLElement>('[data-epg-row]');
    if (!control) {
      if (direction === 'up' && focused.classList.contains('tvl-epg-more')) {
        const last = this.rows[this.rows.length - 1];
        if (last) this.focusRow(last, this.anchorTime);
        return true;
      }
      return false;
    }
    const rowIndex = this.rows.findIndex(row => row.channel.Id === control.dataset.epgRow);
    const row = this.rows[rowIndex];
    if (!row) return false;
    const slots = this.slots(row);
    const slotIndex = slots.findIndex(slot => slot.item.Id === focused.dataset.program);
    if (direction === 'left') {
      if (slotIndex > 0) this.focusProgram(row, slots[slotIndex - 1]!);
      else if (slotIndex === 0 || focused.classList.contains('tvl-epg-retry')) this.focusChannel(row);
      return true;
    }
    if (direction === 'right') {
      const next = slotIndex < 0 ? nearestGuideSlot(slots, this.anchorTime) : slots[slotIndex + 1];
      if (next) this.focusProgram(row, next);
      else if (focused.classList.contains('tvl-epg-channel') && !slots.length) {
        const retry = Array.from(this.scroll.querySelectorAll<HTMLButtonElement>('.tvl-epg-retry')).find(node=>node.dataset.epgRow===row.channel.Id);
        retry?.focus({preventScroll:true});if(retry)this.keepVisible(retry);
      }
      return true;
    }
    if (direction === 'up' || direction === 'down') {
      const adjacent = this.rows[rowIndex + (direction === 'up' ? -1 : 1)];
      if (adjacent) {
        if (focused.classList.contains('tvl-epg-channel')) this.focusChannel(adjacent);
        else this.focusRow(adjacent, this.anchorTime);
        return true;
      }
      if (direction === 'down') {
        this.footer.querySelector<HTMLButtonElement>('button')?.focus({preventScroll: true});
        return true;
      }
      return false;
    }
    return false;
  }

  focus(): void { if (this.valid()) this.focusSelection(); }

  destroy(): void { this.disposed = true; this.revision++; this.layoutObserver?.disconnect(); this.contentScroller?.removeEventListener('scroll', this.artworkScroll); window.removeEventListener('resize', this.resize); }

  private valid(revision = this.revision): boolean { return !this.disposed && revision === this.revision && this.options.isCurrent(); }
  private slots(row: GuideRow): GuideSlot[] { return guideSlots(row.programs, this.windowStart); }

  private async fetchRows(rows: GuideRow[], revision: number, preserve = false): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({length: Math.min(WORKERS, rows.length)}, async () => {
      while (next < rows.length && this.valid(revision)) {
        const row = rows[next++]!;
        const request = ++row.request;
        try {
          const programs = await this.api.getPrograms(row.channel.Id);
          if (!this.valid(revision) || request !== row.request) continue;
          row.programs = programs.length ? programs : row.channel.CurrentProgram ? [row.channel.CurrentProgram] : [];
          row.state = 'ready';
        } catch {
          if (!this.valid(revision) || request !== row.request) continue;
          if (!preserve || !row.programs.length) row.state = 'error';
        }
      }
    }));
  }

  private rebaseWindow(): void {
    const start=Math.floor(Date.now() / (30 * GUIDE_MINUTE)) * 30 * GUIDE_MINUTE;
    if(start===this.windowStart)return;
    const width=this.scroll.querySelector<HTMLElement>('.tvl-epg-time-track')?.offsetWidth || 0;
    const offset=(start-this.windowStart)/GUIDE_DURATION*width;
    this.windowStart=start;
    this.scroll.scrollLeft=Math.max(0,this.scroll.scrollLeft-offset);
  }

  private render(): void {
    if (!this.valid()) return;
    const active = document.activeElement as HTMLElement | null;
    const focusedProgram = active?.dataset.program;
    const focusedChannel = active?.dataset.epgRow;
    const focusedMore = active?.classList.contains('tvl-epg-more');
    const scrollLeft = this.scroll.scrollLeft, scrollTop = this.scroll.scrollTop;
    const grid = el('div', 'tvl-epg-grid');
    const header = el('div', 'tvl-epg-timeline');
    const corner = el('div', 'tvl-epg-corner', 'CANAL');
    const timeline = el('div', 'tvl-epg-time-track');
    for (let halfHour = 0; halfHour < 48; halfHour++) {
      const at = this.windowStart + halfHour * 30 * GUIDE_MINUTE;
      const label = el('span', 'tvl-epg-time', time(new Date(at).toISOString()));
      label.style.left = `${halfHour / 48 * 100}%`;
      if (new Date(at).getDate() !== new Date(this.windowStart).getDate() && new Date(at).getHours() === 0 && new Date(at).getMinutes() === 0) label.textContent = `Amanhã ${label.textContent}`;
      timeline.append(label);
    }
    const now = this.nowMarker(true); if (now) timeline.append(now);
    header.append(corner, timeline); grid.append(header);
    for (const row of this.rows) {
      const rowElement = el('div', 'tvl-epg-row'); rowElement.dataset.channelRow = row.channel.Id;
      const channel = el('button', 'tvl-epg-channel'); channel.type = 'button';
      channel.dataset.channel = row.channel.Id; channel.dataset.epgRow = row.channel.Id;
      channel.setAttribute('aria-label', `${row.channel.ChannelNumber || row.channel.Number || ''} ${row.channel.Name}`.trim());
      channel.append(el('span', 'tvl-epg-channel-number', row.channel.ChannelNumber || row.channel.Number || '•'), el('span', 'tvl-epg-channel-name', row.channel.Name));
      channel.addEventListener('focus', () => this.select(row));
      channel.addEventListener('click', () => {
        if (this.valid() && playable(row.channel)) this.options.onPlay(row.channel);
      });
      const track = el('div', 'tvl-epg-track');
      const slots = this.slots(row);
      for (const slot of slots) {
        const live = isLive(slot.item);
        const card = el('button', `tvl-epg-program${live ? ' tvl-epg-program-live' : ''}`); card.type = 'button';
        card.dataset.program = slot.item.Id; card.dataset.epgRow = row.channel.Id;
        card.style.left = `${slot.left}%`; card.style.width = `${slot.width}%`;
        card.setAttribute('aria-label', `${row.channel.Name}: ${slot.item.Name}, ${time(slot.item.StartDate)} às ${time(slot.item.EndDate)}${live ? ', ao vivo agora' : ', a seguir'}`);
        const timing = el('span', 'tvl-epg-program-time', `${time(slot.item.StartDate)} – ${time(slot.item.EndDate)}`);
        if (live) timing.prepend(el('span', 'tvl-epg-live-badge', 'AO VIVO'));
        card.append(timing, el('span', 'tvl-epg-program-name', slot.item.Name));
        card.addEventListener('focus', () => { this.select(row, slot); this.keepVisible(card); });
        card.addEventListener('click', () => {
          if (!this.valid()) return;
          this.select(row, slot); this.keepVisible(card);
          // Check the time at activation; a programme may have ended since render.
          if (isLive(slot.item) && playable(row.channel)) this.options.onPlay(row.channel);
        });
        track.append(card);
      }
      if (!slots.length) {
        const message = el('div', 'tvl-epg-row-message', row.state === 'loading' ? 'Carregando programação…' : row.state === 'error' ? 'Programação indisponível' : 'Sem informações sobre o programa');
        if (row.state === 'error') {
          const retry = button('Tentar novamente', '', 'tvl-epg-retry', () => { void this.retryRow(row); }); retry.dataset.epgRow = row.channel.Id; message.append(retry);
        }
        track.append(message);
      }
      const marker = this.nowMarker(); if (marker) track.append(marker);
      rowElement.append(channel, track); grid.append(rowElement);
    }
    replace(this.scroll, grid);
    this.setWidth();
    this.scroll.scrollLeft = scrollLeft; this.scroll.scrollTop = scrollTop;
    const selected = this.rows.find(row => row.channel.Id === this.selection.channelId) || this.rows[0];
    if (selected) {
      const slot = this.slots(selected).find(slot => slot.item.Id === this.selection.programId);
      this.select(selected, slot);
    }
    replace(this.footer);
    if (this.rows.length < this.channels.length) {
      const more = button(this.busy ? 'Carregando canais…' : 'Mais canais', '', 'tvl-epg-more', () => { void this.moreChannels(); });
      more.disabled = this.busy; this.footer.append(more);
    }
    if (focusedChannel) {
      const restored = Array.from(this.scroll.querySelectorAll<HTMLElement>('[data-epg-row]')).find(node => node.dataset.epgRow === focusedChannel && (focusedProgram ? node.dataset.program === focusedProgram : node.classList.contains('tvl-epg-channel')));
      if (restored) restored.focus({preventScroll: true});
      else this.focusSelection();
    } else if (focusedMore) {
      const more = this.footer.querySelector<HTMLButtonElement>('button:not(:disabled)');
      if (more) more.focus({preventScroll:true});
      else if(this.rows.length) this.focusChannel(this.rows[this.rows.length-1]!);
    }
  }

  private select(row: GuideRow, slot?: GuideSlot): void {
    this.selection = {channelId: row.channel.Id, programId: slot?.item.Id};
    this.scroll.querySelectorAll<HTMLElement>('.tvl-epg-program, .tvl-epg-channel').forEach(node => {
      const selected = slot ? node.dataset.program === slot.item.Id && node.dataset.epgRow === row.channel.Id : node.dataset.channel === row.channel.Id;
      node.setAttribute('aria-pressed', String(selected));
    });
    const programme = slot?.item || row.programs.find(program => isLive(program)) || row.channel.CurrentProgram;
    const live = programme && isLive(programme);
    const artwork = this.programmeArtwork(programme, row.channel);
    const copy = el('div', 'tvl-epg-detail-copy');
    const meta = el('div', 'tvl-epg-detail-meta');
    if (programme) meta.append(el('span', live ? 'tvl-epg-detail-badge tvl-epg-detail-live' : 'tvl-epg-detail-badge', live ? 'AO VIVO AGORA' : 'A SEGUIR'));
    meta.append(el('span', 'tvl-epg-detail-channel', row.channel.Name));
    if (programme) meta.append(el('span', 'tvl-epg-detail-time', `${time(programme.StartDate)} – ${time(programme.EndDate)}`));
    copy.append(meta, el('h2', 'tvl-epg-detail-title', programme?.Name || 'O guia está indisponível no momento'), el('p', 'tvl-epg-description', plainText(programme?.Overview) || 'As informações do programa não estão disponíveis. Você ainda pode assistir a este canal ao vivo.'));
    if (slot && !live) {
      const action = el('div', 'tvl-epg-detail-action');
      action.append(icon('clock'), el('span', '', `Começa às ${time(programme?.StartDate)}`), el('small', '', 'Próximo programa'));
      copy.append(action);
    }
    replace(this.detail, artwork, copy);
    this.setArtworkHeight();
  }

  private programmeArtwork(programme: Item | undefined, channel: Item): HTMLElement {
    const artwork = el('div', 'tvl-epg-detail-art');
    const placeholder = el('div', 'tvl-epg-art-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.append(icon('live'));
    artwork.append(placeholder);
    // Live TV providers normally store their channel logo as a Primary image.
    // Also try it when a listed programme image or separate Logo fails to load.
    const sources = [
      {url: programme ? this.api.image(programme, 'backdrop') : null, logo: false},
      {url: this.api.image(channel, 'logo'), logo: true},
      {url: this.api.image({...channel, ImageTags: channel.ImageTags?.Primary ? {Primary: channel.ImageTags.Primary} : {}, BackdropImageTags: []}, 'thumb'), logo: true}
    ].filter((source, index, list) => source.url && list.findIndex(candidate => candidate.url === source.url) === index);
    const next = (): void => {
      const source = sources.shift();
      artwork.classList.toggle('tvl-epg-channel-art', !!source?.logo);
      artwork.classList.toggle('tvl-no-art', !source);
      if (!source?.url) return;
      const image = el('img');
      image.alt = source.logo ? `Logotipo de ${channel.Name}` : programme?.Name || '';
      image.addEventListener('error', () => { image.remove(); next(); }, {once: true});
      image.src = source.url;
      artwork.append(image);
    };
    next();
    return artwork;
  }

  private nowMarker(label = false): HTMLElement | null {
    const position = (Date.now() - this.windowStart) / GUIDE_DURATION * 100;
    if (position < 0 || position > 100) return null;
    const line = el('div', label ? 'tvl-epg-now tvl-epg-now-label' : 'tvl-epg-now'); line.style.left = `${position}%`;
    line.setAttribute('aria-hidden', 'true'); if (label) line.append(el('span', '', 'AGORA')); return line;
  }

  private setWidth(): void {
    if (this.disposed) return;
    const channel = this.scroll.querySelector<HTMLElement>('.tvl-epg-channel');
    const column = channel?.getBoundingClientRect().width || 190;
    const visible = Math.max(360, this.scroll.clientWidth - column);
    const width = `${visible * 8}px`;
    if (this.element.style.getPropertyValue('--tvl-epg-timeline') !== width) this.element.style.setProperty('--tvl-epg-timeline', width);
    this.setArtworkHeight();
  }

  private setArtworkHeight(): void {
    if (this.disposed || !this.element.isConnected) return;
    const height = `${Math.max(0, this.scroll.getBoundingClientRect().top)}px`;
    if (this.element.style.getPropertyValue('--tvl-epg-art-height') !== height) this.element.style.setProperty('--tvl-epg-art-height', height);
  }

  private focusSelection(): void {
    const row = this.rows.find(row => row.channel.Id === this.selection.channelId) || this.rows[0];
    if (!row) return;
    const slot = this.slots(row).find(slot => slot.item.Id === this.selection.programId);
    if (slot) this.focusProgram(row, slot); else this.focusChannel(row);
  }

  private focusRow(row: GuideRow, at: number): void {
    const slot = nearestGuideSlot(this.slots(row), at);
    if (slot) this.focusProgram(row, slot, false); else this.focusChannel(row);
  }

  private focusProgram(row: GuideRow, slot: GuideSlot, updateAnchor = true): void {
    if (updateAnchor) this.anchorTime = Math.max(slot.start, this.windowStart);
    const target = Array.from(this.scroll.querySelectorAll<HTMLElement>('[data-program]')).find(node => node.dataset.program === slot.item.Id && node.dataset.epgRow === row.channel.Id);
    target?.focus({preventScroll: true}); if (target) this.keepVisible(target);
  }

  private focusChannel(row: GuideRow): void {
    const target = Array.from(this.scroll.querySelectorAll<HTMLElement>('.tvl-epg-channel')).find(node => node.dataset.channel === row.channel.Id);
    target?.focus({preventScroll: true}); if (target) this.keepVisible(target);
  }

  private keepVisible(node: HTMLElement): void {
    const bounds = this.scroll.getBoundingClientRect(), box = node.getBoundingClientRect();
    const headerHeight = this.scroll.querySelector<HTMLElement>('.tvl-epg-timeline')?.offsetHeight || 44;
    if (box.top < bounds.top + headerHeight) this.scroll.scrollTop -= bounds.top + headerHeight - box.top;
    else if (box.bottom > bounds.bottom) this.scroll.scrollTop += box.bottom - bounds.bottom;
    if (!node.classList.contains('tvl-epg-program')) return;
    const column = this.scroll.querySelector<HTMLElement>('.tvl-epg-channel')?.offsetWidth || 190;
    const visibleStart = bounds.left + column;
    if (box.left < visibleStart) this.scroll.scrollLeft -= visibleStart - box.left;
    else if (box.right > bounds.right) this.scroll.scrollLeft += Math.min(box.right - bounds.right, box.left - visibleStart);
  }

  private async retryRow(row: GuideRow): Promise<void> {
    if (!this.valid() || this.busy) return;
    const revision = this.revision; row.state = 'loading'; this.busy = true; this.render();
    await this.fetchRows([row], revision);
    if (!this.valid(revision)) return;
    this.busy = false; this.render();
  }

  private async moreChannels(): Promise<void> {
    if (!this.valid() || this.busy) return;
    this.busy = true;
    const revision = this.revision;
    const extra: GuideRow[] = this.channels.slice(this.rows.length, this.rows.length + BATCH_SIZE).map(channel => ({channel, programs: [], state: 'loading', request: 0}));
    this.rows.push(...extra); this.render();
    await this.fetchRows(extra, revision);
    if (!this.valid(revision)) return;
    this.busy = false; this.render();
    if (extra[0]) this.focusRow(extra[0], this.anchorTime);
  }
}
