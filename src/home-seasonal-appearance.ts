import { el, replace } from './dom';
import type { HomeCollectionRow } from './home-collection-settings';
import { seasonalAssetUrl } from './seasonal-asset-url';
import { seasonalBackground, seasonalDoor, seasonalFrame } from './home-seasonal-art';
import { adventDoorArt } from './home-advent-art';
import { adventDoorState } from './home-advent';
import { seasonalRankImage } from './home-seasonal-rank';
import { applySeasonalTitleFont } from './home-seasonal-font';
import { cancelSeasonalMotion, changeSeasonalExpansion, seasonalHeaderClearance, settleSeasonalSelection } from './home-seasonal-motion';

type AdventCard = { row: HomeCollectionRow; index: number; caption: HTMLElement | null; title: string; label: string; opensAt?: number; opensLabel?: string; getDate?: () => Date | undefined };
const adventCards = new WeakMap<HTMLElement, AdventCard>();
const pendingMounts = new WeakMap<HTMLElement, () => void>();
type SeasonalRowController = { suspended: boolean; suspend(): void; resume(): void };
const seasonalRows = new WeakMap<HTMLElement, SeasonalRowController>();
const dateChangeEvent = 'tvl-seasonal-date-change';

/** Cached Home keeps its scenery and open doors while another route is shown. */
export function suspendSeasonalRow(section: HTMLElement): void { seasonalRows.get(section)?.suspend(); }

/** Restore Home focus before resuming so a retained scene does not close first. */
export function resumeSeasonalRow(section: HTMLElement): void { seasonalRows.get(section)?.resume(); }

function refreshAdventCard(card: HTMLElement, reveal = false): boolean {
  const data = adventCards.get(card);
  if (!data) return true;
  const state = adventDoorState(data.row, data.index, data.getDate?.());
  const locked = state.locked && !card.closest('.tvl-home-preview');
  if (locked && state.opens && data.opensAt !== state.opens.getTime()) {
    data.opensAt = state.opens.getTime();
    data.opensLabel = state.opens.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  }
  const opens = state.opens ? data.opensLabel : undefined;
  if (card.dataset.adventLocked !== String(locked)) card.dataset.adventLocked = String(locked);
  card.classList.toggle('tvl-advent-locked', locked);
  if (locked) card.classList.remove('tvl-seasonal-item-open');
  if (locked) {
    if (card.getAttribute('aria-disabled') !== 'true') card.setAttribute('aria-disabled', 'true');
  } else if (card.hasAttribute('aria-disabled')) card.removeAttribute('aria-disabled');
  const caption = locked ? opens ? `Abre em ${opens}` : 'Ainda não disponível' : data.title;
  if (data.caption && data.caption.textContent !== caption) data.caption.textContent = caption;
  const label = locked ? `Porta do Advento ${state.day}. ${opens ? `Abre em ${opens}` : 'Ainda não disponível'}`
    : reveal ? `Porta do Advento ${state.day}: ${data.label}` : `Porta do Advento ${state.day}`;
  if (card.getAttribute('aria-label') !== label) card.setAttribute('aria-label', label);
  return !locked;
}

/** Refresh dates in place, preserving focus, scroll position and loaded artwork. */
export function refreshSeasonalDate(section: HTMLElement): void {
  section.dispatchEvent(new Event(dateChangeEvent));
}

function decoration(className: string, src: string): HTMLImageElement {
  const image = el('img', className); image.src = src; image.alt = ''; image.draggable = false;
  image.setAttribute('aria-hidden', 'true'); return image;
}

/** Ordinary decorations preserve item actions; future advent doors stay focusable but closed. */
export function decorateSeasonalCard(card: HTMLElement, row: HomeCollectionRow, index: number, getDate?: () => Date | undefined): void {
  const appearance = row.appearance;
  const art = card.querySelector<HTMLElement>('.tvl-home-row-art');
  if (!appearance || !art) return;
  card.dataset.seasonalTheme = appearance.theme;
  card.dataset.seasonalReveal = appearance.reveal;
  card.dataset.seasonalCoverStyle = appearance.coverStyle || 'classic';
  card.dataset.seasonalFrameStyle = appearance.frameStyle || 'classic';
  if (appearance.frame) {
    art.dataset.seasonalFrame = appearance.theme;
    // Fit only the original poster inside the frame. Reveal layers and the
    // frame itself keep their full-size geometry, including in the preview.
    art.querySelector('img')?.classList.add('tvl-seasonal-poster');
  }
  if (appearance.reveal !== 'none') {
    const cover = el('span', 'tvl-seasonal-cover'); cover.setAttribute('aria-hidden', 'true');
    if (appearance.reveal === 'advent') {
      const flap = el('span', 'tvl-seasonal-advent-flap');
      flap.append(decoration('tvl-seasonal-advent-art', adventDoorArt(index + 1, appearance.coverStyle)),
        decoration('tvl-seasonal-advent-number', seasonalRankImage(index + 1, 'christmas', appearance.coverStyle)));
      cover.append(flap);
      const caption = card.querySelector<HTMLElement>('.tvl-home-row-caption');
      adventCards.set(card, { row, index, caption, title: caption?.textContent || '', label: card.getAttribute('aria-label') || '', getDate });
      card.dataset.adventDay = String(index + 1);
      refreshAdventCard(card);
      // Capture before the normal card action. aria-disabled deliberately does
      // not remove future doors from TV directional navigation.
      card.addEventListener('click', event => {
        if (!refreshAdventCard(card, card.classList.contains('tvl-seasonal-item-open'))) {
          event.preventDefault(); event.stopImmediatePropagation();
        }
      }, true);
    } else for (const side of ['left', 'right'] as const) {
      const panel = el('span', `tvl-seasonal-panel tvl-seasonal-panel-${side}`);
      if (appearance.reveal === 'doors' || appearance.reveal === 'shutters') {
        const photo = appearance.coverStyle === 'photoreal' || appearance.coverStyle === 'nightmare';
        const src = photo ? seasonalAssetUrl(`${appearance.theme === 'halloween' ? 'halloween-nightmare' : 'christmas-photoreal'}-door.webp`)
          : seasonalDoor(appearance.theme, side, appearance.coverStyle);
        panel.append(decoration(`tvl-seasonal-door-art${photo ? ' tvl-seasonal-full-door' : ''}`, src));
      }
      cover.append(panel);
    }
    if (appearance.theme === 'christmas' && appearance.reveal === 'doors') {
      cover.append(el('span', 'tvl-seasonal-door-number', String(index + 1)));
    }
    art.append(cover);
  }
  if (appearance.frame) {
    const photo = appearance.frameStyle === 'photoreal' || appearance.frameStyle === 'nightmare';
    const src = photo ? seasonalAssetUrl(`${appearance.theme === 'halloween' ? 'halloween-nightmare' : 'christmas-photoreal'}-frame.webp`)
      : seasonalFrame(appearance.theme, appearance.frameStyle);
    art.append(decoration('tvl-seasonal-frame', src));
  }
  if (appearance.reveal === 'shutters') {
    const window = el('span', 'tvl-seasonal-window'); window.setAttribute('aria-hidden','true'); art.append(window);
  }
  if (appearance.frame && (appearance.frameStyle === 'photoreal' || appearance.frameStyle === 'nightmare')) {
    // Photo frames have transparent exterior margins and shaped openings. Keep
    // the poster, fallback and every reveal layer inside that opening, while
    // the frame itself and the card's focus outline retain their full extent.
    art.dataset.seasonalFrameShape = appearance.theme;
    const aperture = el('span', 'tvl-seasonal-aperture');
    for (const child of Array.from(art.children)) {
      if (!child.classList.contains('tvl-seasonal-frame')) aperture.append(child);
    }
    art.prepend(aperture);
  }
}

/** Older webOS Chromium serializes custom-property numbers to six significant
 * digits. Comparing its CSS text with a full floating-point result can rewrite
 * the same style forever through Home's mutation observer. */
function seasonalPixels(section: HTMLElement, property: string, value: number): void {
  if (!Number.isFinite(value)) return;
  const next = Math.round(Math.max(0, value) * 100) / 100;
  const stored = section.style.getPropertyValue(property).trim();
  const current = /^\d+(?:\.\d+)?px$/.test(stored) ? parseFloat(stored) : NaN;
  // Keep subpixel sizing while accepting the legacy CSSOM's numeric precision.
  const tolerance = Math.max(.005, next * .000005);
  if (!Number.isFinite(current) || Math.abs(current - next) > tolerance) section.style.setProperty(property, `${next}px`);
}

/** Measure once mounted so expansion reveals a fixed scene instead of stretching it. */
export function refreshSeasonalBackdrop(section: HTMLElement): void {
  if (!section.classList.contains('tvl-seasonal-row') || !section.isConnected || seasonalRows.get(section)?.suspended) return;
  const onMount = pendingMounts.get(section);
  if (onMount) { pendingMounts.delete(section); onMount(); }
  const style = getComputedStyle(section);
  const base = Math.max(0, Math.round(section.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)));
  if (!Number.isFinite(base)) return;
  const fullscreen = section.dataset.seasonalExpansion === 'fullscreen';
  const preview = !!section.closest('.tvl-home-preview');
  const factor = section.dataset.seasonalExpansion === 'large' ? 1 : section.dataset.seasonalExpansion === 'medium' ? .5 : 0;
  const available = preview ? Math.min(520, window.innerHeight * .6) : window.innerHeight - seasonalHeaderClearance() - 16;
  const extra = fullscreen ? Math.max(0, available - base) : Math.max(0, Math.min(base * factor, window.innerHeight * .78 - base));
  const themed = section.querySelector<HTMLElement>('.tvl-seasonal-title-themed');
  const title = section.querySelector<HTMLElement>('.tvl-home-row-title');
  const titleSpace = fullscreen && themed && title ? Math.max(0, themed.offsetHeight - title.offsetHeight) + 12 : 0;
  const top = fullscreen ? Math.min(extra, Math.max(extra / 2, titleSpace)) : extra / 2;
  seasonalPixels(section, '--tvl-seasonal-art-height', Math.round(base + extra + 2 * parseFloat(getComputedStyle(document.documentElement).fontSize)));
  seasonalPixels(section, '--tvl-seasonal-space', extra / 2);
  if (fullscreen) {
    seasonalPixels(section, '--tvl-seasonal-space-top', top);
    seasonalPixels(section, '--tvl-seasonal-space-bottom', extra - top);
  }
}

/** All listeners belong to this row; there are no per-row document observers. */
export function decorateSeasonalRow(section: HTMLElement, cards: HTMLElement, row: HomeCollectionRow): () => void {
  const appearance = row.appearance;
  if (!appearance) return () => {};
  section.classList.add('tvl-seasonal-row');
  section.dataset.seasonalTheme = appearance.theme;
  section.dataset.seasonalBackground = appearance.background;
  section.dataset.seasonalExpansion = appearance.expansion;
  section.dataset.seasonalStyle = appearance.backgroundStyle || 'classic';
  const preview = () => !!section.closest('.tvl-home-preview');
  let hovered: HTMLElement | null = null, expanded = false, disposed = false, suspended = false;
  let backdrop: HTMLElement | undefined;
  let scenery: HTMLElement | undefined;
  let backdropObserver: IntersectionObserver | undefined;
  let backgroundLoaded = false;
  let themedTitle: HTMLElement | undefined;
  if (appearance.expansion === 'fullscreen') {
    const title = section.querySelector<HTMLElement>('.tvl-home-row-title');
    if (title) {
      const plain = el('span', 'tvl-seasonal-title-plain', title.textContent || '');
      themedTitle = el('span', 'tvl-seasonal-title-themed', title.textContent || '');
      themedTitle.setAttribute('aria-hidden', 'true');
      replace(title, plain, themedTitle);
    }
  }
  if (appearance.background !== 'none') {
    backdrop = el('div', 'tvl-seasonal-backdrop'); backdrop.setAttribute('aria-hidden', 'true');
    scenery = el('div', 'tvl-seasonal-scene'); backdrop.append(scenery);
    section.prepend(backdrop);
  }
  const loadBackground = () => {
    if (backgroundLoaded || disposed || suspended || !section.isConnected) return;
    backgroundLoaded = true;
    backdropObserver?.disconnect(); backdropObserver = undefined;
    // Keep the row and its expansion geometry ready from the first paint, but
    // only request/decode its scenery as navigation approaches the row.
    if (scenery) scenery.style.backgroundImage = `url("${seasonalBackground(appearance.theme, appearance.backgroundStyle)}")`;
    if (themedTitle) void applySeasonalTitleFont(themedTitle, appearance.theme, appearance.backgroundStyle).then(() => {
      if (!disposed && !suspended && section.isConnected) {
        refreshSeasonalBackdrop(section);
        if (expanded && !preview()) settleSeasonalSelection();
      }
    });
    if (appearance.background === 'parallax') onScroll();
  };
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scrollFrame = 0, focusFrame = 0, nativeEntryTimer = 0, nativeExitTimer = 0;
  const threeDimensional = appearance.reveal === 'doors' || appearance.reveal === 'shutters' || appearance.reveal === 'advent';
  const closing = new Map<HTMLElement, number>();
  const finishClosing = (card: HTMLElement) => {
    const timer = closing.get(card);
    if (timer !== undefined) window.clearTimeout(timer);
    closing.delete(card);
    if (!card.classList.contains('tvl-seasonal-item-open') && card.classList.contains('tvl-seasonal-reveal-active')) card.classList.remove('tvl-seasonal-reveal-active');
  };
  const updateReveal = (card: HTMLElement, open: boolean, wasOpen: boolean) => {
    if (threeDimensional && open) {
      const timer = closing.get(card);
      if (timer !== undefined) { window.clearTimeout(timer); closing.delete(card); }
      if (!card.classList.contains('tvl-seasonal-reveal-active')) card.classList.add('tvl-seasonal-reveal-active');
    }
    card.classList.toggle('tvl-seasonal-item-open', open);
    if (threeDimensional && !open && wasOpen) {
      if (reduced()) finishClosing(card);
      // transitionend normally releases the layer; the fallback also covers
      // interrupted transitions and clients that omit the event when hidden.
      else if (!closing.has(card)) closing.set(card, window.setTimeout(() => finishClosing(card), 500));
    }
  };
  const item = (target: EventTarget | null): HTMLElement | null => {
    const card = target instanceof Element ? target.closest<HTMLElement>('.tvl-home-row-card') : null;
    return card && cards.contains(card) ? card : null;
  };
  const onTransition = (event: TransitionEvent) => {
    if (disposed || suspended) return;
    if (event.propertyName === 'transform' && event.target instanceof Element
      && event.target.matches('.tvl-seasonal-panel,.tvl-seasonal-advent-flap')) {
      const card = item(event.target);
      if (card && !card.classList.contains('tvl-seasonal-item-open')) finishClosing(card);
    }
  };
  const openCards = new Set<HTMLElement>();
  const sync = (refreshDates = false) => {
    if (disposed || suspended) return;
    const focused = item(document.activeElement);
    // Remote focus can jump directly into a row before the observer delivers
    // its first callback. Mouse navigation and editor previews work likewise.
    if (focused || hovered) loadBackground();
    // A horizontal move only changes the old and new doors. Do not revisit
    // every poster or generate focus mutations on rows with no reveal effect.
    if (appearance.reveal !== 'none') {
      const next = new Set([focused, hovered].filter((card): card is HTMLElement => !!card));
      if (refreshDates && appearance.reveal === 'advent') cards.querySelectorAll<HTMLElement>('.tvl-home-row-card[data-seasonal-theme]').forEach(card => {
        if (!refreshAdventCard(card, next.has(card))) next.delete(card);
      });
      for (const card of openCards) if (!next.has(card)) {
        refreshAdventCard(card, false); updateReveal(card, false, true); openCards.delete(card);
      }
      for (const card of next) if (refreshAdventCard(card, true) && !openCards.has(card)) {
        updateReveal(card, true, false); openCards.add(card);
      }
    }
    const active = !!focused;
    section.classList.toggle('tvl-seasonal-focused', active);
    if (appearance.expansion === 'none' || active === expanded) return;
    if (active) refreshSeasonalBackdrop(section);
    expanded = active;
    changeSeasonalExpansion(section, active, () => refreshSeasonalBackdrop(section));
  };
  const onFocus = (event: FocusEvent) => {
    if (disposed || suspended) return;
    hovered = null; cancelAnimationFrame(focusFrame); sync();
    const previous = event.relatedTarget;
    if (preview() || previous instanceof Node && cards.contains(previous)) return;
    // Jellyfin's custom-scroller contract prevents new native animations, but
    // a preceding native card can still have its deferred 270ms scroll running.
    // Settle once after entry, including a quick hop through another custom
    // row. Within-row Left/Right never restarts this correction, and leaving
    // the row makes it a no-op.
    window.clearTimeout(nativeEntryTimer);
    nativeEntryTimer = window.setTimeout(() => {
      nativeEntryTimer = 0;
      if (!disposed && !suspended && section.isConnected && cards.contains(document.activeElement)) settleSeasonalSelection();
    }, 350);
  };
  const onBlur = (event: FocusEvent) => {
    if (disposed || suspended) return;
    hovered = null; cancelAnimationFrame(focusFrame); focusFrame = requestAnimationFrame(() => sync());
    const next = event.relatedTarget;
    if (preview() || !(next instanceof HTMLElement) || cards.contains(next) || next.closest('[data-scroll-mode-y="custom"]')) return;
    // Native centering can target a neighbour's temporary position while this
    // row closes. Correct visibility once both animations finish, only if that
    // exact control is still selected; newer native navigation stays in charge.
    window.clearTimeout(nativeExitTimer);
    nativeExitTimer = window.setTimeout(() => {
      nativeExitTimer = 0;
      if (!disposed && !suspended && section.isConnected && next.isConnected && document.activeElement === next
        && next.closest('#homeTab') === section.closest('#homeTab')) settleSeasonalSelection();
    }, 350);
  };
  const onPointer = (event: PointerEvent) => {
    // TV focus and touch activation must not leave a synthetic hover open.
    if (disposed || suspended || event.pointerType !== 'mouse') return;
    hovered = item(event.target); sync();
  };
  const onLeave = () => { if (!disposed && !suspended) { hovered = null; sync(); } };
  const onDateChange = () => sync(true);
  const updateParallax = () => {
    scrollFrame = 0;
    if (!scenery || !backgroundLoaded || disposed || suspended) return;
    const range = cards.scrollWidth - cards.clientWidth;
    const progress = range > 0 ? Math.max(0, Math.min(1, cards.scrollLeft / range)) : .5;
    // Use 13.5% of the row width for the full sweep, three times the old range.
    // translateX percentages refer to the existing 115%-wide scenery layer,
    // leaving 0.75% of the row as overlap at either edge. No larger texture or
    // per-item layer is needed, and the background stays clipped throughout.
    const offset = reduced() ? 0 : Math.round((.5 - progress) * (13.5 / 1.15) * 1000) / 1000;
    const transform = `translateX(${offset}%)`;
    if (scenery.style.transform !== transform) scenery.style.transform = transform;
  };
  const onScroll = () => { if (!disposed && !suspended && !scrollFrame) scrollFrame = requestAnimationFrame(updateParallax); };
  section.addEventListener('transitionend', onTransition);
  section.addEventListener(dateChangeEvent, onDateChange);
  cards.addEventListener('focusin', onFocus);
  cards.addEventListener('focusout', onBlur);
  cards.addEventListener('pointerover', onPointer);
  cards.addEventListener('pointerleave', onLeave);
  if (appearance.background === 'parallax') { cards.addEventListener('scroll', onScroll, { passive: true }); onScroll(); }
  const onResize = () => {
    if (disposed || suspended) return;
    cancelSeasonalMotion(); refreshSeasonalBackdrop(section); if (expanded && !preview()) settleSeasonalSelection();
  };
  // Home may abandon a prepared row before mounting it. Keep all external
  // subscriptions weak until it is actually mounted, including resize.
  const observe = () => {
    if (disposed || suspended || !section.isConnected) return;
    window.addEventListener('resize', onResize);
    if ((!backdrop && !themedTitle) || backgroundLoaded || backdropObserver) return;
    if (preview() || typeof IntersectionObserver !== 'function') loadBackground();
    else try {
      const observer = new IntersectionObserver(entries => {
        if (backdropObserver === observer && entries.some(entry => entry.isIntersecting || entry.intersectionRatio > 0)) loadBackground();
      }, { rootMargin: '300px 0px' });
      backdropObserver = observer; observer.observe(section);
    } catch {
      // Older TV clients must retain their artwork if observation is missing
      // or fails, rather than waiting forever for an unavailable callback.
      backdropObserver?.disconnect(); backdropObserver = undefined;
      loadBackground();
    }
  };
  const pause = () => {
    cancelAnimationFrame(scrollFrame); scrollFrame = 0;
    cancelAnimationFrame(focusFrame); focusFrame = 0;
    window.clearTimeout(nativeEntryTimer); nativeEntryTimer = 0;
    window.clearTimeout(nativeExitTimer); nativeExitTimer = 0;
    cancelSeasonalMotion();
    backdropObserver?.disconnect(); backdropObserver = undefined;
    window.removeEventListener('resize', onResize);
    for (const card of closing.keys()) finishClosing(card);
  };
  const controller: SeasonalRowController = {
    suspended: false,
    suspend() {
      if (disposed || suspended) return;
      suspended = controller.suspended = true;
      hovered = null;
      pause();
    },
    resume() {
      if (disposed || !suspended) return;
      suspended = controller.suspended = false;
      if (!section.isConnected) { pendingMounts.set(section, observe); return; }
      observe();
      refreshSeasonalBackdrop(section);
      sync(true);
      if (appearance.background === 'parallax') onScroll();
      if (expanded && !preview() && cards.contains(document.activeElement)) settleSeasonalSelection();
    }
  };
  seasonalRows.set(section, controller);
  pendingMounts.set(section, observe);
  refreshSeasonalBackdrop(section);
  sync();
  return () => {
    disposed = true; pause();
    seasonalRows.delete(section);
    pendingMounts.delete(section);
    cards.querySelectorAll('.tvl-seasonal-reveal-active').forEach(card => card.classList.remove('tvl-seasonal-reveal-active'));
    section.removeEventListener('transitionend', onTransition);
    section.removeEventListener(dateChangeEvent, onDateChange);
    cards.removeEventListener('focusin', onFocus); cards.removeEventListener('focusout', onBlur);
    cards.removeEventListener('pointerover', onPointer); cards.removeEventListener('pointerleave', onLeave);
    cards.removeEventListener('scroll', onScroll);
  };
}
