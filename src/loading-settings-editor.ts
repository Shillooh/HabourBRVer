import type { MediaApi } from './types';
import { button, el, replace } from './dom';
import { brandLabel } from './interface-branding';
import { attachRemote } from './remote';
import { loadingAnimation } from './loading-animation';
import { defaultLoadingScreen, loadingAnimations, parseLoadingScreen, type LoadingScreenSettings } from './loading-settings';
import { createLoadingScreenStore, LoadingScreenSyncError, type LoadingScreenStore } from './loading-settings-store';

export class LoadingSettingsEditor {
  readonly element = el('section', 'tvl-root tvl-keyboard tvl-loading-settings');
  private store: LoadingScreenStore;
  private draft: LoadingScreenSettings;
  private saved: LoadingScreenSettings;
  private preview = el('div', 'tvl-loading-settings-preview');
  private choices = el('div', 'tvl-loading-choices');
  private status = el('p', 'tvl-loading-settings-status');
  private brand = el('input');
  private message = el('input');
  private saveButton: HTMLButtonElement;
  private resetButton = button('Restaurar padrões', '', '', () => this.reset());
  private restoreGlobalButton?: HTMLButtonElement;
  private cancelButton = button('Cancelar', '', '', () => this.cancel());
  private reloadButton = button('Recarregar configurações salvas', '', '', () => void this.load());
  private busy = false;
  private saving = false;
  private ready = false;
  private disposed = false;
  private removeRemote: () => void;
  private targetUserId?: string;
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

  constructor(private api: MediaApi, private options: { onBack: () => void; scope?: 'user' | 'global'; targetUserId?: string }) {
    this.targetUserId = options.targetUserId;
    const isGlobal = options.scope === 'global' || !!this.targetUserId;
    this.store = createLoadingScreenStore(api, this.targetUserId ? 'user' : (options.scope || 'user'), this.targetUserId);
    this.draft = { ...this.store.cached };
    if (this.draft.brandText === 'KiKoTV') this.draft.brandText = 'HabourBR';
    this.saved = { ...this.draft };
    this.saveButton = button(isGlobal ? (this.targetUserId ? 'Salvar para Usuário' : 'Salvar Padrão Global') : 'Salvar', 'check', 'tvl-primary', () => void this.save());
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', isGlobal ? 'Configurações Globais da tela de carregamento' : 'Configurações da tela de carregamento');
    const header = el('header', 'tvl-header');
    header.append(button('Voltar', 'back', 'tvl-back', () => this.cancel()), brandLabel('span', 'tvl-wordmark'));
    const main = el('div', 'tvl-loading-settings-content');
    if (isGlobal) {
      this.banner = el('div', 'tvl-admin-banner');
      this.bannerHeader = el('div', 'tvl-admin-banner-header');
      this.bannerHeader.innerHTML = '<span class="material-icons">shield</span><strong>MODO ADMINISTRADOR</strong>';
      this.bannerText = el('p', '', 'Você está editando o Padrão Global da tela de carregamento do HabourBR. Esta introdução e nome de marca serão exibidos para todos os usuários do servidor.');
      this.banner.append(this.bannerHeader, this.bannerText);

      const selectorWrap = el('div', 'tvl-target-selector');
      const selectLabel = el('label');
      selectLabel.innerHTML = '<span class="material-icons">account_circle</span> Alvo da Edição:';
      this.targetSelect = el('select', 'tvl-target-select') as HTMLSelectElement;
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

      const adminActions = el('div', 'tvl-banner-admin-actions');
      this.copyButton = button('Copiar da minha conta', '', 'tvl-button-copy', () => { void this.copyFromAdmin(); });
      this.resetAllButton = button('Forçar em todos os usuários', '', 'tvl-button-danger', () => { void this.resetAllUsers(); });
      this.restoreGlobalButton = button('Restaurar para o Padrão Global', '', 'tvl-button-secondary', () => { void this.restoreGlobal(); });
      this.restoreGlobalButton.hidden = !this.targetUserId;
      if (this.targetUserId) this.resetAllButton.hidden = true;
      adminActions.append(this.copyButton, this.resetAllButton, this.restoreGlobalButton);
      selectorWrap.append(adminActions);

      this.banner.append(selectorWrap);
      main.append(this.banner);
      void this.loadUsers();
    }
    this.headingTitle = el('h1', '', isGlobal ? 'Tela de carregamento (Padrão Global)' : 'Tela de carregamento');
    main.append(this.headingTitle, el('p', 'tvl-loading-settings-intro', isGlobal
      ? 'Defina o nome da marca, mensagem e animação padrão para todos os usuários do HabourBR.'
      : (this.store.synced ? 'Personalize do seu jeito. Suas escolhas acompanham esta conta do Jellyfin em todos os seus dispositivos.' : 'Personalize do seu jeito. Esta pré-visualização salva as escolhas neste dispositivo.')));
    const layout = el('div', 'tvl-loading-settings-layout');
    const fields = el('div', 'tvl-loading-settings-fields');
    fields.append(el('h2', '', 'Seu texto'), this.field('Título', this.brand, 60, 'brandText'), this.field('Mensagem', this.message, 120, 'message'),
      el('p', 'tvl-loading-settings-help', 'O título salvo aparece em toda a interface, incluindo a tela de login. As alterações permanecem nesta pré-visualização até você Salvar. Deixe qualquer um dos campos em branco para ocultá-lo.'));
    this.preview.setAttribute('aria-label', 'Pré-visualização da tela de carregamento');
    layout.append(fields, this.preview); main.append(layout, el('h2', '', 'Escolha uma animação'));
    this.choices.setAttribute('role', 'group'); this.choices.setAttribute('aria-label', 'Animação de carregamento');
    for (const option of loadingAnimations) {
      const choice = button(option.name, '', 'tvl-loading-choice', () => {
        if (!this.ready || this.busy) return;
        this.draft.animation = option.id; this.updatePreview(); this.clearStatus();
      });
      choice.dataset.animation = option.id;
      const art = loadingAnimation({ ...defaultLoadingScreen(), animation: option.id, brandText: '', message: '' }, true);
      art.setAttribute('aria-hidden', 'true'); art.removeAttribute('role'); art.removeAttribute('aria-live');
      choice.prepend(art); this.choices.append(choice);
    }
    main.append(this.choices, el('p', 'tvl-loading-settings-help', 'Exibida durante o primeiro carregamento da Página Inicial. O retorno à Home permanece rápido.'));
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    const footer = el('footer', 'tvl-loading-settings-footer');
    const actions = el('div', 'tvl-loading-settings-actions');
    this.reloadButton.hidden = true;
    if (!isGlobal) {
      this.restoreGlobalButton = button('Usar Padrão do Servidor', '', 'tvl-button-secondary', () => { void this.restoreGlobal(); });
      this.restoreGlobalButton.hidden = true;
      actions.append(this.restoreGlobalButton);
    }
    actions.append(this.reloadButton, this.resetButton, this.cancelButton, this.saveButton);
    footer.append(this.status, actions); this.element.append(header, main, footer);
    this.removeRemote = attachRemote(this.element, () => this.cancel());
    this.fill(); this.setEnabled(false);
  }
  private field(title: string, input: HTMLInputElement, limit: number, key: 'brandText' | 'message'): HTMLElement {
    const label = el('label', 'tvl-loading-text-field', title);
    input.type = 'text'; input.maxLength = limit; input.autocomplete = 'off';
    input.addEventListener('input', () => {
      this.draft[key] = input.value; this.updatePreview(); this.clearStatus();
    });
    label.append(input); return label;
  }
  private clearStatus(): void { if (this.ready) this.status.textContent = ''; }
  private fill(): void {
    if (this.draft.brandText === 'KiKoTV') this.draft.brandText = 'HabourBR';
    this.brand.value = this.draft.brandText;
    this.message.value = this.draft.message;
    this.updatePreview();
  }
  private updatePreview(): void {
    replace(this.preview, loadingAnimation(this.draft, true));
    for (const choice of Array.from(this.choices.querySelectorAll<HTMLButtonElement>('button'))) {
      choice.setAttribute('aria-pressed', String(choice.dataset.animation === this.draft.animation));
    }
  }
  private setEnabled(enabled: boolean): void {
    this.brand.disabled = this.message.disabled = !enabled;
    for (const control of Array.from(this.choices.querySelectorAll<HTMLButtonElement>('button'))) control.disabled = !enabled;
    this.saveButton.disabled = this.resetButton.disabled = !enabled;
    this.cancelButton.disabled = this.saving;
  }
  async load(): Promise<void> {
    if (this.busy || this.disposed) return;
    this.busy = true; this.ready = false; this.reloadButton.hidden = true; this.setEnabled(false);
    this.status.textContent = 'Carregando suas configurações…';
    try {
      const value = await this.store.load(); if (this.disposed) return;
      if (value.brandText === 'KiKoTV') value.brandText = 'HabourBR';
      this.draft = value; this.saved = parseLoadingScreen(value); this.ready = true; this.fill(); this.status.textContent = '';
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
        this.restoreGlobalButton.hidden = this.options.scope === 'global' || !this.store.hasUserOverride;
      }
    } catch (error) {
      if (!this.disposed) { this.status.textContent = error instanceof Error ? error.message : 'Não foi possível carregar as configurações.'; this.reloadButton.hidden = false; }
    } finally {
      if (!this.disposed) { this.busy = false; this.setEnabled(this.ready); }
    }
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
        const list = await client.getJSON(client.getUrl('TvItemLayout/LoadingScreen/Users'));
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
    this.store = createLoadingScreenStore(this.api, normTarget ? 'user' : 'global', normTarget);
    this.updateAdminHeader();
    void this.load();
  }
  private updateAdminHeader(): void {
    if (!this.banner) return;
    if (this.targetUserId) {
      const name = this.targetUserName || 'Usuário';
      if (this.headingTitle) this.headingTitle.textContent = `Tela de carregamento (${name})`;
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
      if (this.headingTitle) this.headingTitle.textContent = 'Tela de carregamento (Padrão Global)';
      if (this.saveButton) this.saveButton.textContent = 'Salvar Padrão Global';
      if (this.bannerHeader) this.bannerHeader.innerHTML = '<span class="material-icons">shield</span><strong>MODO ADMINISTRADOR</strong>';
      if (this.bannerText) this.bannerText.innerHTML = 'Você está editando o <strong>Padrão Global</strong> da tela de carregamento do HabourBR. Esta introdução e nome de marca serão exibidos para todos os usuários do servidor.';
      if (this.copyButton) this.copyButton.hidden = false;
      if (this.resetAllButton) this.resetAllButton.hidden = false;
      if (this.restoreGlobalButton) this.restoreGlobalButton.hidden = true;
      if (this.targetStatusBadge) this.targetStatusBadge.hidden = true;
    }
  }
  private reset(): void {
    if (!this.ready || this.busy) return;
    this.draft = defaultLoadingScreen(); this.fill(); this.status.textContent = 'Padrões visualizados. Salve para mantê-los.';
  }
  private cancel(): void {
    if (this.saving) return;
    this.draft = parseLoadingScreen(this.saved); this.options.onBack();
  }
  private async save(): Promise<void> {
    if (!this.ready || this.busy || this.disposed) return;
    let settings: LoadingScreenSettings;
    try { settings = parseLoadingScreen(this.draft); }
    catch { this.status.textContent = 'Use um título de até 60 caracteres e uma mensagem de até 120 caracteres, sem caracteres de controle.'; return; }
    this.saving = true; this.busy = true; this.setEnabled(false); this.status.textContent = 'Salvando…';
    try {
      const saved = await this.store.save(settings); if (this.disposed) return;
      this.draft = saved; this.saved = parseLoadingScreen(saved); this.fill();
      if (this.targetUserId) {
        this.status.textContent = `Configurações salvas com sucesso para ${this.targetUserName || 'o perfil'}.`;
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
        const isGlobal = this.options.scope === 'global';
        this.status.textContent = isGlobal ? 'Padrão Global salvo com sucesso!' : (this.store.synced ? 'Salvo na sua conta do Jellyfin.' : 'Salvo neste dispositivo.');
        if (this.restoreGlobalButton && !isGlobal) this.restoreGlobalButton.hidden = false;
      }
      window.dispatchEvent(new CustomEvent('tvl-loading-settings-changed', { detail: { key: this.store.key } }));
    } catch (error) {
      if (this.disposed) return;
      this.status.textContent = error instanceof Error ? error.message : 'Não foi possível salvar as configurações.';
      if (error instanceof LoadingScreenSyncError && error.kind === 'conflict') { this.ready = false; this.reloadButton.hidden = false; }
    } finally {
      if (!this.disposed) { this.saving = false; this.busy = false; this.setEnabled(this.ready); }
    }
  }
  private async copyFromAdmin(): Promise<void> {
    const client = (window as unknown as { ApiClient?: { getUrl(p: string): string; getJSON(u: string): Promise<unknown> } }).ApiClient;
    if (!client) return;
    try {
      this.status.textContent = 'Carregando configurações da sua conta pessoal…';
      const personal = await client.getJSON(client.getUrl('TvItemLayout/LoadingScreen')) as Record<string, unknown> | null;
      const rawSettings = personal?.Settings || personal?.settings;
      if (rawSettings) {
        this.draft = parseLoadingScreen(rawSettings);
        this.saved = parseLoadingScreen(this.draft);
        this.ready = true;
        this.busy = false;
        this.saving = false;
        this.reloadButton.hidden = true;
        this.store.allowSave();
        this.fill();
        this.setEnabled(true);
        const targetLabel = this.targetUserId ? `Salvar para ${this.targetUserName || 'Usuário'}` : 'Salvar Padrão Global';
        this.status.textContent = `Configurações da sua conta pessoal copiadas! Clique em "${targetLabel}" para confirmar.`;
      } else {
        this.status.textContent = 'Sua conta pessoal não possui configurações customizadas.';
      }
    } catch {
      this.status.textContent = 'Não foi possível carregar as configurações pessoais.';
    }
  }
  private async resetAllUsers(): Promise<void> {
    if (!confirm('Atenção: Deseja apagar as customizações de tela de carregamento de TODOS os usuários do servidor e forçar o Padrão Global do HabourBR?')) return;
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
    this.saving = true; this.busy = true; this.setEnabled(false);
    this.status.textContent = 'Restaurando padrão global do servidor…';
    try {
      const fresh = await this.store.resetUserOverride();
      this.draft = fresh; this.saved = parseLoadingScreen(fresh); this.fill();
      if (this.targetUserId && this.targetStatusBadge) {
        this.targetStatusBadge.textContent = 'Herdando Padrão Global do servidor';
        this.targetStatusBadge.className = 'tvl-target-override-status inherits-global';
        this.targetStatusBadge.hidden = false;
        if (this.restoreGlobalButton) this.restoreGlobalButton.disabled = true;
      } else if (this.restoreGlobalButton && !this.targetUserId) {
        this.restoreGlobalButton.hidden = !this.store.hasUserOverride;
      }
      this.status.textContent = this.targetUserId
        ? `Padrão global restaurado com sucesso para ${name}!`
        : 'Padrão global do servidor restaurado com sucesso!';
    } catch {
      this.status.textContent = 'Não foi possível restaurar o padrão global.';
    } finally {
      if (!this.disposed) { this.saving = false; this.busy = false; this.setEnabled(this.ready); }
    }
  }
  destroy(): void { this.disposed = true; this.store.destroy(); this.removeRemote(); this.element.remove(); }
}
