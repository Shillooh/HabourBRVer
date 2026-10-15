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
  private saveButton = button('Salvar', 'check', 'tvl-primary', () => void this.save());
  private resetButton = button('Restaurar padrões', '', '', () => this.reset());
  private cancelButton = button('Cancelar', '', '', () => this.cancel());
  private reloadButton = button('Recarregar configurações salvas', '', '', () => void this.load());
  private busy = false;
  private saving = false;
  private ready = false;
  private disposed = false;
  private removeRemote: () => void;

  constructor(api: MediaApi, private options: { onBack: () => void }) {
    this.store = createLoadingScreenStore(api); this.draft = this.store.cached; this.saved = this.store.cached;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Configurações da tela de carregamento');
    const header = el('header', 'tvl-header');
    header.append(button('Voltar', 'back', 'tvl-back', () => this.cancel()), brandLabel('span', 'tvl-wordmark'));
    const main = el('div', 'tvl-loading-settings-content');
    main.append(el('h1', '', 'Tela de carregamento'), el('p', 'tvl-loading-settings-intro', this.store.synced
      ? 'Personalize do seu jeito. Suas escolhas acompanham esta conta do Jellyfin em todos os seus dispositivos.' : 'Personalize do seu jeito. Esta pré-visualização salva as escolhas neste dispositivo.'));
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
    this.reloadButton.hidden = true; actions.append(this.reloadButton, this.resetButton, this.cancelButton, this.saveButton);
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
  private fill(): void { this.brand.value = this.draft.brandText; this.message.value = this.draft.message; this.updatePreview(); }
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
      this.draft = value; this.saved = parseLoadingScreen(value); this.ready = true; this.fill(); this.status.textContent = '';
    } catch (error) {
      if (!this.disposed) { this.status.textContent = error instanceof Error ? error.message : 'Não foi possível carregar as configurações.'; this.reloadButton.hidden = false; }
    } finally {
      if (!this.disposed) { this.busy = false; this.setEnabled(this.ready); }
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
      this.status.textContent = this.store.synced ? 'Salvo na sua conta do Jellyfin.' : 'Salvo neste dispositivo.';
      window.dispatchEvent(new CustomEvent('tvl-loading-settings-changed', { detail: { key: this.store.key } }));
    } catch (error) {
      if (this.disposed) return;
      this.status.textContent = error instanceof Error ? error.message : 'Não foi possível salvar as configurações.';
      if (error instanceof LoadingScreenSyncError && error.kind === 'conflict') { this.ready = false; this.reloadButton.hidden = false; }
    } finally {
      if (!this.disposed) { this.saving = false; this.busy = false; this.setEnabled(this.ready); }
    }
  }
  destroy(): void { this.disposed = true; this.store.destroy(); this.removeRemote(); this.element.remove(); }
}
