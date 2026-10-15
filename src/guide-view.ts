import type { Item, MediaApi } from './types';
import { button, el } from './dom';
import { HorizontalGuide } from './guide';
import { attachRemote } from './remote';
import { playable } from './utils';

export class GuideView {
  readonly element = el('section', 'tvl-root tvl-keyboard');
  private status = el('div', 'tvl-status');
  private backButton: HTMLButtonElement;
  private guide: HorizontalGuide;
  private removeRemote: () => void;
  private disposed = false;
  private launching = false;
  private launchRevision = 0;
  private launchTimer?: number;
  private refreshTimer?: number;

  constructor(private api: MediaApi, options: { back: () => void }) {
    this.element.id = 'tv-layout';
    this.element.dataset.pane = 'guide';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Guia de TV ao vivo');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    const content = el('div', 'tvl-content');
    const header = el('header', 'tvl-header');
    this.backButton = button('Voltar', 'back', 'tvl-back', options.back);
    header.append(this.backButton);
    this.guide = new HorizontalGuide(api, {
      onPlay: channel => { void this.play(channel); },
      onStatus: message => this.announce(message),
      isCurrent: () => !this.disposed,
    });
    content.append(header, this.guide.element);
    this.element.append(content, this.status);
    this.removeRemote = attachRemote(this.element, options.back, direction => {
      if (direction === 'down' && document.activeElement === this.backButton) { this.guide.focus(); return true; }
      return this.guide.move(direction);
    });
  }

  async load(): Promise<void> {
    this.backButton.focus({preventScroll: true});
    await this.guide.load();
    if (this.disposed) return;
    // Do not displace a channel or retry control chosen while requests load.
    if (document.activeElement === this.backButton) this.guide.focus();
    this.refreshTimer = window.setInterval(() => { void this.guide.refresh(); }, 60_000);
  }

  private async play(channel: Item): Promise<void> {
    if (this.disposed || this.launching || !playable(channel)) return;
    this.launching = true;
    const revision = ++this.launchRevision;
    const current = () => !this.disposed && this.launching && revision === this.launchRevision;
    const focused = document.activeElement as HTMLElement | null;
    focused?.setAttribute('aria-busy', 'true');
    this.announce('Sintonizando canal…');
    const finish = (message: string) => {
      if (!current()) return;
      window.clearTimeout(this.launchTimer);
      this.launching = false;
      focused?.removeAttribute('aria-busy');
      this.announce(message);
    };
    this.launchTimer = window.setTimeout(() => finish('A reprodução não foi iniciada. Tente novamente.'), 15_000);
    try {
      await this.api.play(channel, 0, current);
    } catch (error) {
      finish(error instanceof Error ? error.message : 'Não foi possível iniciar a reprodução. Tente novamente.');
    }
  }

  private announce(message: string): void {
    if (!this.disposed) this.status.textContent = message;
  }

  destroy(): void {
    this.disposed = true;
    this.launchRevision++;
    window.clearTimeout(this.launchTimer);
    window.clearInterval(this.refreshTimer);
    this.guide.destroy();
    this.removeRemote();
    this.element.remove();
  }
}
