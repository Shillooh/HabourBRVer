import type { Item, MediaApi } from './types';
import { button, el, picture, replace } from './dom';
import { attachRemote } from './remote';
import { emptyHomeCollections, parseHomeCollections, orderHomeItems, homeCollectionTabs, homeTabLabel, maxHomeCollectionTabs, maxSeasonalRows, validSeasonDate, isSeasonActive, shuffleHomeItems, defaultSeasonalAppearance, type HomeCollectionRow, type HomeCollectionTab, type HomeItemSort, type HomeSeasonalAppearance, type HomeSeasonalArtStyle } from './home-collection-settings';
import { createHomeCollectionStore, HomeCollectionSyncError, type HomeCollectionStore } from './home-collection-store';
import { cachedHomeRows, nativeHomeRows, type HomeAnchor } from './home-row-placement';
import { homeRowCard } from './home-row-card';
import { homeRowTabs } from './home-row-tabs';
import { getAllWatchlistItems, subscribeWatchlist } from './watchlist';
import { decorateSeasonalRow } from './home-seasonal-appearance';
import { dailyAdvent } from './home-advent';

const watchlistSource = '@watchlist';
const months = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const monthDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const seasonDateLabel = (value: string): string => validSeasonDate(value) ? `${Number(value.slice(3))} de ${months[Number(value.slice(0, 2)) - 1]}` : 'Escolha uma data';


type OrderEntry = { row: HomeCollectionRow } | { anchor: HomeAnchor };
export function combinedHomeOrder(rows: HomeCollectionRow[], anchors: HomeAnchor[]): OrderEntry[] {
  const known = new Set(anchors.map(anchor => anchor.key));
  return [
    ...rows.filter(row => row.placement === 'start').map(row => ({ row })),
    ...anchors.flatMap(anchor => [...rows.filter(row => row.placement === anchor.key).map(row => ({ row })), { anchor }] as OrderEntry[]),
    ...rows.filter(row => row.placement !== 'start' && !known.has(row.placement)).map(row => ({ row })),
  ];
}

/** A single editor beside a compact row list; edits are a local draft until saved. */
export class HomeCollectionEditor {
  readonly element = el('section', 'tvl-home-editor tvl-keyboard');
  private sidebar = el('nav', 'tvl-home-editor-sidebar');
  private workspace = el('div', 'tvl-home-editor-workspace');
  private preview?: HTMLElement;
  private disposePreviewAppearance?: () => void;
  private status = el('p', 'tvl-home-editor-status');
  private saveButton: HTMLButtonElement;
  private draft = emptyHomeCollections();
  private key: string;
  private store: HomeCollectionStore;
  private saving = false;
  private loadingSettings = false;
  private anchors: HomeAnchor[];
  private collections: Item[] = [];
  private selectedId = '';
  private selectedTabs = new Map<string, string>();
  private previewShuffleOrders = new Map<string, string[]>();
  private tab: 'content' | 'order' | 'position' | 'appearance' = 'content';
  private search = '';
  private items = new Map<string, Item[]>();
  private loading = new Set<string>();
  private errors = new Set<string>();
  private visibleItems = 60;
  private disposed = false;
  private ready = false;
  private removeRemote: () => void;
  private removeWatchlist: () => void;
  private watchlistRevision = 0;
  private restoreGlobalButton?: HTMLButtonElement;
  private targetUserName?: string;
  private users: { Id: string; Name: string }[] = [];
  private banner?: HTMLElement;
  private bannerHeader?: HTMLElement;
  private bannerText?: HTMLElement;
  private targetStatusBadge?: HTMLElement;
  private targetSelect?: HTMLSelectElement;
  private copyButton?: HTMLButtonElement;
  private resetAllButton?: HTMLButtonElement;
  private headingTitle?: HTMLElement;
  private headingEyebrow?: HTMLElement;

  constructor(private api: MediaApi, private onClose: (restore: boolean) => void, private scope: 'user' | 'global' = 'user', private targetUserId?: string) {
    const isGlobal = scope === 'global' || !!targetUserId;
    this.store = createHomeCollectionStore(api, targetUserId ? 'user' : scope, targetUserId); this.key = this.store.key; this.draft = this.store.cached;
    const home = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab');
    const native = home ? nativeHomeRows(home) : [];
    this.anchors = native.length ? native.map(({ key, label }) => ({ key, label })) : cachedHomeRows(this.key);
    this.selectedId = this.draft.rows[0]?.id || '';
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', isGlobal ? 'Configurações Globais das fileiras da Página Inicial' : 'Personalizar fileiras da Página Inicial');
    this.sidebar.setAttribute('aria-label', isGlobal ? 'Padrão Global das fileiras da Página Inicial' : 'Suas fileiras da Página Inicial');
    const panel = el('div', 'tvl-home-editor-panel');
    const header = el('header', 'tvl-home-editor-header');
    const title = el('div');
    this.headingEyebrow = el('p', 'tvl-home-editor-eyebrow', isGlobal ? 'PADRÃO GLOBAL · ' : 'PERSONALIZAR PÁGINA INICIAL');
    this.headingTitle = el('h1', '', isGlobal ? 'Fileiras de Coleções (Padrão Global)' : 'Suas fileiras da Página Inicial');
    if (isGlobal) {
      title.append(el('span', 'tvl-admin-badge', 'HabourBR Admin'), this.headingEyebrow, this.headingTitle);
    } else {
      title.append(this.headingEyebrow, this.headingTitle);
    }
    const actions = el('div', 'tvl-home-editor-actions');
    const cancel = button('Cancelar', 'close', '', () => this.close()); cancel.dataset.editorFocus = 'cancel';
    if (isGlobal) {
      this.copyButton = button('Copiar da minha conta', '', 'tvl-button-copy', () => { void this.copyFromAdmin(); });
      this.resetAllButton = button('Forçar em todos os usuários', '', 'tvl-button-danger', () => { void this.resetAllUsers(); });
      this.restoreGlobalButton = button('Restaurar para o Padrão Global', '', 'tvl-button-secondary', () => { void this.restoreGlobal(); });
      this.restoreGlobalButton.hidden = !this.targetUserId;
      if (this.targetUserId) this.resetAllButton.hidden = true;
      actions.append(this.copyButton, this.resetAllButton, this.restoreGlobalButton);
    } else {
      this.restoreGlobalButton = button('Usar Padrão do Servidor', '', 'tvl-button-secondary', () => { void this.restoreGlobal(); });
      this.restoreGlobalButton.hidden = true;
      actions.append(this.restoreGlobalButton);
    }
    this.saveButton = button(isGlobal ? (this.targetUserId ? 'Salvar para Usuário' : 'Salvar Padrão Global') : 'Salvar fileiras', 'check', 'tvl-primary', () => { void this.save(); });
    this.saveButton.disabled = true; this.saveButton.dataset.editorFocus = 'save';
    actions.append(cancel, this.saveButton); header.append(title, actions);
    this.status.setAttribute('role', 'status'); this.status.textContent = 'Carregando coleções…';
    const layout = el('div', 'tvl-home-editor-layout'); layout.append(this.sidebar, this.workspace);
    const introText = isGlobal
      ? 'Você está definindo o padrão global de coleções do HabourBR na Página Inicial para todos os usuários do servidor.'
      : (this.store.synced ? 'As fileiras salvas acompanham esta conta do Jellyfin em todos os seus dispositivos.' : 'Esta pré-visualização salva as opções neste dispositivo.');
    panel.append(header);
    if (isGlobal) {
      this.banner = el('div', 'tvl-admin-banner');
      this.bannerHeader = el('div', 'tvl-admin-banner-header');
      this.bannerHeader.innerHTML = '<span class="material-icons">shield</span><strong>MODO ADMINISTRADOR</strong>';
      this.bannerText = el('p', '', 'Você está editando o Padrão Global de coleções do HabourBR para a Página Inicial. Todos os usuários sem personalização própria receberão este catálogo.');
      this.banner.append(this.bannerHeader, this.bannerText);

      const selectorWrap = el('div', 'tvl-target-selector');
      const selectLabel = el('label');
      selectLabel.innerHTML = '<span class="material-icons">account_circle</span> Alvo da Edição:';
      this.targetSelect = el('select', 'tvl-target-select') as HTMLSelectElement;
      this.targetSelect.dataset.editorFocus = 'target-user';
      const defaultOpt = el('option', '', '🌐 Padrão Global (Todos os Usuários)');
      defaultOpt.value = '';
      this.targetSelect.append(defaultOpt);
      this.targetSelect.addEventListener('change', () => {
        const selectedId = this.targetSelect?.value || undefined;
        const norm = selectedId ? this.normalizeId(selectedId) : '';
        const user = this.users.find(u => this.normalizeId(u.Id) === norm);
        this.switchTarget(selectedId, user?.Name);
      });
      this.targetStatusBadge = el('span', 'tvl-target-override-status');
      this.targetStatusBadge.hidden = true;
      selectorWrap.append(selectLabel, this.targetSelect, this.targetStatusBadge);
      this.banner.append(selectorWrap);
      panel.append(this.banner);
      void this.loadUsers();
    }
    panel.append(el('p', 'tvl-home-editor-intro', introText), this.status, layout);
    this.element.append(panel);
    this.removeRemote = attachRemote(this.element, () => this.close());
    this.removeWatchlist = subscribeWatchlist(api, () => {
      this.watchlistRevision++; this.items.delete(watchlistSource); this.errors.delete(watchlistSource); this.loading.delete(watchlistSource);
      const row = this.selectedRow();
      if (row?.kind === 'watchlist') { if (this.tab === 'order') this.redraw(); else this.renderPreview(row); }
    });
  }
  async load(): Promise<void> {
    this.element.querySelector<HTMLElement>('[data-editor-focus="cancel"]')?.focus({ preventScroll: true });
    await this.loadCollections();
  }
  private async loadCollections(): Promise<void> {
    if (this.disposed || this.loadingSettings || this.saving) return;
    this.loadingSettings = true; this.ready = false; this.saveButton.disabled = true;
    this.disposePreviewAppearance?.(); this.disposePreviewAppearance = undefined;
    this.status.textContent = 'Carregando coleções e fileiras salvas…'; replace(this.sidebar); replace(this.workspace);
    try {
      const [collections, settings] = await Promise.all([this.api.getCollectionList(), this.store.load()]); if (this.disposed) return;
      this.draft = settings; this.selectedId = this.draft.rows[0]?.id || '';
      if (this.targetUserId && this.targetStatusBadge) {
        if (this.store.hasUserOverride) {
          this.targetStatusBadge.textContent = 'Personalização própria ativa';
          this.targetStatusBadge.className = 'tvl-target-override-status has-override';
          this.targetStatusBadge.hidden = false;
          if (this.restoreGlobalButton) {
            this.restoreGlobalButton.disabled = false;
            this.restoreGlobalButton.hidden = false;
          }
        } else {
          this.targetStatusBadge.textContent = 'Herdando Padrão Global do servidor';
          this.targetStatusBadge.className = 'tvl-target-override-status inherits-global';
          this.targetStatusBadge.hidden = false;
          if (this.restoreGlobalButton) {
            this.restoreGlobalButton.disabled = true;
            this.restoreGlobalButton.hidden = false;
          }
        }
      } else if (this.restoreGlobalButton) {
        this.restoreGlobalButton.hidden = !this.store.hasUserOverride;
      }
      this.collections = collections; this.ready = true; this.saveButton.disabled = false;
      this.status.textContent = collections.length ? '' : 'Nenhuma coleção disponível para esta conta ainda.'; this.redraw();
    } catch (error) {
      if (this.disposed) return;
      replace(this.workspace, button('Tentar novamente', '', 'tvl-primary', () => { void this.loadCollections(); }));
      this.status.textContent = error instanceof HomeCollectionSyncError ? error.message : 'Não foi possível carregar as coleções e fileiras salvas. Verifique sua conexão e tente novamente.';
    } finally { this.loadingSettings = false; }
  }
  private control(label: string, focus: string, action: () => void, className = ''): HTMLButtonElement {
    const control = button(label, '', className, action); control.dataset.editorFocus = focus; return control;
  }
  private selectedRow(): HomeCollectionRow | undefined {
    return this.draft.rows.flatMap(row => [row, ...(row.children || [])]).find(row => row.id === this.selectedId);
  }
  private parentOf(row: HomeCollectionRow): HomeCollectionRow | undefined {
    return this.draft.rows.find(group => group.kind === 'seasonal' && group.children?.includes(row));
  }
  private name(row: HomeCollectionRow): string {
    if (row.kind === 'seasonal') return 'Grupo sazonal';
    return row.title.trim() || (row.kind === 'watchlist' ? 'Minha Lista' : row.kind === 'collections' ? 'Coleções' : this.collections.find(item => item.Id === homeCollectionTabs(row)[0].collectionId)?.Name || 'Nova fileira de coleção');
  }
  private source(row: HomeCollectionRow): HomeCollectionTab | undefined {
    return row.tabs?.find(tab => tab.id === this.selectedTabs.get(row.id)) || row.tabs?.[0];
  }
  private sourceCollection(row: HomeCollectionRow): string { const source = this.source(row); return source ? source.collectionId : row.collectionIds[0] || ''; }
  private chooseSource(row: HomeCollectionRow, id: string, focus: string): void {
    this.selectedTabs.set(row.id, id); this.search = ''; this.visibleItems = 60; this.redraw(focus);
  }
  private sourceSwitch(row: HomeCollectionRow, preview = false): HTMLElement | undefined {
    if (!row.tabs?.length) return;
    const prefix = preview ? 'tvl-home-preview' : 'tvl-home-edit';
    const strip = homeRowTabs(row.tabs.map(tab => ({ id: tab.id, label: homeTabLabel(tab, this.collections.find(item => item.Id === tab.collectionId)) })), this.source(row)!.id,
      id => this.chooseSource(row, id, `${prefix}:${id}`), prefix);
    strip.querySelectorAll<HTMLElement>('[data-source-tab]').forEach(control => { control.dataset.editorFocus = `${prefix}:${control.dataset.sourceTab}`; });
    return strip;
  }
  private redraw(focus?: string): void {
    const restore = focus || (document.activeElement as HTMLElement)?.dataset.editorFocus;
    this.disposePreviewAppearance?.(); this.disposePreviewAppearance = undefined;
    replace(this.sidebar); replace(this.workspace); this.preview = undefined;
    const sidebarEntry = (row: HomeCollectionRow, child = false) => {
      const entry = this.control(this.name(row), `row:${row.id}`, () => {
        this.selectedId = row.id; this.search = ''; this.visibleItems = 60;
        if (child && this.tab === 'position') this.tab = 'content';
        this.redraw(`row:${row.id}`);
      }, `tvl-home-row-choice${child ? ' tvl-home-season-choice' : ''}`);
      entry.dataset.editorRow = row.id;
      entry.setAttribute('aria-pressed', String(row.id === this.selectedId));
      entry.append(el('small', '', row.kind === 'seasonal' ? `${row.children?.length || 0} fileira${row.children?.length === 1 ? '' : 's'} sazonal${row.children?.length === 1 ? '' : 'is'} · uma posição na Home`
        : child && row.season ? `${seasonDateLabel(row.season.start)} – ${seasonDateLabel(row.season.end)}`
        : row.kind === 'watchlist' ? 'Filmes e séries salvos' : row.kind === 'collections' ? `${row.collectionIds.length} coleções selecionadas`
        : `Fileira de itens em ${row.ranked ? 'destaque numerado' : 'pôster'}${row.tabs ? ` · ${row.tabs.length} abas` : ''}`));
      this.sidebar.append(entry);
    };
    for (const row of this.draft.rows) { sidebarEntry(row); if (row.kind === 'seasonal') row.children?.forEach(child => sidebarEntry(child, true)); }
    const add = el('div', 'tvl-home-editor-add');
    for (const kind of ['collections', 'items', 'watchlist', 'seasonal'] as const) {
      const control = this.control(kind === 'seasonal' ? 'Adicionar grupo sazonal' : kind === 'watchlist' ? 'Adicionar fileira da Minha Lista' : kind === 'collections' ? 'Adicionar fileira de coleções' : 'Adicionar fileira de itens de coleção', `add:${kind}`, () => {
        const row = this.newRow(kind);
        this.draft.rows.push(row); this.selectedId = row.id; this.tab = 'content'; this.search = ''; this.redraw(kind === 'seasonal' ? 'add-season:items' : 'title');
      }); control.disabled = this.draft.rows.length >= 12; add.append(control);
    }
    this.sidebar.append(add);
    const row = this.selectedRow();
    if (!row) this.workspace.append(el('h2', '', 'Personalize sua Página Inicial'), el('p', '', 'Adicione sua Minha Lista, coleções favoritas ou fileiras sazonais que aparecem na época certa do ano.'));
    else {
      const parent = this.parentOf(row);
      if (!parent && this.tab === 'appearance') this.tab = 'content';
      if (parent) {
        this.workspace.append(this.control('Voltar ao grupo sazonal', 'season:back', () => { this.selectedId = parent.id; this.tab = 'content'; this.redraw(`row:${parent.id}`); }, 'tvl-home-season-back'));
        if (this.tab === 'position') this.tab = 'content';
      }
      const heading = el('div', 'tvl-home-editor-heading');
      heading.append(el('h2', '', this.name(row)), this.control(row.kind === 'seasonal' ? 'Remover grupo sazonal' : 'Remover fileira', 'remove', () => {
        const siblings = parent ? parent.children! : this.draft.rows;
        const index = siblings.indexOf(row); siblings.splice(index, 1);
        this.selectedId = parent?.id || siblings[Math.min(index, siblings.length - 1)]?.id || ''; this.tab = 'content';
        this.redraw(this.selectedId ? `row:${this.selectedId}` : 'add:collections');
      }));
      const tabs = el('nav', 'tvl-home-editor-tabs'); tabs.setAttribute('aria-label', 'Configurações da fileira');
      const choices = row.kind === 'seasonal' ? [['content', 'Fileiras sazonais'], ['position', 'Posição na Home']] as const
        : parent ? [['content', 'Conteúdo'], ['order', 'Ordem dos itens'], ['appearance', 'Aparência']] as const
        : [['content', 'Conteúdo'], ['order', 'Ordem dos itens'], ['position', 'Posição na Home']] as const;
      if (row.kind === 'seasonal' && this.tab === 'order') this.tab = 'content';
      for (const [tab, label] of choices) {
        const control = this.control(label, `tab:${tab}`, () => { this.tab = tab; this.redraw(`tab:${tab}`); }); control.setAttribute('aria-pressed', String(this.tab === tab)); tabs.append(control);
      }
      this.workspace.append(heading, tabs);
      if (row.kind === 'seasonal') {
        const content = el('div', 'tvl-home-editor-row'); this.workspace.append(content);
        if (this.tab === 'position') this.renderPosition(row, content); else this.renderSeasons(row, content);
      } else {
        if (parent && this.tab === 'content') this.renderSeasonDates(row, this.workspace);
        const content = el('div', 'tvl-home-editor-row'); content.setAttribute('role', 'group'); content.setAttribute('aria-label', row.kind === 'watchlist' ? 'Fileira da Minha Lista' : row.kind === 'collections' ? 'Fileira de coleções' : 'Fileira de itens de coleção');
        this.preview = el('aside', 'tvl-home-preview'); this.preview.setAttribute('aria-label', 'Pré-visualização da fileira'); this.preview.tabIndex = -1; this.preview.dataset.editorFocus = 'preview';
        const body = el('div', 'tvl-home-editor-body'); body.append(content, this.preview); this.workspace.append(body);
        const sourceSwitch = row.kind === 'items' && this.tab !== 'appearance' ? this.sourceSwitch(row) : undefined;
        if (this.tab === 'appearance') this.renderAppearance(row, content);
        else if (sourceSwitch) {
          content.append(sourceSwitch); const sourcePanel = el('div'); sourcePanel.id = 'tvl-home-edit-items'; sourcePanel.setAttribute('role', 'tabpanel'); sourcePanel.setAttribute('aria-labelledby', `tvl-home-edit-tab-${encodeURIComponent(this.source(row)!.id)}`); content.append(sourcePanel);
          if (this.tab === 'content') this.renderContent(row, sourcePanel);
          else if (this.tab === 'order') this.renderOrder(row, sourcePanel);
          else this.renderPosition(row, sourcePanel);
        }
        else if (this.tab === 'content') this.renderContent(row, content);
        else if (this.tab === 'order') this.renderOrder(row, content);
        else this.renderPosition(row, content);
        this.renderPreview(row);
      }
    }
    if (restore) {
      const target = Array.from(this.element.querySelectorAll<HTMLElement>('[data-editor-focus]')).find(node => node.dataset.editorFocus === restore && !node.hasAttribute('disabled'))
        || this.workspace.querySelector<HTMLElement>('.tvl-home-editor-tabs [aria-pressed="true"]') || this.sidebar.querySelector<HTMLElement>('button:not(:disabled)');
      target?.focus({ preventScroll: true });
    }
  }
  private newRow(kind: HomeCollectionRow['kind']): HomeCollectionRow {
    const row: HomeCollectionRow = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, kind,
      title: kind === 'watchlist' ? 'Minha Lista' : kind === 'collections' ? 'Coleções' : '',
      collectionIds: [], ranked: false, placement: 'end', itemSort: 'collection', itemOrder: [] };
    if (kind === 'seasonal') row.children = [];
    return row;
  }
  private renderAppearance(row: HomeCollectionRow, content: HTMLElement): void {
    content.classList.add('tvl-home-seasonal-appearance-editor');
    content.append(el('p', 'tvl-home-editor-help', 'Dê a esta fileira sazonal seu próprio cenário e efeito de revelação. Todas as opções são opcionais e são aplicadas apenas quando a fileira estiver na temporada ativa.'));
    const themes = el('div', 'tvl-home-seasonal-themes'); themes.setAttribute('role', 'group'); themes.setAttribute('aria-label', 'Tema sazonal');
    for (const [theme, name] of [['normal', 'Normal'], ['halloween', 'Halloween'], ['christmas', 'Natal']] as const) {
      const choice = this.control(name, `appearance:theme:${theme}`, () => {
        if (theme === 'normal') delete row.appearance;
        else row.appearance = row.appearance ? { ...row.appearance, theme } : defaultSeasonalAppearance(theme);
        if (theme === 'christmas' && row.appearance) {
          for (const key of ['backgroundStyle', 'frameStyle', 'coverStyle', 'rankStyle'] as const) {
            if (row.appearance[key] === 'nightmare') delete row.appearance[key];
          }
        }
        if (theme === 'halloween' && row.appearance?.reveal === 'advent') {
          row.appearance.reveal = 'none'; delete row.appearance.adventUnlock;
        }
        this.redraw(`appearance:theme:${theme}`);
      }, `tvl-home-seasonal-theme tvl-home-seasonal-theme-${theme}`);
      choice.setAttribute('aria-pressed', String((row.appearance?.theme || 'normal') === theme));
      themes.append(choice);
    }
    content.append(el('h3', '', 'Tema'), themes);
    if (!row.appearance) {
      content.append(el('p', 'tvl-home-editor-help', 'Normal mantém a fileira padrão da Home, sem cenários, molduras ou revelação.'));
      return;
    }
    const appearance = row.appearance;
    const option = <Key extends 'background' | 'expansion' | 'reveal'>(key: Key, labelText: string, choices: readonly (readonly [HomeSeasonalAppearance[Key], string])[], help: string) => {
      const label = el('label', 'tvl-home-seasonal-select', labelText), select = el('select');
      select.dataset.editorFocus = `appearance:${key}`;
      for (const [value, text] of choices) { const item = el('option', '', text); item.value = value; select.append(item); }
      select.value = appearance[key];
      select.addEventListener('change', () => {
        appearance[key] = select.value as HomeSeasonalAppearance[Key];
        if (key === 'reveal') {
          if (appearance.reveal === 'advent') appearance.adventUnlock = 'daily';
          else delete appearance.adventUnlock;
        }
        if (key === 'expansion') this.renderPreview(row); else this.redraw(`appearance:${key}`);
      });
      label.append(select); content.append(label, el('p', 'tvl-home-seasonal-setting-help', help));
    };
    let nightmareNoteShown = false;
    const artStyle = (key: 'backgroundStyle' | 'frameStyle' | 'coverStyle', name: string) => {
      const label = el('label', 'tvl-home-seasonal-select tvl-home-seasonal-art-style', name), select = el('select');
      select.dataset.editorFocus = `appearance:${key}`;
      const styles: [HomeSeasonalArtStyle, string][] = [['classic', 'Ilustrado'], ['storybook', 'Lúdico / infantil'], ['photoreal', key === 'coverStyle' && appearance.reveal === 'advent' ? 'Madeira de inverno dourada' : 'Fotorrealista']];
      if (appearance.theme === 'halloween') styles.push(['nightmare', 'Pesadelo — muito assustador']);
      for (const [value, text] of styles) { const option = el('option', '', text); option.value = value; select.append(option); }
      select.value = appearance[key] || 'classic';
      select.addEventListener('change', () => {
        if (select.value === 'classic') delete appearance[key]; else appearance[key] = select.value as HomeSeasonalArtStyle;
        this.redraw(`appearance:${key}`);
      });
      label.append(select); content.append(label);
      if (appearance[key] === 'nightmare' && !nightmareNoteShown) {
        content.append(el('p', 'tvl-home-seasonal-setting-help', 'O estilo Pesadelo foi projetado para coleções de terror adulto.'));
        nightmareNoteShown = true;
      }
    };
    option('background', 'Plano de fundo', [['none', 'Nenhum'], ['static', 'Cenário estático'], ['parallax', 'Cenário parallax']], 'O cenário estático permanece fixo. O cenário parallax se move suavemente atrás dos itens conforme a fileira rola.');
    if (appearance.background !== 'none') artStyle('backgroundStyle', 'Estilo do cenário');
    option('expansion', 'Altura ao focar', [['none', 'Altura padrão'], ['medium', 'Espaçoso · até 1.5×'], ['large', 'Imersivo · até 2×'], ['fullscreen', 'Tela cheia']], 'Retorna ao normal ao remover o foco. Tela cheia preenche o espaço disponível da tela e amplia o título com uma fonte correspondente ao estilo do cenário. Os pôsteres mantêm seu tamanho.');
    const frameLabel = el('label', 'tvl-home-seasonal-frame-toggle');
    const frame = el('input'); frame.type = 'checkbox'; frame.checked = appearance.frame; frame.dataset.editorFocus = 'appearance:frame';
    frame.addEventListener('change', () => { appearance.frame = frame.checked; this.redraw('appearance:frame'); });
    frameLabel.append(frame, el('span', '', 'Molduras temáticas para itens')); content.append(frameLabel);
    if (appearance.frame) artStyle('frameStyle', 'Estilo da moldura');
    if (row.kind === 'items' && row.ranked) {
      const label = el('label', 'tvl-home-seasonal-select tvl-home-seasonal-art-style', 'Estilo da numeração de classificação'), select = el('select');
      select.dataset.editorFocus = 'appearance:rankStyle';
      const styles = [['match', 'Combinar com a moldura'], ['standard', 'Números padrão'], ['classic', 'Ilustrado'], ['storybook', 'Lúdico / infantil'], ['photoreal', 'Texturizado']];
      if (appearance.theme === 'halloween') styles.push(['nightmare', 'Pesadelo — muito assustador']);
      for (const [value, text] of styles) { const option = el('option', '', text); option.value = value; select.append(option); }
      select.value = appearance.rankStyle || 'match';
      select.addEventListener('change', () => {
        if (select.value === 'match') delete appearance.rankStyle;
        else appearance.rankStyle = select.value as HomeSeasonalAppearance['rankStyle'];
        this.redraw('appearance:rankStyle');
      });
      label.append(select); content.append(label);
      if (appearance.rankStyle === 'nightmare' && !nightmareNoteShown) {
        content.append(el('p', 'tvl-home-seasonal-setting-help', 'O estilo Pesadelo foi projetado para coleções de terror adulto.'));
        nightmareNoteShown = true;
      }
    } else if (row.kind === 'items') {
      content.append(el('p', 'tvl-home-seasonal-setting-help', 'Ative Arte de classificação em Conteúdo para aplicar temas aos números.'));
    }
    const reveals: [HomeSeasonalAppearance['reveal'], string][] = [['none', 'Sempre visível'], ['doors', 'Portas se abrindo'], ['shutters', 'Persianas de janela se abrindo'], ['curtains', 'Cortinas se abrindo']];
    if (appearance.theme === 'christmas' && row.kind === 'items') reveals.push(['advent', 'Portas do calendário do advento']);
    option('reveal', 'Revelação do item', reveals, 'Portas, persianas ou cortinas ocultam a arte e o título até que o item seja focado ou passe o cursor. Elas se fecham ao afastar o foco.');
    if (appearance.reveal === 'advent') {
      const label = el('label', 'tvl-home-seasonal-select', 'Abertura das portas'), select = el('select');
      select.dataset.editorFocus = 'appearance:adventUnlock';
      for (const [value, text] of [['daily', 'Diário a partir do início da temporada'], ['focus', 'Abrir qualquer porta ao focar']]) {
        const choice = el('option', '', text); choice.value = value; select.append(choice);
      }
      select.value = appearance.adventUnlock || 'focus';
      select.addEventListener('change', () => { appearance.adventUnlock = select.value as 'daily' | 'focus'; this.redraw('appearance:adventUnlock'); });
      const openingHelp = dailyAdvent(row)
        ? 'A Porta 1 se abre na data de início da temporada, com mais um filme disponível a cada dia. Comece em 1º de dezembro para um calendário do advento tradicional. Os filmes seguem a Ordem dos itens; a ordem aleatória é ignorada para que cada filme mantenha o número de sua porta.'
        : 'Cada porta pode ser aberta quando focada ou com o cursor em cima, sem restrição diária. As posições dos filmes seguem a Ordem dos itens, a menos que a ordem aleatória esteja ativada.';
      label.append(select); content.append(label, el('p', 'tvl-home-seasonal-setting-help', `${openingHelp} As portas de pré-visualização sempre se abrem, independentemente da data de hoje.`));
      artStyle('coverStyle', 'Estilo da porta do advento');
    } else if (appearance.reveal === 'doors' || appearance.reveal === 'shutters') artStyle('coverStyle', 'Estilo de porta ou persiana');
  }
  private renderSeasons(group: HomeCollectionRow, content: HTMLElement): void {
    content.append(el('p', 'tvl-home-editor-help', 'Dê às fileiras sazonais uma posição compartilhada na Home. Apenas as fileiras com datas ativas aparecem, na ordem abaixo. O grupo não possui cabeçalho e não ocupa espaço quando nenhuma estiver ativa.'));
    const list = el('ol', 'tvl-home-season-list'); list.setAttribute('aria-label', 'Fileiras sazonais');
    const children = group.children ||= [];
    children.forEach((row, index) => {
      const line = el('li'); line.dataset.seasonRow = row.id;
      const choose = this.control(this.name(row), `season:edit:${row.id}`, () => { this.selectedId = row.id; this.tab = 'content'; this.search = ''; this.visibleItems = 60; this.redraw('title'); }, 'tvl-home-season-edit');
      choose.setAttribute('aria-label', `Editar ${this.name(row)}`);
      choose.append(el('small', '', row.season ? `${seasonDateLabel(row.season.start)} – ${seasonDateLabel(row.season.end)} todos os anos` : 'Escolha as datas da temporada'));
      line.append(choose);
      const actions = el('div', 'tvl-home-editor-actions');
      for (const [delta, direction] of [[-1, 'para cima'], [1, 'para baixo']] as const) {
        const move = this.control(`Mover ${this.name(row)} ${direction}`, `season:move:${row.id}:${delta}`, () => {
          [children[index], children[index + delta]] = [children[index + delta], children[index]];
          this.redraw(`season:move:${row.id}:${-delta}`);
        }); move.setAttribute('aria-label', `Mover ${this.name(row)} ${direction}`); move.querySelector('span')!.textContent = delta < 0 ? '↑' : '↓';
        move.disabled = index + delta < 0 || index + delta >= children.length; actions.append(move);
      }
      const remove = this.control(`Remover ${this.name(row)}`, `season:remove:${row.id}`, () => { children.splice(index, 1); this.redraw('add-season:items'); });
      actions.append(remove); line.append(actions); list.append(line);
    });
    content.append(list);
    if (!children.length) content.append(el('p', 'tvl-home-season-empty', 'Adicione uma fileira para Halloween, Natal ou qualquer época que você desejar.'));
    const add = el('div', 'tvl-home-season-add'); add.setAttribute('role', 'group'); add.setAttribute('aria-label', 'Adicionar fileira sazonal');
    for (const [kind, label] of [['collections', 'Adicionar fileira de coleções sazonal'], ['items', 'Adicionar fileira de itens de coleção sazonal'], ['watchlist', 'Adicionar fileira da Minha Lista sazonal']] as const) {
      const control = this.control(label, `add-season:${kind}`, () => {
        const row = this.newRow(kind), month = new Date().getMonth() + 1;
        const monthText = String(month).padStart(2, '0');
        row.season = { start: `${monthText}-01`, end: `${monthText}-${monthDays[month - 1]}` };
        row.placement = group.placement; children.push(row); this.selectedId = row.id; this.tab = 'content'; this.search = ''; this.redraw('title');
      }); control.disabled = children.length >= maxSeasonalRows; add.append(control);
    }
    content.append(add);
  }
  private renderSeasonDates(row: HomeCollectionRow, content: HTMLElement): void {
    const dates = el('section', 'tvl-home-season-dates'); dates.setAttribute('aria-label', 'Datas da temporada');
    const summary = el('p', 'tvl-home-editor-help', 'Exibido todos os anos, incluindo ambas as datas. Uma data de término anterior ao início continua no ano seguinte.');
    dates.append(summary);
    const fields = el('div', 'tvl-home-season-date-fields');
    for (const [key, title] of [['start', 'Início'], ['end', 'Término']] as const) {
      const value = row.season?.[key] || '', month = Number(value.slice(0, 2)), day = Number(value.slice(3));
      const field = el('fieldset'); field.append(el('legend', '', title));
      const monthLabel = el('label', '', 'Mês'), monthInput = el('select'); monthInput.setAttribute('aria-label', `${title} - Mês`); monthInput.dataset.editorFocus = `season:${key}:month`;
      months.forEach((name, index) => { const option = el('option', '', name); option.value = String(index + 1); monthInput.append(option); });
      monthInput.value = month >= 1 && month <= 12 ? String(month) : '1';
      const dayLabel = el('label', '', 'Dia'), dayInput = el('select'); dayInput.setAttribute('aria-label', `${title} - Dia`); dayInput.dataset.editorFocus = `season:${key}:day`;
      for (let number = 1; number <= (monthDays[month - 1] || 31); number++) { const option = el('option', '', String(number)); option.value = String(number); dayInput.append(option); }
      dayInput.value = day >= 1 && day <= (monthDays[month - 1] || 31) ? String(day) : '1';
      const update = (focus: string) => {
        const nextMonth = Number(monthInput.value), nextDay = Math.min(Number(dayInput.value), monthDays[nextMonth - 1]);
        row.season ||= { start: '01-01', end: '12-31' };
        row.season[key] = `${String(nextMonth).padStart(2, '0')}-${String(nextDay).padStart(2, '0')}`;
        this.redraw(focus);
      };
      monthInput.addEventListener('change', () => update(monthInput.dataset.editorFocus!));
      dayInput.addEventListener('change', () => update(dayInput.dataset.editorFocus!));
      monthLabel.append(monthInput); dayLabel.append(dayInput); field.append(monthLabel, dayLabel); fields.append(field);
    }
    dates.append(fields); content.append(dates);
  }
  private renderContent(row: HomeCollectionRow, content: HTMLElement): void {
    const label = el('label', '', 'Título da fileira'); const title = el('input'); title.type = 'text'; title.maxLength = 80;
    title.value = row.title; title.placeholder = row.kind === 'watchlist' ? 'Minha Lista' : row.kind === 'collections' ? 'Coleções' : 'Nome da coleção'; title.dataset.editorFocus = 'title';
    title.addEventListener('input', () => {
      row.title = title.value;
      this.workspace.querySelector('h2')!.textContent = this.name(row);
      this.sidebar.querySelector('.tvl-home-row-choice[aria-pressed="true"]>span')!.textContent = this.name(row);
      this.renderPreview(row);
    }); label.append(title); content.append(label);
    if (row.kind === 'watchlist') {
      content.append(el('p', 'tvl-home-editor-help', 'Filmes e séries salvos na sua Minha Lista aparecem juntos aqui. Adicione títulos na tela de detalhes ou ao assistir a um trailer.')); return;
    }
    if (row.kind === 'items') {
      const rank = this.control('Arte de classificação', 'ranked', () => {
        row.ranked = !row.ranked; rank.setAttribute('aria-pressed', String(row.ranked)); this.renderPreview(row);
        if (!this.parentOf(row)) this.sidebar.querySelector('.tvl-home-row-choice[aria-pressed="true"]>small')!.textContent = `Fileira de itens em ${row.ranked ? 'destaque numerado' : 'pôster'}${row.tabs ? ` · ${row.tabs.length} abas` : ''}`;
      });
      rank.setAttribute('aria-pressed', String(row.ranked)); content.append(rank, el('p', 'tvl-home-editor-help', 'Números grandes ao lado dos pôsteres, seguindo a ordem de itens escolhida.'));
      if (!row.tabs) {
        content.append(this.control('Adicionar abas de coleção', 'add-tabs', () => {
          row.tabs = [{ ...homeCollectionTabs(row)[0], label: 'Filmes', itemOrder: row.itemOrder.slice() }, { id: `tab-${Date.now()}`, label: 'Séries', collectionId: '', itemSort: 'collection', itemOrder: [] }];
          this.selectedTabs.set(row.id, row.tabs[1].id); this.search = ''; this.redraw('tab-label');
        }), el('p', 'tvl-home-editor-help', 'Exiba várias coleções em uma única fileira, com alternância como Filmes / Séries.'));
      } else {
        const source = this.source(row)!;
        const tabLabel = el('label', '', 'Rótulo da aba'); const input = el('input'); input.type = 'text'; input.maxLength = 40; input.value = source.label; input.placeholder = 'Nome da coleção'; input.dataset.editorFocus = 'tab-label';
        input.addEventListener('input', () => {
          source.label = input.value;
          const control = Array.from(this.workspace.querySelectorAll<HTMLElement>('.tvl-home-editor-row [data-source-tab]')).find(node => node.dataset.sourceTab === source.id);
          if (control) control.querySelector('span')!.textContent = homeTabLabel(source, this.collections.find(item => item.Id === source.collectionId));
          this.renderPreview(row);
        }); tabLabel.append(input); content.append(tabLabel);
        const actions = el('div', 'tvl-home-editor-actions');
        const add = this.control('Adicionar aba', 'add-tab', () => {
          const tab: HomeCollectionTab = { id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, label: '', collectionId: '', itemSort: 'collection', itemOrder: [] };
          row.tabs!.push(tab); this.selectedTabs.set(row.id, tab.id); this.search = ''; this.redraw('tab-label');
        }); add.disabled = row.tabs.length >= maxHomeCollectionTabs;
        const remove = this.control('Remover aba', 'remove-tab', () => {
          const at = row.tabs!.indexOf(source); row.tabs!.splice(at, 1);
          const remaining = row.tabs![Math.min(at, row.tabs!.length - 1)]; this.selectedTabs.set(row.id, remaining.id);
          if (row.tabs!.length === 1) { row.collectionIds = remaining.collectionId ? [remaining.collectionId] : []; row.itemSort = remaining.itemSort; row.itemOrder = remaining.itemOrder.slice(); delete row.tabs; }
          this.search = ''; this.redraw(row.tabs ? 'tab-label' : 'add-tabs');
        }); remove.disabled = row.tabs.length < 2;
        actions.append(add, remove);
        const at = row.tabs.indexOf(source);
        for (const [delta, label] of [[-1, 'Mover aba para a esquerda'], [1, 'Mover aba para a direita']] as const) {
          const move = this.control(label, `tab-move:${delta}`, () => {
            [row.tabs![at], row.tabs![at + delta]] = [row.tabs![at + delta], row.tabs![at]];
            this.redraw(`tab-move:${-delta}`);
          }); move.disabled = at + delta < 0 || at + delta >= row.tabs.length; actions.append(move);
        }
        content.append(actions, el('p', 'tvl-home-editor-help', 'Cada aba mantém sua própria coleção e ordem de itens. A primeira aba abre por padrão.'));
      }
    }
    content.append(el('h3', '', row.kind === 'collections' ? 'Escolher coleções' : 'Escolher uma coleção'));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Buscar coleções'; search.setAttribute('aria-label', 'Buscar coleções'); search.value = this.search; search.dataset.editorFocus = 'collection-search';
    const choices = el('div', 'tvl-home-collection-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', row.kind === 'collections' ? 'Escolher coleções' : 'Escolher uma coleção');
    const drawChoices = () => {
      replace(choices);
      for (const collection of this.collections.filter(item => item.Name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase()))) {
        const selected = row.kind === 'items' ? this.sourceCollection(row) === collection.Id : row.collectionIds.includes(collection.Id);
        const choice = this.control(collection.Name, `choose:${collection.Id}`, () => {
          if (this.ready) this.status.textContent = '';
          if (row.kind === 'items') {
            const source = this.source(row);
            if (source) { if (source.collectionId !== collection.Id) { source.collectionId = collection.Id; source.itemOrder = []; } }
            else if (row.collectionIds[0] !== collection.Id) { row.collectionIds = [collection.Id]; row.itemOrder = []; }
          }
          else if (selected) row.collectionIds = row.collectionIds.filter(id => id !== collection.Id);
          else if (row.collectionIds.length < 40) row.collectionIds.push(collection.Id);
          this.redraw(`choose:${collection.Id}`);
        }, 'tvl-home-collection-choice'); choice.setAttribute('aria-pressed', String(selected));
        choice.prepend(picture(this.api.image(collection, 'thumb'), 'tvl-home-choice-art')); choices.append(choice);
      }
      if (!choices.childElementCount) choices.append(el('p', '', 'Nenhuma coleção correspondente.'));
    };
    search.addEventListener('input', () => { this.search = search.value; drawChoices(); }); drawChoices(); content.append(search, choices);
  }
  private async loadItems(id: string): Promise<void> {
    if (this.loading.has(id)) return;
    this.loading.add(id); this.errors.delete(id);
    const revision = this.watchlistRevision;
    const current = () => !this.disposed && (id !== watchlistSource || revision === this.watchlistRevision);
    try { const items = await (id === watchlistSource ? getAllWatchlistItems(this.api) : this.api.getCollectionItems(id)); if (current()) this.items.set(id, items); }
    catch { if (current()) this.errors.add(id); }
    finally {
      if (!current()) return;
      this.loading.delete(id);
      const row = this.selectedRow();
      if (row && (row.kind === 'items' && this.sourceCollection(row) === id || row.kind === 'watchlist' && id === watchlistSource)) {
        if (this.tab === 'order') this.redraw();
        else this.renderPreview(row);
      }
    }
  }
  private renderPreview(row: HomeCollectionRow): void {
    if (!this.preview || this.disposed || row.id !== this.selectedId) return;
    this.disposePreviewAppearance?.(); this.disposePreviewAppearance = undefined;
    // Only the preview changes on data arrival or typing. If its retry control
    // disappears, keep focus on this persistent panel instead of the page body.
    const focusedSource = this.preview.contains(document.activeElement) && (document.activeElement as HTMLElement)?.dataset.sourceTab;
    if (this.preview.contains(document.activeElement)) this.preview.focus({ preventScroll: true });
    replace(this.preview);
    const header = el('div', 'tvl-home-preview-header');
    header.append(el('p', 'tvl-home-editor-eyebrow', 'PRÉ-VISUALIZAÇÃO DA HOME'), el('span', 'tvl-home-preview-draft', 'Rascunho não salvo'));
    this.preview.append(header);
    const sequence = combinedHomeOrder(this.draft.rows, this.anchors);
    const parent = this.parentOf(row), positionedRow = parent || row;
    const at = sequence.findIndex(entry => 'row' in entry && entry.row === positionedRow);
    const label = (entry: OrderEntry) => 'row' in entry ? this.name(entry.row) : entry.anchor.label;
    const before = this.anchors.length ? at > 0 ? `Depois de ${label(sequence[at - 1])}` : 'Topo da Página Inicial'
      : positionedRow.placement === 'start' ? 'Topo da Página Inicial' : positionedRow.placement === 'end' ? 'Depois das fileiras existentes da Home' : 'Pré-visualização da posição na Home';
    if (parent && row.season) this.preview.append(el('p', 'tvl-home-preview-season', `${seasonDateLabel(row.season.start)} – ${seasonDateLabel(row.season.end)} todos os anos · ${isSeasonActive(row.season) ? 'Visível hoje' : 'Oculto hoje; apenas pré-visualização'}`));
    this.preview.append(el('p', 'tvl-home-preview-neighbour', parent ? `${before} · shared seasonal position` : before));
    const section = el('section', 'tvl-home-collection-row'); section.setAttribute('aria-label', this.name(row));
    section.append(el('h3', 'tvl-home-row-title', this.name(row)));
    const sourceSwitch = row.kind === 'items' ? this.sourceSwitch(row, true) : undefined;
    if (sourceSwitch) section.append(sourceSwitch);
    const panel = el('div'); panel.id = 'tvl-home-preview-items';
    if (sourceSwitch) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `tvl-home-preview-tab-${encodeURIComponent(this.source(row)!.id)}`); }
    const cards = el('div', 'tvl-home-row-cards'); cards.setAttribute('role', 'list'); cards.setAttribute('aria-label', 'Itens da pré-visualização'); panel.append(cards); section.append(panel);
    const after = this.anchors.length ? at < sequence.length - 1 ? `Antes de ${label(sequence[at + 1])}` : 'Fim da Página Inicial' : 'Acesse a Página Inicial uma vez para ver as fileiras vizinhas.';
    this.preview.append(section, el('p', 'tvl-home-preview-neighbour', after));
    if (focusedSource) Array.from(this.preview.querySelectorAll<HTMLElement>('[data-source-tab]')).find(control => control.dataset.sourceTab === focusedSource)?.focus({ preventScroll: true });
    const status = (message: string) => {
      cards.classList.add('tvl-home-preview-pending');
      const text = el('p', 'tvl-home-preview-message', message); text.setAttribute('aria-live', 'polite'); cards.append(text);
    };
    const selectedIds = row.kind === 'items' ? [this.sourceCollection(row)].filter(Boolean) : row.collectionIds;
    const chosen = selectedIds.map(id => this.collections.find(item => item.Id === id)).filter((item): item is Item => !!item);
    if (row.kind !== 'watchlist' && !chosen.length) {
      status(selectedIds.length ? 'A coleção selecionada não está disponível. Escolha outra em Conteúdo.' : row.kind === 'items' ? 'Escolha uma coleção para pré-visualizar seus itens.' : 'Escolha coleções para vê-las aqui.');
      return;
    }
    let items = chosen;
    if (row.kind === 'items' || row.kind === 'watchlist') {
      const id = row.kind === 'watchlist' ? watchlistSource : chosen[0].Id;
      if (this.errors.has(id)) {
        status(row.kind === 'watchlist' ? 'Não foi possível carregar sua Minha Lista.' : 'A pré-visualização não pôde carregar os itens desta coleção.');
        cards.append(this.control('Tentar novamente', 'retry-preview', () => { void this.loadItems(id); this.renderPreview(row); })); return;
      }
      if (!this.items.has(id)) { status('Carregando pré-visualização…'); void this.loadItems(id); return; }
      items = orderHomeItems(this.items.get(id)!, this.source(row) || row);
    }
    if (row.shuffle && !dailyAdvent(row)) {
      const key = `${row.id}:${this.source(row)?.id || ''}`;
      let order = this.previewShuffleOrders.get(key);
      if (!order || order.length !== items.length || items.some(item => !order!.includes(item.Id))) {
        order = shuffleHomeItems(items).map(item => item.Id); this.previewShuffleOrders.set(key, order);
      }
      const positions = new Map(order.map((id, index) => [id, index]));
      items = [...items].sort((a, b) => positions.get(a.Id)! - positions.get(b.Id)!);
    }
    items.slice(0, 60).forEach((item, index) => {
      const entry = el('div', 'tvl-home-row-entry'); entry.setAttribute('role', 'listitem');
      const card = homeRowCard(this.api, item, row.ranked ? index + 1 : undefined, row.appearance ? () => {} : undefined, row, index);
      if (row.appearance) card.dataset.editorFocus = `preview:item:${item.Id}`;
      entry.append(card); cards.append(entry);
    });
    if (!items.length) { status(row.kind === 'watchlist' ? 'Sua Minha Lista está vazia. Salve um filme ou série para ver aqui.' : 'Esta coleção está vazia. Os itens adicionados a ela aparecerão aqui.'); return; }
    this.disposePreviewAppearance = decorateSeasonalRow(section, cards, row);
    if (row.appearance) this.preview.append(this.control('Focar na pré-visualização', 'preview:focus', () => {
      cards.querySelector<HTMLElement>('.tvl-home-row-card')?.focus();
    }, 'tvl-home-seasonal-preview-focus'));
    const footer = el('div', 'tvl-home-preview-footer');
    const noun = row.kind === 'collections' ? (items.length === 1 ? 'coleção' : 'coleções') : (items.length === 1 ? 'item' : 'itens');
    footer.append(el('p', 'tvl-home-preview-count', items.length > 60 ? `Primeiros 60 de ${items.length} itens${row.kind === 'watchlist' ? '' : ' · A Home também exibe Ver coleção completa'}` : `${items.length} ${noun}`));
    if (items.length > 1) {
      const actions = el('div', 'tvl-home-preview-scroll'); actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', 'Rolar a pré-visualização');
      for (const [direction, glyph] of [[-1, '←'], [1, '→']] as const) {
        const scroll = this.control(direction < 0 ? 'Itens anteriores da pré-visualização' : 'Próximos itens da pré-visualização', `preview:${direction}`, () => { cards.scrollBy({ left: cards.clientWidth * .8 * direction, behavior: 'auto' }); });
        scroll.setAttribute('aria-label', direction < 0 ? 'Itens anteriores da pré-visualização' : 'Próximos itens da pré-visualização'); scroll.querySelector('span')!.textContent = glyph; actions.append(scroll);
      }
      footer.append(actions);
    }
    this.preview.append(footer, el('p', 'tvl-home-preview-note', dailyAdvent(row) ? 'Os filmes seguem a Ordem dos itens. As portas de pré-visualização sempre se abrem; a Home segue as datas da temporada.' : row.shuffle ? 'Exemplo de ordem aleatória. Uma nova visita à Home reordena aleatoriamente; voltar de um item mantém a ordem atual.' : 'Atualiza conforme você edita. Salve as fileiras para aplicar à Página Inicial.'));
  }
  private renderOrder(row: HomeCollectionRow, content: HTMLElement): void {
    const shuffle = this.control('Ordem aleatória ao carregar', 'shuffle', () => {
      row.shuffle = !row.shuffle; shuffle.setAttribute('aria-pressed', String(row.shuffle)); this.renderPreview(row);
    }); shuffle.setAttribute('aria-pressed', String(!!row.shuffle));
    shuffle.disabled = dailyAdvent(row);
    content.append(shuffle, el('p', 'tvl-home-editor-help', dailyAdvent(row) ? 'As portas diárias do advento usam a ordem de itens abaixo. A ordem aleatória é ignorada para que cada filme mantenha o número de sua porta.' : 'Ordem aleatória ao acessar a Home. Voltar de um item mantém a ordem atual. Sua ordem salva abaixo permanece inalterada.'));
    content.append(el('p', 'tvl-home-editor-help', 'Isso altera a ordem apenas nesta fileira da Home. Outras telas mantêm a ordem existente.'));
    let items: Item[];
    if (row.kind === 'collections') items = row.collectionIds.map(id => this.collections.find(item => item.Id === id)).filter((item): item is Item => !!item);
    else {
      const id = row.kind === 'watchlist' ? watchlistSource : this.sourceCollection(row);
      if (row.kind !== 'watchlist' && (!id || !this.collections.some(item => item.Id === id))) { content.append(el('p', '', 'Escolha uma coleção acessível em Conteúdo primeiro.')); return; }
      const sorts: [HomeItemSort, string][] = [['collection', row.kind === 'watchlist' ? 'Ordem da Minha Lista' : 'Ordem da coleção'], ['title', 'Título A–Z'], ['title-desc', 'Título Z–A'], ['newest', 'Mais recentes primeiro'], ['oldest', 'Mais antigos primeiro'], ['custom', 'Ordem personalizada']];
      const options = el('div', 'tvl-home-sort-options'); options.setAttribute('role', 'group'); options.setAttribute('aria-label', 'Ordenar itens');
      for (const [sort, label] of sorts) {
        const source = this.source(row) || row;
        const control = this.control(label, `sort:${sort}`, () => { source.itemSort = sort; this.redraw(`sort:${sort}`); }); control.setAttribute('aria-pressed', String(source.itemSort === sort)); options.append(control);
      }
      content.append(options);
      if (this.errors.has(id)) { content.append(this.control(row.kind === 'watchlist' ? 'Tentar carregar Minha Lista novamente' : 'Tentar carregar itens da coleção novamente', 'retry-items', () => { void this.loadItems(id); this.redraw('tab:order'); })); return; }
      if (!this.items.has(id)) { content.append(el('p', '', row.kind === 'watchlist' ? 'Carregando Minha Lista…' : 'Carregando itens da coleção…')); void this.loadItems(id); return; }
      items = orderHomeItems(this.items.get(id)!, this.source(row) || row);
    }
    if (!items.length) { content.append(el('p', '', 'Nenhum item para organizar ainda.')); return; }
    const list = el('ol', 'tvl-home-item-order'); list.setAttribute('aria-label', 'Itens na ordem de exibição');
    items.slice(0, this.visibleItems).forEach((item, index) => {
      const line = el('li'); line.dataset.orderedItem = item.Id;
      line.append(el('span', 'tvl-home-item-number', String(index + 1)), picture(this.api.image(item, 'thumb'), 'tvl-home-order-art'), el('span', 'tvl-home-order-name', item.Name));
      const actions = el('div', 'tvl-home-editor-actions');
      for (const [delta, direction] of [[-1, 'para cima'], [1, 'para baixo']] as const) {
        const control = this.control(`Mover ${item.Name} ${direction}`, `move:${item.Id}:${direction}`, () => {
          const ordered = items.map(item => item.Id); [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
          if (row.kind === 'collections') row.collectionIds = ordered; else { const source = this.source(row) || row; source.itemSort = 'custom'; source.itemOrder = ordered.slice(0, 2000); }
          this.visibleItems = Math.max(this.visibleItems, index + delta + 1);
          const focusDirection = index + delta === 0 ? 'para baixo' : index + delta === items.length - 1 ? 'para cima' : direction;
          this.redraw(`move:${item.Id}:${focusDirection}`);
        }, 'tvl-home-move-item'); control.setAttribute('aria-label', `Mover ${item.Name} ${direction}`); control.querySelector('span')!.textContent = delta < 0 ? '↑' : '↓';
        control.disabled = index + delta < 0 || index + delta >= Math.min(items.length, 2000); actions.append(control);
      }
      line.append(actions); list.append(line);
    }); content.append(list);
    if (items.length > this.visibleItems) content.append(this.control('Mostrar mais itens', 'more-items', () => {
      const firstNew = items[this.visibleItems]; this.visibleItems += 60;
      this.redraw(firstNew ? `move:${firstNew.Id}:para cima` : 'tab:order');
    }));
  }
  private renderPosition(row: HomeCollectionRow, content: HTMLElement): void {
    content.append(el('p', 'tvl-home-editor-help', 'Mova esta fileira entre as seções existentes da sua Página Inicial. O Jellyfin e os Destaques mantêm o controle de suas próprias fileiras.'));
    if (!this.anchors.length) content.append(el('p', '', 'Acesse a Página Inicial uma vez para ver as seções disponíveis aqui.'));
    const quick = el('div', 'tvl-home-editor-actions');
    quick.append(this.control('Mover para o topo', 'position:top', () => { row.placement = 'start'; this.draft.rows = [row, ...this.draft.rows.filter(item => item !== row)]; this.redraw('position:top'); }),
      this.control('Mover para o fim', 'position:bottom', () => { row.placement = 'end'; this.draft.rows = [...this.draft.rows.filter(item => item !== row), row]; this.redraw('position:bottom'); })); content.append(quick);
    const sequence = combinedHomeOrder(this.draft.rows, this.anchors);
    const list = el('ol', 'tvl-home-position-order'); list.setAttribute('aria-label', 'Ordem das fileiras da Página Inicial');
    sequence.forEach((entry, index) => {
      const line = el('li');
      if ('anchor' in entry) { line.className = 'tvl-home-native-position'; line.append(el('span', '', entry.anchor.label), el('small', '', 'Fileira existente da Página Inicial')); }
      else {
        line.dataset.positionRow = entry.row.id; line.classList.toggle('tvl-home-position-selected', entry.row === row);
        line.append(this.control(this.name(entry.row), `position:${entry.row.id}`, () => { this.selectedId = entry.row.id; this.redraw(`position:${entry.row.id}`); }));
        if (entry.row === row) {
          for (const [delta, label] of [[-1, 'Mover fileira para cima'], [1, 'Mover fileira para baixo']] as const) {
            const control = this.control(label, `position:move:${delta}`, () => {
              [sequence[index], sequence[index + delta]] = [sequence[index + delta], sequence[index]];
              sequence.forEach((entry, i) => { if ('row' in entry) entry.row.placement = sequence.slice(i + 1).find((next): next is {anchor: HomeAnchor} => 'anchor' in next)?.anchor.key || 'end'; });
              this.draft.rows = sequence.flatMap(entry => 'row' in entry ? [entry.row] : []); this.redraw(index + delta === 0 ? 'position:move:1' : index + delta === sequence.length - 1 ? 'position:move:-1' : `position:move:${delta}`);
            }); control.disabled = index + delta < 0 || index + delta >= sequence.length; line.append(control);
          }
        }
      }
      list.append(line);
    }); content.append(list);
  }
  private async save(): Promise<void> {
    if (!this.ready || this.disposed || this.saving) return;
    const datedRows = this.draft.rows.flatMap(row => row.kind === 'seasonal' ? row.children || [] : []);
    const invalidSeason = datedRows.find(row => !row.season || !validSeasonDate(row.season.start) || !validSeasonDate(row.season.end));
    if (invalidSeason) { this.status.textContent = 'Escolha uma data de início e término válida para cada fileira sazonal.'; this.selectedId = invalidSeason.id; this.tab = 'content'; this.redraw('season:start:month'); return; }
    const next = parseHomeCollections(this.draft);
    const invalid = next.rows.flatMap(row => row.kind === 'seasonal' ? row.children || [] : [row]).find(row => row.kind !== 'watchlist' && (row.tabs ? row.tabs.some(tab => !tab.collectionId) : !row.collectionIds.length));
    if (invalid) { this.status.textContent = 'Escolha pelo menos uma coleção para cada fileira e cada aba, ou remova a entrada vazia.'; this.selectedId = invalid.id; this.tab = 'content'; if (invalid.tabs) this.selectedTabs.set(invalid.id, invalid.tabs.find(tab => !tab.collectionId)!.id); this.redraw('title'); return; }
    this.saving = true; this.status.textContent = this.store.synced ? 'Salvando fileiras da Home no Jellyfin…' : 'Salvando fileiras da Home…';
    const controls = Array.from(this.element.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button,select,textarea'))
      .map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    try {
      await this.store.save(next);
      this.saving = false;
      if (!this.disposed) {
        if (this.targetUserId) {
          this.status.textContent = `Fileiras salvas com sucesso para ${this.targetUserName || 'o perfil'}.`;
          if (this.targetStatusBadge) {
            this.targetStatusBadge.textContent = 'Personalização própria ativa';
            this.targetStatusBadge.className = 'tvl-target-override-status has-override';
            this.targetStatusBadge.hidden = false;
          }
          if (this.restoreGlobalButton) {
            this.restoreGlobalButton.disabled = false;
            this.restoreGlobalButton.hidden = false;
          }
        } else {
          this.close();
        }
      }
    } catch (error) {
      if (this.disposed) return;
      this.status.textContent = error instanceof Error ? error.message : 'Não foi possível salvar as fileiras da Página Inicial. Tente novamente.';
      if (error instanceof HomeCollectionSyncError && error.kind === 'conflict') {
        this.ready = false;
        this.status.append(button('Recarregar fileiras salvas', '', '', () => {
          this.saveButton.disabled = true; this.status.textContent = 'Carregando fileiras salvas…'; void this.loadCollections();
        }));
      }
    } finally {
      this.saving = false;
      if (!this.disposed) { controls.forEach(({ control, disabled }) => { control.disabled = disabled; }); this.saveButton.disabled = !this.ready; }
    }
  }
  private close(restore = true): void {
    if (this.disposed || this.saving && restore) return;
    this.disposed = true; this.disposePreviewAppearance?.(); this.disposePreviewAppearance = undefined;
    this.store.destroy(); this.removeRemote(); this.removeWatchlist(); this.element.remove(); this.onClose(restore);
  }
  private normalizeId(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
  }
  private async loadUsers(): Promise<void> {
    const client = (window as unknown as {
      ApiClient?: {
        getUrl(p: string): string;
        getJSON(u: string): Promise<unknown>;
        getUsers?(): Promise<unknown>;
      };
    }).ApiClient;
    if (!client || !this.targetSelect) return;

    const parseUsers = (raw: unknown): { Id: string; Name: string }[] => {
      if (!Array.isArray(raw)) return [];
      return raw.map((u: Record<string, unknown>) => {
        const rawId = (u.Id || u.id || '') as string;
        const normId = rawId ? this.normalizeId(String(rawId)) : '';
        const name = (u.Name || u.name || u.Username || u.username || normId) as string;
        return { Id: normId, Name: name };
      }).filter(u => u.Id && u.Name);
    };

    try {
      let usersList: { Id: string; Name: string }[] = [];
      try {
        const list = await client.getJSON(client.getUrl('TvItemLayout/HomeCollections/Users'));
        usersList = parseUsers(list);
      } catch { /* Try native fallback */ }

      if (usersList.length === 0) {
        try {
          if (typeof client.getUsers === 'function') {
            const nativeUsers = await client.getUsers();
            usersList = parseUsers(nativeUsers);
          } else {
            const nativeUsers = await client.getJSON(client.getUrl('Users'));
            usersList = parseUsers(nativeUsers);
          }
        } catch { /* Native fallback failed */ }
      }

      if (usersList.length > 0) {
        this.users = usersList;
        this.populateUserSelect();
        if (this.targetUserId) {
          const normTarget = this.normalizeId(this.targetUserId);
          const u = this.users.find(u => this.normalizeId(u.Id) === normTarget);
          if (u) {
            this.targetUserId = u.Id;
            this.targetUserName = u.Name;
            this.updateAdminHeader();
          }
        }
      }
    } catch { /* User listing not available */ }
  }
  private populateUserSelect(): void {
    if (!this.targetSelect) return;
    replace(this.targetSelect);
    const globalOpt = el('option', '', '🌐 Padrão Global (Todos os Usuários)');
    globalOpt.value = '';
    this.targetSelect.append(globalOpt);
    for (const u of this.users) {
      const opt = el('option', '', `👤 ${u.Name}`);
      opt.value = u.Id;
      this.targetSelect.append(opt);
    }
    const normTarget = this.targetUserId ? this.normalizeId(this.targetUserId) : '';
    this.targetSelect.value = normTarget ? (this.users.find(u => this.normalizeId(u.Id) === normTarget)?.Id || normTarget) : '';
  }
  private switchTarget(targetUserId?: string, targetUserName?: string): void {
    const normTarget = targetUserId ? this.normalizeId(targetUserId) : undefined;
    this.targetUserId = normTarget;
    this.targetUserName = targetUserName;
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (normTarget) {
      params.set('targetUserId', normTarget);
      params.set('cinemaGlobal', '1');
    } else {
      params.delete('targetUserId');
      params.set('cinemaGlobal', '1');
    }
    const cleanBase = location.hash.split('?')[0].replace(/^#/, '');
    history.replaceState(history.state, '', `#${cleanBase}?${params.toString()}`);
    this.store.destroy();
    this.store = createHomeCollectionStore(this.api, normTarget ? 'user' : 'global', normTarget);
    this.key = this.store.key;
    this.updateAdminHeader();
    void this.loadCollections();
  }
  private updateAdminHeader(): void {
    if (!this.banner) return;
    if (this.targetUserId) {
      const name = this.targetUserName || 'Usuário';
      if (this.headingTitle) this.headingTitle.textContent = `Fileiras de Coleções (${name})`;
      if (this.headingEyebrow) this.headingEyebrow.textContent = `PERFIL · ${name.toUpperCase()}`;
      if (this.saveButton) this.saveButton.textContent = `Salvar para ${name}`;
      if (this.bannerHeader) this.bannerHeader.innerHTML = '<span class="material-icons">person</span><strong>MODO ADMINISTRADOR · PERFIL DE USUÁRIO</strong>';
      if (this.bannerText) this.bannerText.innerHTML = `Você está visualizando e editando as configurações de <strong>${name}</strong>. As alterações salvas serão aplicadas exclusivamente para esta conta.`;
      if (this.copyButton) this.copyButton.hidden = false;
      if (this.resetAllButton) this.resetAllButton.hidden = true;
      if (this.restoreGlobalButton) {
        this.restoreGlobalButton.textContent = 'Restaurar para o Padrão Global';
        this.restoreGlobalButton.hidden = false;
      }
    } else {
      if (this.headingTitle) this.headingTitle.textContent = 'Fileiras de Coleções (Padrão Global)';
      if (this.headingEyebrow) this.headingEyebrow.textContent = 'PADRÃO GLOBAL · ';
      if (this.saveButton) this.saveButton.textContent = 'Salvar Padrão Global';
      if (this.bannerHeader) this.bannerHeader.innerHTML = '<span class="material-icons">shield</span><strong>MODO ADMINISTRADOR</strong>';
      if (this.bannerText) this.bannerText.innerHTML = 'Você está editando o <strong>Padrão Global</strong> de coleções do HabourBR para a Página Inicial. Todos os usuários sem personalização própria receberão este catálogo.';
      if (this.copyButton) this.copyButton.hidden = false;
      if (this.resetAllButton) this.resetAllButton.hidden = false;
      if (this.restoreGlobalButton) this.restoreGlobalButton.hidden = true;
      if (this.targetStatusBadge) this.targetStatusBadge.hidden = true;
    }
  }
  private async copyFromAdmin(): Promise<void> {
    const client = (window as unknown as { ApiClient?: { getUrl(p: string): string; getJSON(u: string): Promise<unknown> } }).ApiClient;
    if (!client) return;
    try {
      this.status.textContent = 'Carregando coleções da sua conta pessoal…';
      const personal = await client.getJSON(client.getUrl('TvItemLayout/HomeCollections')) as Record<string, unknown> | null;
      const rawSettings = personal?.Settings || personal?.settings;
      if (rawSettings) {
        this.draft = parseHomeCollections(rawSettings);
        this.selectedId = this.draft.rows[0]?.id || '';
        this.ready = true;
        this.loadingSettings = false;
        this.saving = false;
        this.store.allowSave();
        this.saveButton.disabled = false;
        this.redraw();
        const targetLabel = this.targetUserId ? `Salvar para ${this.targetUserName || 'Usuário'}` : 'Salvar Padrão Global';
        this.status.textContent = `Configurações de coleções da sua conta pessoal copiadas! Clique em "${targetLabel}" para confirmar.`;
      } else {
        this.status.textContent = 'Sua conta pessoal não possui configurações de coleções customizadas.';
      }
    } catch {
      this.status.textContent = 'Não foi possível carregar as configurações pessoais.';
    }
  }
  private async resetAllUsers(): Promise<void> {
    if (!confirm('Atenção: Deseja apagar as customizações de fileiras de TODOS os usuários do servidor e forçar o Padrão Global do HabourBR?')) return;
    try {
      this.status.textContent = 'Aplicando padrão global a todos os usuários…';
      await this.store.resetAllUsers();
      this.status.textContent = 'Padrão global aplicado com sucesso a todos os usuários!';
    } catch {
      this.status.textContent = 'Erro ao resetar personalizações dos usuários.';
    }
  }
  private async restoreGlobal(): Promise<void> {
    const name = this.targetUserName || 'este usuário';
    const msg = this.targetUserId
      ? `Deseja remover as personalizações de ${name} e fazê-lo voltar a herdar o Padrão Global do HabourBR?`
      : 'Deseja descartar suas personalizações individuais e voltar a usar o Padrão Global do HabourBR definido pelo administrador?';
    if (!confirm(msg)) return;
    this.saving = true; this.saveButton.disabled = true;
    this.status.textContent = 'Restaurando padrão global do servidor…';
    try {
      const fresh = await this.store.resetUserOverride();
      this.draft = fresh; this.selectedId = this.draft.rows[0]?.id || '';
      if (this.targetUserId && this.targetStatusBadge) {
        this.targetStatusBadge.textContent = 'Herdando Padrão Global do servidor';
        this.targetStatusBadge.className = 'tvl-target-override-status inherits-global';
        this.targetStatusBadge.hidden = false;
        if (this.restoreGlobalButton) this.restoreGlobalButton.disabled = true;
      } else if (this.restoreGlobalButton && !this.targetUserId) {
        this.restoreGlobalButton.hidden = !this.store.hasUserOverride;
      }
      this.redraw();
      this.status.textContent = this.targetUserId
        ? `Padrão global restaurado com sucesso para ${name}!`
        : 'Padrão global do servidor restaurado com sucesso!';
    } catch {
      this.status.textContent = 'Não foi possível restaurar o padrão global.';
    } finally {
      this.saving = false; this.saveButton.disabled = !this.ready;
    }
  }
  destroy(): void { this.close(false); }
}
