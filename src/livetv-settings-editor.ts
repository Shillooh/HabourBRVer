import type { MediaApi } from './types';
import { button, el, replace } from './dom';
import { brandLabel } from './interface-branding';
import { attachRemote } from './remote';
import { defaultLiveTvSettings, defaultSenadoUrls, parseLiveTvSettings, type LiveTvSettings } from './livetv-settings';
import { createLiveTvStore, LiveTvStore, LiveTvSyncError } from './livetv-settings-store';

export class LiveTvSettingsEditor {
  readonly element = el('section', 'tvl-root tvl-keyboard tvl-livetv-settings');
  private store: LiveTvStore;
  private draft: LiveTvSettings;
  private saved: LiveTvSettings;

  private defaultChannelEnabledCheckbox = el('input') as HTMLInputElement;
  private channelNameInput = el('input') as HTMLInputElement;
  private channelDescInput = el('input') as HTMLInputElement;
  private customM3uInput = el('input') as HTMLInputElement;
  private userAgentSelect = el('select') as HTMLSelectElement;
  private localRegionSelect = el('select') as HTMLSelectElement;
  private urlList = el('ul', 'tvl-livetv-url-list');
  private newUrlInput = el('input') as HTMLInputElement;

  private status = el('p', 'tvl-livetv-settings-status');
  private saveButton: HTMLButtonElement;
  private resetButton = button('Restaurar padrões de fábrica', 'restore', 'tvl-danger tvl-livetv-btn-reset', () => void this.reset());
  private restoreUrlsButton = button('Restaurar 5 links da TV Senado', 'restart_alt', 'tvl-secondary tvl-livetv-btn-restore', () => this.restoreSenadoUrls());
  private cancelButton = button('Cancelar', '', 'tvl-cancel', () => this.cancel());

  private busy = false;
  private saving = false;
  private ready = false;
  private disposed = false;
  private removeRemote: () => void;

  constructor(private api: MediaApi, private options: { onBack: () => void; scope?: 'user' | 'global'; targetUserId?: string }) {
    this.store = createLiveTvStore(api, options.scope || 'global', options.targetUserId);
    this.draft = { ...this.store.cached, defaultChannelUrls: [...this.store.cached.defaultChannelUrls] };
    this.saved = { ...this.draft, defaultChannelUrls: [...this.draft.defaultChannelUrls] };

    this.saveButton = button('Salvar Padrão Global', 'check', 'tvl-primary', () => void this.save());
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Configurações Globais de TV Ao Vivo');

    const header = el('header', 'tvl-header');
    header.append(button('Voltar', 'back', 'tvl-back', () => this.cancel()), brandLabel('span', 'tvl-wordmark'));

    const main = el('div', 'tvl-livetv-settings-content');

    const banner = el('div', 'tvl-admin-banner');
    const bannerHeader = el('div', 'tvl-admin-banner-header');
    bannerHeader.innerHTML = '<span class="material-icons">shield</span><strong>MODO ADMINISTRADOR — TV AO VIVO BOX</strong>';
    const bannerText = el('p', '', 'Você está configurando o Padrão Global de TV Ao Vivo do HabourBR. O canal padrão e a lista de fallbacks são utilizados ao abrir a área de TV.');
    banner.append(bannerHeader, bannerText);

    const title = el('h1', '', 'TV Ao Vivo (Live TV Box)');
    const intro = el('p', 'tvl-livetv-settings-intro', 'Configure a reprodução automática de canal em tela cheia e o auto-failover caso links fiquem fora do ar.');

    // Checkbox canal padrão
    const cbLabel = el('label', 'tvl-livetv-checkbox-field');
    this.defaultChannelEnabledCheckbox.type = 'checkbox';
    this.defaultChannelEnabledCheckbox.checked = this.draft.defaultChannelEnabled;
    this.defaultChannelEnabledCheckbox.addEventListener('change', () => {
      this.draft.defaultChannelEnabled = this.defaultChannelEnabledCheckbox.checked;
      this.syncDirty();
    });
    cbLabel.append(this.defaultChannelEnabledCheckbox, el('span', '', 'Ativar reprodução automática do Canal Padrão ao abrir a TV Ao Vivo'));

    // Nome do Canal Padrão
    const nameLabel = el('label', 'tvl-livetv-text-field');
    nameLabel.append(el('span', '', 'Nome do Canal Padrão (ex: TV Senado)'));
    this.channelNameInput.type = 'text';
    this.channelNameInput.maxLength = 100;
    this.channelNameInput.value = this.draft.defaultChannelName;
    this.channelNameInput.addEventListener('input', () => {
      this.draft.defaultChannelName = this.channelNameInput.value.trim() || 'TV Senado';
      this.syncDirty();
    });
    nameLabel.append(this.channelNameInput);

    // Subtítulo / Descrição
    const descLabel = el('label', 'tvl-livetv-text-field');
    descLabel.append(el('span', '', 'Subtítulo / Descrição'));
    this.channelDescInput.type = 'text';
    this.channelDescInput.maxLength = 200;
    this.channelDescInput.value = this.draft.defaultChannelDescription;
    this.channelDescInput.addEventListener('input', () => {
      this.draft.defaultChannelDescription = this.channelDescInput.value.trim() || 'Canal de Boas-Vindas · Ao Vivo 24h';
      this.syncDirty();
    });
    descLabel.append(this.channelDescInput);

    // Lista de URLs .m3u8 (Principal + Fallbacks)
    const urlHeading = el('h2', '', 'Lista de Links .m3u8 (Principal + Fila de Fallbacks)');
    const urlHelp = el('p', 'tvl-livetv-settings-help', 'O sistema tenta reproduzir o Link #1. Em caso de queda ou erro de rede, o auto-failover passa automaticamente para o Link #2, #3, etc.');

    // Adicionar URL
    const addRow = el('div', 'tvl-livetv-add-row');
    this.newUrlInput.type = 'url';
    this.newUrlInput.placeholder = 'http://exemplo.com/stream.m3u8';
    const addBtn = button('Adicionar URL', 'add', '', () => this.addUrl());
    addRow.append(this.newUrlInput, addBtn);

    // Fonte .m3u de Categorias
    const m3uHeading = el('h2', '', 'Fonte .m3u Opcional para Categorias');
    const m3uHelp = el('p', 'tvl-livetv-settings-help', 'O HabourBR lê automaticamente os TunerHosts M3U cadastrados no Jellyfin. Você também pode informar um arquivo local ou URL adicional:');
    const m3uLabel = el('label', 'tvl-livetv-text-field');
    this.customM3uInput.type = 'text';
    this.customM3uInput.placeholder = 'C:\\canais\\lista.m3u ou http://.../lista.m3u';
    this.customM3uInput.value = this.draft.customM3uPathOrUrl;
    this.customM3uInput.addEventListener('input', () => {
      this.draft.customM3uPathOrUrl = this.customM3uInput.value.trim();
      this.syncDirty();
    });
    m3uLabel.append(this.customM3uInput);

    // User-Agent para Streams
    const uaHeading = el('h2', '', 'User-Agent para Transmissões IPTV');
    const uaHelp = el('p', 'tvl-livetv-settings-help', 'Identificador de cliente enviado aos provedores de streaming. O sistema rotaciona automaticamente entre VLC, OkHttp e Android para garantir conexão sem bloqueios:');
    const uaLabel = el('label', 'tvl-livetv-text-field');
    const uaOptions = [
      { value: 'VLC/3.0.20 LibVLC/3.0.20', label: 'VLC Player (Recomendado - VLC/3.0.20)' },
      { value: 'okhttp/5.0.0-alpha.2', label: 'OkHttp (Android / Apps - okhttp/5.0.0-alpha.2)' },
      { value: 'Mozilla/5.0 (Linux; Android 12; Chromecast) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', label: 'Android TV / Chromecast (Smart TV)' }
    ];
    uaOptions.forEach(opt => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === this.draft.userAgent) o.selected = true;
      this.userAgentSelect.append(o);
    });
    this.userAgentSelect.addEventListener('change', () => {
      this.draft.userAgent = this.userAgentSelect.value;
      this.syncDirty();
    });
    uaLabel.append(this.userAgentSelect);

    // Região / Estado de Canais Locais
    const regHeading = el('h2', '', 'Região / Estado de Canais Locais');
    const regHelp = el('p', 'tvl-livetv-settings-help', 'Destaca automaticamente no topo da lista os canais regionais do seu estado (reconhecendo variações como SP, RJ, BA, MG, nomes por extenso e cidades polo):');
    const regLabel = el('label', 'tvl-livetv-text-field');
    const regionOptions = [
      { value: 'none', label: 'Nenhum (Padrão — Exibir categorias puras da lista M3U)' },
      { value: 'auto', label: 'Automático (Identificar se a lista M3U possui categoria "Local - ...")' },
      { value: 'AC', label: 'Acre (AC)' },
      { value: 'AL', label: 'Alagoas (AL)' },
      { value: 'AP', label: 'Amapá (AP)' },
      { value: 'AM', label: 'Amazonas (AM)' },
      { value: 'BA', label: 'Bahia (BA)' },
      { value: 'CE', label: 'Ceará (CE)' },
      { value: 'DF', label: 'Distrito Federal (DF)' },
      { value: 'ES', label: 'Espírito Santo (ES)' },
      { value: 'GO', label: 'Goiás (GO)' },
      { value: 'MA', label: 'Maranhão (MA)' },
      { value: 'MT', label: 'Mato Grosso (MT)' },
      { value: 'MS', label: 'Mato Grosso do Sul (MS)' },
      { value: 'MG', label: 'Minas Gerais (MG)' },
      { value: 'PA', label: 'Pará (PA)' },
      { value: 'PB', label: 'Paraíba (PB)' },
      { value: 'PR', label: 'Paraná (PR)' },
      { value: 'PE', label: 'Pernambuco (PE)' },
      { value: 'PI', label: 'Piauí (PI)' },
      { value: 'RJ', label: 'Rio de Janeiro (RJ)' },
      { value: 'RN', label: 'Rio Grande do Norte (RN)' },
      { value: 'RS', label: 'Rio Grande do Sul (RS)' },
      { value: 'RO', label: 'Rondônia (RO)' },
      { value: 'RR', label: 'Roraima (RR)' },
      { value: 'SC', label: 'Santa Catarina (SC)' },
      { value: 'SP', label: 'São Paulo (SP)' },
      { value: 'SE', label: 'Sergipe (SE)' },
      { value: 'TO', label: 'Tocantins (TO)' }
    ];
    regionOptions.forEach(opt => {
      const o = el('option') as HTMLOptionElement;
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === (this.draft.localRegion || 'none')) o.selected = true;
      this.localRegionSelect.append(o);
    });
    this.localRegionSelect.addEventListener('change', () => {
      this.draft.localRegion = this.localRegionSelect.value;
      this.syncDirty();
    });
    regLabel.append(this.localRegionSelect);

    const actionsBar = el('div', 'tvl-livetv-actions-bar');
    actionsBar.append(this.restoreUrlsButton, this.resetButton);

    main.append(
      banner,
      title,
      intro,
      cbLabel,
      nameLabel,
      descLabel,
      urlHeading,
      urlHelp,
      this.urlList,
      addRow,
      m3uHeading,
      m3uHelp,
      m3uLabel,
      uaHeading,
      uaHelp,
      uaLabel,
      regHeading,
      regHelp,
      regLabel,
      actionsBar
    );

    const footer = el('footer', 'tvl-livetv-settings-footer');
    const footerActions = el('div', 'tvl-livetv-settings-actions');
    footerActions.append(this.cancelButton, this.saveButton);
    footer.append(this.status, footerActions);

    this.element.append(header, main, footer);

    this.renderUrlList();
    this.removeRemote = attachRemote(this.element, () => this.cancel());
  }

  async load(): Promise<void> {
    if (this.disposed || this.busy) return;
    this.busy = true;
    this.status.textContent = 'Carregando configurações…';
    try {
      const settings = await this.store.load();
      if (this.disposed) return;
      this.draft = { ...settings, defaultChannelUrls: [...settings.defaultChannelUrls] };
      this.saved = { ...this.draft, defaultChannelUrls: [...this.draft.defaultChannelUrls] };
      this.updateInputs();
      this.ready = true;
      this.status.textContent = '';
      this.syncDirty();
    } catch {
      if (!this.disposed) {
        this.status.textContent = '';
        this.ready = true;
        this.syncDirty();
      }
    } finally {
      this.busy = false;
    }
  }

  private updateInputs(): void {
    this.defaultChannelEnabledCheckbox.checked = this.draft.defaultChannelEnabled;
    this.channelNameInput.value = this.draft.defaultChannelName;
    this.channelDescInput.value = this.draft.defaultChannelDescription;
    this.customM3uInput.value = this.draft.customM3uPathOrUrl;
    this.userAgentSelect.value = this.draft.userAgent || 'VLC/3.0.20 LibVLC/3.0.20';
    this.localRegionSelect.value = this.draft.localRegion || 'none';
    this.renderUrlList();
  }

  private renderUrlList(): void {
    replace(this.urlList);
    this.draft.defaultChannelUrls.forEach((url, index) => {
      const li = el('li', 'tvl-livetv-url-item');
      const badge = el('span', 'tvl-livetv-badge', `#${index + 1}`);

      const input = el('input') as HTMLInputElement;
      input.type = 'text';
      input.value = url;
      input.addEventListener('change', () => {
        if (input.value.trim()) {
          this.draft.defaultChannelUrls[index] = input.value.trim();
          this.syncDirty();
        }
      });

      const btnUp = el('button', 'tvl-livetv-btn-icon', '▲');
      btnUp.title = 'Mover para cima';
      btnUp.disabled = index === 0;
      btnUp.addEventListener('click', () => this.moveUrl(index, -1));

      const btnDown = el('button', 'tvl-livetv-btn-icon', '▼');
      btnDown.title = 'Mover para baixo';
      btnDown.disabled = index === this.draft.defaultChannelUrls.length - 1;
      btnDown.addEventListener('click', () => this.moveUrl(index, 1));

      const btnDel = el('button', 'tvl-livetv-btn-icon tvl-livetv-btn-danger', '✕');
      btnDel.title = 'Remover URL';
      btnDel.addEventListener('click', () => this.removeUrl(index));

      li.append(badge, input, btnUp, btnDown, btnDel);
      this.urlList.append(li);
    });
  }

  private moveUrl(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.draft.defaultChannelUrls.length) return;
    const temp = this.draft.defaultChannelUrls[index];
    this.draft.defaultChannelUrls[index] = this.draft.defaultChannelUrls[target];
    this.draft.defaultChannelUrls[target] = temp;
    this.renderUrlList();
    this.syncDirty();
  }

  private removeUrl(index: number): void {
    if (this.draft.defaultChannelUrls.length <= 1) {
      this.status.textContent = 'Mantenha ao menos 1 URL na lista de reprodução.';
      return;
    }
    this.draft.defaultChannelUrls.splice(index, 1);
    this.renderUrlList();
    this.syncDirty();
  }

  private addUrl(): void {
    const val = this.newUrlInput.value.trim();
    if (!val) return;
    this.draft.defaultChannelUrls.push(val);
    this.newUrlInput.value = '';
    this.renderUrlList();
    this.syncDirty();
  }

  private restoreSenadoUrls(): void {
    this.draft.defaultChannelUrls = [...defaultSenadoUrls];
    this.renderUrlList();
    this.status.textContent = '5 links padrão da TV Senado restaurados na lista.';
    this.syncDirty();
  }

  private async reset(): Promise<void> {
    if (this.disposed || this.saving) return;
    this.saving = true;
    this.status.textContent = 'Restaurando padrões de fábrica…';
    try {
      const reset = await this.store.resetDefaults();
      this.draft = { ...reset, defaultChannelUrls: [...reset.defaultChannelUrls] };
      this.saved = { ...this.draft, defaultChannelUrls: [...this.draft.defaultChannelUrls] };
      this.updateInputs();
      this.status.textContent = 'Configurações de TV Ao Vivo restauradas com sucesso.';
      this.syncDirty();
    } catch {
      this.status.textContent = 'Erro ao restaurar padrões.';
    } finally {
      this.saving = false;
    }
  }

  private async save(): Promise<void> {
    if (this.disposed || this.saving) return;
    this.saving = true;
    this.status.textContent = 'Salvando configurações…';
    try {
      await this.store.save(this.draft);
      this.saved = { ...this.draft, defaultChannelUrls: [...this.draft.defaultChannelUrls] };
      this.status.textContent = 'Configurações salvas com sucesso!';
      this.syncDirty();
    } catch (error) {
      if (error instanceof LiveTvSyncError) {
        this.status.textContent = error.message;
      } else {
        this.status.textContent = 'Erro ao salvar configurações de TV Ao Vivo.';
      }
    } finally {
      this.saving = false;
    }
  }

  private isDirty(): boolean {
    if (this.draft.enabled !== this.saved.enabled) return true;
    if (this.draft.defaultChannelEnabled !== this.saved.defaultChannelEnabled) return true;
    if (this.draft.defaultChannelName !== this.saved.defaultChannelName) return true;
    if (this.draft.defaultChannelDescription !== this.saved.defaultChannelDescription) return true;
    if (this.draft.customM3uPathOrUrl !== this.saved.customM3uPathOrUrl) return true;
    if (this.draft.userAgent !== this.saved.userAgent) return true;
    if (this.draft.localRegion !== this.saved.localRegion) return true;
    if (this.draft.defaultChannelUrls.length !== this.saved.defaultChannelUrls.length) return true;
    for (let i = 0; i < this.draft.defaultChannelUrls.length; i++) {
      if (this.draft.defaultChannelUrls[i] !== this.saved.defaultChannelUrls[i]) return true;
    }
    return false;
  }

  private syncDirty(): void {
    this.saveButton.disabled = !this.ready || this.saving;
  }

  private cancel(): void {
    this.options.onBack();
  }

  destroy(): void {
    this.disposed = true;
    this.removeRemote();
    this.element.remove();
  }
}
