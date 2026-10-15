import { button, el, replace } from './dom';
import { isCinemaLayout, isDesktopLayout } from './layout';
import { isWatched, plainText, progress, resumePosition } from './utils';
import type { Item, MediaApi } from './types';
import { isIntro, queuedFeature, sameMediaId, visible, type ActivePlayback, type PlayerContext } from './player-context';

// Native OSD, local playback confirmation and queue patterns adapted from
// jampez77/InPlayerEpisodePreview-TV (f61a2d6), MIT; see LICENSE.md.
const available = (item: Item) => !!item.Id && item.LocationType !== 'Virtual' && !item.IsMissing && !item.IsVirtualItem && !item.IsPlaceHolder && item.PlayAccess !== 'None';
const commands: Record<string, string> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Enter: 'select', Escape: 'back', Backspace: 'back', BrowserBack: 'back', GoBack: 'back' };
const codes: Record<number, string> = { 13: 'select', 37: 'left', 38: 'up', 39: 'right', 40: 'down', 8: 'back', 27: 'back', 461: 'back', 10009: 'back' };
const wrap = (index: number, length: number) => (index % length + length) % length;
const timeout = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

export class PlayerBrowser {
  private entry = button('Navegar', 'episodes', 'tvl-player-entry', () => { void this.open(); });
  private element: HTMLElement | null = null;
  private current: ActivePlayback | null = null;
  private previousFocus: HTMLElement | null = null;
  private items: Item[] = [];
  private seasons: Item[] = [];
  private index = 0;
  private revision = 0;
  private state: 'closed' | 'loading' | 'ready' | 'error' | 'playing' = 'closed';
  private stopContext: () => void;
  private observer: MutationObserver;
  private frame: number | undefined;
  private pendingOpen: number | undefined;
  private destroyed = false;
  private held = new Set<string>();
  private content = el('div', 'tvl-player-content');
  private status = el('p', 'tvl-player-status');
  private seasonNav = el('nav', 'tvl-player-seasons');
  private heading = el('h2', 'tvl-player-heading', 'Navegar');
  private count = el('span', 'tvl-player-count');
  private play = button('Reproduzir', 'play', 'tvl-player-play', () => { void this.playSelected(); });
  private previous = button('Anterior', '', 'tvl-player-previous', () => this.navigate(-1));
  private next = button('Próximo', '', 'tvl-player-next', () => this.navigate(1));
  private closeButton = button('Fechar', 'close', 'tvl-player-close', () => this.close());
  private retry = button('Tentar novamente', '', 'tvl-player-retry', () => { void this.load(); });

  constructor(private context: PlayerContext, private getApi: () => MediaApi | null) {
    this.entry.id = 'tvl-player-browse';
    this.entry.lastElementChild?.remove();
    this.entry.setAttribute('aria-label', 'Navegar');
    this.entry.title = 'Navegar';
    this.entry.setAttribute('aria-haspopup', 'dialog');
    this.seasonNav.setAttribute('aria-label', 'Temporadas');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.play.dataset.playerAction = 'play';
    this.previous.dataset.playerAction = 'previous'; this.next.dataset.playerAction = 'next';
    this.stopContext = context.subscribe(this.sync);
    this.observer = new MutationObserver(this.schedule);
    // Jellyfin's layoutManager changes html without updating body or playback.
    this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden', 'style', 'disabled', 'aria-disabled'] });
    window.addEventListener('keydown', this.keyDown, true); window.addEventListener('keyup', this.keyUp, true);
    window.addEventListener('command', this.command, true); window.addEventListener('blur', this.blur);
    document.addEventListener('focusin', this.focus, true); document.addEventListener('pointerdown', this.pointer, true);
    document.addEventListener('fullscreenchange', this.sync);
    this.sync();
  }
  private standalone(): boolean {
    const osd = this.context.getSnapshot()?.osd;
    return Array.from(document.querySelectorAll<HTMLElement>('#tvEpisodePreview, #previewPopup')).some(visible)
      || Array.from(document.querySelectorAll<HTMLElement>('#popupPreviewButton')).some(control =>
        !!osd?.contains(control) && visible(control) && !control.matches(':disabled, [aria-disabled="true"]'));
  }
  private standaloneScript(): boolean {
    return Array.from(document.scripts).some(script => /(?:InPlayerEpisodePreview|inplayer-episode-preview)/i.test(script.src)
      || /(?:^|\/)InPlayerPreview\/ClientScript(?:[?#]|$)/i.test(script.src));
  }
  private openAfterStandalone(): void {
    if (this.pendingOpen !== undefined) return;
    const current = this.active();
    // The standalone TV edition creates its panel on Down, with no idle button.
    // Let all of its input listeners run first, regardless of script load order.
    // A leftover/failed script alone must not leave the player without browsing.
    this.pendingOpen = window.setTimeout(() => {
      this.pendingOpen = undefined;
      const active = this.active();
      if (current && active && current.key === active.key && sameMediaId(current.playingItemId, active.playingItemId)) void this.open();
    }, 0);
  }
  private dialog(): boolean {
    return Array.from(document.querySelectorAll<HTMLElement>('.dialogContainer .dialog.opened, dialog[open], [role="dialog"][aria-modal="true"]'))
      .some(node => node !== this.element && !this.element?.contains(node) && visible(node));
  }
  private active(): ActivePlayback | null {
    if (!/(?:^|\/)video\/?(?:\?|$)/i.test(location.hash.replace(/^#/, '') || location.pathname)
      || !isCinemaLayout()) return null;
    const current = this.context.getSnapshot();
    return current && visible(current.osd) && visible(current.video) ? current : null;
  }
  private schedule = (): void => {
    if (!this.destroyed && this.frame === undefined) this.frame = requestAnimationFrame(() => { this.frame = undefined; this.sync(); });
  };
  private sync = (): void => {
    if (this.destroyed) return;
    const current = this.active();
    if (!current || this.standalone()) {
      this.entry.remove(); this.close(false); return;
    }
    // The native bottom OSD is a flex row around .osdControls. A text button
    // in that flow shrinks the entire seek/control area. Keep mouse access in
    // its reserved gradient padding. TV remotes use Down without an extra icon;
    // unknown player layouts also retain Down only.
    const bar = isDesktopLayout() ? current.osd.querySelector<HTMLElement>('.videoOsdBottom') : null;
    if (bar && this.entry.parentElement !== bar) bar.append(this.entry);
    else if (!bar) this.entry.remove();
    const label = current.item?.Type === 'Episode' ? 'Episódios e temporadas' : current.item?.Type === 'TvChannel' || current.item?.Type === 'Program' ? 'Canais' : current.item?.Type === 'Movie' ? 'Títulos semelhantes' : 'Navegar';
    this.entry.setAttribute('aria-label', label); this.entry.title = label;
    if (this.element) {
      if (this.dialog() || (this.state !== 'playing' && this.current && (this.current.key !== current.key
        || !sameMediaId(this.current.playingItemId, current.playingItemId)
        || (!!this.current.playlistItemId && !!current.playlistItemId && this.current.playlistItemId !== current.playlistItemId)))) { this.close(false); return; }
      this.mount();
    }
  };
  private mount(): void {
    const fullscreen = document.fullscreenElement;
    const host = fullscreen instanceof HTMLElement && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (this.element && this.element.parentElement !== host) host.append(this.element);
  }
  async open(): Promise<void> {
    if (this.element || this.destroyed || this.standalone() || this.dialog()) return;
    const current = this.active();
    if (!current || !this.getApi()) return;
    this.current = current;
    this.previousFocus = document.activeElement as HTMLElement;
    this.element = el('section', 'tvl-player-browser');
    this.element.id = 'tvl-player-browser'; this.element.tabIndex = -1;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Navegar durante a reprodução');
    const header = el('header', 'tvl-player-header');
    header.append(this.heading, this.count, this.closeButton);
    const actions = el('div', 'tvl-player-actions'); actions.append(this.previous, this.play, this.next);
    this.element.append(header, this.seasonNav, this.content, this.status, this.retry, actions);
    document.body.setAttribute('data-tvl-player-browser-open', '');
    this.entry.setAttribute('aria-expanded', 'true');
    this.mount(); await this.load();
  }
  private isCurrent(revision: number): boolean {
    return !this.destroyed && !!this.element?.isConnected && revision === this.revision
      && !!this.active() && !this.standalone();
  }
  private async load(): Promise<void> {
    const api = this.getApi(); const current = this.current;
    if (!api || !current || !this.element) return;
    const revision = ++this.revision;
    this.state = 'loading'; this.items = []; this.seasons = []; this.status.textContent = 'Carregando…';
    this.content.textContent = ''; this.seasonNav.textContent = ''; this.count.textContent = '';
    this.retry.hidden = true; this.play.hidden = true; this.previous.hidden = true; this.next.hidden = true;
    this.closeButton.focus({ preventScroll: true });
    try {
      let item = current.item;
      let playback = current.playbackContext;
      if (!item) {
        try { item = await api.getItem(current.itemId); }
        catch (error) {
          playback = await api.getPlaybackContext?.() || undefined;
          if (!playback || !sameMediaId(playback.PlayingItemId, current.playingItemId)
            || !isIntro({ Type: playback.PlayingItemType, ExtraType: playback.PlayingItemExtraType })) throw error;
        }
      }
      if (!this.isCurrent(revision)) return;
      if (!item || isIntro(item)) {
        playback = playback || await api.getPlaybackContext?.() || undefined;
        const feature = playback && sameMediaId(playback.PlayingItemId, current.playingItemId)
          ? await queuedFeature(playback, api, () => this.isCurrent(revision)) : null;
        if (!feature) throw new Error('A navegação estará disponível quando o filme ou episódio começar.');
        item = feature;
        this.current = { ...current, item, itemId: item.Id, upcomingItemId: item.Id, playlistItemId: playback?.PlaylistItemId };
      }
      let items: Item[];
      if (item.Type === 'Episode' && item.SeriesId) {
        const episode = item;
        const [seasons, episodes] = await Promise.all([api.getSeasons(item.SeriesId), api.getEpisodes(item.SeriesId, '')]);
        if (!this.isCurrent(revision)) return;
        this.seasons = seasons;
        items = episodes.filter(candidate => available(candidate) && candidate.Type === 'Episode' && (!candidate.SeriesId || sameMediaId(candidate.SeriesId, episode.SeriesId)));
        if (!items.some(candidate => sameMediaId(candidate.Id, episode.Id)) && available(item)) items.push(item);
        items.sort((a, b) => (a.ParentIndexNumber ?? Number.MAX_SAFE_INTEGER) - (b.ParentIndexNumber ?? Number.MAX_SAFE_INTEGER)
          || (a.IndexNumber ?? Number.MAX_SAFE_INTEGER) - (b.IndexNumber ?? Number.MAX_SAFE_INTEGER) || a.Id.localeCompare(b.Id));
        this.heading.textContent = item.SeriesName || 'Episódios e temporadas';
      } else if (item.Type === 'Movie') {
        items = [item, ...await api.getSimilar(item.Id)].filter(candidate => candidate.Type === 'Movie' && available(candidate));
        this.heading.textContent = 'Títulos semelhantes';
      } else if (item.Type === 'TvChannel' || (item.Type === 'Program' && item.ChannelId)) {
        if (item.Type === 'Program') item = await api.getItem(item.ChannelId!);
        if (!this.isCurrent(revision)) return;
        if (item.Type !== 'TvChannel') throw new Error('Este canal está indisponível.');
        const channel = item;
        items = (await api.getChannels()).filter(candidate => candidate.Type === 'TvChannel' && available(candidate));
        if (!items.some(candidate => sameMediaId(candidate.Id, channel.Id))) items.push(item);
        this.heading.textContent = 'TV ao Vivo';
      } else throw new Error('Inicie um filme, episódio ou canal ao vivo para navegar.');
      if (!this.isCurrent(revision)) return;
      const unique = new Map<string, Item>();
      for (const candidate of items) if (![...unique.keys()].some(id => sameMediaId(id, candidate.Id))) unique.set(candidate.Id, candidate);
      this.items = [...unique.values()];
      if (!this.items.length) throw new Error('Nenhum item disponível foi encontrado. Tente novamente.');
      this.index = Math.max(0, this.items.findIndex(candidate => sameMediaId(candidate.Id, item.Id)));
      this.state = 'ready'; this.render(); this.play.focus({ preventScroll: true });
    } catch (error) {
      if (!this.isCurrent(revision)) return;
      this.state = 'error'; this.status.textContent = error instanceof Error ? error.message : 'Não foi possível carregar a mídia. Tente novamente.';
      this.retry.hidden = false; this.retry.focus({ preventScroll: true });
    }
  }
  private render(): void {
    const item = this.items[this.index]; const api = this.getApi();
    if (!item || !api || !this.element) return;
    const current = this.current;
    const playing = sameMediaId(item.Id, current?.itemId) || sameMediaId(item.Id, current?.item?.ChannelId);
    const upcoming = playing && !!current?.upcomingItemId;
    const programme = item.Type === 'TvChannel' ? item.CurrentProgram : undefined;
    this.element.dataset.itemId = item.Id;
    this.count.textContent = `${this.index + 1} de ${this.items.length}`;
    this.status.textContent = ''; this.retry.hidden = true;
    this.play.hidden = false; this.play.disabled = false; this.play.removeAttribute('aria-busy');
    this.previous.hidden = this.items.length < 2; this.next.hidden = this.items.length < 2;
    this.previous.disabled = false; this.next.disabled = false;
    const label = playing && !upcoming ? 'Voltar para reprodução' : item.Type === 'TvChannel' ? 'Assistir canal'
      : resumePosition(item) > 0 ? 'Continuar' : 'Reproduzir';
    this.play.lastElementChild!.textContent = label;
    const media = el('div', 'tvl-player-media');
    const fallback = el('span', 'tvl-player-image-fallback', item.Type === 'TvChannel' ? item.Name : 'Nenhuma imagem disponível');
    const image = el('img', 'tvl-player-image'); image.alt = ''; image.draggable = false;
    let source = programme ? api.image(programme, 'thumb') : api.image(item, 'thumb');
    const backup = item.Type === 'TvChannel' ? api.image(item, 'logo') || api.image(item, 'thumb') : null;
    const setBackup = () => {
      if (backup && image.src !== new URL(backup, location.href).href) { image.src = backup; image.classList.add('tvl-player-logo'); }
      else { image.hidden = true; fallback.hidden = false; }
    };
    image.addEventListener('error', setBackup);
    if (!source && backup) { source = backup; image.classList.add('tvl-player-logo'); }
    if (source) { image.src = source; fallback.hidden = true; } else image.hidden = true;
    media.append(image, fallback);
    if (playing) media.append(el('span', 'tvl-player-playing', upcoming ? 'A seguir após a introdução' : 'Reproduzindo agora'));
    const percent = progress(item);
    if (percent) { const track = el('div', 'tvl-player-progress'); const fill = el('div'); fill.style.width = `${percent}%`; track.append(fill); media.append(track); }
    const details = el('div', 'tvl-player-details');
    const position = item.Type === 'Episode' ? `${item.ParentIndexNumber === 0 ? 'Especiais' : `Temporada ${item.ParentIndexNumber ?? '?'}`} · Episódio ${item.IndexNumber ?? '?'}`
      : item.Type === 'TvChannel' ? [item.Number || item.ChannelNumber, item.Name].filter(Boolean).join(' · ') : [item.ProductionYear, item.OfficialRating].filter(Boolean).join(' · ');
    details.append(el('p', 'tvl-player-position', position), el('h3', 'tvl-player-title', programme?.Name || item.Name));
    if (programme?.StartDate && programme.EndDate) {
      const format = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      details.append(el('p', 'tvl-player-time', `Ao vivo agora · ${format(programme.StartDate)}–${format(programme.EndDate)}`));
    } else if (item.Type !== 'TvChannel') {
      const runtime = item.RunTimeTicks ? `${Math.round(item.RunTimeTicks / 600000000)} min` : '';
      details.append(el('p', 'tvl-player-meta', [runtime, isWatched(item) ? 'Assistido' : '', item.Genres?.slice(0, 3).join(' · ')].filter(Boolean).join(' · ')));
    }
    details.append(el('p', 'tvl-player-description', plainText(programme?.Overview || item.Overview)));
    replace(this.content, media, details);
    const seasonButtons = this.seasons.filter(season => this.items.some(candidate => candidate.SeasonId === season.Id || candidate.ParentIndexNumber === season.IndexNumber)).map(season => {
      const control = button(season.Name || `Temporada ${season.IndexNumber}`, '', '', () => {
        const index = this.items.findIndex(candidate => candidate.SeasonId === season.Id || candidate.ParentIndexNumber === season.IndexNumber);
        if (index >= 0) { this.index = index; this.render(); this.play.focus({ preventScroll: true }); }
      });
      control.dataset.season = season.Id;
      control.setAttribute('aria-pressed', String(item.SeasonId === season.Id || item.ParentIndexNumber === season.IndexNumber));
      return control;
    });
    replace(this.seasonNav, ...seasonButtons); this.seasonNav.hidden = !seasonButtons.length;
    const previous = this.items[wrap(this.index - 1, this.items.length)], next = this.items[wrap(this.index + 1, this.items.length)];
    this.previous.textContent = `‹ ${previous.Name}`; this.previous.setAttribute('aria-label', `Anterior: ${previous.Name}`);
    this.next.textContent = `${next.Name} ›`; this.next.setAttribute('aria-label', `Próximo: ${next.Name}`);
  }
  private navigate(direction: number): void {
    if (this.state !== 'ready' || this.items.length < 2) return;
    this.index = wrap(this.index + direction, this.items.length); this.render(); this.play.focus({ preventScroll: true });
  }
  private async playSelected(): Promise<void> {
    if (this.state !== 'ready') return;
    const item = this.items[this.index], api = this.getApi(), current = this.active();
    if (!item || !api || !current) return;
    if (!current.upcomingItemId && (sameMediaId(item.Id, current.itemId) || sameMediaId(item.Id, current.item?.ChannelId))) { this.close(); return; }
    const revision = ++this.revision;
    const video = current.video; const source = video.srcObject || video.currentSrc || video.src;
    const previousPlaylistItemId = current.playlistItemId || this.current?.playlistItemId;
    this.state = 'playing'; this.play.disabled = true; this.play.setAttribute('aria-busy', 'true');
    this.previous.disabled = true; this.next.disabled = true; this.seasonNav.querySelectorAll('button').forEach(button => button.disabled = true);
    this.status.textContent = item.Type === 'TvChannel' ? 'Sintonizando canal…' : 'Iniciando reprodução…';
    try {
      await api.play(item, item.Type === 'TvChannel' ? 0 : resumePosition(item), () => this.isCurrent(revision));
      if (!this.isCurrent(revision)) return;
      const started = Date.now();
      let lastContext = 0;
      let sessionConfirmed = '';
      while (this.isCurrent(revision) && Date.now() - started < 20000) {
        this.context.refresh();
        const active = this.active();
        if (!active) return;
        const changedSource = active.video !== video || (active.video.srcObject || active.video.currentSrc || active.video.src) !== source;
        const locallyPlaying = changedSource && !active.video.paused && !active.video.ended && !active.video.error && active.video.readyState >= 2;
        const selected = sameMediaId(active.playingItemId, item.Id) || (item.Type === 'TvChannel' && sameMediaId(active.item?.ChannelId, item.Id));
        if (locallyPlaying && (selected || sameMediaId(active.playingItemId, sessionConfirmed))) { this.close(); return; }
        if (api.getPlaybackContext && Date.now() - lastContext > 700) {
          lastContext = Date.now();
          const playback = await api.getPlaybackContext().catch(() => null);
          if (!this.isCurrent(revision)) return;
          sessionConfirmed = '';
          if (playback) {
            let confirmed = sameMediaId(playback.PlayingItemId, item.Id);
            if (!confirmed && item.Type === 'TvChannel' && playback.PlayingItemId) {
              const programme = await api.getItem(playback.PlayingItemId).catch(() => null);
              if (!this.isCurrent(revision)) return;
              confirmed = !!programme && sameMediaId(programme.ChannelId, item.Id);
            }
            const changedIntro = !sameMediaId(playback.PlayingItemId, current.playingItemId)
              || (!!previousPlaylistItemId && !!playback.PlaylistItemId && playback.PlaylistItemId !== previousPlaylistItemId);
            if (!confirmed && changedIntro && isIntro({ Type: playback.PlayingItemType, ExtraType: playback.PlayingItemExtraType })) {
              const feature = await queuedFeature(playback, api, () => this.isCurrent(revision));
              confirmed = !!feature && sameMediaId(feature.Id, item.Id);
            }
            if (confirmed) sessionConfirmed = playback.PlayingItemId;
          }
        }
        await timeout(100);
      }
      if (this.isCurrent(revision)) throw new Error('A reprodução não iniciou. Tente novamente.');
    } catch (error) {
      if (!this.isCurrent(revision)) return;
      this.state = 'ready'; this.render();
      this.status.textContent = error instanceof Error ? error.message : 'Não foi possível iniciar a reprodução. Tente novamente.';
      this.play.focus({ preventScroll: true });
    }
  }
  close(restore = true): void {
    if (!this.element) return;
    this.revision++; this.state = 'closed'; this.element.remove(); this.element = null;
    document.body.removeAttribute('data-tvl-player-browser-open'); this.entry.setAttribute('aria-expanded', 'false');
    if (restore && this.previousFocus?.isConnected && visible(this.previousFocus)) this.previousFocus.focus({ preventScroll: true });
    else if (restore && this.entry.isConnected) this.entry.focus({ preventScroll: true });
    this.current = null;
  }
  private consume(event: Event): void { event.preventDefault(); event.stopImmediatePropagation(); }
  private canBrowseDown(current: ActivePlayback): boolean {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || focused === document.body || focused === current.video) return true;
    // Jellyfin makes only its TV seek slider part of remote navigation. Some
    // themes put it below the buttons, so Down must be able to leave it while
    // ordinary form fields and mouse-only volume sliders keep their editing.
    if (focused.closest('input, textarea, select, [contenteditable="true"]')
      && !focused.matches('input.osdPositionSlider[type="range"].focusable')) return false;
    // Jellyfin's player header lives outside videoOsdPage. Its Down action
    // must reach the seek/play controls before browsing can take over.
    if (focused.closest('.osdHeader, .skinHeader')) return !visible(focused) || !!focused.closest('.osdHeader-hidden');
    if (!current.osd.contains(focused)) return false;
    // Persistent trailer actions remain visible after native controls fade.
    // Down first reveals those controls through Jellyfin's own navigation.
    if (focused.closest('#tvl-trailer-actions') && current.osd.querySelector('.videoOsdBottom-hidden')) return false;
    if (focused === this.entry || !visible(focused) || focused.closest('.videoOsdBottom-hidden')) return true;
    const rect = focused.getBoundingClientRect();
    // Compare actual rows so wrapped controls and unfamiliar OSD layouts keep
    // their native navigation. Ignore our own floating mouse shortcut.
    return !Array.from(current.osd.querySelectorAll<HTMLElement>('button, a[href], input:not([type="range"]):not([type="file"]), select, textarea, .focusable'))
      .some(control => {
        if (control === focused || control === this.entry || control.contains(focused)
          || control.matches(':disabled, [aria-disabled="true"], [tabindex="-1"]') || !visible(control)
          || control.closest('.videoOsdBottom-hidden')) return false;
        const next = control.getBoundingClientRect();
        return next.top > rect.top + 1 && next.bottom > rect.bottom + 1 && next.top < innerHeight && next.bottom > 0;
      });
  }
  private handle(command: string, repeat = false): boolean {
    const current = this.active();
    if (!current || this.standalone() || this.dialog()) return false;
    if (!this.element) {
      if (command !== 'down' || !this.canBrowseDown(current)) return false;
      if (this.standaloneScript()) {
        if (!repeat) this.openAfterStandalone();
        return false;
      }
      if (!repeat) void this.open(); return true;
    }
    const season = (document.activeElement as HTMLElement)?.closest<HTMLButtonElement>('[data-season]');
    if (command === 'back' || command === 'escape') { this.close(); return true; }
    if (command === 'left' || command === 'right') {
      const direction = command === 'left' ? -1 : 1;
      if (season) {
        const controls = Array.from(this.seasonNav.querySelectorAll<HTMLButtonElement>('button'));
        controls[wrap(controls.indexOf(season) + direction, controls.length)]?.focus({ preventScroll: true });
      } else this.navigate(direction);
      return true;
    }
    if (command === 'up') {
      if (season || this.seasonNav.hidden || this.state !== 'ready') this.close();
      else this.seasonNav.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
      return true;
    }
    if (command === 'down') { if (season) this.play.focus({ preventScroll: true }); return true; }
    if (['select', 'enter', 'ok'].includes(command)) {
      if (!repeat) {
        const active = document.activeElement as HTMLElement;
        if (this.element.contains(active) && active.matches('button:not(:disabled)')) active.click();
      }
      return true;
    }
    return false;
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.code || event.key || String(event.keyCode);
    if (!event.repeat) this.held.delete(key);
    if (event.repeat && this.held.has(key) && !this.element) { this.consume(event); return; }
    const command = commands[event.key] || codes[event.keyCode];
    if (command && this.handle(command, event.repeat)) { this.held.add(key); this.consume(event); }
    else if (event.key === 'Tab' && this.element && !this.dialog()) {
      const buttons = Array.from(this.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(visible);
      buttons[wrap(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.shiftKey ? -1 : 1), buttons.length)]?.focus();
      this.consume(event);
    }
  };
  private keyUp = (event: KeyboardEvent): void => { if (this.held.delete(event.code || event.key || String(event.keyCode))) this.consume(event); };
  private command = (event: Event): void => {
    const command = (event as CustomEvent<{ command?: string }>).detail?.command?.toLowerCase();
    if (command && this.handle(command)) this.consume(event);
  };
  private blur = (): void => { this.held.clear(); };
  private focus = (event: FocusEvent): void => {
    if (this.element && !this.element.contains(event.target as Node) && !this.dialog()) {
      (this.state === 'ready' ? this.play : this.closeButton).focus({ preventScroll: true });
    }
  };
  private pointer = (event: Event): void => { if (this.element && !this.element.contains(event.target as Node)) this.close(false); };
  destroy(): void {
    this.destroyed = true; this.close(false); this.entry.remove(); this.stopContext(); this.observer.disconnect();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    if (this.pendingOpen !== undefined) clearTimeout(this.pendingOpen);
    window.removeEventListener('keydown', this.keyDown, true); window.removeEventListener('keyup', this.keyUp, true);
    window.removeEventListener('command', this.command, true); window.removeEventListener('blur', this.blur);
    document.removeEventListener('focusin', this.focus, true); document.removeEventListener('pointerdown', this.pointer, true);
    document.removeEventListener('fullscreenchange', this.sync);
  }
}
