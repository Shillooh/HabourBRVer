import { button, el } from './dom';
import { brandLabel } from './interface-branding';
import { attachRemote } from './remote';
import { isCinemaLayout } from './layout';
import { currentUserAccount, isCurrentUserAdministrator, sameUserAccount } from './current-user-policy';
import { openProfileLogin, profileImage, profileSession, profileSwitchPending, ProfileLoginRequired, publicProfiles, sameProfileServer, sameProfileSession, switchPublicProfile,
  type ProfileSession, type ProfileSwitchPhase, type PublicProfile } from './profile-auth';

type NativeDashboard = { logout(): void; navigate?(route: string): unknown };
const dashboard = () => (window as Window & { Dashboard?: NativeDashboard }).Dashboard;


/** Desktop/TV profile chooser backed by Jellyfin's public profiles and native
 * session lifecycle. Mobile retains the original avatar's native handler. */
export class ProfileMenu {
  private enabled = false;
  private scope: string | null | undefined;
  private disposed = false;
  private overlay?: HTMLElement;
  private anchor?: HTMLElement;
  private expanded: string | null = null;
  private popup: string | null = null;
  private detachRemote?: () => void;
  private loginPending?: AbortController;
  private switching?: { cancel: () => void; remove: () => void; routeChanged: () => void };

  constructor() {
    document.addEventListener('click', this.onClick, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('command', this.onCommand, true);
    window.addEventListener('hashchange', this.onRoute);
    window.addEventListener('popstate', this.onRoute);
  }

  update(enabled: boolean, scope: string | null): void {
    if (this.disposed) return;
    const supported = isCinemaLayout();
    if (!supported) { this.switching?.cancel(); this.loginPending?.abort(); }
    enabled = enabled && supported;
    if (!enabled || scope !== this.scope) this.close(false);
    this.enabled = enabled; this.scope = scope;
  }

  private avatar(node: EventTarget | null): HTMLElement | null {
    return node instanceof Element ? node.closest<HTMLElement>('.skinHeader .headerUserButton') : null;
  }

  private open(anchor: HTMLElement): boolean {
    if (!this.enabled || !isCinemaLayout() || this.disposed || this.overlay || this.switching || profileSwitchPending() || typeof dashboard()?.logout !== 'function') return false;
    // Do not compete with an existing native or Cinema modal.
    if (Array.from(document.querySelectorAll<HTMLElement>('.dialogContainer .dialog.opened, dialog[open], [role="dialog"][aria-modal="true"]'))
      .some(node => !node.closest('.hide,[hidden]') && !!node.getClientRects().length)) return false;
    this.anchor = anchor; this.expanded = anchor.getAttribute('aria-expanded'); this.popup = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-haspopup', 'dialog');
    const overlay = el('div', 'tvl-profile-overlay');
    const panel = el('section', 'tvl-profile-menu tvl-profile-chooser');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Quem está assistindo?');
    const brand = brandLabel('p', 'tvl-profile-brand');
    const heading = el('h2', '', 'Quem está assistindo?');
    const grid = el('div', 'tvl-profile-grid'); grid.setAttribute('aria-label', 'Perfis');
    const status = el('p', 'tvl-profile-status', 'Carregando perfis…'); status.setAttribute('role', 'status');
    const session = profileSession();
    const current = () => this.overlay === overlay && (!session || sameProfileSession(session));
    const login = button('Usar tela de login', '', 'tvl-profile-secondary', () => {
      if (!current() || profileSwitchPending()) { this.close(false); return; }
      login.disabled = true;
      status.textContent = 'Abrindo a tela de login…';
      const failed = () => {
        if (current()) { status.textContent = 'Não foi possível abrir a tela de login. Tente novamente.'; login.disabled = false; }
      };
      if (session) { void this.openLogin(session).then(() => this.close(false)).catch(failed); return; }
      try {
        const native = dashboard();
        if (typeof native?.logout !== 'function') throw new Error('A troca de perfil padrão está indisponível');
        // Jellyfin owns its session/cache cleanup and native login navigation.
        native.logout(); this.close(false);
      } catch { failed(); }
    });
    const back = button('Voltar', 'back', 'tvl-profile-secondary', () => this.close(true));
    const settings = button('Configurações', '', 'tvl-profile-secondary', () => {
      this.close(false);
      const native = dashboard();
      if (typeof native?.navigate === 'function') native.navigate('mypreferencesmenu');
      else location.hash = '/mypreferencesmenu';
    });
    const actions = el('div', 'tvl-profile-actions'); actions.append(settings, login, back);
    panel.append(brand, heading, grid, status, actions);
    overlay.append(panel); this.overlay = overlay;
    document.body.append(overlay); document.body.classList.add('tvl-profile-open');
    this.detachRemote = attachRemote(panel, () => this.close(true));
    back.focus({ preventScroll: true });
    void this.addDashboard(panel, overlay, login, status);
    if (session) void this.chooseProfile(grid, overlay, session, status, login, back);
    else status.textContent = 'A troca de perfil está indisponível.';
    return true;
  }

  private async addDashboard(panel: HTMLElement, overlay: HTMLElement, before: HTMLElement, status: HTMLElement): Promise<void> {
    const account = currentUserAccount();
    const current = () => this.overlay === overlay && panel.contains(before) && sameUserAccount(account);
    if (!await isCurrentUserAdministrator(account) || !current()) return;
    const action = button('Painel de Controle', '', 'tvl-profile-secondary', () => {
      if (action.disabled) return;
      action.disabled = true;
      void isCurrentUserAdministrator(account).then(allowed => {
        if (!current()) return;
        if (!allowed) {
          action.remove(); status.textContent = 'O acesso ao painel de controle não está mais disponível.';
          before.focus({ preventScroll: true }); return;
        }
        this.close(false);
        const native = dashboard();
        if (typeof native?.navigate === 'function') native.navigate('dashboard');
        else location.hash = '/dashboard';
      }).finally(() => { action.disabled = false; });
    });
    before.parentElement?.insertBefore(action, before);
  }

  private artwork(session: ProfileSession, profile: PublicProfile): HTMLElement {
    const artwork = el('span', 'tvl-profile-artwork'); artwork.setAttribute('aria-hidden', 'true');
    const words = profile.Name.trim().split(/\s+/);
    const initials = (Array.from(words[0])[0] || '') + (words.length > 1 ? Array.from(words[words.length - 1])[0] || '' : '');
    artwork.append(el('span', 'tvl-profile-initials', initials.toLocaleUpperCase()));
    let tone = 0; for (const letter of profile.Id) tone = (tone * 31 + letter.charCodeAt(0)) >>> 0;
    artwork.dataset.tone = String(tone % 5);
    const url = profileImage(session, profile);
    if (url) {
      const image = el('img', 'tvl-profile-avatar'); image.src = url; image.alt = '';
      image.addEventListener('error', () => image.remove(), { once: true }); artwork.append(image);
    }
    return artwork;
  }

  private async chooseProfile(grid: HTMLElement, overlay: HTMLElement, session: ProfileSession, status: HTMLElement,
    login: HTMLButtonElement, back: HTMLButtonElement): Promise<void> {
    const current = () => this.overlay === overlay && sameProfileSession(session);
    grid.setAttribute('aria-busy', 'true');
    try {
      const profiles = await publicProfiles(session);
      if (!current()) return;
      status.textContent = profiles.length ? '' : 'Nenhum perfil público disponível.';
      for (const profile of profiles) {
        const selected = profile.Id.replace(/-/g, '').toLowerCase() === session.userId.replace(/-/g, '').toLowerCase();
        const control = button('', '', 'tvl-profile-card', () => {
          if (!current()) { this.close(false); return; }
          if (selected) { this.close(true); return; }
          if (!profile.CanSwitchDirectly) { login.click(); return; }
          this.startSwitch(session, profile);
        });
        control.setAttribute('aria-label', `${profile.Name}, ${selected ? 'perfil atual' : profile.CanSwitchDirectly ? 'trocar perfil' : 'entrar'}`);
        if (selected) control.setAttribute('aria-current', 'true');
        const artwork = this.artwork(session, profile);
        if (selected) artwork.append(el('span', 'tvl-profile-current-mark', '✓'));
        // The button helper's empty label is replaced by the profile's artwork
        // and accessible, visible name; no native authentication UI is cloned.
        control.textContent = '';
        control.append(artwork, el('span', 'tvl-profile-card-name', profile.Name),
          el('span', 'tvl-profile-card-note', selected ? 'Perfil atual' : profile.CanSwitchDirectly ? '' : 'Entrar'));
        grid.append(control);
      }
      if (document.activeElement === back) (grid.querySelector<HTMLElement>('[aria-current="true"]') || grid.querySelector<HTMLElement>('button') || login).focus({ preventScroll: true });
    } catch {
      if (current()) status.textContent = 'Não foi possível carregar os perfis. Tente novamente.';
    } finally { grid.removeAttribute('aria-busy'); }
  }

  private startSwitch(session: ProfileSession, profile: PublicProfile): void {
    if (this.switching || profileSwitchPending() || !sameProfileSession(session)) return;
    this.close(false);
    const controller = new AbortController();
    const start = location.hash;
    let phase: ProfileSwitchPhase = 'checking';
    const overlay = el('div', 'tvl-profile-overlay tvl-profile-switching');
    const panel = el('section', 'tvl-profile-menu tvl-profile-progress'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', 'Trocando de perfil');
    const status = el('p', 'tvl-profile-status', 'Verificando perfil…'); status.setAttribute('role', 'status');
    let adopting = false;
    const cancel = () => { if (!adopting) { controller.abort(); remove(); } };
    const cancelButton = button('Cancelar', '', '', cancel);
    panel.append(brandLabel('p', 'tvl-profile-brand'), this.artwork(session, profile), el('h2', '', `Abrindo ${profile.Name}`), status, cancelButton); overlay.append(panel);
    document.body.append(overlay); document.body.classList.add('tvl-profile-open');
    const detach = attachRemote(panel, cancel);
    const remove = () => {
      detach(); overlay.remove();
      if (this.switching?.remove === remove) this.switching = undefined;
      if (!this.overlay && document.body.classList.contains('tvl-profile-open')) document.body.classList.remove('tvl-profile-open');
    };
    const forceCancel = () => { controller.abort(); remove(); };
    this.switching = { cancel: forceCancel, remove, routeChanged: () => {
      const login = /^#\/?(?:login|selectserver)\/?(?:\?|$)/i.test(location.hash);
      if (phase === 'checking' ? location.hash !== start : phase === 'signing-out' ? location.hash !== start && !login
        : phase === 'signing-in' ? !login : !login && !/^#\/?home\/?(?:\?|$)/i.test(location.hash)) forceCancel();
    } }; cancelButton.focus({ preventScroll: true });
    void switchPublicProfile(session, profile.Id, controller.signal, next => {
      phase = next; adopting = phase === 'opening' || phase === 'signing-out'; cancelButton.disabled = adopting;
      status.textContent = phase === 'checking' ? 'Verificando perfil…' : phase === 'signing-out' ? 'Encerrando a sessão atual…'
        : phase === 'signing-in' ? 'Entrando…' : 'Abrindo a Página Inicial…';
    }).then(remove).catch(error => {
      if (controller.signal.aborted || this.disposed || error?.name === 'AbortError') { remove(); return; }
      adopting = false; cancelButton.remove();
      const needsLogin = error instanceof ProfileLoginRequired || !session.client.getCurrentUserId();
      const failedUser = session.client.getCurrentUserId();
      status.textContent = error instanceof ProfileLoginRequired ? error.message
        : needsLogin ? 'Não foi possível entrar nesse perfil.' : 'Não foi possível trocar de perfil. Sua sessão atual continua ativa.';
      const action = button(needsLogin ? 'Continuar para o login' : 'Fechar', '', 'tvl-primary', () => {
        remove();
        if (needsLogin && sameProfileServer(session) && session.client.getCurrentUserId() === failedUser) {
          if (session.client.getCurrentUserId()) void this.openLogin(session).catch(() => {});
          else session.dashboard.navigate(`login?serverid=${encodeURIComponent(session.serverId)}`);
        }
      });
      panel.append(action); action.focus({ preventScroll: true });
    });
  }

  private openLogin(session: ProfileSession): Promise<void> {
    const controller = new AbortController(); this.loginPending = controller;
    return openProfileLogin(session, controller.signal).finally(() => {
      if (this.loginPending === controller) this.loginPending = undefined;
    });
  }

  private close(restore: boolean): void {
    this.detachRemote?.(); this.detachRemote = undefined;
    this.overlay?.remove(); this.overlay = undefined;
    if (!this.switching && document.body.classList.contains('tvl-profile-open')) document.body.classList.remove('tvl-profile-open');
    const anchor = this.anchor; this.anchor = undefined;
    if (!anchor) return;
    for (const [name, value] of [['aria-expanded', this.expanded], ['aria-haspopup', this.popup]] as const) {
      if (value === null) anchor.removeAttribute(name); else anchor.setAttribute(name, value);
    }
    if (restore && anchor.isConnected && anchor.getClientRects().length) anchor.focus({ preventScroll: true });
  }

  private onClick = (event: MouseEvent): void => {
    if (event.button || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const anchor = this.avatar(event.target);
    if (anchor && this.open(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private onKey = (event: KeyboardEvent): void => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['Enter', ' ', 'Spacebar'].includes(event.key) && event.keyCode !== 13) return;
    const anchor = this.avatar(document.activeElement);
    if (anchor && this.open(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private onCommand = (event: Event): void => {
    const command = (event as CustomEvent).detail?.command?.toLowerCase();
    if (!['select', 'enter', 'ok'].includes(command)) return;
    const anchor = this.avatar(document.activeElement);
    if (anchor && this.open(anchor)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  private onRoute = (): void => { this.close(false); this.switching?.routeChanged(); };

  destroy(): void {
    if (this.disposed) return;
    this.loginPending?.abort();
    this.switching?.cancel(); this.switching?.remove();
    this.close(true); this.disposed = true; this.enabled = false;
    document.removeEventListener('click', this.onClick, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('command', this.onCommand, true);
    window.removeEventListener('hashchange', this.onRoute);
    window.removeEventListener('popstate', this.onRoute);
  }
}
