import type { Item, MediaApi } from './types';
import { isCinemaLayout } from './layout';
import { isIntro, sameMediaId, type ActivePlayback } from './player-context';
import { el, replace } from './dom';
import { episodeCode, plainText, runtime, time } from './utils';

type Options = {
  getApi: () => MediaApi | null;
  getPlayback: () => ActivePlayback | null;
  subscribe?: (listener: () => void) => () => void;
};
type PauseDetails = { item: Item; subject: Item; channel?: Item; title: string; logos: string[]; discs: string[]; retryTrailerOwner?: boolean };
const accountScope = (api: MediaApi | null): string => JSON.stringify([api?.serverId || '', api?.userId || '']);
const playbackKey = (snapshot: ActivePlayback, api: MediaApi | null): string => JSON.stringify([
  accountScope(api), snapshot.key, snapshot.playingItemId, snapshot.playlistItemId || ''
]);

function visible(node: Element): boolean {
  if (!(node instanceof HTMLElement) || node.hidden || node.closest('.hide, [hidden]') || !node.getClientRects().length) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Independently implemented from the feature description in
 * https://github.com/jampez77/Jellyfin-PauseScreen (dbad66b).
 * Metadata stays with the playing item, except a trailer with a
 * server-confirmed advertised movie. Episode parents only supply artwork.
 */
export function startPauseScreen(options: Options): () => void {
  const overlay = el('section', 'tvl-pause-screen');
  overlay.id = 'tvl-pause-screen'; overlay.hidden = true;
  overlay.setAttribute('role', 'region');
  overlay.setAttribute('aria-label', 'Detalhes da mídia pausada');
  let host: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;
  let key = '';
  let details: PauseDetails | null = null;
  let pending = false;
  let generation = 0;
  let lastAttempt = 0;
  let disposed = false;
  let frame: number | undefined;

  function paused(snapshot: ActivePlayback | null): snapshot is ActivePlayback {
    const nativeItemId = snapshot?.osd.querySelector<HTMLElement>('.btnUserRating[data-id]')?.dataset.id;
    return !!snapshot && isCinemaLayout() && snapshot.video.isConnected && snapshot.osd.isConnected
      && (!nativeItemId || sameMediaId(nativeItemId, snapshot.playingItemId || snapshot.itemId))
      && visible(snapshot.osd) && snapshot.video.paused && !snapshot.video.ended && !snapshot.video.error
      && snapshot.video.readyState >= 2 && snapshot.video.videoWidth > 0 && snapshot.video.videoHeight > 0;
  }

  function blocked(): boolean {
    // The standalone PauseScreen owns this marker even while it is hidden.
    // Respect its installation rather than displaying two pause treatments.
    if (document.getElementById('video-overlay') || document.body.hasAttribute('data-tvl-player-browser-open')) return true;
    return Array.from(document.querySelectorAll<HTMLElement>(
      '#tvl-player-browser, .dialogContainer .dialog.opened, dialog[open], [role="dialog"][aria-modal="true"], #videoOsdPage .upNextContainer'
    )).some(node => node !== overlay && visible(node));
  }

  function hide(): void {
    overlay.hidden = true;
    if (host?.classList.contains('tvl-pause-host')) host.classList.remove('tvl-pause-host');
  }

  function reset(): void {
    hide();
    generation++; pending = false; details = null; key = ''; video = null; lastAttempt = 0;
  }

  function show(snapshot: ActivePlayback): void {
    if (!details || !paused(snapshot) || blocked()) { hide(); return; }
    if (host !== snapshot.osd) {
      host?.classList.remove('tvl-pause-host');
      host = snapshot.osd;
      host.append(overlay);
    }
    if (!host.classList.contains('tvl-pause-host')) host.classList.add('tvl-pause-host');
    overlay.hidden = false;
    const synopsis = overlay.querySelector<HTMLElement>('.tvl-pause-synopsis');
    if (synopsis) {
      // Trailer controls reserve the lower portion of the screen. Only fade
      // text that was actually clipped; short descriptions remain fully clear.
      const clipped = host.classList.contains('tvl-trailer-overlay') && synopsis.scrollHeight > synopsis.clientHeight + 1;
      if (synopsis.classList.contains('tvl-pause-synopsis-clipped') !== clipped) {
        synopsis.classList.toggle('tvl-pause-synopsis-clipped', clipped);
      }
    }
  }

  function artwork(urls: string[], className: string, label: string, onReady?: () => void, onMissing?: () => void): HTMLImageElement | null {
    if (!urls.length) return null;
    const image = el('img', className);
    image.alt = label; image.hidden = true;
    let index = 0;
    image.addEventListener('load', () => { image.hidden = false; onReady?.(); });
    image.addEventListener('error', () => {
      image.hidden = true;
      if (++index < urls.length) image.src = urls[index];
      else { image.remove(); onMissing?.(); }
    });
    image.src = urls[0];
    return image;
  }

  function render(model: PauseDetails): void {
    const copy = el('div', 'tvl-pause-copy');
    if (model.channel) copy.append(el('div', 'tvl-pause-channel', model.channel.Name));
    const title = el('h1', 'tvl-pause-title', model.title);
    const titleBlock = el('div', 'tvl-pause-title-block');
    const logo = artwork(model.logos, `tvl-pause-logo${model.channel ? ' tvl-pause-channel-logo' : ''}`, model.channel?.Name || model.title,
      () => { if (!model.channel) title.hidden = true; }, () => { title.hidden = false; });
    if (logo && model.channel) titleBlock.append(logo);
    titleBlock.append(title); if (logo && !model.channel) titleBlock.append(logo);
    copy.append(titleBlock);
    const subject = model.subject;
    if (subject.Type === 'Episode') {
      copy.append(el('h2', 'tvl-pause-episode', [episodeCode(subject), subject.Name].filter(Boolean).join('  ·  ')));
    }
    const meta = el('div', 'tvl-pause-meta');
    const values = [subject.ProductionYear ? String(subject.ProductionYear) : '', subject.OfficialRating || '', model.channel ? '' : runtime(subject.RunTimeTicks)];
    if (model.channel && subject.StartDate && subject.EndDate) values.push(`${time(subject.StartDate)} – ${time(subject.EndDate)}`);
    for (const value of values.filter(Boolean)) meta.append(el('span', '', value));
    if (meta.childElementCount) copy.append(meta);
    const tagline = plainText(subject.Taglines?.[0]);
    if (tagline) copy.append(el('p', 'tvl-pause-tagline', tagline));
    const synopsis = plainText(subject.Overview);
    if (synopsis) copy.append(el('p', 'tvl-pause-synopsis', synopsis));
    replace(overlay, copy);
    const disc = artwork(model.discs, 'tvl-pause-disc', '', undefined, () => overlay.classList.remove('tvl-pause-has-disc'));
    overlay.classList.toggle('tvl-pause-has-disc', !!disc);
    if (disc) { disc.setAttribute('aria-hidden', 'true'); overlay.append(disc); }
  }

  async function readDetails(snapshot: ActivePlayback, api: MediaApi, current: () => boolean): Promise<PauseDetails | null> {
    // The queued feature is not the film being advertised. Resolve a trailer's
    // actual owner through an authenticated mapping independent of cinema actions.
    const playingId = snapshot.playingItemId || snapshot.itemId;
    let item: Item | null = snapshot.item?.Id === playingId ? snapshot.item : null;
    try { item = await api.getItem(playingId); } catch { /* The native snapshot can still provide the current title. */ }
    if (!current() || !item?.Id || !sameMediaId(item.Id, playingId) || !item.Name) return null;
    let retryTrailerOwner = false;
    const getTrailerDetails = api.getTrailerDetails || api.getTrailerActions;
    if (isIntro(item) && getTrailerDetails) {
      retryTrailerOwner = true;
      try {
        const trailer = await getTrailerDetails({ PlayingItemId: playingId, PlaylistItemId: snapshot.playlistItemId });
        if (!current()) return null;
        if (trailer?.Movie?.Id && sameMediaId(trailer.PlayingItemId, playingId)
          && (trailer.PlaylistItemId || '') === (snapshot.playlistItemId || '')) {
          const advertised = await api.getItem(trailer.Movie.Id);
          if (!current()) return null;
          if (advertised.Type === 'Movie' && sameMediaId(advertised.Id, trailer.Movie.Id) && advertised.Name) {
            item = advertised; retryTrailerOwner = false;
          }
        }
      } catch { /* Keep the trailer's own metadata and retry a late queue report. */ }
    }
    if (!current()) return null;
    if (item.Type === 'Audio' || item.Type === 'MusicAlbum' || item.Type === 'MusicArtist') return null;
    let channel: Item | undefined = item.Type === 'TvChannel' ? item : undefined;
    if (item.Type === 'Program' && item.ChannelId) {
      try { channel = await api.getItem(item.ChannelId); } catch { /* Keep the playing programme's own metadata. */ }
    }
    const subject = item.Type === 'TvChannel' ? item.CurrentProgram || item : item;
    const logos: string[] = [], discs: string[] = [];
    const add = (target: string[], value: string | null) => { if (value && !target.includes(value)) target.push(value); };
    if (channel) {
      add(logos, api.image(channel, 'logo'));
      add(logos, api.image(channel, 'thumb'));
      return { item, subject, channel, title: subject.Name, logos, discs };
    }
    const parents: Item[] = [];
    if (item.Type === 'Episode') {
      const ids = [item.SeasonId, item.SeriesId].filter((id, index, all): id is string => !!id && id !== item!.Id && all.indexOf(id) === index);
      const results = await Promise.allSettled(ids.map(id => api.getItem(id)));
      for (const result of results) if (result.status === 'fulfilled') parents.push(result.value);
    }
    for (const source of [item, ...parents]) {
      // ParentLogo fields may point straight to the series; explicit own-image
      // tags preserve the documented item -> season -> series fallback order.
      if (source.ImageTags?.Logo) add(logos, api.image(source, 'logo'));
      if (source.ImageTags?.Disc) add(discs, api.image(source, 'disc'));
    }
    const series = parents.find(parent => parent.Id === item!.SeriesId);
    const title = item.Type === 'Episode' ? item.SeriesName || series?.Name || item.Name : item.Name;
    return { item, subject, title, logos, discs, retryTrailerOwner };
  }

  function sync(): void {
    frame = undefined;
    if (disposed) return;
    const snapshot = options.getPlayback();
    if (!paused(snapshot)) { reset(); return; }
    const api = options.getApi();
    if (!api) { reset(); return; }
    const snapshotKey = playbackKey(snapshot, api);
    if (key !== snapshotKey || video !== snapshot.video) {
      reset(); key = snapshotKey; video = snapshot.video;
    }
    if (blocked()) { hide(); return; }
    show(snapshot);
    const refreshAfter = details?.retryTrailerOwner ? 5_000 : details?.channel ? 60_000 : details ? Infinity : 10_000;
    if (pending || (lastAttempt && Date.now() - lastAttempt < refreshAfter)) return;
    pending = true; lastAttempt = Date.now();
    const revision = ++generation;
    const source = snapshot.video.currentSrc || snapshot.video.src, sourceObject = snapshot.video.srcObject;
    const isCurrent = () => {
      const current = options.getPlayback();
      return !disposed && revision === generation && paused(current)
        && playbackKey(current, options.getApi()) === snapshotKey && current.video === snapshot.video
        && (current.video.currentSrc || current.video.src) === source && current.video.srcObject === sourceObject;
    };
    void readDetails(snapshot, api, isCurrent).then(model => {
      if (disposed || revision !== generation) return;
      pending = false;
      if (!isCurrent()) { reset(); return; }
      const current = options.getPlayback();
      if (!paused(current) || playbackKey(current, options.getApi()) !== key || current.video !== video) { reset(); return; }
      details = model;
      if (model) render(model);
      show(current);
    }).catch(() => {
      if (disposed || revision !== generation) return;
      pending = false; hide();
    });
  }

  function schedule(): void {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(sync);
  }
  const mediaEvents = ['pause', 'play', 'playing', 'ended', 'emptied', 'error', 'loadeddata', 'loadstart'];
  const onMedia = (event: Event) => {
    if (event.target === video && ['play', 'playing', 'ended', 'emptied', 'error', 'loadstart'].includes(event.type)) reset();
    schedule();
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target !== overlay && !overlay.contains(record.target))) schedule();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'open', 'style', 'data-tvl-player-browser-open'] });
  for (const event of mediaEvents) document.addEventListener(event, onMedia, true);
  const unsubscribe = options.subscribe?.(schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('resize', schedule);
  document.addEventListener('viewbeforehide', schedule, true);
  const interval = window.setInterval(schedule, 1000);
  schedule();
  return () => {
    disposed = true; generation++;
    if (frame !== undefined) cancelAnimationFrame(frame);
    clearInterval(interval); observer.disconnect(); unsubscribe?.();
    for (const event of mediaEvents) document.removeEventListener(event, onMedia, true);
    window.removeEventListener('hashchange', schedule); window.removeEventListener('popstate', schedule);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('viewbeforehide', schedule, true);
    hide(); overlay.remove();
  };
}
