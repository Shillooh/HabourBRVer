import type { Item, ItemUserData, MediaApi } from './types';
import { el, icon, button, picture, replace } from './dom';
import { runtime, progress, playbackEnd, resumePosition, isWatched, seasonName, episodeCode, time, programmeProgress, playable, plainText } from './utils';
import { attachRemote } from './remote';
import { CollectionPicker } from './collection-picker';
import { subscribeWatchlist } from './watchlist';
import { AdminItemActions } from './admin-item-actions';

type Pane = 'overview' | 'episodes' | 'similar';
export class DetailView {
  readonly element = el('section', 'tvl-root tvl-keyboard');
  private content = el('div', 'tvl-content');
  private status = el('div', 'tvl-status');
  private item!: Item;
  private target: Item | null = null;
  private watchedItem?: Item;
  private watchedPending = false;
  private watchedRevision = 0;
  private metadataRevision = 0;
  private seasons: Item[] = [];
  private selectedSeason?: Item;
  private episodes = new Map<string, Item[]>();
  private episodeRequests = new Map<string, Promise<Item[]>>();
  private similar: Item[] = [];
  private pane: Pane = 'overview';
  private disposed = false;
  private revision = 0;
  private loadingRevision = 0;
  private removeRemote: () => void;
  private launchTimer?: number;
  private liveTimer?: number;
  private endTimeTimer?: number;
  private launching = false;
  private favoritePending = false;
  private restoreId = '';
  private collectionPicker?: CollectionPicker;
  private collectionAccess: boolean | null = null;
  private collectionSaving = false;
  private collectionsRevision = 0;
  private watchlist: boolean | null = null;
  private watchlistPending = false;
  private watchlistFailed = false;
  private watchlistRevision = 0;
  private watchlistRefreshNeeded = false;
  private stopWatchlist?: () => void;
  private adminActions: AdminItemActions;

  constructor(private api: MediaApi, private options: { id: string; close: () => void; back: () => void; navigate: (id: string) => void; openGuide: () => void; openCollection: (item: Item) => void; openAdditional?: (item: Item) => boolean; openNative?: (item: Item) => void; focusId?: string }) {
    this.restoreId = options.focusId || '';
    this.element.id = 'tv-layout';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Detalhes da mídia');
    this.status.setAttribute('role','status');
    this.status.setAttribute('aria-live','polite');
    this.element.append(this.content, this.status);
    this.adminActions = new AdminItemActions(api, this.element, { openNative: options.openNative, announce: message => this.announce(message),
      updated: () => { if (this.disposed) return; const season = this.selectedSeason?.Id; this.loadingRevision++; this.metadataRevision++; this.target = null; this.episodes.clear(); this.episodeRequests.clear(); replace(this.content); void this.load(season); } });
    this.removeRemote = attachRemote(this.element, () => this.back(), direction=>this.moveBetweenSeasons(direction));
  }
  async load(retainSeasonId?: string): Promise<void> {
    this.content.append(this.header(), el('div', 'tvl-loading', 'Carregando sua biblioteca…'));
    this.focusFirst();
    try {
      const requested = await this.api.getItem(this.options.id);
      if (this.disposed) return;
      this.item = requested;
      this.watchedItem = requested;
      if (this.options.openAdditional?.(requested)) return;
      if (requested.Type === 'Season' || requested.Type === 'Episode') {
        if (!requested.SeriesId) { this.options.close(); return; }
        this.item = await this.api.getItem(requested.SeriesId);
        if (requested.Type === 'Episode' && playable(requested)) this.target = requested;
      } else if (requested.Type === 'Program') {
        if (!requested.ChannelId) { this.options.close(); return; }
        this.item = await this.api.getItem(requested.ChannelId);
      }
      if (this.disposed) return;
      if (this.item.Type === 'BoxSet') { this.options.openCollection(this.item); return; }
      if (!['Movie','Series','TvChannel'].includes(this.item.Type || '')) { this.options.close(); return; }
      if (this.item.Type !== 'TvChannel' && this.api.canManageCollections) {
        try { this.collectionAccess = await this.api.canManageCollections(); } catch { /* The picker offers a permission retry. */ }
        if (this.disposed) return;
      }
      this.element.setAttribute('aria-label', `Detalhes de ${this.item.Name}`);
      if (this.item.Type === 'Series') {
        // Main metadata remains usable while season and next-up requests load.
        const [seasons, next] = await Promise.allSettled([this.api.getSeasons(this.item.Id), this.api.getNextEpisode(this.item.Id)]);
        if (this.disposed) return;
        this.seasons = seasons.status === 'fulfilled' ? seasons.value : [];
        this.target ||= next.status === 'fulfilled' ? next.value : null;
        this.selectedSeason = this.seasons.find(s => s.Id === retainSeasonId)
          || this.seasons.find(s => s.Id === (requested.Type === 'Season' ? requested.Id : this.target?.SeasonId))
          || this.seasons.find(s => s.IndexNumber === this.target?.ParentIndexNumber) || this.seasons.find(s => s.IndexNumber !== 0) || this.seasons[0];
        if (!this.target && this.selectedSeason) {
          // Empty first seasons should not hide playable episodes in later ones.
          const ordered = [this.selectedSeason, ...this.seasons.filter(s => s.Id !== this.selectedSeason?.Id)];
          for (const season of ordered) {
            try {
              this.target = (await this.fetchEpisodes(season))[0] || null;
              if (this.disposed) return;
              if (this.target) { if (requested.Type !== 'Season') this.selectedSeason=season; break; }
            } catch { /* Episodes has its own retry state. */ }
          }
        }
        if (seasons.status === 'rejected') this.announce('Não foi possível carregar as temporadas. Reabra os detalhes para tentar novamente.');
      } else this.target = this.item;
      if (this.disposed) return;
      this.setBackdrop();
      if (requested.Type === 'Season') this.pane = 'episodes';
      this.render();
      if (this.item.Type !== 'TvChannel' && this.api.getWatchlistState && this.api.setWatchlist) {
        this.stopWatchlist?.();
        this.stopWatchlist = subscribeWatchlist(this.api, () => {
          if (this.watchlistPending) this.watchlistRefreshNeeded = true;
          else void this.refreshWatchlist();
        });
        void this.refreshWatchlist();
      }
      if (this.item.Type === 'TvChannel') {
        this.liveTimer = window.setInterval(() => { void this.refreshChannel(); }, 60_000);
      }
    } catch {
      if (this.disposed) return;
      replace(this.content,this.header());
      const error = el('div','tvl-empty');
      error.append(el('h1','','Não foi possível carregar este título'), el('p','','Verifique sua conexão e tente novamente.'),
        button('Tentar novamente','', 'tvl-primary', () => { replace(this.content); void this.load(); }));
      this.content.append(error); this.focusFirst();
    }
  }
  private async refreshChannel(): Promise<void> {
    try {
      const refreshed = await this.api.getItem(this.item.Id);
      if (this.disposed) return;
      const changed = refreshed.CurrentProgram?.Id !== this.item.CurrentProgram?.Id;
      this.item = refreshed; this.target = refreshed;
      if (changed && this.pane === 'overview' && !this.launching) { this.setBackdrop(); this.render(); }
      else if(this.pane === 'overview') this.element.querySelectorAll<HTMLElement>('[data-live-progress]').forEach(node => {
        node.style.width = `${programmeProgress(this.item.CurrentProgram || this.item)}%`;
      });
    } catch { /* Keep the guide visible during a temporary disconnect. */ }
  }
  private setBackdrop(): void {
    this.element.querySelector('.tvl-backdrop')?.remove();
    const subject = this.item.CurrentProgram || this.item;
    const backdrop = picture(this.api.image(subject,'backdrop') || this.api.image(this.item,'backdrop'), 'tvl-backdrop');
    this.element.prepend(backdrop);
  }
  private header(): HTMLElement {
    const header = el('header','tvl-header');
    const back = button(this.pane === 'overview' ? 'Voltar' : 'Visão Geral','back','tvl-back', () => this.back());
    header.append(back);
    return header;
  }
  private title(compact = false): HTMLElement {
    const node = el('div',`tvl-title-wrap${compact ? ' tvl-title-compact' : ''}`);
    const logo = this.api.image(this.item,'logo');
    if (logo) {
      const image = el('img','tvl-logo'); image.src = logo; image.alt = this.item.Name;
      image.addEventListener('error', () => image.replaceWith(el('h1','tvl-title',this.item.Name)), {once:true});
      node.append(image);
    } else node.append(el('h1','tvl-title',this.item.Name));
    return node;
  }
  private meta(item = this.item): HTMLElement {
    const row = el('div','tvl-meta');
    if (item.ProductionYear) row.append(el('span','',String(item.ProductionYear)));
    if (item.OfficialRating) row.append(el('span','tvl-rating',item.OfficialRating));
    const duration = item.Type === 'Series' ? `${this.seasons.filter(s => s.IndexNumber !== 0).length} temporadas` : runtime(item.RunTimeTicks);
    if (duration && duration !== '0 temporadas') row.append(el('span','',duration));
    const width = Math.max(0,...(item.MediaStreams || []).filter(s => s.Type === 'Video').map(s => s.Width || 0));
    if (width >= 1280) row.append(el('span','tvl-quality',width >= 3840 ? '4K' : 'HD'));
    if (item.CommunityRating) row.append(el('span','tvl-community',`★ ${item.CommunityRating.toFixed(1)}`));
    return row;
  }
  private render(): void {
    if (this.disposed) return;
    window.clearTimeout(this.endTimeTimer);
    this.revision++;
    this.element.dataset.pane = this.pane;
    this.element.dataset.kind = this.item.Type;
    replace(this.content,this.header());
    if (this.pane === 'episodes') void this.renderEpisodes();
    else if (this.pane === 'similar') void this.renderSimilar();
    else this.renderOverview();
  }
  private renderOverview(): void {
    const movie = this.item.Type === 'Movie';
    const live = this.item.Type === 'TvChannel';
    const hero = el('main',`tvl-hero${movie ? ' tvl-movie-hero' : ''}`);
    const body = el('div','tvl-hero-copy');
    if (live) {
      const eyebrow = el('div','tvl-eyebrow');
      eyebrow.append(el('span','tvl-live-dot'), el('span','','TV AO VIVO'), el('span','tvl-eyebrow-divider','/'), el('span','',this.item.ChannelNumber || this.item.Number || 'NO AR'));
      body.append(eyebrow);
    }
    body.append(this.title());
    const programme = this.item.CurrentProgram;
    if (live) {
      body.append(el('h2','tvl-episode-name', programme?.Name || 'Ao vivo neste canal'));
      const times = el('div','tvl-meta');
      if (programme?.StartDate && programme.EndDate) times.append(el('span','',`${time(programme.StartDate)} – ${time(programme.EndDate)}`));
      times.append(el('span','tvl-on-air','Ao vivo')); body.append(times);
    } else {
      const metadata = this.meta();
      this.appendEndTime(metadata);
      body.append(metadata);
    }
    if (!live && !movie && this.target) body.append(el('h2','tvl-episode-name',`${episodeCode(this.target)}${episodeCode(this.target) ? '  ' : ''}${this.target.Name}`));
    const summary = live ? programme?.Overview || this.item.Overview : this.item.Overview;
    body.append(el('p','tvl-synopsis',plainText(summary) || (live ? 'As informações de programação não estão disponíveis para este canal.' : 'Nenhuma sinopse disponível para este título.')));
    if (live && programme?.StartDate && programme.EndDate) body.append(this.liveProgress(programme));
    if (this.target && !live && progress(this.target) > 0 && progress(this.target) < 100) body.append(this.resumeProgress(this.target));
    const actions = el('div',`tvl-actions${movie ? ' tvl-actions-movie' : ''}`);
    actions.append(this.playbackActions());
    if (movie) {
      const trailer=button('Trailer','trailer','tvl-trailer',()=>void this.playTrailer());
      trailer.setAttribute('aria-label','Assistir ao trailer');trailer.dataset.focusId='trailer';
      actions.append(trailer);
    }
    if (this.item.Type === 'Series') {
      const episodes = button('Episódios e temporadas','episodes','', () => this.open('episodes'));
      episodes.dataset.focusId = 'episodes'; actions.append(episodes);
    }
    if (live) {
      const guide=button('Canais e guia','live','',this.options.openGuide);
      guide.dataset.focusId='guide';actions.append(guide);
    }
    else {
      const similar = button('Títulos semelhantes','grid',movie ? 'tvl-round-label' : '',() => this.open('similar'));
      similar.dataset.focusId = 'similar'; actions.append(similar);
    }
    if (!live && this.api.getWatchlistState && this.api.setWatchlist) {
      const saved = button('', 'plus', 'tvl-watchlist', () => void this.toggleWatchlist());
      saved.dataset.focusId = 'watchlist'; saved.dataset.watchlist = '';
      actions.append(saved); this.updateWatchlistButton(saved);
    }
    const favorite = button(this.item.UserData?.IsFavorite ? 'Nos favoritos' : 'Adicionar aos favoritos', 'heart', movie ? 'tvl-icon-button' : 'tvl-favorite', () => void this.toggleFavorite());
    favorite.setAttribute('aria-label',this.item.UserData?.IsFavorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
    favorite.setAttribute('aria-pressed',String(!!this.item.UserData?.IsFavorite));
    favorite.dataset.favorite = ''; favorite.dataset.focusId = 'favorite'; actions.append(favorite);
    if (!live && this.collectionAccess !== false && this.api.canManageCollections && this.api.addToCollection && this.api.createCollection) {
      const add = button('Adicionar à coleção', 'grid', 'tvl-add-collection', () => this.openCollectionPicker());
      add.dataset.focusId = 'add-collection'; actions.insertBefore(add, favorite);
    }
    if (!live && this.watchedItem && this.api.setPlayed) {
      const watched = this.watchedButton(this.watchedItem, movie ? 'tvl-icon-button' : '');
      watched.dataset.focusId = 'watched'; actions.insertBefore(watched, favorite);
    }
    if (!live) actions.append(this.adminActions.button(this.watchedItem || this.item));
    body.append(actions);
    if (!live && !movie && this.item.Genres?.length) body.append(el('p','tvl-genre-line',this.item.Genres.slice(0,3).join('  ·  ')));
    hero.append(body);
    if (movie) {
      this.content.append(hero, this.filmDetails());
    } else {
      const footer = el('footer','tvl-footer');
      footer.append(el('span','tvl-footer-kind',live ? 'SEUS CANAIS AO VIVO' : 'DESCUBRA MAIS'));
      this.content.append(hero, footer);
    }
    let collections:HTMLElement|undefined;
    let more:HTMLElement|undefined;
    if (!live) {
      collections = el('section','tvl-collections');
      collections.setAttribute('aria-label','Coleções');
      // An empty placeholder avoids advertising membership before the server replies.
      this.content.append(collections);
      more = el('section','tvl-movie-recommendations');
      more.setAttribute('aria-label','Títulos semelhantes');
      more.append(el('h2','tvl-section-title','Títulos semelhantes'));
      this.content.append(more);
    }
    this.focusFirst(this.restoreId);
    if(collections)void this.fillCollections(collections,this.restoreId);
    if(more)void this.fillRecommendations(more,false);
    this.restoreId = '';
  }
  private filmDetails(): HTMLElement {
    const details = el('section','tvl-film-details');
    const left = el('div','tvl-film-description');
    if (this.item.Taglines?.[0]) left.append(el('p','tvl-tagline',this.item.Taglines[0]));
    left.append(el('p','',plainText(this.item.Overview) || 'Nenhuma sinopse disponível.'));
    const right = el('dl','tvl-facts');
    const people = (this.item.People || []).filter(p=>p.Type === 'Actor').slice(0,4).map(p=>p.Name).filter(Boolean);
    const directors = (this.item.People || []).filter(p=>p.Type === 'Director').map(p=>p.Name).filter(Boolean);
    for (const [label,value] of [['Elenco', people.join(', ')], ['Diretor',directors.join(', ')], ['Gêneros',(this.item.Genres || []).join(', ')]]) {
      if (!value) continue;
      const row = el('div'); row.append(el('dt','',`${label}:`),el('dd','',value)); right.append(row);
    }
    details.append(left,right); return details;
  }
  private resumeProgress(item: Item): HTMLElement {
    const wrap = el('div','tvl-resume');
    const bar = el('div','tvl-progress'); const fill = el('span'); fill.style.width = `${progress(item)}%`; bar.append(fill);
    const remaining = runtime(Math.max(0,(item.RunTimeTicks || 0)-(item.UserData?.PlaybackPositionTicks || 0)));
    wrap.append(bar,el('span','',`Restam ${remaining}`)); return wrap;
  }
  private liveProgress(item: Item): HTMLElement {
    const wrap = el('div','tvl-live-progress');
    const bar = el('div','tvl-progress');const fill = el('span');fill.dataset.liveProgress='';fill.style.width=`${programmeProgress(item)}%`;bar.append(fill);
    const label = el('div','tvl-live-times');label.append(el('span','',time(item.StartDate)),el('span','',time(item.EndDate)));
    wrap.append(bar,label);return wrap;
  }
  private appendEndTime(metadata: HTMLElement): void {
    const target = this.target;
    if (!target || !playbackEnd(target)) return;
    const node = el('time', 'tvl-end-time');
    metadata.append(node);
    const update = () => {
      if (this.disposed || this.pane !== 'overview') return;
      const end = playbackEnd(target);
      if (!end) { node.remove(); return; }
      node.dateTime = end.toISOString();
      node.textContent = `Termina às ${time(node.dateTime)}`;
      // Refresh when the displayed finish minute changes, including partial-minute resumes.
      this.endTimeTimer = window.setTimeout(update, 60_000 - end.getTime() % 60_000);
    };
    update();
  }
  private playLabel(): string {
    if (this.item.Type === 'TvChannel') return 'Assistir ao vivo';
    if (!this.target) return 'Nenhum episódio disponível';
    const code = this.item.Type === 'Series' ? episodeCode(this.target) : '';
    return `${this.canResume() ? 'Continuar' : 'Reproduzir'}${code ? ` ${code}` : ''}`;
  }
  private playbackActions(): HTMLElement {
    const play = button(this.playLabel(), 'play', 'tvl-primary', () => { if(this.target) void this.play(this.target); });
    play.dataset.focusId = 'play'; play.disabled = !this.target || !playable(this.target);
    if (!['Movie', 'Episode'].includes(this.target?.Type || '') || !this.canResume()) return play;
    const playback = el('div', 'tvl-playback-actions');
    const restart = button('Reproduzir do início', '', 'tvl-restart', () => { if(this.target) void this.play(this.target, 0); });
    restart.dataset.focusId = 'restart'; restart.disabled = play.disabled;
    playback.append(play, restart); return playback;
  }
  private canResume(): boolean {
    return !!this.target && resumePosition(this.target) > 0;
  }
  private open(pane: Pane): void {
    this.restoreId = (document.activeElement as HTMLElement)?.dataset.focusId || '';
    this.pane = pane;this.render();
  }
  back(): void {
    if (this.collectionPicker) { this.closeCollectionPicker(); return; }
    if (this.pane !== 'overview') {this.pane='overview';this.render();}
    else this.options.back();
  }
  private async fetchEpisodes(season: Item): Promise<Item[]> {
    const pending = this.episodeRequests.get(season.Id);
    if (pending) return pending;
    const cached = this.episodes.get(season.Id);
    if (cached) return cached;
    const metadataRevision = this.metadataRevision;
    const request = (async () => {
      let revision: number, items: Item[];
      do {
        revision = this.watchedRevision;
        items = await this.api.getEpisodes(this.item.Id, season.Id);
        // A list started before a watched write must not put old badges back.
      } while (!this.disposed && revision !== this.watchedRevision);
      if (!this.disposed && metadataRevision === this.metadataRevision) this.episodes.set(season.Id, items);
      return items;
    })();
    this.episodeRequests.set(season.Id, request);
    try { return await request; }
    finally { if (this.episodeRequests.get(season.Id) === request) this.episodeRequests.delete(season.Id); }
  }
  private moveBetweenSeasons(direction: string): boolean {
    if (this.pane !== 'episodes' || !this.selectedSeason || !['up','down'].includes(direction)) return false;
    const cards = Array.from(this.element.querySelectorAll<HTMLElement>('.tvl-episode'));
    const current = document.activeElement as HTMLElement;
    const currentCard = current.closest('.tvl-episode-row')?.querySelector('.tvl-episode') || current;
    const forwards = direction === 'down';
    if (!cards.length || currentCard !== cards[forwards ? cards.length - 1 : 0]) return false;
    const seasonIndex = this.seasons.findIndex(season => season.Id === this.selectedSeason?.Id);
    const next = this.seasons[seasonIndex + (forwards ? 1 : -1)];
    if (next) {
      this.selectedSeason = next;
      void this.updateEpisodes(forwards ? 'first' : 'last', !!current.dataset.watchedId);
    }
    else if (!forwards && current.dataset.watchedId) return false;
    // At the outer edges, keep the episode focused instead of wrapping seasons.
    return true;
  }
  private async renderEpisodes(): Promise<void> {
    const layout = el('main','tvl-browser');
    const sidebar = el('aside','tvl-sidebar');
    sidebar.append(this.title(true), this.meta());
    const seasons = el('nav','tvl-seasons'); seasons.setAttribute('aria-label','Temporadas');
    for (const season of this.seasons) {
      const node = button(seasonName(season), '', 'tvl-season', () => { this.selectedSeason=season; void this.updateEpisodes(); });
      node.dataset.season = season.Id;
      node.setAttribute('aria-pressed',String(season.Id === this.selectedSeason?.Id));
      node.append(el('span','tvl-season-count',season.ChildCount != null ? String(season.ChildCount) : ''),icon('chevron'));
      seasons.append(node);
    }
    sidebar.append(seasons);
    const right = el('section','tvl-browser-main'); right.id='tvl-episodes-area';
    layout.append(sidebar,right);this.content.append(layout);
    if (!this.seasons.length) {
      right.append(this.empty('Nenhuma temporada disponível','As temporadas aparecerão aqui quando estiverem disponíveis em sua biblioteca.'));
      this.focusFirst(); return;
    }
    void this.updateEpisodes();
    const active = seasons.querySelector<HTMLElement>('[aria-pressed="true"]'); active?.focus({preventScroll:true});
  }
  private async updateEpisodes(focusEdge?: 'first' | 'last', watchedEdge = false): Promise<void> {
    if (!this.selectedSeason) return;
    const season = this.selectedSeason;
    const revision = ++this.loadingRevision;
    const area = this.element.querySelector<HTMLElement>('#tvl-episodes-area'); if (!area) return;
    this.element.querySelectorAll<HTMLElement>('[data-season]').forEach(node => node.setAttribute('aria-pressed',String(node.dataset.season===season.Id)));
    const anchor = focusEdge ? Array.from(this.element.querySelectorAll<HTMLElement>('[data-season]')).find(node => node.dataset.season === season.Id) : undefined;
    // Keep focus on an existing control while the old episode list is replaced.
    // Only move it into the new list if the user has not navigated elsewhere.
    anchor?.focus({preventScroll:true});
    const heading = el('div','tvl-browser-heading');heading.append(el('h2','',seasonName(season)));
    if (this.api.setPlayed) heading.append(this.watchedButton(season, 'tvl-season-watched'));
    heading.append(this.adminActions.button(season));
    area.setAttribute('aria-busy','true');
    const loading = el('div','tvl-loading','Carregando episódios…');
    replace(area,heading,loading);
    try {
      const items = await this.fetchEpisodes(season);
      if (this.disposed || revision !== this.loadingRevision || this.pane !== 'episodes') return;
      const list = el('div','tvl-episode-list');list.setAttribute('aria-label',`Episódios de ${seasonName(season)}`);
      if (!items.length) list.append(this.empty('Nenhum episódio disponível','Esta temporada ainda não possui episódios reproduzíveis.'));
      for (const episode of items) {
        const card = el('button','tvl-episode'); card.type='button';card.dataset.episode=episode.Id;
        card.setAttribute('aria-label',`${episodeCode(episode)} ${episode.Name}${isWatched(episode) ? ', assistido' : ''}`);
        const thumb = picture(this.api.image(episode,'thumb'),'tvl-episode-thumb');
        const overlay = el('span','tvl-thumb-play');overlay.append(icon('play'));thumb.append(overlay);
        thumb.append(el('span','tvl-episode-number',episodeCode(episode)));
        if (progress(episode)>0) {const bar=el('span','tvl-thumb-progress');bar.style.width=`${progress(episode)}%`;thumb.append(bar);}
        const copy=el('div','tvl-episode-copy');
        const title=el('div','tvl-episode-title');title.append(el('h3','',episode.Name),el('span','',runtime(episode.RunTimeTicks)));
        copy.append(title,el('p','',plainText(episode.Overview)||'Nenhuma sinopse disponível.'));
        if (resumePosition(episode)) copy.append(el('span','tvl-continue','Continuar assistindo'));
        else if (isWatched(episode)) {const watched=el('span','tvl-watched','Assistido');watched.prepend(icon('check'));copy.append(watched);}
        card.append(thumb,copy);card.addEventListener('click',()=>void this.play(episode));
        const row = el('div', 'tvl-episode-row'); row.append(card);
        if (this.api.setPlayed) row.append(this.watchedButton(episode, 'tvl-icon-button tvl-episode-watched', `${episodeCode(episode)} ${episode.Name}`));
        row.append(this.adminActions.button(episode));
        list.append(row);
      }
      loading.replaceWith(list);
      area.setAttribute('aria-busy','false');
      if (anchor && document.activeElement === anchor) {
        const cards = list.querySelectorAll<HTMLElement>('.tvl-episode');
        const card = cards[focusEdge === 'last' ? cards.length - 1 : 0];
        const target = (watchedEdge ? card?.parentElement?.querySelector<HTMLElement>('[data-watched-id]') : card) || card;
        target?.focus({preventScroll:true});
        target?.scrollIntoView({block:'nearest',inline:'nearest'});
        if (!target) this.announce(`${seasonName(season)} não possui episódios disponíveis.`);
      }
    } catch {
      if (this.disposed || revision !== this.loadingRevision || this.pane !== 'episodes') return;
      loading.replaceWith(this.empty('Não foi possível carregar os episódios','Verifique sua conexão e tente novamente.',()=>void this.updateEpisodes(focusEdge)));
      area.setAttribute('aria-busy','false');
      if (anchor && document.activeElement === anchor) area.querySelector<HTMLElement>('.tvl-empty button')?.focus({preventScroll:true});
    }
  }
  private async renderSimilar(): Promise<void> {
    const main=el('main','tvl-similar');main.append(el('div','tvl-eyebrow',`PORQUE VOCÊ ASSISTIU ${this.item.Name}`),el('h1','tvl-section-title','Títulos semelhantes'));
    this.content.append(main);await this.fillRecommendations(main,true);
  }
  private async fillCollections(container: HTMLElement, focusId=''): Promise<void> {
    const revision = this.revision;
    const collectionsRevision = ++this.collectionsRevision;
    const anchor=document.activeElement;
    container.setAttribute('aria-busy','true');
    try {
      const collections = await this.api.getCollections(this.item.Id);
      if (this.disposed || revision !== this.revision || collectionsRevision !== this.collectionsRevision) return;
      const restoreFocus = container.contains(document.activeElement);
      container.removeAttribute('aria-busy');
      if (!collections.length) { container.remove(); if (restoreFocus) this.focusFirst(); return; }
      const grid = el('div','tvl-film-grid');
      for (const collection of collections) {
        const card = el('button','tvl-film-card tvl-collection-card');
        card.type = 'button';
        card.dataset.focusId = `collection-${collection.Id}`;
        card.setAttribute('aria-label',`Abrir coleção: ${collection.Name}`);
        const art = picture(this.api.image(collection,'thumb'),'tvl-film-art');
        const copy = el('div','tvl-film-copy');
        copy.append(el('h3','',collection.Name),el('span','tvl-collection-link','Ver coleção →'));
        card.append(art,copy);
        card.addEventListener('click',()=>this.options.navigate(collection.Id));
        grid.append(card);
      }
      replace(container,el('h2','tvl-section-title','Coleções'),grid);
      if (restoreFocus) this.focusFirst('',grid);
      else if(focusId.startsWith('collection-')&&document.activeElement===anchor){
        this.focusFirst(focusId,grid);
        (document.activeElement as HTMLElement)?.scrollIntoView({block:'nearest',inline:'nearest'});
      }
    } catch {
      if (this.disposed || revision !== this.revision || collectionsRevision !== this.collectionsRevision) return;
      const restoreFocus = container.contains(document.activeElement);
      container.removeAttribute('aria-busy');
      const retry = button('Tentar novamente','','',()=>{
        if (container.getAttribute('aria-busy') === 'true') return;
        retry.setAttribute('aria-busy','true');
        void this.fillCollections(container);
      });
      replace(container,el('h2','tvl-section-title','Coleções'),el('p','tvl-collections-message','Não foi possível carregar as coleções.'),retry);
      if (restoreFocus) retry.focus({preventScroll:true});
    }
  }
  private async fillRecommendations(container: HTMLElement, focus: boolean): Promise<void> {
    const rev=this.revision;const loading=el('div','tvl-loading','Buscando algo que você vai adorar…');container.append(loading);
    try {
      const items=await this.api.getSimilar(this.item.Id);
      if(this.disposed||rev!==this.revision)return;
      this.similar=items;loading.remove();
      const grid=el('div','tvl-film-grid');
      if(!items.length)grid.append(this.empty('Mais para descobrir','Ainda não há títulos semelhantes disponíveis na sua biblioteca.'));
      for(const item of items){
        const card=el('button','tvl-film-card');card.type='button';
        const art=picture(this.api.image(item,'thumb'),'tvl-film-art');art.append(el('span','tvl-film-duration',runtime(item.RunTimeTicks)));
        const copy=el('div','tvl-film-copy');copy.append(el('h3','',item.Name));
        const meta=el('div','tvl-card-meta');if(item.ProductionYear)meta.append(el('span','',String(item.ProductionYear)));if(item.OfficialRating)meta.append(el('span','tvl-rating',item.OfficialRating));
        copy.append(meta,el('p','',plainText(item.Overview)||'Ver este título na sua biblioteca.'));card.append(art,copy);
        card.addEventListener('click',()=>this.options.navigate(item.Id));grid.append(card);
      }
      container.append(grid);if(focus)this.focusFirst('',grid);
    }catch{
      if(this.disposed||rev!==this.revision)return;
      loading.remove();container.append(this.empty('Recomendações indisponíveis','Você ainda pode reproduzir este título.',()=>{container.querySelector('.tvl-empty')?.remove();void this.fillRecommendations(container,focus);}));
      if(focus)this.focusFirst();
    }
  }
  private updateWatchlistButton(node = this.element.querySelector<HTMLButtonElement>('[data-watchlist]')): void {
    if (!node) return;
    const label = this.watchlistFailed ? 'Tentar lista novamente' : this.watchlist === null ? 'Carregando lista…'
      : this.watchlist ? 'Na minha lista' : 'Adicionar à lista';
    node.setAttribute('aria-label', this.watchlistFailed ? label : this.watchlist ? 'Remover da lista' : label);
    node.setAttribute('aria-pressed', String(this.watchlist === true));
    node.setAttribute('aria-busy', String(this.watchlistPending));
    node.setAttribute('aria-disabled', String(this.watchlistPending));
    const caption = node.querySelector('span'); if (caption) caption.textContent = label;
    node.querySelector('svg')?.replaceWith(icon(this.watchlist ? 'check' : 'plus'));
  }
  private async refreshWatchlist(): Promise<void> {
    if (!this.api.getWatchlistState || this.watchlistPending || this.disposed) return;
    const revision = ++this.watchlistRevision, id = this.item.Id, user = this.api.userId, server = this.api.serverId;
    const current = () => !this.disposed && revision === this.watchlistRevision && id === this.item.Id
      && user === this.api.userId && server === this.api.serverId;
    this.watchlistPending = true; this.watchlistRefreshNeeded = false; this.watchlistFailed = false; this.updateWatchlistButton();
    try {
      const state = await this.api.getWatchlistState(id);
      if (current()) this.watchlist = state.InWatchlist;
    } catch (error) {
      if (current()) { this.watchlistFailed = true; this.announce(error instanceof Error ? error.message : 'Não foi possível carregar sua lista. Tente novamente.'); }
    } finally {
      if (current()) {
        this.watchlistPending = false; this.updateWatchlistButton();
        if (this.watchlistRefreshNeeded) void this.refreshWatchlist();
      }
    }
  }
  private async toggleWatchlist(): Promise<void> {
    if (this.watchlistPending || !this.api.setWatchlist) return;
    if (this.watchlistFailed || this.watchlist === null) { await this.refreshWatchlist(); return; }
    const revision = ++this.watchlistRevision, id = this.item.Id, user = this.api.userId, server = this.api.serverId;
    const current = () => !this.disposed && revision === this.watchlistRevision && id === this.item.Id
      && user === this.api.userId && server === this.api.serverId;
    this.watchlistPending = true; this.updateWatchlistButton();
    try {
      const state = await this.api.setWatchlist(id, !this.watchlist);
      if (!current()) return;
      this.watchlist = state.InWatchlist;
      this.announce(state.InWatchlist ? 'Adicionado à sua lista' : 'Removido da sua lista');
    } catch (error) {
      if (current()) { this.watchlistFailed = true; this.announce(error instanceof Error ? error.message : 'Não foi possível atualizar sua lista. Tente novamente.'); }
    } finally {
      if (current()) {
        this.watchlistPending = false; this.updateWatchlistButton();
        if (this.watchlistRefreshNeeded) void this.refreshWatchlist();
      }
    }
  }
  private async toggleFavorite(): Promise<void> {
    if(this.favoritePending)return;this.favoritePending=true;
    const value=!this.item.UserData?.IsFavorite;
    try{await this.api.setFavorite(this.item.Id,value);if(this.disposed)return;this.item.UserData={...this.item.UserData,IsFavorite:value};
      const node=this.element.querySelector<HTMLButtonElement>('[data-favorite]');
      if(node){node.setAttribute('aria-pressed',String(value));node.setAttribute('aria-label',value?'Remover dos favoritos':'Adicionar aos favoritos');const label=node.querySelector('span');if(label)label.textContent=value?'Nos favoritos':'Adicionar aos favoritos';}
      this.announce(value?'Adicionado aos seus favoritos':'Removido dos seus favoritos');
    }catch{this.announce('Não foi possível atualizar os favoritos. Tente novamente.');}finally{this.favoritePending=false;}
  }
  private watchedButton(item: Item, className: string, label?: string): HTMLButtonElement {
    const subject = label || (item.Type === 'Movie' ? '' : (item.Type === 'Episode' ? 'episódio' : item.Type === 'Season' ? 'temporada' : item.Type === 'Series' ? 'série' : (item.Type || '').toLowerCase()));
    const node = button('', 'check', `tvl-watch-toggle ${className}`, () => void this.toggleWatched(item));
    node.dataset.watchedId = item.Id; node.dataset.watchedSubject = subject;
    this.updateWatchedButton(node, item); return node;
  }
  private updateWatchedButton(node: HTMLButtonElement, item: Item): void {
    const played = isWatched(item);
    const label = played ? `Marcar${node.dataset.watchedSubject ? ` ${node.dataset.watchedSubject}` : ''} como não assistido` : `Marcar${node.dataset.watchedSubject ? ` ${node.dataset.watchedSubject}` : ''} como assistido`;
    node.setAttribute('aria-label', label); node.title = label;
    node.setAttribute('aria-pressed', String(played));
    node.setAttribute('aria-disabled', String(this.watchedPending));
    node.setAttribute('aria-busy', String(this.watchedPending));
    const caption = node.querySelector('span'); if (caption) caption.textContent = label;
  }
  private watchedItems(): Item[] {
    return [this.item, this.target, this.watchedItem, ...this.seasons, ...Array.from(this.episodes.values()).flat()]
      .filter((item): item is Item => !!item);
  }
  private applyWatchedData(id: string, data?: ItemUserData): void {
    if (!data) return;
    // Favourite writes can complete independently; only copy watch-related fields.
    for (const item of this.watchedItems().filter(item => item.Id === id)) {
      item.UserData = { ...item.UserData, Played: data.Played, PlaybackPositionTicks: data.PlaybackPositionTicks,
        PlayedPercentage: data.PlayedPercentage, PlayCount: data.PlayCount, LastPlayedDate: data.LastPlayedDate,
        UnplayedItemCount: data.UnplayedItemCount };
    }
  }
  private async refreshRelatedWatched(item: Item): Promise<boolean> {
    const ids = new Set<string>();
    if (item.Type === 'Episode') {
      if (item.SeriesId) ids.add(item.SeriesId);
      if (item.SeasonId) ids.add(item.SeasonId);
    } else if (item.Type === 'Season') {
      if (item.SeriesId) ids.add(item.SeriesId);
      if (this.target?.SeasonId === item.Id) ids.add(this.target.Id);
    } else if (item.Type === 'Series') {
      for (const season of this.seasons) ids.add(season.Id);
      if (this.target) ids.add(this.target.Id);
    }
    const reads = Array.from(ids).map(async id => {
      const updated = await this.api.getItem(id);
      if (!this.disposed) this.applyWatchedData(id, updated.UserData);
    });
    if (item.Type === 'Series' || item.Type === 'Season') {
      for (const seasonId of this.episodes.keys()) {
        if (item.Type === 'Season' && seasonId !== item.Id) continue;
        reads.push((async () => {
          const updated = await this.api.getEpisodes(this.item.Id, seasonId);
          if (!this.disposed) for (const episode of updated) this.applyWatchedData(episode.Id, episode.UserData);
        })());
      }
    }
    const results = await Promise.allSettled(reads);
    return results.every(result => result.status === 'fulfilled');
  }
  private refreshWatchedControls(): void {
    const items = this.watchedItems();
    this.element.querySelectorAll<HTMLButtonElement>('[data-watched-id]').forEach(node => {
      const item = items.find(item => item.Id === node.dataset.watchedId);
      if (item) this.updateWatchedButton(node, item);
    });
  }
  private refreshWatchedPresentation(): void {
    this.refreshWatchedControls();
    this.element.querySelectorAll<HTMLButtonElement>('[data-episode]').forEach(card => {
      const episode = this.watchedItems().find(item => item.Id === card.dataset.episode); if (!episode) return;
      card.setAttribute('aria-label', `${episodeCode(episode)} ${episode.Name}${isWatched(episode) ? ', assistido' : ''}`);
      const copy = card.querySelector('.tvl-episode-copy');
      copy?.querySelectorAll('.tvl-watched,.tvl-continue').forEach(node => node.remove());
      if (resumePosition(episode)) copy?.append(el('span', 'tvl-continue', 'Continuar assistindo'));
      else if (isWatched(episode)) {
        const badge = el('span', 'tvl-watched', 'Assistido'); badge.prepend(icon('check')); copy?.append(badge);
      }
      const thumb = card.querySelector('.tvl-episode-thumb'); thumb?.querySelector('.tvl-thumb-progress')?.remove();
      if (progress(episode) > 0) { const bar = el('span', 'tvl-thumb-progress'); bar.style.width = `${progress(episode)}%`; thumb?.append(bar); }
    });
    if (this.pane !== 'overview') return;
    const actions = this.content.querySelector<HTMLElement>('.tvl-actions');
    const old = actions?.querySelector<HTMLElement>('.tvl-playback-actions, [data-focus-id="play"]');
    if (old) {
      const focused = old.contains(document.activeElement);
      const playback = this.playbackActions(); old.replaceWith(playback);
      if (focused) this.focusFirst('play');
    }
    this.content.querySelector('.tvl-resume')?.remove();
    if (this.target && progress(this.target) > 0 && progress(this.target) < 100) actions?.before(this.resumeProgress(this.target));
    const metadata = this.content.querySelector<HTMLElement>('.tvl-hero .tvl-meta');
    if (metadata) { window.clearTimeout(this.endTimeTimer); metadata.querySelector('.tvl-end-time')?.remove(); this.appendEndTime(metadata); }
  }
  private async toggleWatched(item: Item): Promise<void> {
    if (this.watchedPending || !this.api.setPlayed || this.disposed) return;
    this.watchedPending = true; this.refreshWatchedControls();
    const played = !isWatched(item);
    try {
      const data = await this.api.setPlayed(item.Id, played);
      if (this.disposed) return;
      this.watchedRevision++;
      this.applyWatchedData(item.Id, data); this.refreshWatchedPresentation();
      const refreshed = await this.refreshRelatedWatched(item);
      if (this.disposed) return;
      this.refreshWatchedPresentation();
      this.announce(`${item.Name} marcado como ${data.Played ? 'assistido' : 'não assistido'}.${refreshed ? '' : ' Reabra os detalhes para atualizar os episódios relacionados.'}`);
    } catch {
      if (!this.disposed) this.announce('Não foi possível atualizar o status de assistido. Tente novamente.');
    } finally {
      this.watchedPending = false;
      if (!this.disposed) this.refreshWatchedControls();
    }
  }
  private openCollectionPicker(): void {
    if (this.collectionPicker || this.disposed) return;
    if (this.collectionSaving) { this.announce('A coleção ainda está sendo salva.'); return; }
    this.removeRemote();
    this.element.setAttribute('aria-modal', 'false');
    this.content.setAttribute('aria-hidden', 'true');
    this.content.style.pointerEvents = 'none';
    const picker = new CollectionPicker(this.api, this.item, {
      close: () => this.closeCollectionPicker(),
      pending: value => { this.collectionSaving = value; },
      saved: collection => {
        if (this.disposed) return;
        this.closeCollectionPicker();
        this.announce(`Adicionado a ${collection.Name}`);
        if (this.pane !== 'overview') return;
        let section = this.content.querySelector<HTMLElement>('.tvl-collections');
        if (!section) {
          section = el('section', 'tvl-collections'); section.setAttribute('aria-label', 'Coleções');
          this.content.insertBefore(section, this.content.querySelector('.tvl-movie-recommendations'));
        }
        void this.fillCollections(section);
      }
    });
    this.collectionPicker = picker;
    this.element.append(picker.element);
    void picker.load();
  }
  private closeCollectionPicker(): void {
    if (!this.collectionPicker) return;
    this.collectionPicker.destroy(); this.collectionPicker = undefined;
    this.element.setAttribute('aria-modal', 'true');
    this.content.removeAttribute('aria-hidden'); this.content.style.pointerEvents = '';
    this.removeRemote = attachRemote(this.element, () => this.back(), direction => this.moveBetweenSeasons(direction));
    this.focusFirst('add-collection');
  }
  private async play(item: Item, startTicks?: number): Promise<void> {
    if(this.launching||!playable(item))return;
    await this.launch(
      ()=>this.api.play(item,startTicks ?? (item.Type==='TvChannel' ? 0 : resumePosition(item)),()=>!this.disposed),
      item.Type==='TvChannel'?'Sintonizando canal…':`Iniciando ${item.Name}…`
    );
  }
  private async playTrailer(): Promise<void> {
    if(this.item.Type!=='Movie'||this.launching)return;
    await this.launch(()=>this.api.playTrailer(this.item,()=>!this.disposed),`Iniciando trailer de ${this.item.Name}…`);
  }
  private async launch(request:()=>Promise<void>,pending:string): Promise<void> {
    this.launching=true;this.announce(pending);
    const focused=document.activeElement as HTMLButtonElement;
    focused?.setAttribute('aria-busy','true');
    const finish=(message:string)=>{if(this.disposed)return;this.launching=false;focused?.removeAttribute('aria-busy');this.announce(message);};
    try{
      await request();
      if(this.disposed)return;
      this.launchTimer=window.setTimeout(()=>finish('A reprodução não iniciou. Tente novamente.'),15_000);
    }catch(error){finish(error instanceof Error?error.message:'Não foi possível iniciar a reprodução. Tente novamente.');}
  }
  private empty(title: string, description: string, retry?: () => void): HTMLElement {
    const node=el('div','tvl-empty');node.append(el('h2','',title),el('p','',description));
    if(retry)node.append(button('Tentar novamente','','',retry));return node;
  }
  private announce(message: string): void {this.status.textContent=message;}
  private focusFirst(id='',within:HTMLElement=this.element): void {
    const node=(id?Array.from(within.querySelectorAll<HTMLElement>('[data-focus-id]')).find(node=>node.dataset.focusId===id):null)
      ||within.querySelector<HTMLElement>('.tvl-primary:not(:disabled), .tvl-film-card, .tvl-season')||within.querySelector<HTMLElement>('button:not(:disabled)');
    node?.focus({preventScroll:true});
  }
  destroy(): void {this.stopWatchlist?.();this.disposed=true;this.loadingRevision++;this.revision++;this.collectionPicker?.destroy();this.adminActions.destroy();this.removeRemote();window.clearTimeout(this.launchTimer);window.clearTimeout(this.endTimeTimer);window.clearInterval(this.liveTimer);this.element.remove();}
}
