import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import type { Item, MediaApi } from './types';
import { button, el, replace } from './dom';
import { attachRemote } from './remote';
import {
  defaultLiveTvSettings,
  defaultSenadoUrls,
  isBrazilianPremiere,
  isChannelInState,
  STATE_NAME_MAP,
  STATE_REGEX_MAP,
  type LiveTvSettings
} from './livetv-settings';
import { createLiveTvStore, LiveTvStore } from './livetv-settings-store';

export type LiveBoxCategory = {
  id: string;
  name: string;
  icon?: string;
  count: number;
};

export type LiveBoxChannel = {
  id: string;
  jellyfinId?: string;
  epgId?: string;
  channelNumber: string;
  name: string;
  groupTitle: string;
  logoUrl?: string;
  streamUrl?: string;
};

let virtualStreamInterceptorInstalled = false;

function setupVirtualStreamInterceptor(): void {
  if (virtualStreamInterceptorInstalled || typeof window === 'undefined') return;
  virtualStreamInterceptorInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : (input as Request).url;

    if (!urlStr || !urlStr.includes('/TvItemLayout/LiveTv/VirtualStream')) {
      return originalFetch(input, init);
    }

    let targetStreamUrl = '';
    try {
      const parsed = new URL(urlStr, window.location.href);
      targetStreamUrl = parsed.searchParams.get('url') || '';
    } catch {
      const match = urlStr.match(/[?&]url=([^&]+)/);
      if (match) targetStreamUrl = decodeURIComponent(match[1]);
    }

    if (!targetStreamUrl) {
      return new Response('Missing target url', { status: 400 });
    }

    let sessionId = '';
    let isCancelled = false;
    let isUpstreamClosed = false;
    let pullError: any = null;
    const prefetchQueue: Uint8Array[] = [];
    const pendingPullResolvers: Array<() => void> = [];

    function triggerPull(): void {
      const resolvers = pendingPullResolvers.splice(0, pendingPullResolvers.length);
      for (const resolve of resolvers) {
        resolve();
      }
    }

    // Pump de Pré-Busca: mantém sempre 2 a 3 blocos prontos na memória do navegador
    async function prefetchLoop(): Promise<void> {
      while (!isCancelled && !isUpstreamClosed) {
        if (prefetchQueue.length >= 3) {
          await new Promise(r => setTimeout(r, 25));
          continue;
        }

        try {
          const win = window as unknown as { ApiClient?: any };
          const client = win?.ApiClient;
          const readUrl = client?.getUrl
            ? client.getUrl('TvItemLayout/LiveTv/ReadChunk', { sessionId })
            : `/TvItemLayout/LiveTv/ReadChunk?sessionId=${encodeURIComponent(sessionId)}`;

          const res = await originalFetch(readUrl);
          if (res.status === 200) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength > 0) {
              prefetchQueue.push(new Uint8Array(buf));
              triggerPull();
            }
          } else if (res.status === 204) {
            // Fila temporariamente vazia: aguarda 80ms antes de consultar novamente
            await new Promise(r => setTimeout(r, 80));
          } else if (res.status === 410) {
            isUpstreamClosed = true;
            triggerPull();
            break;
          } else {
            throw new Error(`ReadChunk HTTP ${res.status}`);
          }
        } catch (err) {
          if (!isCancelled) {
            pullError = err;
            triggerPull();
          }
          break;
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const win = window as unknown as { ApiClient?: any };
          const client = win?.ApiClient;
          const startUrl = client?.getUrl
            ? client.getUrl('TvItemLayout/LiveTv/StartSession', { url: targetStreamUrl })
            : `/TvItemLayout/LiveTv/StartSession?url=${encodeURIComponent(targetStreamUrl)}`;

          const startRes = await originalFetch(startUrl);
          if (!startRes.ok) {
            throw new Error(`StartSession HTTP ${startRes.status}`);
          }
          const data = (await startRes.json()) as { sessionId?: string; status?: number };
          if (!data?.sessionId) {
            throw new Error('No sessionId returned from StartSession');
          }
          sessionId = data.sessionId;

          // Dispara o loop de prefetch contínuo em background
          void prefetchLoop();
        } catch (err) {
          controller.error(err);
        }
      },

      async pull(controller) {
        while (!isCancelled) {
          if (prefetchQueue.length > 0) {
            const chunk = prefetchQueue.shift()!;
            controller.enqueue(chunk);
            return;
          }
          if (isUpstreamClosed) {
            controller.close();
            return;
          }
          if (pullError) {
            controller.error(pullError);
            return;
          }

          // Aguarda novo bloco ser enfileirado pelo prefetchLoop
          await new Promise<void>(resolve => {
            pendingPullResolvers.push(resolve);
            setTimeout(resolve, 35);
          });
        }
      },

      async cancel() {
        isCancelled = true;
        prefetchQueue.length = 0;
        triggerPull();
        if (sessionId) {
          try {
            const win = window as unknown as { ApiClient?: any };
            const client = win?.ApiClient;
            const stopUrl = client?.getUrl
              ? client.getUrl('TvItemLayout/LiveTv/StopSession', { sessionId })
              : `/TvItemLayout/LiveTv/StopSession?sessionId=${encodeURIComponent(sessionId)}`;
            await originalFetch(stopUrl, { method: 'POST' });
          } catch { }
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      }
    });
  };
}


export class LiveTvBoxView {
  readonly element = el('section', 'tvl-livebox-root');
  private video = el('video', 'tvl-livebox-player') as HTMLVideoElement;
  private hlsInstance: Hls | null = null;
  private mpegtsPlayer: mpegts.Player | null = null;

  private backdrop = el('div', 'tvl-livebox-backdrop hidden');
  private drawers = el('div', 'tvl-livebox-drawers closed');
  private floatingTrigger: HTMLButtonElement;
  private drawerCloseBtn: HTMLButtonElement;
  private audioButton: HTMLButtonElement;
  private topBadge = el('div', 'tvl-livebox-top-badge');

  private catList = el('ul', 'tvl-livebox-cat-list');
  private channelList = el('ul', 'tvl-livebox-channel-list');
  private searchInput = el('input', 'tvl-livebox-search-input') as HTMLInputElement;

  private epgBar = el('div', 'tvl-livebox-epg-bar hidden');
  private epgTitle = el('h2', 'tvl-livebox-epg-title');
  private epgProgramsWrap = el('div', 'tvl-livebox-epg-programs');
  private tuneButton: HTMLButtonElement;
  private favButton: HTMLButtonElement;
  private searchButton: HTMLButtonElement;

  private fsButton: HTMLButtonElement;
  private volumeHud = el('div', 'tvl-livebox-volume-hud hidden');
  private volumeHudTimer?: number;
  private mouseIdleTimer?: number;
  private epgTimer?: number;

  private store: LiveTvStore;
  private settings: LiveTvSettings;
  private categories: LiveBoxCategory[] = [];
  private allChannels: LiveBoxChannel[] = [];
  private filteredChannels: LiveBoxChannel[] = [];

  private activeCategoryId = 'default-senado';
  private selectedChannel: LiveBoxChannel | null = null;
  private playingChannel: LiveBoxChannel | null = null;
  private favorites = new Set<string>();

  private currentFailoverIndex = 0;
  private failoverTimer?: number;
  private disposed = false;
  private removeRemote: () => void;

  private isTuning = false;
  private isSwitchingChannel = false;
  private isWaitingForCushion = false;
  private cushionCheckTimer?: number;
  private currentVolume = 1.0;
  private isUserMuted = false;

  constructor(private api: MediaApi, private options: { back: () => void }) {
    this.store = createLiveTvStore(api, 'global');
    this.settings = defaultLiveTvSettings();

    document.body.classList.add('tvl-livebox-active');

    // Recupera volume e estado de áudio salvos pelo usuário
    let savedVol = 1.0;
    let savedMuted = false;
    try {
      const v = localStorage.getItem('tvl-livebox-volume');
      if (v !== null) {
        const parsed = parseFloat(v);
        if (!isNaN(parsed)) savedVol = Math.max(0, Math.min(1, parsed));
      }
      savedMuted = localStorage.getItem('tvl-livebox-muted') === 'true';
    } catch { }

    this.currentVolume = savedVol;
    this.isUserMuted = savedMuted;

    // Configuração do Player de Vídeo de Fundo
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = this.isUserMuted;
    this.video.volume = this.currentVolume;
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.addEventListener('playing', () => this.onVideoPlaying());
    this.video.addEventListener('loadeddata', () => this.onVideoPlaying());
    this.video.addEventListener('canplay', () => this.onVideoPlaying());
    this.video.addEventListener('timeupdate', () => {
      if (this.video.currentTime > 0 && !this.video.paused) {
        this.onVideoPlaying();
      }
    });
    this.video.addEventListener('waiting', () => {
      if (!this.isSwitchingChannel && !this.disposed) {
        this.waitForBufferCushion(2.0);
      }
    });
    this.video.addEventListener('error', () => {
      if (this.video.error && !this.isSwitchingChannel) {
        this.onStreamFail();
      }
    });
    this.video.addEventListener('volumechange', () => {
      this.updateAudioButton();
      if (!this.isSwitchingChannel) {
        this.currentVolume = this.video.volume;
        this.isUserMuted = this.video.muted;
        try {
          localStorage.setItem('tvl-livebox-volume', String(this.currentVolume));
          localStorage.setItem('tvl-livebox-muted', String(this.isUserMuted));
        } catch { }
      }
    });

    const videoWrap = el('div', 'tvl-livebox-video-wrap');
    videoWrap.append(this.video);

    // Clique no vídeo fecha gavetas e oculta EPG; duplo-clique alterna tela cheia
    videoWrap.addEventListener('click', () => {
      this.closeDrawers();
      this.hideEpgBar();
    });
    videoWrap.addEventListener('dblclick', e => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFullscreen();
    });

    // Backdrop de fechamento suave ao clicar no fundo
    this.backdrop.addEventListener('click', () => {
      this.closeDrawers();
      this.hideEpgBar();
    });

    // Botão de Tela Cheia
    this.fsButton = el('button', 'tvl-livebox-fs-btn') as HTMLButtonElement;
    this.fsButton.innerHTML = '<span class="material-icons">fullscreen</span>';
    this.fsButton.title = 'Tela Cheia (F)';
    this.fsButton.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleFullscreen();
    });

    // Botão de Áudio (Ativar / Silenciar Som)
    this.audioButton = el('button', `tvl-livebox-unmute-btn ${this.isUserMuted ? 'muted' : 'unmuted'}`) as HTMLButtonElement;
    this.updateAudioButton();
    this.audioButton.title = 'Silenciar / Ativar Som (M)';
    this.audioButton.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      this.toggleAudio();
    });
    if (!this.isUserMuted) {
      this.setupAutoUnmuteOnFirstInteraction();
    }

    // Indicador Superior de Canal em Reprodução (Não sobrepõe o botão de áudio!)
    const liveDot = el('span', 'tvl-livebox-live-dot');
    const badgeText = el('span', 'tvl-livebox-badge-text', 'Carregando...');
    this.topBadge.append(liveDot, badgeText);

    // Botão Flutuante (☰ Canais) visível quando o menu está fechado
    this.floatingTrigger = el('button', 'tvl-livebox-float-trigger') as HTMLButtonElement;
    this.floatingTrigger.title = 'Abrir Menu de Canais (☰)';
    this.floatingTrigger.innerHTML = '<span class="material-icons">menu</span><span class="tvl-livebox-float-label">Canais</span>';
    this.floatingTrigger.addEventListener('click', () => this.openDrawers());

    // Construção da Coluna 1: Categorias com botão integrado de fechar no cabeçalho
    const colCategories = el('div', 'tvl-livebox-col-categories');
    const catHeader = el('div', 'tvl-livebox-drawer-header');

    this.drawerCloseBtn = el('button', 'tvl-livebox-drawer-toggle-btn') as HTMLButtonElement;
    this.drawerCloseBtn.innerHTML = '<span class="material-icons">menu_open</span>';
    this.drawerCloseBtn.title = 'Recolher Menu (☰)';
    this.drawerCloseBtn.addEventListener('click', () => this.closeDrawers());

    const catTitle = el('h3', 'tvl-livebox-drawer-title');
    catTitle.innerHTML = '<span class="material-icons">tv</span> Categorias';
    catHeader.append(this.drawerCloseBtn, catTitle);

    const navHome = el('div', 'tvl-livebox-nav-home');
    navHome.innerHTML = '<span class="material-icons">home</span> Início';
    navHome.addEventListener('click', () => this.options.back());

    colCategories.append(catHeader, this.catList, navHome);

    // Construção da Coluna 2: Canais
    const colChannels = el('div', 'tvl-livebox-col-channels');
    const searchWrap = el('div', 'tvl-livebox-search-wrap');
    this.searchInput.placeholder = 'Buscar canal...';
    this.searchInput.addEventListener('input', () => this.filterChannels());
    searchWrap.append(this.searchInput);

    colChannels.append(searchWrap, this.channelList);

    this.drawers.append(colCategories, colChannels);

    // Construção da Barra Inferior em Espelho (EPG - 1 Clique)
    const epgActions = el('div', 'tvl-livebox-epg-actions');
    this.tuneButton = button('Sintonizar', 'play_arrow', 'tvl-livebox-btn tvl-livebox-btn-tune', () => {
      if (this.selectedChannel) void this.tuneChannel(this.selectedChannel);
    });
    this.favButton = button('Adicionar aos favoritos', 'star_border', 'tvl-livebox-btn tvl-livebox-btn-fav', () => {
      this.toggleFavoriteSelected();
    });
    this.searchButton = button('Procurar', 'search', 'tvl-livebox-btn tvl-livebox-btn-search', () => {
      this.searchInput.focus();
    });
    epgActions.append(this.tuneButton, this.favButton, this.searchButton);

    this.epgBar.append(this.epgTitle, this.epgProgramsWrap, epgActions);
    this.epgBar.addEventListener('mouseenter', () => window.clearTimeout(this.epgTimer));
    this.epgBar.addEventListener('mouseleave', () => {
      window.clearTimeout(this.epgTimer);
      this.epgTimer = window.setTimeout(() => this.hideEpgBar(), 4000);
    });

    this.element.append(
      videoWrap,
      this.backdrop,
      this.fsButton,
      this.audioButton,
      this.topBadge,
      this.volumeHud,
      this.floatingTrigger,
      this.drawers,
      this.epgBar
    );

    // Ajuste de volume via Scroll do Mouse
    this.element.addEventListener('wheel', (e: WheelEvent) => {
      if ((e.target as HTMLElement)?.closest('.tvl-livebox-drawers')) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      let newVol = Math.min(1, Math.max(0, this.video.volume + delta));
      if (newVol > 0 && this.video.muted) {
        this.video.muted = false;
        this.isUserMuted = false;
      }
      this.video.volume = Math.round(newVol * 100) / 100;
      this.currentVolume = this.video.volume;
      this.showVolumeHud(Math.round(this.video.volume * 100));
      this.updateAudioButton();
      this.onUserActivity();
    }, { passive: false });

    // Auto-hide de botões quando o mouse fica parado
    this.element.addEventListener('mousemove', () => this.onUserActivity());
    this.element.addEventListener('mousedown', () => this.onUserActivity());

    // Eventos de teclado, fullscreen e visibilidade de aba
    window.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('fullscreenchange', this.onFsChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    this.removeRemote = attachRemote(this.element, () => {
      if (!this.drawers.classList.contains('closed')) {
        this.closeDrawers();
      } else {
        this.options.back();
      }
    });
  }

  async load(): Promise<void> {
    try {
      this.settings = await this.store.load();
    } catch {
      this.settings = defaultLiveTvSettings();
    }

    // Inicializa o Canal Padrão (TV Senado) em tela cheia se ativado
    if (this.settings.defaultChannelEnabled && this.settings.defaultChannelUrls.length > 0) {
      this.playDefaultSenado(0);
    }

    await this.fetchCatalog();
  }

  private openDrawers(): void {
    this.drawers.classList.remove('closed');
    this.floatingTrigger.classList.add('hidden');
    this.backdrop.classList.remove('hidden');
    this.onUserActivity();
  }

  private closeDrawers(): void {
    this.drawers.classList.add('closed');
    this.floatingTrigger.classList.remove('hidden');
    this.backdrop.classList.add('hidden');
    this.hideEpgBar();
    this.onUserActivity();
  }

  private toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      this.element.requestFullscreen?.().catch(() => { });
    } else {
      document.exitFullscreen?.().catch(() => { });
    }
  }

  private onFsChange = (): void => {
    const isFs = Boolean(document.fullscreenElement);
    this.fsButton.innerHTML = `<span class="material-icons">${isFs ? 'fullscreen_exit' : 'fullscreen'}</span>`;
    this.fsButton.title = isFs ? 'Sair da Tela Cheia (F)' : 'Tela Cheia (F)';
  };

  private handleVisibilityChange = (): void => {
    if (this.disposed) return;
    if (document.visibilityState === 'visible' && this.video) {
      if (this.video.buffered.length > 0) {
        const liveEdge = this.video.buffered.end(this.video.buffered.length - 1);
        if (liveEdge - this.video.currentTime > 2.5) {
          this.video.currentTime = Math.max(0, liveEdge - 0.5);
        }
      }
      if (this.video.paused) {
        this.video.play().catch(() => { });
      }
    }
  };

  private showVolumeHud(pct: number): void {
    window.clearTimeout(this.volumeHudTimer);
    const iconName = this.video.muted || pct === 0 ? 'volume_off' : pct < 50 ? 'volume_down' : 'volume_up';
    this.volumeHud.innerHTML = `
      <span class="material-icons tvl-livebox-vol-icon">${iconName}</span>
      <div class="tvl-livebox-vol-track">
        <div class="tvl-livebox-vol-fill" style="width: ${pct}%"></div>
      </div>
      <span class="tvl-livebox-vol-pct">${pct}%</span>
    `;
    this.volumeHud.classList.remove('hidden');
    this.volumeHudTimer = window.setTimeout(() => {
      this.volumeHud.classList.add('hidden');
    }, 1500);
  }

  private onUserActivity(): void {
    this.element.classList.remove('tvl-mouse-idle');
    window.clearTimeout(this.mouseIdleTimer);
    if (this.drawers.classList.contains('closed')) {
      this.mouseIdleTimer = window.setTimeout(() => {
        if (this.drawers.classList.contains('closed') && !this.disposed) {
          this.element.classList.add('tvl-mouse-idle');
        }
      }, 3500);
    }
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (this.disposed) return;
    if (document.activeElement?.tagName === 'INPUT') return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      let vol = Math.min(1, this.video.volume + 0.05);
      if (this.video.muted) {
        this.video.muted = false;
        this.isUserMuted = false;
      }
      this.video.volume = Math.round(vol * 100) / 100;
      this.currentVolume = this.video.volume;
      this.showVolumeHud(Math.round(this.video.volume * 100));
      this.updateAudioButton();
      this.onUserActivity();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      let vol = Math.max(0, this.video.volume - 0.05);
      this.video.volume = Math.round(vol * 100) / 100;
      this.currentVolume = this.video.volume;
      this.showVolumeHud(Math.round(this.video.volume * 100));
      this.updateAudioButton();
      this.onUserActivity();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      this.toggleAudio();
      this.showVolumeHud(this.video.muted ? 0 : Math.round(this.video.volume * 100));
      this.onUserActivity();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.toggleFullscreen();
      this.onUserActivity();
    }
  };

  private toggleAudio(): void {
    this.video.muted = !this.video.muted;
    this.isUserMuted = this.video.muted;
    if (!this.video.muted) {
      if (this.video.volume === 0) {
        this.video.volume = this.currentVolume > 0 ? this.currentVolume : 1.0;
        this.currentVolume = this.video.volume;
      }
      this.video.play().catch(() => { });
    }
    try {
      localStorage.setItem('tvl-livebox-muted', String(this.isUserMuted));
      localStorage.setItem('tvl-livebox-volume', String(this.currentVolume));
    } catch { }
    this.updateAudioButton();
  }

  private autoUnmuteBound = false;
  private setupAutoUnmuteOnFirstInteraction(): void {
    if (this.autoUnmuteBound) return;
    this.autoUnmuteBound = true;

    const tryUnmute = () => {
      this.autoUnmuteBound = false;
      if (this.disposed) return;
      if (this.video.muted && !this.isUserMuted) {
        this.video.muted = false;
        this.video.volume = this.currentVolume;
        this.updateAudioButton();
        this.video.play().catch(() => { });
      }
    };

    window.addEventListener('pointerdown', tryUnmute, { once: true, capture: true });
    window.addEventListener('keydown', tryUnmute, { once: true, capture: true });
    window.addEventListener('click', tryUnmute, { once: true, capture: true });
  }

  private updateAudioButton(): void {
    if (this.video.muted || this.video.volume === 0) {
      this.audioButton.innerHTML = '🔇 Ativar Som';
      this.audioButton.classList.add('muted');
      this.audioButton.classList.remove('unmuted');
    } else {
      this.audioButton.innerHTML = '🔊 Silenciar';
      this.audioButton.classList.remove('muted');
      this.audioButton.classList.add('unmuted');
    }
    this.audioButton.hidden = false;
  }

  private updateTopBadge(name: string): void {
    const textEl = this.topBadge.querySelector('.tvl-livebox-badge-text');
    if (textEl) textEl.textContent = name;
  }

  private playDefaultSenado(index = 0): void {
    const urls = this.settings.defaultChannelUrls.length > 0 ? this.settings.defaultChannelUrls : defaultSenadoUrls;
    this.currentFailoverIndex = (index >= 0 && index < urls.length) ? index : 0;
    const targetUrl = urls[this.currentFailoverIndex];

    const proxyUrl = `/TvItemLayout/LiveTv/ProxyM3u8?url=${encodeURIComponent(targetUrl)}`;
    this.updateTopBadge(`${this.settings.defaultChannelName} · Ao Vivo`);
    this.playingChannel = {
      id: 'default-senado',
      channelNumber: '1',
      name: this.settings.defaultChannelName,
      groupTitle: '📺 Canal Padrão',
      streamUrl: proxyUrl
    };

    this.video.muted = false;
    this.video.volume = 1.0;
    this.updateAudioButton();

    this.playStream(proxyUrl);
    this.renderChannelList();
  }

  private playStream(streamUrl: string, rawStreamUrl?: string): void {
    window.clearTimeout(this.failoverTimer);
    this.isSwitchingChannel = true;

    if (this.mpegtsPlayer) {
      try {
        this.mpegtsPlayer.pause();
        this.mpegtsPlayer.unload();
        this.mpegtsPlayer.detachMediaElement();
        this.mpegtsPlayer.destroy();
      } catch { }
      this.mpegtsPlayer = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();

    // Timeout de 20s para auto-failover caso a stream trave ou não carregue
    this.failoverTimer = window.setTimeout(() => {
      if (this.video.readyState < 2) {
        this.onStreamFail();
      }
    }, 20000);

    const HlsConstructor = (window as unknown as { Hls?: typeof Hls }).Hls || Hls;

    if (HlsConstructor?.isSupported()) {
      if (this.hlsInstance) {
        this.hlsInstance.destroy();
      }
      this.hlsInstance = new HlsConstructor({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 30
      });
      this.hlsInstance.attachMedia(this.video);
      this.hlsInstance.on(HlsConstructor.Events.MEDIA_ATTACHED, () => {
        this.hlsInstance?.loadSource(streamUrl);
      });
      this.hlsInstance.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
        this.isSwitchingChannel = false;
        window.clearTimeout(this.failoverTimer);
        this.updateTopBadge(this.playingChannel?.name || 'Ao Vivo');
      });
      this.hlsInstance.on(HlsConstructor.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          // Se o HLS falhar (ex: status 422 - stream é MPEG-TS bruto ou erro de manifesto)
          // e temos o link original, aciona imediatamente o player nativo de MPEG-TS!
          if (rawStreamUrl && mpegts.isSupported()) {
            this.playMpegTs(rawStreamUrl);
            return;
          }
          this.onStreamFail();
        }
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = streamUrl;
      this.video.load();
    } else {
      if (rawStreamUrl && mpegts.isSupported()) {
        this.playMpegTs(rawStreamUrl);
        return;
      }
      this.video.src = streamUrl;
    }

    // Mantém o volume e estado de som previamente ajustados pelo usuário
    this.video.muted = this.isUserMuted;
    this.video.volume = this.currentVolume;

    const playPromise = this.video.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          this.updateAudioButton();
        })
        .catch(err => {
          console.warn('Autoplay com som bloqueado pelo navegador até primeira interação:', err);
          this.video.muted = true;
          this.updateAudioButton();
          this.video.play().catch(() => { });
          this.setupAutoUnmuteOnFirstInteraction();
        });
    }
  }

  private getBufferedAhead(): number {
    try {
      const ct = this.video.currentTime;
      const b = this.video.buffered;
      for (let i = 0; i < b.length; i++) {
        const start = b.start(i);
        const end = b.end(i);
        if (start <= ct + 0.3 && end >= ct) {
          return end - ct;
        }
      }
    } catch { }
    return 0;
  }

  private waitForBufferCushion(minSeconds = 2.0, maxWaitMs = 3500): void {
    if (this.isWaitingForCushion || this.disposed) return;
    this.isWaitingForCushion = true;
    window.clearTimeout(this.cushionCheckTimer);

    const startTime = Date.now();
    const check = () => {
      if (this.disposed || this.isSwitchingChannel) {
        this.isWaitingForCushion = false;
        return;
      }

      const ahead = this.getBufferedAhead();
      const elapsed = Date.now() - startTime;

      if (ahead >= minSeconds || (elapsed >= maxWaitMs && ahead >= 0.6)) {
        this.isWaitingForCushion = false;
        const playPromise = this.video.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => this.updateAudioButton())
            .catch(err => {
              console.warn('Autoplay com som bloqueado pelo navegador até primeira interação:', err);
              this.video.muted = true;
              this.updateAudioButton();
              this.video.play().catch(() => { });
              this.setupAutoUnmuteOnFirstInteraction();
            });
        }
        return;
      }

      this.cushionCheckTimer = window.setTimeout(check, 100);
    };

    this.cushionCheckTimer = window.setTimeout(check, 100);
  }

  private playMpegTs(rawUrl: string): void {
    setupVirtualStreamInterceptor();

    window.clearTimeout(this.failoverTimer);
    window.clearTimeout(this.cushionCheckTimer);
    this.isWaitingForCushion = false;
    this.isSwitchingChannel = true;

    // Timeout de 25s para buffers de transmissão ao vivo MPEG-TS inicializarem
    this.failoverTimer = window.setTimeout(() => {
      if (this.video.readyState < 2) {
        this.onStreamFail();
      }
    }, 25000);

    if (this.hlsInstance) {
      this.hlsInstance.destroy();
      this.hlsInstance = null;
    }
    if (this.mpegtsPlayer) {
      try {
        this.mpegtsPlayer.pause();
        this.mpegtsPlayer.unload();
        this.mpegtsPlayer.detachMediaElement();
        this.mpegtsPlayer.destroy();
      } catch { }
      this.mpegtsPlayer = null;
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();

    const win = typeof window !== 'undefined' ? (window as unknown as { ApiClient?: any }) : undefined;
    const client = win?.ApiClient || (this.api as unknown as { client?: any })?.client;
    const streamEndpoint = client?.getUrl
      ? client.getUrl('TvItemLayout/LiveTv/VirtualStream', { url: rawUrl })
      : `/TvItemLayout/LiveTv/VirtualStream?url=${encodeURIComponent(rawUrl)}`;

    try {
      this.mpegtsPlayer = mpegts.createPlayer({
        type: 'mpegts',
        isLive: true,
        url: streamEndpoint
      }, {
        enableWorker: false, // OBRIGATÓRIO: Permite que window.fetch intercepte os chunks na thread principal
        lazyLoad: false,
        stashInitialSize: 512 * 1024, // 512 KB de amortecimento inicial
        enableStashBuffer: true,
        isLive: true,
        liveBufferLatencyChasing: false, // CRÍTICO: Não pular para a ponta do buffer para não secar o colchão de segurança!
        liveSync: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 15
      });

      this.mpegtsPlayer.attachMediaElement(this.video);
      this.mpegtsPlayer.load();

      // Colchão Inicial (Pre-buffer Gate): aguarda acumular pelo menos 2.0s de buffer antes de chamar video.play()
      this.waitForBufferCushion(2.0);

      this.mpegtsPlayer.on(mpegts.Events.MEDIA_INFO, () => {
        this.isSwitchingChannel = false;
        window.clearTimeout(this.failoverTimer);
        const name = this.playingChannel ? `${this.playingChannel.name} · Ao Vivo` : 'Ao Vivo';
        this.updateTopBadge(name);
      });

      this.mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
        console.warn('mpegts error:', type, detail, info);
      });
    } catch (err) {
      console.error('Erro ao iniciar mpegtsPlayer:', err);
      this.onStreamFail();
    }

    // Mantém o volume e estado de som previamente ajustados pelo usuário
    this.video.muted = this.isUserMuted;
    this.video.volume = this.currentVolume;
  }

  private onVideoPlaying(): void {
    this.isSwitchingChannel = false;
    window.clearTimeout(this.failoverTimer);
    const name = this.playingChannel ? `${this.playingChannel.name} · Ao Vivo` : 'Ao Vivo';
    this.updateTopBadge(name);
    this.updateAudioButton();
  }

  private onStreamFail(): void {
    window.clearTimeout(this.failoverTimer);
    // Auto-failover para os links de backup da TV Senado APENAS se estiver tocando a TV Senado!
    if (this.playingChannel?.id === 'default-senado') {
      const urls = this.settings.defaultChannelUrls.length > 0 ? this.settings.defaultChannelUrls : defaultSenadoUrls;
      if (urls.length <= 1) return;
      const nextIndex = (this.currentFailoverIndex + 1) % urls.length;
      this.playDefaultSenado(nextIndex);
    } else {
      // Para canais normais do usuário, não reseta para a TV Senado! Avisa no badge
      this.updateTopBadge(`${this.playingChannel?.name || 'Canal'} · Sinal indisponível`);
    }
  }

  private async fetchCatalog(): Promise<void> {
    const win = typeof window !== 'undefined' ? (window as unknown as { ApiClient?: any }) : undefined;
    const client = win?.ApiClient || (this.api as unknown as { client?: any })?.client;
    let catalogData: { categories?: LiveBoxCategory[]; channels?: LiveBoxChannel[] } = {};

    if (client) {
      try {
        const catalogUrl = client.getUrl ? client.getUrl('TvItemLayout/LiveTv/Catalog', { refresh: true }) : '/TvItemLayout/LiveTv/Catalog?refresh=true';
        catalogData = (await client.getJSON(catalogUrl)) as typeof catalogData;
      } catch (err) {
        console.warn('Não foi possível carregar catálogo M3U da API', err);
        catalogData = {};
      }
    }

    // Se a API não retornou canais, busca canais nativos do Jellyfin
    if (!catalogData.channels || catalogData.channels.length === 0) {
      try {
        const jfChannels = await this.api.getChannels();
        catalogData.channels = jfChannels.map((c, i) => ({
          id: c.Id,
          jellyfinId: c.Id,
          channelNumber: c.ChannelNumber || (i + 1).toString(),
          name: c.Name || `Canal ${i + 1}`,
          groupTitle: '📡 Todos os Canais',
          logoUrl: `/Items/${c.Id}/Images/Primary`
        }));
      } catch {
        catalogData.channels = [];
      }
    }

    this.allChannels = catalogData.channels || [];

    // Categoria opcional de Canais Locais caso configurado no Admin
    const region = (this.settings.localRegion || 'none').trim().toUpperCase();

    // Normaliza canais "Local - ..." do fornecedor (ex: "Local - Bahia") para "TV Aberta"
    // para não poluir a lista com categorias fixas de outros estados.
    this.allChannels.forEach(c => {
      if (/^Local\s*-\s*/i.test(c.groupTitle || '') || (c.groupTitle || '').trim().toLowerCase() === 'local') {
        c.groupTitle = 'TV Aberta';
      }
    });

    // Isola os canais Premiere brasileiros na sua categoria própria "Premiere"
    let premiereCount = 0;
    this.allChannels.forEach(c => {
      if (isBrazilianPremiere(c.name, c.groupTitle || '')) {
        c.groupTitle = 'Premiere';
        premiereCount++;
      }
    });

    // Monta lista de categorias incluindo fixas
    const builtInCats: LiveBoxCategory[] = [
      { id: 'default-senado', name: `📺 ${this.settings.defaultChannelName}`, icon: 'live_tv', count: 1 },
      { id: 'favorites', name: '⭐ Favoritos', icon: 'star', count: this.favorites.size },
      { id: 'all-channels', name: '📡 Todos os Canais', icon: 'list', count: this.allChannels.length }
    ];

    if (region !== 'NONE' && region !== '') {
      if (region === 'AUTO') {
        const autoLocalChannels = this.allChannels.filter(c => /local/i.test(c.groupTitle || ''));
        if (autoLocalChannels.length > 0) {
          builtInCats.push({
            id: 'local-region',
            name: '📍 Canais Locais',
            icon: 'location_on',
            count: autoLocalChannels.length
          });
        }
      } else if (STATE_REGEX_MAP[region]) {
        const localChannels = this.allChannels.filter(c => isChannelInState(c, region));
        if (localChannels.length > 0) {
          const stateLabel = STATE_NAME_MAP[region] || region;
          builtInCats.push({
            id: 'local-region',
            name: `📍 Canais Locais (${stateLabel})`,
            icon: 'location_on',
            count: localChannels.length
          });
        }
      }
    }

    const serverCats = (catalogData.categories || [])
      .filter(cat => {
        if (cat.id === 'all-channels' || cat.name.includes('Todos os Canais')) return false;
        // Categorias tipo "Local - Bahia" ou "Local - ..." são sempre filtradas da lista principal
        if (/^Local\s*-\s*/i.test(cat.name) || cat.name.trim().toLowerCase() === 'local') return false;
        return true;
      })
      .map(cat => ({
        id: cat.id,
        name: cat.name,
        icon: cat.name.toLowerCase() === 'premiere' ? 'sports_soccer' : (cat.icon || 'tv'),
        count: cat.name.toLowerCase() === 'premiere' && premiereCount > 0 ? premiereCount : cat.count
      }));

    // Garante que "Premiere" fique posicionado imediatamente acima de "Esportes"
    if (premiereCount > 0) {
      const premIdx = serverCats.findIndex(c => c.name.toLowerCase() === 'premiere');
      let premCat: LiveBoxCategory;
      if (premIdx >= 0) {
        premCat = serverCats.splice(premIdx, 1)[0];
        premCat.count = premiereCount;
      } else {
        premCat = {
          id: 'cat-premiere',
          name: 'Premiere',
          icon: 'sports_soccer',
          count: premiereCount
        };
      }
      const esportesIdx = serverCats.findIndex(c => c.name.toLowerCase().includes('esporte'));
      if (esportesIdx >= 0) {
        serverCats.splice(esportesIdx, 0, premCat);
      } else {
        const abertaIdx = serverCats.findIndex(c => c.name.toLowerCase().includes('aberta'));
        if (abertaIdx >= 0) serverCats.splice(abertaIdx + 1, 0, premCat);
        else serverCats.unshift(premCat);
      }
    }

    this.categories = [...builtInCats, ...serverCats];
    this.renderCategoryList();
    this.selectCategory('default-senado');
  }

  private renderCategoryList(): void {
    replace(this.catList);

    this.categories.forEach(cat => {
      const li = el('li', 'tvl-livebox-cat-item');
      if (cat.id === this.activeCategoryId) li.classList.add('active');

      const left = el('div', 'tvl-livebox-cat-left');
      const name = el('span', 'tvl-livebox-cat-name', cat.name);
      left.append(name);

      const count = el('span', 'tvl-livebox-cat-count', String(cat.count));

      li.append(left, count);
      li.addEventListener('click', () => this.selectCategory(cat.id));

      this.catList.append(li);
    });
  }

  private selectCategory(categoryId: string): void {
    this.activeCategoryId = categoryId;
    this.renderCategoryList();

    if (categoryId === 'default-senado') {
      this.filteredChannels = [
        {
          id: 'default-senado',
          channelNumber: '1',
          name: this.settings.defaultChannelName,
          groupTitle: 'Canal de Boas-Vindas',
          logoUrl: ''
        }
      ];
    } else if (categoryId === 'favorites') {
      this.filteredChannels = this.allChannels.filter(c => this.favorites.has(c.id) || (c.jellyfinId && this.favorites.has(c.jellyfinId)));
    } else if (categoryId === 'all-channels') {
      this.filteredChannels = [...this.allChannels];
    } else if (categoryId === 'local-region') {
      const region = (this.settings.localRegion || 'none').trim().toUpperCase();
      if (region === 'AUTO') {
        this.filteredChannels = this.allChannels.filter(c => /local/i.test(c.groupTitle || ''));
      } else {
        this.filteredChannels = this.allChannels.filter(c => isChannelInState(c, region));
      }
    } else {
      const cat = this.categories.find(c => c.id === categoryId);
      const targetGroup = (cat?.name || '').trim().toLowerCase();
      // Match estrito: o canal só pertence à categoria exata definida pelo fornecedor
      this.filteredChannels = this.allChannels.filter(c => {
        const group = (c.groupTitle || '').trim().toLowerCase();
        return group === targetGroup;
      });
    }

    this.renderChannelList();
  }

  private filterChannels(): void {
    const term = this.searchInput.value.trim().toLowerCase();
    if (!term) {
      this.selectCategory(this.activeCategoryId);
      return;
    }
    this.filteredChannels = this.allChannels.filter(c =>
      c.name.toLowerCase().includes(term) || c.channelNumber.includes(term)
    );
    this.renderChannelList();
  }

  private renderChannelList(): void {
    replace(this.channelList);
    const fragment = document.createDocumentFragment();

    this.filteredChannels.forEach(channel => {
      const li = el('li', 'tvl-livebox-channel-item');
      const isSelected = this.selectedChannel?.id === channel.id;
      const isPlaying = this.playingChannel?.id === channel.id;

      if (isSelected) li.classList.add('selected');
      if (isPlaying) li.classList.add('playing');

      const num = el('span', 'tvl-livebox-channel-num', channel.channelNumber || '—');

      const logo = el('img', 'tvl-livebox-channel-logo') as HTMLImageElement;
      logo.loading = 'lazy';
      if (channel.logoUrl) {
        logo.src = channel.logoUrl;
      } else {
        logo.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="%23e50914"><path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/></svg>';
      }

      const name = el('span', 'tvl-livebox-channel-name', channel.name);

      li.append(num, logo, name);

      if (isPlaying) {
        const iconPlaying = el('span', 'material-icons tvl-livebox-channel-playing-icon', 'volume_up');
        li.append(iconPlaying);
      }

      // 1 Clique: Seleciona canal e abre Barra Inferior de EPG (sem parar o vídeo!)
      // 2 Cliques (ou clique duplo / clique no já selecionado): Sintoniza o canal!
      li.addEventListener('click', () => {
        if (this.selectedChannel?.id === channel.id) {
          void this.tuneChannel(channel);
        } else {
          this.selectChannel(channel);
        }
      });

      li.addEventListener('dblclick', () => {
        void this.tuneChannel(channel);
      });

      fragment.append(li);
    });

    this.channelList.append(fragment);
  }

  private selectChannel(channel: LiveBoxChannel): void {
    this.selectedChannel = channel;
    this.renderChannelList();
    this.showEpgBar(channel);
  }

  private async showEpgBar(channel: LiveBoxChannel): Promise<void> {
    window.clearTimeout(this.epgTimer);
    this.epgBar.classList.remove('hidden');
    this.epgTitle.textContent = channel.name;
    replace(this.epgProgramsWrap);

    // Auto-hide após 7 segundos se o usuário não interagir
    this.epgTimer = window.setTimeout(() => {
      this.hideEpgBar();
    }, 7000);

    const isFav = this.favorites.has(channel.id) || (channel.jellyfinId && this.favorites.has(channel.jellyfinId));
    this.updateFavButton(Boolean(isFav));

    // Se for o canal padrão da TV Senado
    if (channel.id === 'default-senado') {
      const line1 = el('div', 'tvl-livebox-prog-line now');
      line1.innerHTML = '<span class="tvl-livebox-prog-time">Ao Vivo 24h</span><span class="tvl-livebox-prog-name">Transmissão Oficial da TV Senado</span>';
      this.epgProgramsWrap.append(line1);
      return;
    }

    // Carrega EPG do Jellyfin (/LiveTv/Programs)
    const targetId = channel.jellyfinId || channel.epgId || channel.id;
    try {
      const programs = await this.api.getPrograms(targetId);
      if (programs.length === 0) {
        const empty = el('div', 'tvl-livebox-prog-line');
        empty.innerHTML = '<span class="tvl-livebox-prog-time">—</span><span class="tvl-livebox-prog-name">Sem informações de programação disponíveis no momento</span>';
        this.epgProgramsWrap.append(empty);
        return;
      }

      // Mostra os primeiros 2 programas (Atual + Próximo)
      programs.slice(0, 2).forEach((prog, index) => {
        const line = el('div', `tvl-livebox-prog-line ${index === 0 ? 'now' : 'next'}`);
        const startStr = prog.StartDate ? new Date(prog.StartDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const endStr = prog.EndDate ? new Date(prog.EndDate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const timeStr = startStr && endStr ? `${startStr} ~ ${endStr}` : (index === 0 ? 'Agora' : 'A Seguir');

        const spanTime = el('span', 'tvl-livebox-prog-time', timeStr);
        const spanName = el('span', 'tvl-livebox-prog-name', prog.Name || 'Sem título');

        line.append(spanTime, spanName);
        this.epgProgramsWrap.append(line);
      });
    } catch {
      const errLine = el('div', 'tvl-livebox-prog-line');
      errLine.innerHTML = '<span class="tvl-livebox-prog-time">—</span><span class="tvl-livebox-prog-name">Programação ao vivo</span>';
      this.epgProgramsWrap.append(errLine);
    }
  }

  private hideEpgBar(): void {
    window.clearTimeout(this.epgTimer);
    this.epgBar.classList.add('hidden');
  }

  private updateFavButton(isFav: boolean): void {
    if (isFav) {
      this.favButton.classList.add('active');
      this.favButton.textContent = 'Favoritado';
    } else {
      this.favButton.classList.remove('active');
      this.favButton.textContent = 'Adicionar aos favoritos';
    }
  }

  private toggleFavoriteSelected(): void {
    if (!this.selectedChannel) return;
    const id = this.selectedChannel.jellyfinId || this.selectedChannel.id;
    const isFav = this.favorites.has(id);
    if (isFav) {
      this.favorites.delete(id);
      this.updateFavButton(false);
    } else {
      this.favorites.add(id);
      this.updateFavButton(true);
    }
    const favCat = this.categories.find(c => c.id === 'favorites');
    if (favCat) favCat.count = this.favorites.size;
    this.renderCategoryList();
  }

  private async tuneChannel(channel: LiveBoxChannel): Promise<void> {
    if (this.isTuning && this.playingChannel?.id === channel.id) {
      return;
    }
    this.isTuning = true;
    try {
      this.playingChannel = channel;
      this.renderChannelList();
      this.updateTopBadge(`${channel.name} · Sintonizando...`);
      this.hideEpgBar();

      // Já começa com som em todos os canais sintonizados
      this.video.muted = false;
      this.video.volume = 1.0;
      this.updateAudioButton();

      if (channel.id === 'default-senado') {
        this.playDefaultSenado(0);
        return;
      }

      const win = typeof window !== 'undefined' ? (window as unknown as { ApiClient?: any }) : undefined;
      const client = win?.ApiClient || (this.api as unknown as { client?: any })?.client;
      const targetId = channel.jellyfinId || channel.id;

      // 1. Prioriza a stream direta do canal (M3U) se disponível
      if (channel.streamUrl && (channel.streamUrl.startsWith('http://') || channel.streamUrl.startsWith('https://'))) {
        const url = channel.streamUrl;
        const isTs = url.includes('.ts') || (!url.includes('.m3u8') && !url.includes('master'));
        if (isTs && mpegts.isSupported()) {
          this.playMpegTs(url);
          return;
        }

        const proxied = client?.getUrl
          ? client.getUrl('TvItemLayout/LiveTv/ProxyM3u8', { url })
          : `/TvItemLayout/LiveTv/ProxyM3u8?url=${encodeURIComponent(url)}`;
        this.playStream(proxied, url);
        return;
      }

      // 2. Se não tem streamUrl direta, busca no Jellyfin via PlaybackInfo
      if (client && channel.jellyfinId) {
        try {
          const postBody = {
            UserId: this.api.userId || (client.getCurrentUserId ? client.getCurrentUserId() : undefined),
            StartTimeTicks: 0,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            MaxStreamingBitrate: 140000000,
            DeviceProfile: client.getDeviceProfile ? client.getDeviceProfile() : {}
          };

          let playbackInfo: any = null;
          if (typeof client.getPlaybackInfo === 'function') {
            try {
              playbackInfo = await client.getPlaybackInfo(targetId, postBody);
            } catch { }
          }

          if (!playbackInfo && client.ajax) {
            const infoUrl = client.getUrl ? client.getUrl(`Items/${targetId}/PlaybackInfo`, {
              UserId: postBody.UserId,
              StartTimeTicks: 0,
              IsPlayback: true,
              AutoOpenLiveStream: true,
              MaxStreamingBitrate: 140000000
            }) : `/Items/${targetId}/PlaybackInfo?AutoOpenLiveStream=true`;

            playbackInfo = (await client.ajax({
              type: 'POST',
              url: infoUrl,
              data: JSON.stringify(postBody),
              dataType: 'json',
              contentType: 'application/json'
            })) as any;
          }

          const mediaSource = playbackInfo?.MediaSources?.[0];
          if (mediaSource) {
            const rawFallback = mediaSource.Path && (mediaSource.Path.startsWith('http://') || mediaSource.Path.startsWith('https://'))
              ? mediaSource.Path
              : undefined;

            // Se o mediaSource.Path for TS direto, toca via mpegts.js
            if (rawFallback && (rawFallback.includes('.ts') || (!rawFallback.includes('.m3u8') && !rawFallback.includes('master'))) && mpegts.isSupported()) {
              this.playMpegTs(rawFallback);
              return;
            }

            if (mediaSource.TranscodingUrl) {
              const fullUrl = client.getUrl ? client.getUrl(mediaSource.TranscodingUrl.replace(/^\//, '')) : mediaSource.TranscodingUrl;
              this.playStream(fullUrl, rawFallback);
              return;
            }
            if (mediaSource.LiveStreamId) {
              const liveUrl = client.getUrl ? client.getUrl(`Videos/${targetId}/master.m3u8`, {
                MediaSourceId: mediaSource.Id,
                LiveStreamId: mediaSource.LiveStreamId
              }) : `/Videos/${targetId}/master.m3u8?LiveStreamId=${encodeURIComponent(mediaSource.LiveStreamId)}`;
              this.playStream(liveUrl, rawFallback);
              return;
            }
            if (mediaSource.DirectStreamUrl && (mediaSource.DirectStreamUrl.includes('.m3u8') || mediaSource.DirectStreamUrl.includes('master'))) {
              const fullUrl = client.getUrl ? client.getUrl(mediaSource.DirectStreamUrl.replace(/^\//, '')) : mediaSource.DirectStreamUrl;
              this.playStream(fullUrl, rawFallback);
              return;
            }
            if (rawFallback) {
              const proxied = client.getUrl ? client.getUrl('TvItemLayout/LiveTv/ProxyM3u8', { url: rawFallback }) : `/TvItemLayout/LiveTv/ProxyM3u8?url=${encodeURIComponent(rawFallback)}`;
              this.playStream(proxied, rawFallback);
              return;
            }
          }
        } catch (err) {
          console.warn('Erro ao obter PlaybackInfo para o canal', err);
        }
      }

      // 3. Fallback de transmissão master do Jellyfin
      const fallbackStream = client?.getUrl ? client.getUrl(`Videos/${targetId}/master.m3u8`) : `/Videos/${targetId}/master.m3u8`;
      this.playStream(fallbackStream);
    } finally {
      this.isTuning = false;
    }
  }

  destroy(): void {
    this.disposed = true;
    document.body.classList.remove('tvl-livebox-active');
    document.removeEventListener('fullscreenchange', this.onFsChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.clearTimeout(this.failoverTimer);
    window.clearTimeout(this.cushionCheckTimer);
    window.clearTimeout(this.mouseIdleTimer);
    window.clearTimeout(this.volumeHudTimer);
    window.clearTimeout(this.epgTimer);
    if (this.hlsInstance) {
      this.hlsInstance.destroy();
      this.hlsInstance = null;
    }
    if (this.mpegtsPlayer) {
      try {
        this.mpegtsPlayer.pause();
        this.mpegtsPlayer.unload();
        this.mpegtsPlayer.detachMediaElement();
        this.mpegtsPlayer.destroy();
      } catch { }
      this.mpegtsPlayer = null;
    }
    try {
      const win = typeof window !== 'undefined' ? (window as unknown as { ApiClient?: any }) : undefined;
      const client = win?.ApiClient;
      const stopUrl = client?.getUrl ? client.getUrl('TvItemLayout/LiveTv/StopSession') : '/TvItemLayout/LiveTv/StopSession';
      window.fetch(stopUrl, { method: 'POST' }).catch(() => { });
    } catch { }
    this.video.pause();
    this.video.src = '';
    this.video.remove();
    this.removeRemote();
    this.element.remove();
  }
}
