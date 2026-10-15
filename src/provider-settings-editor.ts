import { button, el, replace } from './dom';
import { brandLabel } from './interface-branding';
import { attachRemote } from './remote';
import { providerBrand, providerBrands } from './provider-brands';
import { cloneProviderHomes, defaultProviderConfig, defaultCustomProvider, maxProviders, maxProviderRows, type ProviderId, type ProviderHomeConfig, type ProviderHomesSettings, type ProviderRow, type ProviderRowSource, type ProviderItemSort } from './provider-settings';
import { providerAppearance, providerLogo } from './provider-appearance';
import { providerHomeRow } from './provider-home';
import { createProviderHomesStore, ProviderHomesSyncError, type ProviderHomesStore } from './provider-settings-store';
import { cachedHomeRows, nativeHomeRows, type HomeAnchor } from './home-row-placement';
import { homeCollectionKey } from './home-collection-settings';
import { homeRowCard } from './home-row-card';
import type { Item, MediaApi, ProviderDirectory } from './types';
import { providerServiceChoices, type ProviderSourceKey } from './provider-service-choices';

type Options = { onBack: () => void; loadPreview: (provider: ProviderHomeConfig, row: ProviderRow) => Promise<Item[]>; providerId?: ProviderId };
const sources: [ProviderRowSource, string][] = [['movies', 'Filmes'], ['shows', 'Séries'], ['trending-movies', 'Filmes em Alta'], ['trending-shows', 'Séries em Alta'], ['collection', 'Coleção'], ['watchlist', 'Minha Lista']];
const sorts: [ProviderItemSort, string][] = [['collection', 'Ordem original'], ['title', 'Título A–Z'], ['title-desc', 'Título Z–A'], ['newest', 'Mais recentes primeiro'], ['oldest', 'Mais antigos primeiro']];

/** One draft workspace for Home and its provider pages. Save is the only writer. */
export class ProviderSettingsEditor {
  readonly element = el('section', 'tvl-root tvl-provider-settings tvl-keyboard');
  private sidebar = el('nav', 'tvl-provider-settings-sidebar');
  private workspace = el('div', 'tvl-provider-settings-workspace');
  private status = el('p', 'tvl-provider-settings-status');
  private reloadButton: HTMLButtonElement;
  private saveButton: HTMLButtonElement;
  private cancelButton: HTMLButtonElement;
  private store: ProviderHomesStore;
  private draft: ProviderHomesSettings;
  private saved: ProviderHomesSettings;
  private selected: ProviderId | 'home' = 'home';
  private selectedRows = new Map<ProviderId, string>();
  private directory?: ProviderDirectory;
  private directoryLoading = false;
  private directoryFailed = false;
  private directoryGeneration = 0;
  private directorySearch = new Map<string, string>();
  private collections: Item[] = [];
  private collectionsFailed = false;
  private collectionsLoading = false;
  private anchors: HomeAnchor[] = [];
  private previewItems = new Map<string, Item[]>();
  private previewPending = new Map<string, Promise<Item[]>>();
  private ready = false;
  private saving = false;
  private loading = false;
  private disposed = false;
  private generation = 0;
  private previewGeneration = 0;
  private removeRemote: () => void;

  constructor(private api: MediaApi, private options: Options) {
    this.store = createProviderHomesStore(api); this.draft = this.store.cached; this.saved = cloneProviderHomes(this.draft);
    this.selected = options.providerId || 'home';
    this.element.setAttribute('aria-label', 'Configurações dos serviços de streaming');
    this.sidebar.setAttribute('aria-label', 'Páginas dos serviços de streaming');
    this.status.setAttribute('role', 'status');
    const home = document.querySelector<HTMLElement>('#indexPage #homeTab, #homeTab');
    const native = home ? nativeHomeRows(home).filter(anchor => !anchor.element.closest('.tvl-provider-row')) : [];
    const cache = cachedHomeRows(this.store.key);
    const collectionCache = cachedHomeRows(homeCollectionKey(api.serverId || location.origin, api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous')));
    const unique = new Map<string, HomeAnchor>();
    for (const anchor of [...native, ...cache, ...collectionCache]) if (!unique.has(anchor.key)) unique.set(anchor.key, anchor);
    this.anchors = Array.from(unique.values());
    const panel = el('div', 'tvl-provider-settings-panel');
    const header = el('header', 'tvl-provider-settings-header');
    const heading = el('div'); heading.append(brandLabel('p', 'tvl-provider-settings-eyebrow', 'PERSONALIZAR '), el('h1', '', 'Serviços de Streaming'));
    const actions = el('div', 'tvl-provider-settings-actions');
    actions.append(this.control(options.providerId ? 'Voltar ao serviço' : 'Voltar às configurações', 'back', () => this.options.onBack(), 'back'));
    this.cancelButton = this.control('Cancelar alterações', 'cancel', () => this.cancel()); this.cancelButton.disabled = true; actions.append(this.cancelButton);
    this.saveButton = this.control('Salvar alterações', 'save', () => { void this.save(); }, 'check', 'tvl-primary');
    this.saveButton.disabled = true; actions.append(this.saveButton); header.append(heading, actions);
    this.reloadButton = this.control('Recarregar configurações salvas', 'reload', () => { void this.load(); }); this.reloadButton.hidden = true;
    const message = el('div', 'tvl-provider-settings-message'); message.append(this.status, this.reloadButton);
    const layout = el('div', 'tvl-provider-settings-layout'); layout.append(this.sidebar, this.workspace);
    panel.append(header, el('p', 'tvl-provider-settings-intro', this.store.synced ? 'Suas escolhas acompanham esta conta do Jellyfin em todos os seus dispositivos.' : 'Esta prévia salva as escolhas neste dispositivo.'), message, layout);
    this.element.append(panel);
    // Native selects need their Up/Down and Enter behaviour. Register before the
    // shared remote listener so choosing an option cannot leave the field.
    window.addEventListener('keydown', this.selectKeys, true);
    window.addEventListener('keyup', this.selectKeys, true);
    window.addEventListener('command', this.selectCommand, true);
    this.removeRemote = attachRemote(this.element, () => this.options.onBack());
  }
  private selectKeys = (event: KeyboardEvent) => {
    const active = document.activeElement;
    if (!this.disposed && active instanceof HTMLInputElement && active.type === 'range' && this.element.contains(active)
      && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      event.stopImmediatePropagation(); return;
    }
    if (!this.disposed && active instanceof HTMLInputElement && active.type === 'checkbox' && this.element.contains(active) && event.key === 'Enter') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type === 'keydown' && !event.repeat) active.click();
      return;
    }
    if (!this.disposed && active instanceof HTMLSelectElement && this.element.contains(active)
      && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) event.stopImmediatePropagation();
  };
  private selectCommand = (event: Event) => {
    const active = document.activeElement;
    const command = (event as CustomEvent).detail?.command?.toLowerCase();
    if (active instanceof HTMLInputElement && active.type === 'range' && this.element.contains(active) && ['left', 'right'].includes(command)) {
      event.preventDefault(); event.stopImmediatePropagation();
      active.value = String(Math.min(Number(active.max), Math.max(Number(active.min), Number(active.value) + (command === 'right' ? 1 : -1))));
      active.dispatchEvent(new Event('input', { bubbles: true })); return;
    }
    if (!(active instanceof HTMLSelectElement) || !this.element.contains(active) || !['up', 'down', 'left', 'right', 'select', 'enter', 'ok'].includes(command)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (['up', 'down', 'left', 'right'].includes(command)) {
      const direction = command === 'up' || command === 'left' ? -1 : 1;
      active.selectedIndex = Math.max(0, Math.min(active.options.length - 1, active.selectedIndex + direction)); active.dispatchEvent(new Event('change', { bubbles: true }));
    } else active.click();
  };
  private control(label: string, focus: string, action: () => void, glyph = '', classes = ''): HTMLButtonElement {
    const node = button(label, glyph, classes, action); node.dataset.providerSettingsFocus = focus; return node;
  }
  private restoreFocus(key?: string): void {
    if (!key) return;
    const target = Array.from(this.element.querySelectorAll<HTMLElement>('[data-provider-settings-focus]')).find(node => node.dataset.providerSettingsFocus === key);
    target?.focus({ preventScroll: true });
  }
  async load(): Promise<void> {
    if (this.disposed || this.loading || this.saving) return;
    const generation = ++this.generation; this.previewGeneration++;
    this.collectionsLoading = false;
    this.loading = true; this.ready = false; this.saveButton.disabled = true; this.cancelButton.disabled = true; this.reloadButton.hidden = true;
    this.status.textContent = 'Carregando serviços de streaming salvos…';
    this.setControlsDisabled(true);
    try {
      const [settings, collections] = await Promise.allSettled([this.store.load(), this.api.getCollectionList()]);
      if (this.disposed || generation !== this.generation) return;
      if (settings.status === 'rejected') throw settings.reason;
      this.draft = settings.value; this.saved = cloneProviderHomes(this.draft); this.ready = true;
      this.collections = collections.status === 'fulfilled' ? collections.value : [];
      this.collectionsFailed = collections.status === 'rejected';
      this.status.textContent = collections.status === 'rejected' ? 'Não foi possível carregar as opções de coleção. As fileiras automáticas de filmes e séries continuam disponíveis.' : '';
      if (this.selected !== 'home' && !this.draft.providers.some(provider => provider.id === this.selected)) this.selected = 'home';
      this.previewItems.clear(); this.render();
      if (!this.directory && !this.directoryLoading) void this.loadDirectory();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.status.textContent = error instanceof ProviderHomesSyncError ? error.message : 'Não foi possível carregar os serviços de streaming salvos. Verifique sua conexão e tente novamente.';
      this.reloadButton.hidden = false;
    } finally {
      if (!this.disposed && generation === this.generation) { this.loading = false; this.saveButton.disabled = !this.ready; this.cancelButton.disabled = !this.ready; this.setControlsDisabled(!this.ready); }
    }
  }
  private setControlsDisabled(disabled: boolean): void {
    for (const region of [this.sidebar, this.workspace]) region.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select').forEach(control => {
      if (disabled) { control.dataset.providerDisabled = String(control.disabled); control.disabled = true; }
      else if (control.dataset.providerDisabled !== undefined) { control.disabled = control.dataset.providerDisabled === 'true'; delete control.dataset.providerDisabled; }
    });
  }
  private changed(): void { this.status.textContent = 'Alterações não salvas'; }
  private cancel(): void {
    if (this.disposed || !this.ready || this.loading || this.saving) return;
    this.draft = cloneProviderHomes(this.saved); this.previewItems.clear();
    if (this.selected !== 'home' && !this.draft.providers.some(provider => provider.id === this.selected)) this.selected = 'home';
    this.render(); this.status.textContent = 'Alterações descartadas.'; this.reloadButton.hidden = true;
  }
  private render(focus?: string): void {
    if (this.disposed) return;
    const restore = focus || (document.activeElement as HTMLElement | null)?.dataset.providerSettingsFocus;
    this.previewGeneration++;
    this.renderSidebar(); replace(this.workspace);
    if (this.selected === 'home') this.renderHome();
    else {
      const provider = this.draft.providers.find(provider => provider.id === this.selected);
      if (provider) this.renderProvider(provider);
    }
    // A collection-choice refresh can finish during Save. New controls must
    // inherit the pending operation's disabled state too.
    this.setControlsDisabled(this.loading || this.saving || !this.ready);
    this.restoreFocus(restore);
  }
  private renderSidebar(): void {
    replace(this.sidebar);
    const home = this.control('Fileira da Página Inicial', 'page:home', () => { this.selected = 'home'; this.render('page:home'); });
    home.setAttribute('aria-pressed', String(this.selected === 'home')); this.sidebar.append(home);
    for (const provider of this.draft.providers) {
      const brand = providerAppearance(provider);
      const choice = this.control(brand.name, `page:${provider.id}`, () => { this.selected = provider.id; this.render(`page:${provider.id}`); });
      choice.setAttribute('aria-pressed', String(this.selected === provider.id));
      const logo = providerLogo(provider, 'tvl-provider-sidebar-logo'); logo.setAttribute('aria-hidden', 'true'); choice.prepend(logo);
      if (!provider.enabled) choice.append(el('small', '', 'Oculto'));
      this.sidebar.append(choice);
    }
    const add = this.control('Adicionar serviço', 'add-service', () => {
      const provider = defaultCustomProvider(`custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      this.draft.providers.push(provider); this.selected = provider.id; this.changed(); this.render('provider:name');
    }); add.disabled = this.draft.providers.length >= maxProviders; this.sidebar.append(add);
  }
  private field(label: string, focus: string, value: string, change: (value: string) => void, max = 80): HTMLElement {
    const wrap = el('label', 'tvl-provider-field', label), input = el('input'); input.type = 'text'; input.maxLength = max; input.value = value;
    input.dataset.providerSettingsFocus = focus; input.addEventListener('input', () => { change(input.value); this.changed(); }); wrap.append(input); return wrap;
  }
  private checkbox(label: string, focus: string, value: boolean, change: (value: boolean) => void): HTMLElement {
    const wrap = el('label', 'tvl-provider-toggle'), input = el('input'); input.type = 'checkbox'; input.checked = value; input.dataset.providerSettingsFocus = focus;
    input.addEventListener('change', () => { change(input.checked); this.changed(); }); wrap.append(input, el('span', '', label)); return wrap;
  }
  private select(label: string, focus: string, value: string, choices: [string, string][], change: (value: string) => void): HTMLElement {
    const wrap = el('label', 'tvl-provider-field', label), select = el('select'); select.dataset.providerSettingsFocus = focus;
    for (const [id, text] of choices) { const option = el('option', '', text); option.value = id; select.append(option); }
    select.value = value; select.addEventListener('change', () => { change(select.value); this.changed(); }); wrap.append(select); return wrap;
  }
  private renderHome(): void {
    this.workspace.append(el('h2', '', 'A fileira de serviços de streaming'), el('p', 'tvl-provider-help', 'Escolha quais serviços aparecem na Página Inicial e onde a fileira deve ficar.'));
    this.workspace.append(this.checkbox('Exibir serviços de streaming na Página Inicial', 'home:enabled', this.draft.enabled, value => { this.draft.enabled = value; this.renderHomePreview(); }));
    this.workspace.append(this.field('Título da fileira', 'home:title', this.draft.title, value => { this.draft.title = value; this.renderHomePreview(); }));
    const positions: [string, string][] = [['start', 'Antes da primeira fileira'], ...this.anchors.map(anchor => [anchor.key, `Antes de ${anchor.label}`] as [string, string]), ['end', 'Depois da última fileira']];
    if (!positions.some(([key]) => key === this.draft.placement)) positions.splice(positions.length - 1, 0, [this.draft.placement, 'Posição salva na Página Inicial (indisponível no momento)']);
    this.workspace.append(this.select('Posição na Página Inicial', 'home:placement', this.draft.placement, positions, value => { this.draft.placement = value; }));
    const size = el('label', 'tvl-provider-field tvl-provider-size'), range = el('input'), amount = el('output', '', `${this.draft.tileScale}%`);
    range.type = 'range'; range.min = '70'; range.max = '150'; range.step = '1'; range.value = String(this.draft.tileScale);
    range.setAttribute('aria-label', 'Tamanho do card'); range.setAttribute('aria-valuetext', `${range.value}%`); range.dataset.providerSettingsFocus = 'home:tile-size'; amount.setAttribute('aria-hidden', 'true');
    range.addEventListener('input', () => { this.draft.tileScale = Number(range.value); amount.textContent = `${range.value}%`; range.setAttribute('aria-valuetext', `${range.value}%`); this.changed(); this.renderHomePreview(); });
    size.append(el('span', '', 'Tamanho do card'), amount, range); this.workspace.append(size);
    this.workspace.append(this.checkbox('Exibir nomes dos serviços', 'home:show-names', this.draft.showNames, value => { this.draft.showNames = value; this.renderHomePreview(); }));
    const preview = el('aside', 'tvl-provider-home-preview'); preview.setAttribute('aria-label', 'Prévia da fileira de serviços na Página Inicial'); this.workspace.append(preview); this.renderHomePreview();
    const list = el('ol', 'tvl-provider-service-order'); list.setAttribute('aria-label', 'Ordem dos serviços na Página Inicial');
    for (const [index, provider] of this.draft.providers.entries()) {
      const brand = providerAppearance(provider), entry = el('li');
      entry.append(this.checkbox(`Exibir ${brand.name}`, `enabled:${provider.id}`, provider.enabled, value => { provider.enabled = value; this.render(`enabled:${provider.id}`); }));
      const actions = el('div', 'tvl-provider-order-actions');
      const earlier = this.control(`Mover ${brand.name} para a esquerda`, `earlier:${provider.id}`, () => this.moveProvider(provider, -1), '', 'tvl-provider-order-button'); earlier.disabled = index === 0;
      const later = this.control(`Mover ${brand.name} para a direita`, `later:${provider.id}`, () => this.moveProvider(provider, 1), '', 'tvl-provider-order-button'); later.disabled = index === this.draft.providers.length - 1;
      actions.append(earlier, later); entry.append(actions); list.append(entry);
    }
    this.workspace.append(list);
    for (const brand of providerBrands.filter(brand => !this.draft.providers.some(provider => provider.id === brand.id))) {
      const add = this.control(`Adicionar ${brand.name}`, `add-provider:${brand.id}`, () => {
        this.draft.providers.push(defaultProviderConfig(brand.id)); this.changed(); this.render(`page:${brand.id}`);
      }); add.disabled = this.draft.providers.length >= maxProviders; this.workspace.append(add);
    }
  }
  private renderHomePreview(): void {
    const preview = this.workspace.querySelector<HTMLElement>('.tvl-provider-home-preview'); if (!preview) return;
    replace(preview, el('span', 'tvl-provider-preview-label', 'PRÉVIA DA PÁGINA INICIAL'));
    if (!this.draft.enabled) { preview.append(el('p', 'tvl-provider-help', 'Esta fileira está oculta na Página Inicial.')); return; }
    const row = providerHomeRow(this.draft, id => { this.selected = id; this.render(`page:${id}`); });
    if (row) preview.append(row); else preview.append(el('p', 'tvl-provider-help', 'Nenhum serviço está ativado.'));
  }
  private moveProvider(provider: ProviderHomeConfig, direction: number): void {
    const index = this.draft.providers.indexOf(provider), next = index + direction;
    if (next < 0 || next >= this.draft.providers.length) return;
    this.draft.providers.splice(index, 1); this.draft.providers.splice(next, 0, provider); this.changed(); this.render(`enabled:${provider.id}`);
  }
  private renderProvider(provider: ProviderHomeConfig): void {
    const brand = providerAppearance(provider), header = el('div', 'tvl-provider-editor-brand');
    header.style.setProperty('--provider-accent', brand.accent); header.append(providerLogo(provider), el('h2', '', `Início de ${brand.name}`)); this.workspace.append(header);
    this.workspace.append(this.serviceField(provider, 'Nome do serviço', 'name', provider.name, value => { provider.name = value; this.updateAppearance(provider); }, value => value.trim() ? '' : 'Digite o nome do serviço.'));
    const options = el('div', 'tvl-provider-page-options');
    options.append(this.checkbox(`Exibir ${brand.name} na Página Inicial`, 'provider:enabled', provider.enabled, value => { provider.enabled = value; this.render('provider:enabled'); }),
      this.checkbox('Exibir arte em destaque (Hero)', 'provider:hero', provider.hero, value => { provider.hero = value; })); this.workspace.append(options);
    this.renderContent(provider);
    this.workspace.append(el('h3', '', 'Arte visual do serviço'));
    const appearance = el('div', 'tvl-provider-appearance'), fields = el('div');
    fields.append(this.serviceField(provider, 'URL do Logotipo', 'logo', provider.logoUrl, value => { provider.logoUrl = value.trim(); this.updateAppearance(provider); }, value => this.logoError(value), 2048));
    fields.append(el('p', 'tvl-provider-help', providerBrand(provider.id) ? 'Deixe a URL do logotipo em branco para usar o logotipo original do serviço.' : 'Use uma URL de imagem HTTP ou HTTPS, ou deixe em branco para um badge com inicial.'));
    fields.append(this.serviceField(provider, 'Cor de destaque (Accent)', 'accent', provider.accent, value => { provider.accent = value; this.updateAppearance(provider); }, value => /^#[\da-f]{6}$/i.test(value) ? '' : 'Use uma cor hexadecimal de seis dígitos como #e50914.', 7));
    const tilePreview = el('aside', 'tvl-provider-appearance-preview'); tilePreview.setAttribute('aria-label', 'Prévia do card do serviço');
    appearance.append(fields, tilePreview); this.workspace.append(appearance); this.updateAppearance(provider);
    const advanced = el('details', 'tvl-provider-advanced'), summary = el('summary', '', 'Correspondência automática de catálogo'); summary.tabIndex = 0;
    advanced.append(summary, el('p', 'tvl-provider-help', 'Escolha os serviços cujos filmes e séries pertencem a esta página. O Disney+ também inclui títulos dos estúdios Disney antes ou entre lançamentos no streaming. As fileiras de coleção funcionam independentemente dessas escolhas.'));
    const sourceChoices = el('div', 'tvl-provider-service-sources'); advanced.append(sourceChoices);
    this.renderServiceSources(provider, sourceChoices);
    const offers = el('fieldset', 'tvl-provider-offers'); offers.append(el('legend', '', 'Catálogo do Brasil'));
    for (const [type, label] of [['flatrate', 'Incluir títulos de assinatura'], ['free', 'Incluir títulos gratuitos'], ['ads', 'Incluir títulos com anúncios']] as const) {
      offers.append(this.checkbox(label, `provider:offer-${type}`, provider.offerTypes.includes(type), checked => {
        provider.offerTypes = checked ? [...provider.offerTypes, type] : provider.offerTypes.filter(value => value !== type);
        this.refreshSelectedPreview(provider); const error = offers.querySelector<HTMLElement>('.tvl-provider-field-error')!;
        error.textContent = provider.offerTypes.length ? '' : 'Escolha pelo menos um tipo de disponibilidade.'; error.hidden = !!provider.offerTypes.length;
      }));
    }
    const offerError = el('p', 'tvl-provider-field-error', provider.offerTypes.length ? '' : 'Escolha pelo menos um tipo de disponibilidade.'); offerError.hidden = !!provider.offerTypes.length; offers.append(offerError); advanced.append(offers); this.workspace.append(advanced);
    const manage = el('div', 'tvl-provider-manage');
    const builtin = providerBrand(provider.id);
    if (builtin) manage.append(this.control('Restaurar padrões', 'provider:restore', () => {
      const index = this.draft.providers.indexOf(provider); this.draft.providers[index] = defaultProviderConfig(builtin.id);
      this.clearProviderInputs(provider.id); this.changed(); this.render('provider:name');
    }));
    manage.append(this.control('Remover serviço', 'provider:remove', () => {
      this.draft.providers = this.draft.providers.filter(value => value !== provider); this.clearProviderInputs(provider.id);
      this.selected = 'home'; this.changed(); this.render('page:home');
    }, '', 'tvl-provider-remove'));
    this.workspace.append(manage);
  }
  private renderContent(provider: ProviderHomeConfig): void {
    const brand = providerAppearance(provider);
    this.workspace.append(el('h3', '', 'Fileiras de conteúdo'), el('p', 'tvl-provider-help', provider.rows.length
      ? 'Escolha uma fileira para alterar o conteúdo ou adicione uma fileira de coleção ou da Minha Lista. Links salvos de coleção continuam funcionando se você renomear a coleção.'
      : 'Adicione uma fileira de coleção ou da Minha Lista para pré-visualizar filmes e séries.'));
    const rowList = el('div', 'tvl-provider-row-list'); rowList.setAttribute('aria-label', `Fileiras de ${brand.name}`);
    const selected = provider.rows.find(row => row.id === this.selectedRows.get(provider.id)) || provider.rows[0];
    if (selected) this.selectedRows.set(provider.id, selected.id);
    for (const [index, row] of provider.rows.entries()) {
      const entry = el('div', 'tvl-provider-row-choice');
      const choose = this.control(row.title || sources.find(([source]) => source === row.source)![1], `row:${row.id}`, () => { this.selectedRows.set(provider.id, row.id); this.render(`row:${row.id}`); });
      choose.classList.add('tvl-provider-row-button'); choose.setAttribute('aria-label', row.title || sources.find(([source]) => source === row.source)![1]);
      const rowSource = el('span', 'tvl-provider-row-source-label', this.rowSourceName(row)); rowSource.id = `provider-row-source-${provider.id}-${row.id}`;
      choose.append(rowSource); choose.setAttribute('aria-describedby', rowSource.id);
      choose.setAttribute('aria-pressed', String(row === selected)); if (!row.enabled) choose.append(el('small', '', 'Oculto'));
      const up = this.control(`Mover ${row.title || 'fileira'} para cima`, `up:${row.id}`, () => this.moveRow(provider, row, -1), '', 'tvl-provider-order-button'); up.disabled = index === 0;
      const down = this.control(`Mover ${row.title || 'fileira'} para baixo`, `down:${row.id}`, () => this.moveRow(provider, row, 1), '', 'tvl-provider-order-button'); down.disabled = index === provider.rows.length - 1;
      const arrows = el('div', 'tvl-provider-order-actions'); arrows.append(up, down); entry.append(choose, arrows); rowList.append(entry);
    }
    if (!selected) {
      const choices: [string, string][] = [['', 'Escolha uma coleção'], ...this.collections.map(item => [item.Id, item.Name] as [string, string])];
      this.workspace.append(this.select('Coleção', 'row:collection', '', choices, value => {
        if (value) this.addCollectionRow(provider, value);
      }));
    }
    this.workspace.append(rowList);
    const add = this.control('Adicionar fileira de coleção', 'add-row', () => this.addCollectionRow(provider));
    add.disabled = provider.rows.length >= maxProviderRows;
    this.workspace.append(add);
    const addWatchlist = this.control('Adicionar fileira da Minha Lista', 'add-watchlist', () => {
      if (provider.rows.length >= maxProviderRows) return;
      const row: ProviderRow = { id: `watchlist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: 'Minha Lista', source: 'watchlist', collectionId: '', enabled: true, ranked: false, itemSort: 'title' };
      provider.rows.push(row); this.selectedRows.set(provider.id, row.id); this.changed(); this.render('row:title');
    });
    addWatchlist.disabled = provider.rows.length >= maxProviderRows;
    this.workspace.append(addWatchlist);
    if (selected) this.renderRow(provider, selected);
    this.workspace.append(el('p', 'tvl-provider-help', 'Para escolher filmes ou séries específicos, use “Adicionar à coleção” em um título e selecione essa coleção aqui.'));
    if (this.collectionsFailed) this.workspace.append(el('p', 'tvl-provider-field-error', 'Não foi possível carregar as coleções. As configurações dos serviços não foram alteradas.'));
    else if (!this.collections.length) this.workspace.append(el('p', 'tvl-provider-help', 'Ainda não há coleções disponíveis para esta conta.'));
    const reload = this.control(this.collectionsLoading ? 'Atualizando coleções…' : 'Atualizar coleções', 'refresh-collections', () => { void this.refreshCollections(); });
    reload.disabled = this.collectionsLoading; this.workspace.append(reload);
  }
  private addCollectionRow(provider: ProviderHomeConfig, collectionId = ''): void {
    if (provider.rows.length >= maxProviderRows) return;
    const title = this.collections.find(item => item.Id === collectionId)?.Name || 'Coleção';
    const row: ProviderRow = { id: `row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: title.slice(0, 80), source: 'collection', collectionId, enabled: true, ranked: false, itemSort: 'collection' };
    provider.rows.push(row); this.selectedRows.set(provider.id, row.id); this.changed(); this.render(collectionId ? 'row:title' : 'row:collection');
  }
  private async refreshCollections(): Promise<void> {
    if (this.disposed || this.loading || this.saving || this.collectionsLoading) return;
    const generation = this.generation; this.collectionsLoading = true; this.render('refresh-collections');
    try {
      const collections = await this.api.getCollectionList();
      if (this.disposed || generation !== this.generation) return;
      this.collections = collections; this.collectionsFailed = false; this.previewItems.clear();
    } catch {
      if (this.disposed || generation !== this.generation) return;
      this.collectionsFailed = true;
    } finally {
      if (!this.disposed && generation === this.generation) {
        this.collectionsLoading = false;
        const active = document.activeElement as HTMLElement | null;
        this.render(active?.dataset.providerSettingsFocus || 'refresh-collections');
      }
    }
  }
  private serviceField(provider: ProviderHomeConfig, label: string, focus: string, value: string, change: (value: string) => void, validate: (value: string) => string, max = 80): HTMLElement {
    const wrap = this.field(label, `provider:${focus}`, value, change, max), input = wrap.querySelector('input')!;
    input.setAttribute('aria-label', label);
    const error = el('span', 'tvl-provider-field-error'); error.id = `provider-field-${provider.id}-${focus}`; input.setAttribute('aria-describedby', error.id);
    const check = () => { const message = validate(input.value); error.textContent = message; error.hidden = !message; input.setAttribute('aria-invalid', String(!!message)); };
    input.addEventListener('input', check); wrap.append(error); check(); return wrap;
  }
  private logoError(value: string): string {
    if (!value.trim()) return '';
    try { const url = new URL(value.trim()); if (/^https?:\/\//i.test(value.trim()) && !/\s/.test(value.trim()) && url.hostname && !url.username && !url.password && value.trim().length <= 2048) return ''; } catch { /* Show a field-level error below. */ }
    return 'Use uma URL de imagem HTTP ou HTTPS sem usuário ou senha.';
  }
  private clearProviderInputs(id: ProviderId): void {
    this.directorySearch.delete(`${id}:movieProviderIds`); this.directorySearch.delete(`${id}:showProviderIds`); this.previewItems.clear();
  }
  private async loadDirectory(): Promise<void> {
    if (this.disposed || this.directoryLoading) return;
    if (!this.api.getProviderDirectory) { this.directoryFailed = true; this.refreshServiceSources(); return; }
    const generation = ++this.directoryGeneration;
    this.directoryLoading = true; this.directoryFailed = false; this.refreshServiceSources();
    try {
      const directory = await this.api.getProviderDirectory();
      if (this.disposed || generation !== this.directoryGeneration) return;
      this.directory = directory;
    } catch {
      if (!this.disposed && generation === this.directoryGeneration) this.directoryFailed = true;
    } finally {
      if (!this.disposed && generation === this.directoryGeneration) { this.directoryLoading = false; this.refreshServiceSources(); }
    }
  }
  private refreshServiceSources(): void {
    const host = this.workspace.querySelector<HTMLElement>('.tvl-provider-service-sources');
    const provider = this.draft.providers.find(value => value.id === this.selected);
    if (!host || !provider) return;
    const active = document.activeElement as HTMLElement | null;
    const focus = active && host.contains(active) ? active.dataset.providerSettingsFocus : undefined;
    this.renderServiceSources(provider, host);
    if (this.loading || this.saving || !this.ready) host.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => {
      control.dataset.providerDisabled = String(control.disabled); control.disabled = true;
    });
    if (focus) {
      const controls = Array.from(host.querySelectorAll<HTMLElement>('[data-provider-settings-focus]'));
      const target = controls.find(node => node.dataset.providerSettingsFocus === focus)
        || controls.find(node => node.dataset.providerSettingsFocus === `provider:${focus.includes('showProviderIds') ? 'showProviderIds' : 'movieProviderIds'}:search`);
      target?.focus({ preventScroll: true });
    }
  }
  private renderServiceSources(provider: ProviderHomeConfig, host: HTMLElement): void {
    replace(host);
    const status = el('p', 'tvl-provider-help'); status.setAttribute('role', 'status');
    status.textContent = this.directoryLoading ? 'Carregando a lista completa de serviços do Brasil. Serviços integrados já estão disponíveis.'
      : this.directoryFailed ? 'A lista completa de serviços do Brasil está indisponível. Serviços integrados e seleções salvas continuam disponíveis.' : '';
    status.hidden = !status.textContent; host.append(status);
    if (this.directoryFailed && this.api.getProviderDirectory) host.append(this.control('Tentar lista de serviços novamente', 'provider:directory-retry', () => { void this.loadDirectory(); }));
    const fields = el('div', 'tvl-provider-service-pickers');
    for (const [key, label, kind] of [['movieProviderIds', 'Serviços de filmes', 'filmes'], ['showProviderIds', 'Serviços de séries', 'séries']] as const) {
      fields.append(this.servicePicker(provider, key, label, kind));
    }
    host.append(fields);
  }
  private servicePicker(provider: ProviderHomeConfig, key: ProviderSourceKey, label: string, kind: string): HTMLElement {
    const field = el('fieldset', 'tvl-provider-service-picker'); field.append(el('legend', '', label));
    const search = el('input'); search.type = 'text'; search.placeholder = 'Buscar um serviço'; search.maxLength = 120;
    search.setAttribute('aria-label', `Buscar serviços de ${kind}`); search.dataset.providerSettingsFocus = `provider:${key}:search`;
    const searchKey = `${provider.id}:${key}`; search.value = this.directorySearch.get(searchKey) || ''; field.append(search);
    const summary = el('p', 'tvl-provider-service-selection'); field.append(summary);
    const list = el('div', 'tvl-provider-service-list'); field.append(list);
    const choices = providerServiceChoices(this.directory, key, provider[key]);
    const controls: { choice: typeof choices[number]; input: HTMLInputElement; wrap: HTMLElement }[] = [];
    const empty = el('p', 'tvl-provider-help', 'Nenhum serviço corresponde à sua busca.'); empty.hidden = true;
    for (const choice of choices) {
      const wrap = el('label', 'tvl-provider-toggle'), input = el('input'); input.type = 'checkbox';
      input.dataset.providerSettingsFocus = `provider:${key}:${choice.key}`;
      input.addEventListener('change', () => {
        const current = provider[key];
        let next = input.checked ? [...new Set([...current, ...choice.ids])] : current.filter(id => !choice.ids.includes(id));
        // A partial built-in preset must remain removable at the selection
        // limit, even when its other catalogue variants would not fit.
        if (next.length > 20 && choice.ids.some(id => current.includes(id))) next = current.filter(id => !choice.ids.includes(id));
        if (next.length <= 20) { provider[key] = next; this.changed(); this.refreshSelectedPreview(provider); }
        update();
      });
      wrap.append(input, el('span', '', choice.name)); list.append(wrap); controls.push({ choice, input, wrap });
    }
    list.append(empty);
    const clear = this.control(`Limpar serviços de ${kind}`, `provider:${key}:clear`, () => {
      provider[key] = []; this.changed(); this.refreshSelectedPreview(provider); update();
    }, '', 'tvl-provider-source-clear'); field.append(clear);
    const limit = el('p', 'tvl-provider-help', 'É possível selecionar até 20 serviços de catálogo.'); limit.hidden = true; field.append(limit);
    const update = () => {
      const selected = new Set(provider[key]);
      for (const { choice, input } of controls) {
        const matches = choice.ids.filter(id => selected.has(id)).length;
        input.checked = matches === choice.ids.length; input.indeterminate = matches > 0 && matches < choice.ids.length;
        input.disabled = matches === 0 && new Set([...selected, ...choice.ids]).size > 20;
      }
      const names = [...new Set(choices.filter(choice => choice.ids.some(id => selected.has(id))).map(choice => choice.name))];
      summary.textContent = names.length ? `Selecionados: ${names.join(', ')}` : 'Nenhum serviço de catálogo automático selecionado.';
      limit.hidden = selected.size < 20;
    };
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase(); this.directorySearch.set(searchKey, search.value);
      for (const { choice, wrap } of controls) wrap.hidden = !choice.name.toLocaleLowerCase().includes(query);
      empty.hidden = controls.some(({ wrap }) => !wrap.hidden);
    };
    search.addEventListener('input', filter); update(); filter(); return field;
  }
  private updateAppearance(provider: ProviderHomeConfig): void {
    const appearance = providerAppearance(provider), header = this.workspace.querySelector<HTMLElement>('.tvl-provider-editor-brand');
    if (header) { header.style.setProperty('--provider-accent', appearance.accent); replace(header, providerLogo(provider), el('h2', '', `Início de ${appearance.name}`)); }
    const toggle = this.workspace.querySelector<HTMLElement>('[data-provider-settings-focus="provider:enabled"]')?.parentElement?.querySelector('span');
    if (toggle) toggle.textContent = `Exibir ${appearance.name} na Página Inicial`;
    this.workspace.querySelector('.tvl-provider-row-list')?.setAttribute('aria-label', `Fileiras de ${appearance.name}`);
    const preview = this.workspace.querySelector<HTMLElement>('.tvl-provider-appearance-preview');
    if (preview) {
      replace(preview, el('span', 'tvl-provider-preview-label', 'PRÉVIA DO SERVIÇO'));
      const row = providerHomeRow({ ...this.draft, enabled: true, title: '', providers: [{ ...provider, enabled: true }] }, () => {});
      if (row) preview.append(row);
    }
    this.renderSidebar();
  }
  private refreshSelectedPreview(provider: ProviderHomeConfig): void {
    const row = provider.rows.find(row => row.id === this.selectedRows.get(provider.id)) || provider.rows[0];
    const preview = this.workspace.querySelector<HTMLElement>('.tvl-provider-row-preview');
    if (row && preview) void this.renderRowPreview(provider, row, preview);
  }
  private providerError(provider: ProviderHomeConfig): { focus: string; message: string } | undefined {
    if (!provider.name.trim()) return { focus: 'name', message: 'Digite o nome do serviço.' };
    const logo = this.logoError(provider.logoUrl); if (logo) return { focus: 'logo', message: logo };
    if (!/^#[\da-f]{6}$/i.test(provider.accent)) return { focus: 'accent', message: 'Use uma cor hexadecimal de seis dígitos como #e50914.' };
    if (!provider.offerTypes.length) return { focus: 'offer-flatrate', message: 'Escolha pelo menos um tipo de disponibilidade.' };
  }
  private moveRow(provider: ProviderHomeConfig, row: ProviderRow, direction: number): void {
    const index = provider.rows.indexOf(row), next = index + direction; if (next < 0 || next >= provider.rows.length) return;
    provider.rows.splice(index, 1); provider.rows.splice(next, 0, row); this.changed(); this.render(`row:${row.id}`);
  }
  private updateRowSummary(row: ProviderRow): void {
    const controls = Array.from(this.workspace.querySelectorAll<HTMLElement>('[data-provider-settings-focus]'));
    const choice = controls.find(node => node.dataset.providerSettingsFocus === `row:${row.id}`);
    const label = choice?.querySelector('span'); if (label) label.textContent = row.title || sources.find(([source]) => source === row.source)![1];
    if (label) choice?.setAttribute('aria-label', label.textContent || 'Collection');
    const source = choice?.querySelector('.tvl-provider-row-source-label'); if (source) source.textContent = this.rowSourceName(row);
    const hidden = choice?.querySelector('small');
    if (row.enabled) hidden?.remove(); else if (choice && !hidden) choice.append(el('small', '', 'Oculto'));
    for (const direction of ['up', 'down']) {
      const move = controls.find(node => node.dataset.providerSettingsFocus === `${direction}:${row.id}`);
      const text = `Mover ${row.title || 'fileira'} para ${direction === 'up' ? 'cima' : 'baixo'}`;
      const span = move?.querySelector('span'); if (span) span.textContent = text;
      move?.setAttribute('aria-label', text);
    }
  }
  private rowSourceName(row: ProviderRow): string {
    if (row.source === 'watchlist') return 'Sua Lista · correspondente a este serviço';
    if (row.collectionId) return this.collections.find(item => item.Id === row.collectionId)?.Name || 'Coleção salva (indisponível no momento)';
    if (row.source.startsWith('trending')) return 'Automático (Popularidade TMDB)';
    return row.source === 'collection' ? 'Escolha uma coleção' : 'Catálogo de streaming do Brasil';
  }
  private renderRow(provider: ProviderHomeConfig, row: ProviderRow): void {
    const editor = el('div', 'tvl-provider-row-editor'), fields = el('div', 'tvl-provider-row-fields');
    const preview = el('aside', 'tvl-provider-row-preview'); preview.setAttribute('aria-label', 'Prévia da fileira na página do serviço');
    const refresh = () => { void this.renderRowPreview(provider, row, preview); };
    fields.append(this.field('Título da fileira', 'row:title', row.title, value => {
      row.title = value; this.updateRowSummary(row); refresh();
    }), this.checkbox('Exibir esta fileira', 'row:enabled', row.enabled, value => { row.enabled = value; this.updateRowSummary(row); refresh(); }),
    this.select('Conteúdo', 'row:source', row.source, sources, value => {
      const defaultTitle = sources.find(([source]) => source === row.source)?.[1];
      if (!row.title || row.title === defaultTitle) row.title = sources.find(([source]) => source === value)![1];
      row.source = value as ProviderRowSource; row.collectionId = ''; this.render('row:source');
    }));
    const collectionRequired = row.source === 'collection';
    const isTrending = row.source.startsWith('trending');
    const defaultOptionLabel = collectionRequired ? 'Escolha uma coleção' : isTrending ? 'Automático (Popularidade TMDB)' : 'Automático';
    const collections: [string, string][] = [[ '', defaultOptionLabel ], ...this.collections.map(item => [item.Id, item.Name] as [string, string])];
    if (row.collectionId && !collections.some(([id]) => id === row.collectionId)) collections.push([row.collectionId, 'Coleção salva (indisponível no momento)']);
    const collection = this.select(collectionRequired ? 'Coleção' : 'Substituição por coleção', 'row:collection', row.collectionId, collections, value => {
      if (!row.collectionId && (row.title === 'Collection' || row.title === 'Coleção')) {
        row.title = (this.collections.find(item => item.Id === value)?.Name || row.title).slice(0, 80);
        const title = fields.querySelector<HTMLInputElement>('[data-provider-settings-focus="row:title"]'); if (title) title.value = row.title;
        this.updateRowSummary(row);
      }
      row.collectionId = value; this.updateRowSummary(row); fields.querySelector('[aria-invalid]')?.removeAttribute('aria-invalid'); refresh();
    });
    if (row.source !== 'watchlist') fields.prepend(collection);
    fields.append(this.select('Ordem dos itens', 'row:sort', row.itemSort, sorts, value => { row.itemSort = value as ProviderItemSort; refresh(); }),
      this.checkbox('Exibir numeração de ranking', 'row:ranked', row.ranked, value => { row.ranked = value; refresh(); }),
      this.control('Remover fileira', 'remove-row', () => {
        const index = provider.rows.indexOf(row); provider.rows.splice(index, 1); this.selectedRows.set(provider.id, provider.rows[Math.min(index, provider.rows.length - 1)]?.id || '');
        this.changed(); this.render('add-row');
      }, '', 'tvl-provider-remove'));
    fields.append(el('p', 'tvl-provider-help', isTrending ? 'Automático busca os títulos mais populares do TMDB para este serviço e cruza com a sua biblioteca do Jellyfin. Se desejar, escolha uma coleção manual para sobrescrever.'
      : row.source === 'watchlist' ? 'Filmes e séries salvos na sua Lista aparecem juntos quando correspondem ao catálogo deste serviço.'
      : row.source === 'collection' ? 'Apenas títulos visíveis para esta conta do Jellyfin podem aparecer.' : 'Automático exibe títulos correspondentes na sua biblioteca do Jellyfin. O Disney+ inclui títulos dos estúdios Disney junto com os lançamentos de streaming do Brasil. Uma substituição por coleção utiliza a coleção escolhida em vez disso.'));
    editor.append(fields, preview); this.workspace.append(editor); refresh();
  }
  private async renderRowPreview(provider: ProviderHomeConfig, row: ProviderRow, preview: HTMLElement): Promise<void> {
    const generation = ++this.previewGeneration;
    replace(preview, el('span', 'tvl-provider-preview-label', 'PRÉVIA DA FILEIRA'), el('h3', '', row.title || sources.find(([source]) => source === row.source)![1]));
    const status = el('p', 'tvl-provider-help'); preview.append(status);
    if (!row.enabled) { status.textContent = 'Esta fileira está oculta na página do serviço.'; return; }
    if (row.source === 'collection' && !row.collectionId) { status.textContent = 'Escolha uma coleção para pré-visualizar esta fileira.'; return; }
    const key = JSON.stringify([provider.id, provider.name, provider.movieProviderIds, provider.showProviderIds, provider.offerTypes, row.source, row.collectionId, row.itemSort]);
    try {
      let items = this.previewItems.get(key);
      if (!items) {
        status.textContent = 'Carregando prévia…';
        let request = this.previewPending.get(key);
        if (!request) {
          request = this.options.loadPreview({ ...provider, movieProviderIds: [...provider.movieProviderIds], showProviderIds: [...provider.showProviderIds], offerTypes: [...provider.offerTypes], rows: provider.rows.map(row => ({ ...row })) }, { ...row }); this.previewPending.set(key, request);
          void request.then(value => { if (!this.disposed) this.previewItems.set(key, value); }, () => undefined).then(() => { if (this.previewPending.get(key) === request) this.previewPending.delete(key); });
        }
        items = await request;
      }
      if (this.disposed || generation !== this.previewGeneration) return;
      status.textContent = items.length ? '' : row.source === 'watchlist' ? 'Nenhum filme ou série da sua Lista corresponde a este serviço ainda.' : 'Nenhum título correspondente está disponível na biblioteca desta conta ainda.';
      const cards = el('div', 'tvl-home-row-cards');
      items.slice(0, 8).forEach((item, index) => {
        const entry = el('div', 'tvl-home-row-entry'); entry.append(homeRowCard(this.api, item, row.ranked ? index + 1 : undefined)); cards.append(entry);
      }); preview.append(cards);
    } catch (error) {
      if (this.disposed || generation !== this.previewGeneration) return;
      status.textContent = error instanceof Error ? error.message : 'Não foi possível carregar esta prévia. Seu rascunho continua inalterado.';
      preview.append(this.control('Tentar prévia novamente', 'retry-preview', () => { void this.renderRowPreview(provider, row, preview); }));
    }
  }
  private async save(): Promise<void> {
    if (this.disposed || !this.ready || this.saving || this.loading) return;
    for (const provider of this.draft.providers) {
      const invalid = this.providerError(provider);
      if (invalid) {
        this.selected = provider.id; this.render();
        if (invalid.focus.startsWith('offer-')) this.workspace.querySelector<HTMLDetailsElement>('.tvl-provider-advanced')!.open = true;
        this.restoreFocus(`provider:${invalid.focus}`); this.status.textContent = invalid.message; return;
      }
      const row = provider.rows.find(row => row.enabled && row.source === 'collection' && !row.collectionId);
      if (!row) continue;
      this.selected = provider.id; this.selectedRows.set(provider.id, row.id); this.render('row:collection');
      const collection = Array.from(this.workspace.querySelectorAll<HTMLElement>('[data-provider-settings-focus]')).find(node => node.dataset.providerSettingsFocus === 'row:collection');
      collection?.setAttribute('aria-invalid', 'true');
      this.status.textContent = `Escolha uma coleção para “${row.title || 'Coleção'}” antes de salvar.`;
      return;
    }
    this.saving = true; this.saveButton.disabled = true; this.cancelButton.disabled = true; this.setControlsDisabled(true); this.status.textContent = 'Salvando serviços de streaming…';
    try {
      const saved = await this.store.save(cloneProviderHomes(this.draft)); if (this.disposed) return;
      this.draft = saved; this.saved = cloneProviderHomes(saved); this.render(); this.status.textContent = this.store.synced ? 'Salvo na sua conta do Jellyfin.' : 'Salvo neste dispositivo.';
      this.reloadButton.hidden = true;
      window.dispatchEvent(new CustomEvent('tvl-provider-settings-changed', { detail: { serverId: this.api.serverId, userId: this.api.userId } }));
    } catch (error) {
      if (this.disposed) return;
      this.status.textContent = error instanceof ProviderHomesSyncError ? error.message : 'Não foi possível salvar os serviços de streaming. Seu rascunho continua aqui.';
      if (error instanceof ProviderHomesSyncError && (error.kind === 'conflict' || error.kind === 'stale')) {
        this.ready = false; this.reloadButton.hidden = error.kind === 'stale';
      }
    } finally {
      if (!this.disposed) { this.saving = false; this.saveButton.disabled = !this.ready; this.cancelButton.disabled = !this.ready; this.setControlsDisabled(false); }
    }
  }
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.generation++; this.previewGeneration++; this.directoryGeneration++; this.store.destroy(); this.removeRemote();
    window.removeEventListener('keydown', this.selectKeys, true); window.removeEventListener('keyup', this.selectKeys, true); window.removeEventListener('command', this.selectCommand, true);
    this.previewItems.clear(); this.previewPending.clear(); this.element.remove();
  }
}
