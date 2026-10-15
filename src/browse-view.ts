import type { Item, ItemPage, MediaApi, SuggestionSection } from './types';
import type { MusicKind } from './browse-api';
import { button, el, icon, picture, replace, isCardAction } from './dom';
import { attachRemote } from './remote';
import { plainText, resumePosition, runtime } from './utils';
import { AdminItemActions } from './admin-item-actions';

export type BrowseTab = MusicKind | 'suggestions' | 'genres' | 'all' | 'active' | 'completed';
export type BrowseState = { tab: BrowseTab; search: string; letter: string; genreId?: string; genreName?: string;
  favorite?: boolean; loadedCount: number; focusId?: string; scrollTop?: number };
type Options = { kind: 'music' | 'recordings'; tab?: BrowseTab; parentId?: string; item?: Item;
  back: () => void; navigate: (id: string) => void; navigateRoute: (hash: string) => void;
  openNative?: (item: Item) => void;
  focusId?: string; state?: BrowseState; onState?: (state: BrowseState) => void };
const pageSize = 48;
const playable = (item: Item) => ['Movie','Episode','Video','Recording','Audio','MusicAlbum','Playlist'].includes(item.Type || '')
  && item.PlayAccess !== 'None' && !item.IsMissing && !item.IsVirtualItem && item.LocationType !== 'Virtual';

/** Music and recordings share the same remote navigation and artwork. */
export class BrowseView {
  readonly element = el('section', 'tvl-root tvl-keyboard tvl-browse-view');
  private content = el('div', 'tvl-content');
  private hero = el('div', 'tvl-browse-hero');
  private controls = el('div', 'tvl-browse-controls');
  private results = el('div', 'tvl-browse-results');
  private status = el('p', 'tvl-browse-status');
  private state: BrowseState;
  private items: Item[] = [];
  private selected?: Item;
  private nextStart = 0;
  private total = 0;
  private revision = 0;
  private focusRevision = 0;
  private disposed = false;
  private loading = false;
  private launching = false;
  private launchRevision = 0;
  private launchTimer?: number;
  private internalFocus = false;
  private initialFocus: string;
  private initialScroll: number;
  private restored = false;
  private removeRemote: () => void;
  private adminActions: AdminItemActions;
  private get title(): string { return this.options.kind === 'music' ? 'Música' : 'Gravações'; }
  private get playlist(): boolean { return this.options.item?.Type === 'Playlist'; }
  private entryKey(item: Item): string { return this.playlist ? item.PlaylistItemId || item.Id : item.Id; }

  constructor(private api: MediaApi, private options: Options) {
    this.state = { tab: options.tab || (options.kind === 'music' ? 'albums' : 'all'), search: '', letter: '', loadedCount: 0, ...options.state };
    this.initialFocus = options.focusId || this.state.focusId || '';
    this.initialScroll = this.state.scrollTop || 0;
    this.element.id = 'tv-layout'; this.element.dataset.pane = options.kind;
    this.element.classList.toggle('tvl-browse-music', options.kind === 'music');
    this.element.classList.toggle('tvl-browse-playlist', this.playlist);
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', options.item ? `Detalhes de ${options.item.Name}` : this.title);
    const header = el('header', 'tvl-header');
    const back = button('Voltar', 'back', 'tvl-back', options.back); back.dataset.focusId = 'back';
    header.append(back, el('span', 'tvl-browse-page-title', this.title));
    if (options.kind === 'music') {
      const queue=button('Reproduzindo agora','play','',()=>options.navigateRoute('#/queue'));queue.dataset.focusId='now-playing';header.append(queue);
    }
    this.status.setAttribute('role', 'status');
    this.content.append(header, this.hero, this.controls, this.status, this.results); this.element.append(this.content);
    this.adminActions = new AdminItemActions(api, this.element, { openNative: options.openNative, announce: message => { this.status.textContent = message; },
      updated: () => { void this.refreshMetadata(); } });
    this.renderHero(options.item); this.renderControls();
    this.removeRemote = attachRemote(this.element, options.back);
    this.element.addEventListener('focusin', event => {
      if (this.internalFocus) return;
      const id = (event.target as HTMLElement).dataset.focusId;
      if (id) { this.focusRevision++; this.state.focusId = id; this.save(); }
    });
    this.content.addEventListener('scroll', () => { if (this.restored) this.save(); }, { passive: true });
  }

  async load(): Promise<void> { await this.fetch(); }
  private save(): void {
    if (this.restored) this.state.scrollTop = this.content.scrollTop;
    if (!this.disposed) this.options.onState?.({ ...this.state });
  }
  private focus(id: string, fallback = false): void {
    const target = Array.from(this.element.querySelectorAll<HTMLElement>('[data-focus-id]')).find(node => node.dataset.focusId === id)
      || (fallback ? this.results.querySelector<HTMLElement>('[data-browse-item], [data-library-id], [data-genre-id]')
        || this.results.querySelector<HTMLElement>('button') : null);
    if (!target) return;
    this.internalFocus = true; target.focus({ preventScroll: true }); this.internalFocus = false;
    if (target.closest('.tvl-browse-results')) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.state.focusId = target.dataset.focusId; this.save();
  }
  private change(change: Partial<BrowseState>, focus: string): void {
    this.state = { ...this.state, ...change, loadedCount: 0, scrollTop: 0, focusId: focus || undefined };
    this.initialFocus = focus; this.initialScroll = 0; this.restored = true;
    this.content.scrollTop = 0; this.items = []; this.renderControls(); this.focus(focus); this.save(); void this.fetch();
  }
  private renderControls(): void {
    replace(this.controls);
    if (this.options.item) return;
    const nav = el('nav', 'tvl-browse-tabs'); nav.setAttribute('aria-label', `Navegar em ${this.title.toLowerCase()}`);
    const tabs: [BrowseTab,string][] = this.options.kind === 'recordings'
      ? [['all','Todas as gravações'],['active','Gravando agora'],['completed','Concluídas']]
      : [['albums','Álbuns'],['suggestions','Sugestões'],['albumArtists','Artistas do álbum'],['artists','Artistas'],['songs','Músicas'],['genres','Gêneros'],['playlists','Playlists']];
    for (const [tab,label] of tabs) {
      const control = button(label, '', 'tvl-browse-tab', () => this.change({ tab, search: '', letter: '', genreId: undefined, genreName: undefined }, `tab:${tab}`));
      control.dataset.focusId = `tab:${tab}`; control.setAttribute('aria-pressed', String(this.state.tab === tab)); nav.append(control);
    }
    const nativeLinks = this.options.kind === 'recordings'
      ? [['Guia de TV','#/livetv?tab=1'],['Programação','#/livetv?tab=4'],['Gravações de séries','#/livetv?tab=5']]
      : [];
    for (const [label,route] of nativeLinks) {
      const link=button(label,'','tvl-browse-tab',()=>this.options.navigateRoute(route));link.dataset.focusId=`native:${label}`;nav.append(link);
    }
    if (this.options.kind === 'music') {
      const favorites = button('Favoritos', 'heart', 'tvl-browse-tab', () => this.change({ favorite: !this.state.favorite,
        tab: this.state.tab === 'genres' || this.state.tab === 'suggestions' ? 'albums' : this.state.tab }, 'favorites'));
      favorites.dataset.focusId = 'favorites'; favorites.setAttribute('aria-pressed', String(!!this.state.favorite)); nav.append(favorites);
    }
    const form = el('form', 'tvl-browse-search'); form.setAttribute('role', 'search');
    const input = el('input'); input.type = 'search'; input.placeholder = `Buscar em ${this.title.toLowerCase()}`;
    input.setAttribute('aria-label', input.placeholder); input.value = this.state.search; input.dataset.focusId = 'search'; input.autocomplete = 'off';
    const submit = button('Buscar', '', 'tvl-browse-submit', () => {}); submit.type = 'submit'; submit.dataset.focusId = 'search-submit';
    form.append(input, submit); form.addEventListener('submit', event => {
      event.preventDefault(); this.change({ search: input.value.trim(), letter: '',
        tab: this.state.tab === 'genres' || this.state.tab === 'suggestions' ? 'albums' : this.state.tab }, 'search');
    });
    if (this.state.search) { const clear = button('Limpar busca', 'close', '', () => this.change({ search: '' }, 'search')); clear.dataset.focusId = 'clear-search'; form.append(clear); }
    this.controls.append(nav, form);
    if (this.options.kind === 'music' && !['genres','suggestions'].includes(this.state.tab)) {
      const alphabet = el('nav', 'tvl-browse-alphabet'); alphabet.setAttribute('aria-label', 'Navegar por título');
      for (const letter of ['', '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
        const control = button(letter || 'Todos', '', '', () => this.change({ letter }, `letter:${letter || 'all'}`));
        control.dataset.focusId = `letter:${letter || 'all'}`; control.setAttribute('aria-pressed', String(this.state.letter === letter)); alphabet.append(control);
      }
      this.controls.append(alphabet);
    }
  }
  private async getPage(startIndex: number): Promise<ItemPage> {
    if (this.options.kind === 'recordings') return this.api.getRecordings({ status: this.state.tab === 'active' ? 'active' : this.state.tab === 'completed' ? 'completed' : 'all',
      parentId: this.options.parentId, search: this.state.search, startIndex, limit: pageSize });
    const item = this.options.item;
    if (this.playlist) return this.api.getPlaylistItems(item!.Id, { startIndex, limit: pageSize });
    return this.api.getMusic({ kind: item?.Type === 'MusicAlbum' ? 'songs' : item?.Type === 'MusicArtist' ? 'albums' : this.state.tab as MusicKind,
      parentId: this.options.parentId, albumId: item?.Type === 'MusicAlbum' ? item.Id : undefined,
      artistId: item?.Type === 'MusicArtist' ? item.Id : undefined, search: this.state.search,
      favorite: this.state.favorite, letter: this.state.letter, genreId: this.state.genreId, startIndex, limit: pageSize });
  }
  private async fetch(append = false): Promise<void> {
    if (this.disposed || append && this.loading) return;
    const revision = ++this.revision, focusRevision = this.focusRevision;
    const current = () => !this.disposed && revision === this.revision;
    const requestedFocus = this.initialFocus; this.initialFocus = '';
    this.loading = true; this.results.setAttribute('aria-busy','true');
    const oldCount = this.items.length;
    if (!append) { replace(this.results, el('p','tvl-loading',`Carregando ${this.title.toLowerCase()}…`)); if (!this.element.contains(document.activeElement)) this.focus('back'); }
    try {
      if (this.options.item && !['MusicAlbum','MusicArtist','Playlist'].includes(this.options.item.Type || '')) {
        replace(this.results, el('p','tvl-browse-detail-note', this.options.item.Type === 'Audio' ? 'Pronto para ouvir.' : 'Pronto para assistir.'));
      } else if (!this.options.item && this.state.tab === 'suggestions') {
        const sections = await this.api.getMusicSuggestions(this.options.parentId); if (!current()) return; this.renderSections(sections);
      } else if (!this.options.item && this.state.tab === 'genres') {
        const genres = await this.api.getMusicGenres(this.options.parentId); if (!current()) return; this.renderGenres(genres);
      } else {
        let start = append ? this.nextStart : 0;
        const desired = append ? start + pageSize : Math.max(pageSize, this.state.loadedCount);
        const found = new Map((append ? this.items : []).map(item => [this.entryKey(item),item]));
        let total = 0;
        do {
          const result = await this.getPage(start); if (!current()) return;
          for (const item of result.items) found.set(this.entryKey(item),item);
          total = result.total;
          if (result.nextStartIndex <= start && start < total) throw new Error('The page did not advance.');
          start = result.nextStartIndex;
        } while (start < total && start < desired);
        this.items = [...found.values()]; this.nextStart = start; this.total = total; this.state.loadedCount = start; this.renderItems();
      }
      if (!current()) return;
      this.loading = false; this.results.removeAttribute('aria-busy');
      if (focusRevision === this.focusRevision && (this.element.contains(document.activeElement) || document.activeElement === document.body)) {
        const target = append && this.items[oldCount] ? `item:${this.entryKey(this.items[oldCount])}` : requestedFocus;
        if (target) this.focus(target, true);
        else if (this.options.item) this.focus(playable(this.options.item) && (!this.playlist || this.items.length) ? 'play' : '', true);
        else this.focus('', true);
        if (!this.restored && this.initialScroll) this.content.scrollTop = this.initialScroll;
      }
      this.restored = true; this.initialScroll = 0; this.save();
    } catch {
      if (!current()) return;
      this.loading = false; this.results.removeAttribute('aria-busy');
      const error = el('div', 'tvl-browse-empty');
      const retry = button('Tentar novamente', '', 'tvl-primary', () => { this.initialFocus = requestedFocus; void this.fetch(append); }); retry.dataset.focusId = 'retry';
      error.append(el('h2','',`${this.title} indisponível`), el('p','','Verifique sua conexão e tente novamente.'), retry);
      if (append) { this.results.querySelector('.tvl-browse-more')?.remove(); this.results.querySelector('.tvl-browse-empty')?.remove(); this.results.append(error); }
      else replace(this.results,error);
      if (focusRevision === this.focusRevision && (this.element.contains(document.activeElement) || document.activeElement === document.body)) this.focus('retry');
    }
  }
  private renderSections(sections: SuggestionSection[]): void {
    replace(this.results,...sections.filter(section => section.items.length).map((section,index)=>this.section(section,`section-${index}`)));
    const first = sections.find(section => section.items.length)?.items[0]; this.renderHero(first);
    if (!first) this.results.append(this.empty('Nada aqui ainda','Seu histórico de reprodução e músicas adicionadas recentemente aparecerão aqui.'));
  }
  private section(section: SuggestionSection, prefix: string): HTMLElement {
    const group = el('section','tvl-browse-section'); group.setAttribute('aria-label',section.title);
    group.append(el('h2','',section.title),this.grid(section.items,prefix,true)); return group;
  }
  private renderGenres(genres: Item[]): void {
    const grid = el('div','tvl-browse-genres');
    for (const genre of genres) {
      const card = button(genre.Name,'chevron','tvl-browse-genre',()=>this.change({tab:'albums',genreId:genre.Id,genreName:genre.Name},''));
      card.dataset.genreId=genre.Id; card.dataset.focusId=`genre:${genre.Id}`; grid.append(card);
    }
    replace(this.results,el('h2','','Navegar por gêneros'),genres.length?grid:this.empty('Nenhum gênero ainda','Os gêneros musicais aparecerão aqui.'));
  }
  private renderItems(): void {
    const name = this.playlist ? this.options.item?.MediaType === 'Video' ? 'Títulos' : 'Faixas'
      : this.options.item?.Type === 'MusicAlbum' ? 'Faixas' : this.options.item?.Type === 'MusicArtist' ? 'Álbuns'
      : this.state.search ? `Resultados para “${this.state.search}”` : this.state.genreName || (this.state.tab === 'playlists' ? 'Playlists' : this.state.tab === 'songs' ? 'Músicas' : this.options.kind === 'recordings' ? 'Suas gravações' : this.state.tab === 'artists' || this.state.tab === 'albumArtists' ? 'Artistas' : 'Álbuns');
    const heading = el('div','tvl-browse-section-heading'); heading.append(el('h2','',name),el('span','',`${this.total} ${this.total===1?'item':'itens'}`));
    replace(this.results,heading);
    if (this.state.genreId) { const clear = button('Todos os gêneros','back','',()=>this.change({tab:'genres',genreId:undefined,genreName:undefined},'tab:genres')); clear.dataset.focusId='all-genres'; heading.append(clear); }
    if (this.items.length) this.results.append(this.grid(this.items,'item',false));
    else this.results.append(this.empty(this.playlist?'Esta playlist está vazia':this.state.favorite?'Nenhum favorito encontrado':'Nada encontrado',this.state.search||this.state.genreId||this.state.letter?'Tente uma busca ou filtro diferente.':this.playlist?'Os itens disponíveis nesta playlist aparecerão aqui.':'Os itens da sua biblioteca do Jellyfin aparecerão aqui.'));
    if (this.playlist) { const play = this.hero.querySelector<HTMLButtonElement>('[data-focus-id=play]'); if (play) play.disabled = !this.items.length; }
    if (this.nextStart < this.total) {
      const more = button('Mostrar mais','','tvl-primary',()=>{void this.fetch(true);}); more.dataset.focusId='show-more';
      const footer=el('div','tvl-browse-more');footer.append(more);this.results.append(footer);
    }
    if (!this.options.item) this.renderHero(this.items[0]);
  }
  private grid(items: Item[], prefix: string, row: boolean): HTMLElement {
    const grid = el('div',this.playlist?'tvl-browse-tracks':row?'tvl-browse-grid tvl-browse-row':'tvl-browse-grid'); grid.setAttribute('role','list');
    for (const [index,item] of items.entries()) {
      const entry=el('div','tvl-browse-entry');entry.setAttribute('role','listitem');
      const card=el('button','tvl-browse-card');card.type='button';card.dataset.browseItem=item.Id;card.dataset.itemId=item.Id;card.dataset.id=item.Id;card.dataset.itemType=item.Type||'';card.dataset.focusId=`${prefix}:${this.entryKey(item)}`;
      if(this.playlist){card.dataset.playlistEntry=item.PlaylistItemId||'';card.append(el('span','tvl-browse-track-number',String(index+1)));}
      const episode=item.Type==='Episode';const label=episode&&item.SeriesName?`${item.SeriesName}: ${item.Name}`:item.Name;
      card.setAttribute('aria-label',this.playlist||this.options.item?.Type==='MusicAlbum'?`Reproduzir ${label}`:label);
      card.append(picture(this.api.image(item,'thumb'),'tvl-browse-art'));
      const copy=el('div','tvl-browse-caption');copy.append(el('h3','',episode&&item.SeriesName?item.SeriesName:item.Name));
      const sub=episode?[item.ParentIndexNumber!=null?`S${item.ParentIndexNumber}`:'',item.IndexNumber!=null?`E${item.IndexNumber}`:'',item.Name].filter(Boolean).join(' · ')
        : item.AlbumArtist || item.Artists?.join(', ') || (item.ProductionYear?String(item.ProductionYear):item.Type==='MusicArtist'?'Artista':'');
      if(sub)copy.append(el('p','',sub));
      if(item.IsInProgress||item.Status==='InProgress')copy.append(el('span','tvl-browse-live','Gravando agora'));
      if(item.UserData?.IsFavorite){const favorite=el('span','tvl-browse-heart');favorite.setAttribute('aria-label','Favorito');favorite.append(icon('heart'));card.append(favorite);}
      card.append(copy);if(this.playlist){const duration=item.RunTimeTicks?Math.floor(item.RunTimeTicks/10_000_000):0;card.append(el('span','tvl-browse-track-duration',duration?`${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')}`:''));}
      card.addEventListener('focus',()=>{if(!this.options.item)this.renderHero(item);});
      card.addEventListener('click',(event: MouseEvent)=>{
        const target = event.target as HTMLElement | null;
        if (isCardAction(target, card)) {
          event.stopPropagation();
          event.preventDefault();
          return;
        }
        if(this.disposed)return;this.save();if(this.playlist)void this.play(this.options.item!,item.PlaylistItemId);else if(this.options.item?.Type==='MusicAlbum')void this.play(item);else this.options.navigate(item.Id);
      });
      entry.append(card, this.adminActions.button(item));grid.append(entry);
    }
    return grid;
  }
  private renderHero(item?: Item): void {
    this.selected=item;replace(this.hero);
    const backdrop=picture(item?this.api.image(item,'backdrop')||this.api.image(item,'thumb'):null,'tvl-browse-backdrop');backdrop.setAttribute('aria-hidden','true');
    const copy=el('div','tvl-browse-hero-copy');
    copy.append(el('p','tvl-browse-eyebrow',this.playlist?'PLAYLIST':this.options.item?.Type==='MusicArtist'?'ARTISTA':this.options.item?.Type==='MusicAlbum'?'ÁLBUM':this.title.toUpperCase()));
    copy.append(el('h1','',item?.Type==='Episode'&&item.SeriesName?item.SeriesName:item?.Name||this.title));
    if(item){
      const meta=[item.Type==='Episode'?item.Name:'',item.AlbumArtist||item.Artists?.join(', ')||'',item.ProductionYear?String(item.ProductionYear):'',runtime(item.RunTimeTicks),item.IsInProgress||item.Status==='InProgress'?'Gravando agora':''].filter(Boolean);
      if(meta.length)copy.append(el('p','tvl-browse-meta',meta.join(' · ')));
      const overview=plainText(item.Overview);if(overview)copy.append(el('p','tvl-browse-overview',overview));
      const actions=el('div','tvl-browse-actions');
      if(playable(item)){const play=button(item.Type==='Playlist'?'Reproduzir playlist':resumePosition(item)?'Retomar':item.Type==='MusicAlbum'?'Reproduzir álbum':'Reproduzir','play','tvl-primary',()=>{void this.play(item);});play.dataset.focusId='play';actions.append(play);}
      if(!this.options.item){const details=button('Detalhes','info','',()=>this.options.navigate(item.Id));details.dataset.focusId='details';actions.append(details);}
      if(this.options.item && this.options.kind==='music'){
        const favorite=button(item.UserData?.IsFavorite?'Remover dos favoritos':'Adicionar aos favoritos','heart','',()=>{void this.favorite(item);});favorite.dataset.focusId='favorite-item';actions.append(favorite);
      }
      actions.append(this.adminActions.button(item));
      copy.append(actions);
    } else copy.append(el('p','tvl-browse-overview','Explore sua biblioteca do Jellyfin.'));
    this.hero.append(backdrop,copy);
  }
  private async play(item: Item, entryId?: string): Promise<void> {
    if(this.launching||this.disposed)return;this.launching=true;
    const revision=++this.launchRevision;
    const current=()=>!this.disposed&&this.launching&&revision===this.launchRevision;
    const focused=document.activeElement as HTMLElement|null;focused?.setAttribute('aria-busy','true');
    this.status.textContent=`Iniciando ${item.Name}…`;
    const finish=(message:string)=>{if(!current())return;window.clearTimeout(this.launchTimer);this.launching=false;focused?.removeAttribute('aria-busy');this.status.textContent=message;};
    this.launchTimer=window.setTimeout(()=>finish('A reprodução não foi iniciada. Tente novamente.'),15_000);
    try {
      if(item.Type==='Playlist')await this.api.playPlaylist(item,entryId,current);
      else await this.api.play(item,resumePosition(item),current);
      // Audio remains on this page. Dispatch is not confirmation of playback;
      // native Now playing exposes the current device's actual playback state.
      if(['Audio','MusicAlbum','Playlist'].includes(item.Type||''))finish('Reprodução solicitada.');
    } catch(error) {finish(error instanceof Error?error.message:'Não foi possível iniciar a reprodução. Tente novamente.');}
  }
  private async favorite(item: Item): Promise<void> {
    if(this.launching||this.disposed)return;this.launching=true;const next=!item.UserData?.IsFavorite;
    try{await this.api.setFavorite(item.Id,next);if(this.disposed)return;item.UserData={...item.UserData,IsFavorite:next};this.renderHero(item);this.focus('favorite-item');this.status.textContent=next?'Adicionado aos favoritos.':'Removido dos favoritos.';}
    catch{if(!this.disposed)this.status.textContent='Não foi possível atualizar os favoritos. Tente novamente.';}finally{this.launching=false;}
  }
  private async refreshMetadata(): Promise<void> {
    if (this.disposed) return;
    const selected = this.options.item || this.selected;
    if (selected) {
      try {
        const updated = await this.api.getItem(selected.Id);
        if (this.disposed) return;
        if (this.options.item?.Id === selected.Id) this.options.item = updated;
        if (this.selected?.Id === selected.Id) this.renderHero(updated);
      } catch { /* Native dialogs report save failures; retain usable artwork. */ }
    }
    if (!this.disposed) await this.fetch();
  }
  private empty(title:string,message:string):HTMLElement{const box=el('div','tvl-browse-empty');box.append(el('h2','',title),el('p','',message));return box;}
  destroy():void{this.save();this.disposed=true;this.revision++;this.launchRevision++;window.clearTimeout(this.launchTimer);this.adminActions.destroy();this.removeRemote();this.element.remove();}
}
