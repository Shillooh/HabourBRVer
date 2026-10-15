import type { Item, MediaApi } from './types';
import { button, el, icon, picture, replace, isCardAction } from './dom';
import { attachRemote } from './remote';
import { plainText } from './utils';
import { AdminItemActions } from './admin-item-actions';

type CollectionOptions = {
  item?: Item;
  parentId?: string;
  back: () => void;
  navigate: (id: string) => void;
  focusId?: string;
  openNative?: (item: Item) => void;
};

const typeNames: Record<string, string> = {
  Movie: 'Filme', Series: 'Série', Season: 'Temporada', Episode: 'Episódio',
  BoxSet: 'Coleção', MusicAlbum: 'Álbum', MusicArtist: 'Artista',
  Audio: 'Faixa', MusicVideo: 'Vídeo musical', Video: 'Vídeo',
  Book: 'Livro', Photo: 'Foto', PhotoAlbum: 'Álbum de fotos', Folder: 'Pasta',
  TvChannel: 'TV ao Vivo'
};

export class CollectionView {
  readonly element = el('section', 'tvl-root tvl-keyboard tvl-collection-view');
  private content = el('div', 'tvl-content');
  private hero = el('div', 'tvl-collection-hero');
  private count = el('p', 'tvl-collection-count');
  private body = el('div', 'tvl-collection-body');
  private backButton: HTMLButtonElement;
  private removeRemote: () => void;
  private disposed = false;
  private revision = 0;
  private focusId: string;
  private adminActions: AdminItemActions;

  constructor(private api: MediaApi, private options: CollectionOptions) {
    this.focusId = options.focusId || '';
    this.element.id = 'tv-layout';
    this.element.dataset.pane = 'collections';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', options.item ? `Coleção ${options.item.Name}` : 'Coleções');
    this.adminActions = new AdminItemActions(api, this.element, { openNative: options.openNative, updated: () => { void this.refreshMetadata(); },
      announce: message => { this.count.textContent = message; } });
    const header = el('header', 'tvl-header');
    this.backButton = button('Voltar', 'back', 'tvl-back', options.back);
    this.backButton.dataset.focusId = 'back';
    header.append(this.backButton);
    const copy = el('div', 'tvl-collection-hero-copy');
    copy.append(el('h1', 'tvl-collection-title', options.item?.Name || 'Coleções'));
    const overview = plainText(options.item?.Overview);
    if (overview) copy.append(el('p', 'tvl-collection-overview', overview));
    this.count.setAttribute('aria-live', 'polite');
    copy.append(this.count);
    if (options.item) copy.append(this.adminActions.button(options.item));
    this.hero.append(copy);
    this.setArtwork(options.item);
    this.content.append(header, this.hero, this.body);
    this.element.append(this.content);
    this.removeRemote = attachRemote(this.element, options.back);

  }

  async load(): Promise<void> {
    if (this.disposed) return;
    const revision = ++this.revision;
    const focused = document.activeElement as HTMLElement | null;
    const previousId = this.element.contains(focused) ? focused?.dataset.focusId : undefined;
    if (previousId && previousId !== 'back' && previousId !== 'retry') this.focusId = previousId;
    this.count.textContent = '';
    this.body.setAttribute('aria-busy', 'true');
    const loading = el('p', 'tvl-loading', this.options.item ? 'Carregando esta coleção…' : 'Carregando suas coleções…');
    loading.setAttribute('role', 'status');
    replace(this.body, loading);
    this.backButton.focus({ preventScroll: true });
    try {
      const items = this.options.item
        ? await this.api.getCollectionItems(this.options.item.Id)
        : await this.api.getCollectionList(this.options.parentId);
      if (!this.current(revision)) return;
      this.body.removeAttribute('aria-busy');
      this.count.textContent = `${items.length} ${this.options.item
        ? items.length === 1 ? 'item' : 'itens'
        : items.length === 1 ? 'coleção' : 'coleções'}`;
      // Prefer the collection's own artwork. A collection without an image can
      // borrow an actual member's backdrop rather than inventing cover artwork.
      const artwork = [this.options.item, ...items].find(item => item && this.api.image(item, 'backdrop'));
      this.setArtwork(artwork);
      if (!items.length) {
        const empty = el('div', 'tvl-collection-empty');
        empty.append(el('h2', '', this.options.item ? 'Esta coleção está vazia' : 'Nenhuma coleção ainda'),
          el('p', '', this.options.item ? 'Não há itens nesta coleção.' : 'Suas coleções aparecerão aqui.'));
        replace(this.body, empty);
        return;
      }
      const heading = el('h2', 'tvl-collection-section-title', this.options.item ? 'Nesta coleção' : 'Suas coleções');
      const list = el('div', 'tvl-collection-grid');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', this.options.item ? 'Itens da coleção' : 'Coleções');
      for (const item of items) {
        const entry = el('div', 'tvl-collection-entry');
        entry.setAttribute('role', 'listitem');
        entry.append(this.card(item), this.adminActions.button(item));
        list.append(entry);
      }
      replace(this.body, heading, list);
      // A foreign dialog may have taken focus while the request was pending.
      // Let that dialog keep it; otherwise restore the chosen member on return.
      if (document.activeElement === this.backButton || document.activeElement === document.body) {
        const cards = Array.from(list.querySelectorAll<HTMLButtonElement>('button'));
        const target = cards.find(card => card.dataset.focusId === this.focusId) || cards[0];
        target?.focus({ preventScroll: true });
        if (this.focusId) target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    } catch {
      if (!this.current(revision)) return;
      this.body.removeAttribute('aria-busy');
      const error = el('div', 'tvl-collection-empty');
      const retry = button('Tentar novamente', '', 'tvl-primary', () => { void this.load(); });
      retry.dataset.focusId = 'retry';
      error.append(el('h2', '', this.options.item ? 'Coleção indisponível' : 'Coleções indisponíveis'),
        el('p', '', 'Verifique sua conexão e tente novamente.'), retry);
      replace(this.body, error);
      if (document.activeElement === this.backButton || document.activeElement === document.body) retry.focus({ preventScroll: true });
    }
  }

  private current(revision: number): boolean {
    return !this.disposed && revision === this.revision;
  }

  private async refreshMetadata(): Promise<void> {
    if (this.disposed) return;
    if (this.options.item) {
      try {
        const item = await this.api.getItem(this.options.item.Id);
        if (this.disposed) return;
        this.options.item = item;
        this.element.setAttribute('aria-label', `Coleção ${item.Name}`);
        this.hero.querySelector<HTMLElement>('.tvl-collection-title')!.textContent = item.Name;
        this.hero.querySelector('.tvl-collection-overview')?.remove();
        const overview = plainText(item.Overview);
        if (overview) this.count.before(el('p', 'tvl-collection-overview', overview));
        this.hero.querySelector('.tvl-admin-item')?.replaceWith(this.adminActions.button(item));
        this.setArtwork(item);
      } catch { /* Keep the last known collection if its metadata read fails. */ }
    }
    if (!this.disposed) await this.load();
  }

  private setArtwork(item?: Item): void {
    this.hero.querySelector('.tvl-collection-backdrop')?.remove();
    const art = picture(item ? this.api.image(item, 'backdrop') : null, 'tvl-collection-backdrop');
    art.setAttribute('aria-hidden', 'true');
    this.hero.prepend(art);
  }

  private card(item: Item): HTMLButtonElement {
    const card = el('button', 'tvl-collection-card');
    card.type = 'button';
    card.dataset.collectionItem = item.Id;
    card.dataset.itemId = item.Id;
    card.dataset.id = item.Id;
    card.dataset.focusId = `item:${item.Id}`;
    card.setAttribute('aria-label', item.Name);
    const art = picture(this.api.image(item, 'thumb'), 'tvl-collection-art');
    const placeholder = el('span', 'tvl-collection-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.append(icon('grid'));
    art.append(placeholder);
    const caption = el('div', 'tvl-collection-caption');
    caption.append(el('h3', 'tvl-collection-card-title', item.Name));
    const metadata = [typeNames[item.Type || ''], item.ProductionYear ? String(item.ProductionYear) : ''].filter(Boolean);
    if (metadata.length) caption.append(el('p', 'tvl-collection-card-meta', metadata.join(' · ')));
    card.append(art, caption);
    card.addEventListener('focus', () => { this.focusId = card.dataset.focusId || ''; });
    card.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (isCardAction(target, card)) {
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (!this.disposed) this.options.navigate(item.Id);
    });
    return card;
  }

  destroy(): void {
    this.disposed = true;
    this.revision++;
    this.adminActions.destroy();
    this.removeRemote();
    this.element.remove();
  }
}
