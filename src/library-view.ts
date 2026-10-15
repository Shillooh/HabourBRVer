import type { Item, MediaApi, LibraryQuery, SuggestionSection } from './types';
import { button, el, icon, picture, replace, isCardAction } from './dom';
import { attachRemote } from './remote';
import { progress, resumePosition } from './utils';
import { subscribeWatchlist } from './watchlist';

export type LibraryTab = 'all' | 'suggestions' | 'favorites' | 'genres' | 'watchlist';
export type LibraryBrowseState = {
  tab: LibraryTab;
  search: string;
  letter: string;
  genreId?: string;
  genreName?: string;
  /** Raw API pagination depth, including any items filtered by the adapter. */
  loadedCount: number;
  focusId?: string;
  scrollTop?: number;
};
type Options = {
  kind: 'movies' | 'shows';
  parentId?: string;
  initialTab?: LibraryTab;
  back: () => void;
  navigate: (id: string) => void;
  openCollections: () => void;
  focusId?: string;
  state?: LibraryBrowseState;
  onState?: (state: LibraryBrowseState) => void;
};
const pageSize = 48;

export class LibraryView {
  readonly element = el('section', 'tvl-root tvl-keyboard tvl-library-view');
  private get isShows(): boolean { return this.options.kind === 'shows'; }
  private get title(): string { return this.isShows ? 'Séries' : 'Filmes'; }
  private get plural(): string { return this.isShows ? 'séries' : 'filmes'; }
  private get singular(): string { return this.isShows ? 'série' : 'filme'; }
  private content = el('div', 'tvl-content');
  private hero = el('div', 'tvl-library-hero');
  private navigation = el('nav', 'tvl-library-tabs');
  private filters = el('div', 'tvl-library-filters');
  private results = el('div', 'tvl-library-results');
  private count = el('p', 'tvl-library-count');
  private input = el('input', 'tvl-library-search-input');
  private state: LibraryBrowseState;
  private nextFocus = '';
  private initialScroll = 0;
  private restoring = false;
  private internalFocus = false;
  private focusRevision = 0;
  private items: Item[] = [];
  private total: number | null = null;
  private nextStart = 0;
  private hasMore = false;
  private loading = false;
  private disposed = false;
  private revision = 0;
  private removeRemote: () => void;
  private stopWatchlist: () => void;

  constructor(private api: MediaApi, private options: Options) {
    this.state = { tab: options.initialTab || 'suggestions', search: '', letter: '', loadedCount: 0, ...options.state };
    this.nextFocus = options.focusId || this.state.focusId || '';
    this.initialScroll = this.state.scrollTop || 0;
    this.restoring = !!(options.state || options.focusId);
    this.element.id = 'tv-layout';
    this.element.dataset.pane = options.kind;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', this.title);
    const header = el('header', 'tvl-header');
    const back = button('Voltar', 'back', 'tvl-back', options.back);
    back.dataset.focusId = 'back';
    header.append(back);
    const heroCopy = el('div', 'tvl-library-hero-copy');
    heroCopy.append(el('h1', 'tvl-library-title', this.title), this.count);
    this.hero.append(heroCopy);
    this.navigation.setAttribute('aria-label', `Navegar em ${this.plural}`);
    this.count.setAttribute('aria-live', 'polite');
    this.content.append(header, this.hero, this.navigation, this.filters, this.results);
    this.element.append(this.content);
    this.renderControls();
    this.removeRemote = attachRemote(this.element, options.back);
    this.stopWatchlist = subscribeWatchlist(api, () => {
      if (this.state.tab !== 'watchlist') return;
      this.nextFocus = (document.activeElement as HTMLElement | null)?.dataset.focusId || '';
      void this.loadResults();
    });
    this.element.addEventListener('focusin', event => {
      if (this.internalFocus) return;
      const id = (event.target as HTMLElement).dataset.focusId;
      if (id) {
        this.focusRevision++;
        this.restoring = false; this.initialScroll = 0;
        this.state.focusId = id; this.save();
      }
    });
    this.content.addEventListener('scroll', () => { this.save(); }, { passive: true });
  }

  async load(): Promise<void> { await this.loadResults(); }

  private save(): void {
    if (!this.restoring) this.state.scrollTop = this.content.scrollTop;
    if (!this.disposed) this.options.onState?.({ ...this.state });
  }

  private change(next: Partial<LibraryBrowseState>, focusId: string): void {
    this.state = { ...this.state, ...next, loadedCount: 0, scrollTop: 0, focusId: focusId || undefined };
    this.nextFocus = focusId;
    this.initialScroll = 0; this.restoring = false;
    this.content.scrollTop = 0;
    this.items = [];
    this.renderControls();
    this.focus(focusId);
    this.save();
    void this.loadResults();
  }

  private renderControls(): void {
    replace(this.navigation);
    const collections = button('Coleções', 'grid', 'tvl-library-tab tvl-library-collections', this.options.openCollections);
    collections.dataset.focusId = 'collections';
    const allLabel = this.isShows ? 'Todas as séries' : 'Todos os filmes';
    const tabs: [LibraryTab, string][] = [['suggestions', 'Sugestões'], ['watchlist', 'Minha Lista'], ['favorites', 'Favoritos'], ['genres', 'Gêneros'], ['all', allLabel]];
    for (const [tab, label] of tabs) {
      if (tab === 'all') this.navigation.append(collections);
      const control = button(label, '', 'tvl-library-tab', () => {
        this.change({ tab, search: '', letter: '', genreId: undefined, genreName: undefined }, `tab:${tab}`);
      });
      control.dataset.focusId = `tab:${tab}`;
      control.dataset.libraryTab = tab;
      control.setAttribute('aria-pressed', String(this.state.tab === tab));
      this.navigation.append(control);
    }
    const form = el('form', 'tvl-library-search');
    form.setAttribute('role', 'search');
    this.input = el('input', 'tvl-library-search-input');
    this.input.type = 'search'; this.input.tabIndex = 0;
    this.input.placeholder = `Buscar ${this.plural}`; this.input.value = this.state.search;
    this.input.autocomplete = 'off'; this.input.dataset.focusId = 'search';
    this.input.setAttribute('aria-label', `Buscar ${this.plural}`);
    const submit = button('Buscar', '', 'tvl-library-search-submit', () => {});
    submit.type = 'submit'; submit.dataset.focusId = 'search-submit';
    form.append(this.input, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const tab = this.state.tab === 'suggestions' || (this.state.tab === 'genres' && !this.state.genreId) ? 'all' : this.state.tab;
      this.change({ tab, search: this.input.value.trim(), letter: '' }, 'search');
    });
    if (this.state.search) {
      const clear = button('Limpar busca', 'close', 'tvl-library-clear', () => this.change({ search: '' }, 'search'));
      clear.dataset.focusId = 'clear-search'; form.append(clear);
    }
    const controls: HTMLElement[] = [form];
    if (this.state.tab === 'all' || this.state.tab === 'favorites' || this.state.tab === 'watchlist' || this.state.genreId) {
      const alphabet = el('nav', 'tvl-library-alphabet');
      alphabet.setAttribute('aria-label', 'Navegar por título');
      for (const letter of ['', '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
        const control = button(letter || 'Todos', '', 'tvl-library-letter', () => this.change({ letter }, `letter:${letter || 'all'}`));
        control.dataset.focusId = `letter:${letter || 'all'}`;
        control.dataset.libraryLetter = letter;
        control.setAttribute('aria-pressed', String(this.state.letter === letter));
        if (letter === '#') control.setAttribute('aria-label', '# — números e símbolos');
        alphabet.append(control);
      }
      controls.push(alphabet);
    }
    replace(this.filters, ...controls);
  }

  private query(startIndex: number): LibraryQuery {
    return { parentId: this.options.parentId, search: this.state.search || undefined,
      letter: this.state.letter || undefined, genreId: this.state.tab === 'genres' ? this.state.genreId : undefined,
      favorite: this.state.tab === 'favorites' || undefined, startIndex, limit: pageSize };
  }

  private async loadResults(append = false): Promise<void> {
    if (this.disposed || (append && this.loading)) return;
    const revision = ++this.revision;
    const current = () => !this.disposed && revision === this.revision;
    this.loading = true;
    const requestedFocus = this.nextFocus;
    const focusRevision = this.focusRevision;
    this.nextFocus = '';
    const firstNew = this.items.length;
    this.results.setAttribute('aria-busy', 'true');
    if (!append) {
      this.count.textContent = '';
      const loading = el('p', 'tvl-loading', this.state.tab === 'suggestions' ? 'Procurando algo para assistir…' : `Carregando ${this.plural}…`);
      loading.setAttribute('role', 'status');
      replace(this.results, loading);
      if (!this.element.contains(document.activeElement)) this.focus(`tab:${this.state.tab}`, false, false);
    } else this.results.querySelector<HTMLButtonElement>('[data-focus-id="show-more"]')?.setAttribute('aria-busy', 'true');
    try {
      if (this.state.tab === 'suggestions') {
        const sections = await (this.isShows ? this.api.getShowSuggestions(this.options.parentId) : this.api.getMovieSuggestions(this.options.parentId));
        if (!current()) return;
        this.renderSuggestions(sections);
      } else if (this.state.tab === 'genres' && !this.state.genreId) {
        const genres = await (this.isShows ? this.api.getShowGenres(this.options.parentId) : this.api.getMovieGenres(this.options.parentId));
        if (!current()) return;
        this.renderGenres(genres);
      } else {
        let offset = append ? this.nextStart : 0;
        const desired = append ? offset + pageSize : Math.max(pageSize, this.state.loadedCount || 0);
        const unique = new Map((append ? this.items : []).map(item => [item.Id, item]));
        let more = true;
        let total: number | null = null;
        do {
          if (this.state.tab === 'watchlist' && !this.api.getWatchlist) throw new Error('A Minha Lista está indisponível.');
          const page = await (this.state.tab === 'watchlist' ? this.api.getWatchlist!({ ...this.query(offset), type: this.isShows ? 'Series' : 'Movie' }) : this.isShows ? this.api.getShows(this.query(offset)) : this.api.getMovies(this.query(offset)));
          if (!current()) return;
          for (const item of page.items) unique.set(item.Id, item);
          total = typeof page.total === 'number' && Number.isFinite(page.total) ? page.total : null;
          const next = page.nextStartIndex;
          more = next > offset && (total !== null ? next < total : next - offset >= pageSize);
          offset = next;
        } while (more && offset < desired);
        this.items = [...unique.values()]; this.total = total;
        this.nextStart = offset; this.hasMore = more; this.state.loadedCount = offset;
        this.count.textContent = total === null ? '' : `${total} ${total === 1 ? this.singular : this.plural}`;
        this.renderItems();
      }
      if (!current()) return;
      this.results.removeAttribute('aria-busy'); this.loading = false;
      const target = append ? `${this.singular}:${this.items[firstNew]?.Id || ''}` : requestedFocus;
      if (focusRevision === this.focusRevision && (this.element.contains(document.activeElement) || document.activeElement === document.body)) {
        if (target) this.focus(target, true);
        else if (!this.state.focusId || this.state.focusId === `tab:${this.state.tab}`) this.focusFirstResult();
        if (this.restoring) this.content.scrollTop = this.initialScroll;
      }
      this.initialScroll = 0; this.restoring = false;
      this.save();
    } catch {
      if (!current()) return;
      this.loading = false; this.results.removeAttribute('aria-busy');
      const error = el('div', 'tvl-library-empty');
      const retry = button('Tentar novamente', '', 'tvl-primary', () => { this.nextFocus = requestedFocus; void this.loadResults(append); });
      retry.dataset.focusId = 'retry';
      error.append(el('h2', '', `${this.title} indisponíveis`), el('p', '', 'Verifique sua conexão e tente novamente.'), retry);
      if (append) {
        this.results.querySelector('.tvl-library-more')?.remove();
        this.results.querySelector('.tvl-library-empty')?.remove();
        this.results.append(error);
      } else replace(this.results, error);
      this.restoring = false; this.initialScroll = 0;
      if (focusRevision === this.focusRevision && (this.element.contains(document.activeElement) || document.activeElement === document.body)) this.focus('retry');
    }
  }

  private renderItems(): void {
    const heading = el('div', 'tvl-library-section-heading');
    let label = this.state.tab === 'watchlist' ? 'Sua lista' : this.state.tab === 'favorites' ? 'Seus favoritos' : this.state.genreName || (this.isShows ? 'Todas as séries' : 'Todos os filmes');
    if (this.state.search) label = `Resultados para “${this.state.search}”`;
    else if (this.state.letter) label += ` · ${this.state.letter}`;
    heading.append(el('h2', '', label));
    if (this.state.tab === 'genres' && this.state.genreId) {
      const all = button('Todos os gêneros', 'back', 'tvl-library-all-genres', () => this.change({ genreId: undefined, genreName: undefined, letter: '', search: '' }, 'tab:genres'));
      all.dataset.focusId = 'all-genres'; heading.append(all);
    }
    replace(this.results, heading);
    if (this.items.length) this.results.append(this.grid(this.items, label));
    else this.results.append(this.empty(this.state.tab === 'watchlist' ? 'Nenhum título salvo encontrado' : this.state.tab === 'favorites' ? 'Nenhum favorito encontrado' : `Nenhum(a) ${this.singular} encontrado(a)`,
      this.state.search || this.state.letter || this.state.genreId ? 'Tente uma busca ou filtro diferente.' : this.state.tab === 'watchlist' ? `Adicione ${this.plural} à sua lista a partir dos detalhes${this.isShows ? '' : ' ou trailers'}.` : this.state.tab === 'favorites' ? `Seus(suas) ${this.plural} favoritos(as) aparecerão aqui.` : `${this.title} nesta biblioteca aparecerão aqui.`));
    if (this.hasMore) {
      const footer = el('div', 'tvl-library-more');
      const more = button('Mostrar mais', '', 'tvl-primary', () => { void this.loadResults(true); });
      more.dataset.focusId = 'show-more'; footer.append(more); this.results.append(footer);
    }
    this.artwork(this.items[0]);
  }

  private renderSuggestions(sections: SuggestionSection[]): void {
    replace(this.results);
    let first: Item | undefined;
    for (const [index, section] of sections.entries()) {
      if (!section.items.length) continue;
      first ||= section.items[0];
      const group = el('section', 'tvl-library-suggestion-section');
      group.setAttribute('aria-label', section.title);
      group.append(el('h2', 'tvl-library-section-title', section.title), this.grid(section.items, section.title, `${this.singular}:section-${index}`));
      this.results.append(group);
    }
    if (!first) this.results.append(this.empty('Sem sugestões ainda', 'As sugestões aparecerão conforme sua biblioteca crescer.'));
    this.artwork(first);
  }

  private renderGenres(genres: Item[]): void {
    this.count.textContent = `${genres.length} ${genres.length === 1 ? 'gênero' : 'gêneros'}`;
    const grid = el('div', 'tvl-library-genres');
    for (const genre of genres) {
      const card = button(genre.Name, 'chevron', 'tvl-library-genre', () => this.change({ genreId: genre.Id, genreName: genre.Name, search: '', letter: '' }, ''));
      card.dataset.genreId = genre.Id; card.dataset.focusId = `genre:${genre.Id}`;
      grid.append(card);
    }
    replace(this.results, el('h2', 'tvl-library-section-title', 'Explorar gêneros'), genres.length ? grid : this.empty('Nenhum gênero ainda', `Gêneros da sua biblioteca de ${this.plural} aparecerão aqui.`));
    this.artwork();
  }

  private grid(items: Item[], label: string, focusPrefix = this.singular): HTMLElement {
    const grid = el('div', 'tvl-library-grid');
    grid.setAttribute('role', 'list'); grid.setAttribute('aria-label', label);
    for (const item of items) {
      const entry = el('div', 'tvl-library-entry'); entry.setAttribute('role', 'listitem');
      const card = el('button', 'tvl-library-card'); card.type = 'button';
      card.dataset.libraryItem = item.Id;
      card.dataset.itemId = item.Id;
      card.dataset.id = item.Id;
      if (this.isShows) card.dataset.showItem = item.Id; else card.dataset.movieItem = item.Id;
      card.dataset.focusId = `${focusPrefix}:${item.Id}`;
      const episode = item.Type === 'Episode';
      const title = episode && item.SeriesName ? item.SeriesName : item.Name;
      const numbering = [item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : '', item.IndexNumber != null ? `E${item.IndexNumber}` : ''].filter(Boolean).join(' · ');
      const episodeLabel = [numbering, item.Name].filter(Boolean).join(' · ');
      card.setAttribute('aria-label', episode ? `${title}: ${episodeLabel}` : title);
      const art = picture(this.api.image(item, 'thumb'), 'tvl-library-art');
      const placeholder = el('span', 'tvl-library-placeholder'); placeholder.setAttribute('aria-hidden', 'true');
      placeholder.append(icon('grid')); art.append(placeholder);
      if (item.UserData?.IsFavorite) { const favorite = el('span', 'tvl-library-favorite'); favorite.setAttribute('aria-label', 'Favorito'); favorite.append(icon('heart')); art.append(favorite); }
      if (resumePosition(item) > 0 && progress(item) > 0) {
        const value = progress(item);
        const track = el('span', 'tvl-library-progress');
        track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', 'Progresso da reprodução');
        track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(Math.round(value)));
        const fill = el('span'); fill.style.width = `${value}%`; track.append(fill); art.append(track);
      }
      const caption = el('div', 'tvl-library-caption'); caption.append(el('h3', '', title));
      if (episode) caption.append(el('p', 'tvl-library-episode', episodeLabel));
      const meta = [item.ProductionYear ? String(item.ProductionYear) : '', item.OfficialRating || ''].filter(Boolean);
      if (meta.length) caption.append(el('p', '', meta.join(' · ')));
      card.append(art, caption);
      card.addEventListener('click', (event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        if (isCardAction(target, card)) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if (!this.disposed) { this.save(); this.options.navigate(item.Id); }
      });
      entry.append(card); grid.append(entry);
    }
    return grid;
  }

  private empty(title: string, message: string): HTMLElement {
    const empty = el('div', 'tvl-library-empty'); empty.append(el('h2', '', title), el('p', '', message)); return empty;
  }

  private artwork(item?: Item): void {
    this.hero.querySelector('.tvl-library-backdrop')?.remove();
    const art = picture(item ? this.api.image(item, 'backdrop') : null, 'tvl-library-backdrop');
    art.setAttribute('aria-hidden', 'true'); this.hero.prepend(art);
  }

  private focus(id: string, fallback = false, record = true): void {
    const control = Array.from(this.element.querySelectorAll<HTMLElement>('[data-focus-id]')).find(node => node.dataset.focusId === id);
    if (control) {
      this.internalFocus = true;
      control.focus({ preventScroll: true });
      this.internalFocus = false;
      if (id.startsWith(`${this.singular}:`) || id.startsWith('genre:')) control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (record) { this.state.focusId = id; this.save(); }
    }
    else if (fallback) this.focusFirstResult();
  }

  private focusFirstResult(): void {
    const result = this.results.querySelector<HTMLElement>('[data-library-item], [data-genre-id]')
      || this.results.querySelector<HTMLElement>('button');
    const id = result?.dataset.focusId;
    if (id) this.focus(id);
  }

  destroy(): void {
    this.save(); this.disposed = true; this.revision++;
    this.stopWatchlist(); this.removeRemote(); this.element.remove();
  }
}
