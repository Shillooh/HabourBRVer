import type { Item } from './types';

export const TICKS_PER_MINUTE = 600_000_000;
export function runtime(ticks?: number): string {
  const minutes = Math.round((ticks || 0) / TICKS_PER_MINUTE);
  if (minutes < 1) return '';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}
export function resumePosition(item: Item): number {
  const position = item.UserData?.PlaybackPositionTicks;
  return position != null && Number.isFinite(position) ? Math.max(0, position) : 0;
}
export function isWatched(item: Item): boolean {
  return !!item.UserData?.Played && (!['Movie', 'Episode'].includes(item.Type || '') || resumePosition(item) === 0);
}
export function progress(item: Item): number {
  const position = resumePosition(item);
  // Jellyfin retains the watched flag during a rewatch. Its current position
  // takes priority over that earlier completion and any stale percentage.
  if (position && item.RunTimeTicks && Number.isFinite(item.RunTimeTicks) && item.RunTimeTicks > 0) {
    return Math.min(100, position / item.RunTimeTicks * 100);
  }
  if (!position && item.UserData?.Played) return 100;
  const percentage = item.UserData?.PlayedPercentage;
  return percentage != null && Number.isFinite(percentage) ? Math.min(100, Math.max(0, percentage)) : 0;
}
export function playbackEnd(item: Item, now = Date.now()): Date | null {
  const duration = item.RunTimeTicks;
  if (!['Movie', 'Episode'].includes(item.Type || '') || !playable(item)
    || duration == null || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(now)) return null;
  const resume = Math.min(duration, resumePosition(item));
  const end = new Date(now + (duration - resume) / 10_000);
  return Number.isFinite(end.getTime()) ? end : null;
}
export function seasonName(item: Item): string {
  if (item.IndexNumber === 0) return 'Especiais';
  const fallback = item.IndexNumber == null ? 'Episódios' : `Temporada ${item.IndexNumber}`;
  return !item.Name || /^(season|series|chapter|temporada)\s*\d+$/i.test(item.Name.trim()) ? fallback : item.Name;
}
export function episodeCode(item: Item): string {
  return [item.ParentIndexNumber != null ? `S${item.ParentIndexNumber}` : '', item.IndexNumber != null ? `E${item.IndexNumber}` : ''].filter(Boolean).join(' · ');
}
export function time(date?: string): string {
  if (!date || !Number.isFinite(Date.parse(date))) return '';
  return new Date(date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
export function programmeProgress(item: Item, now = Date.now()): number {
  const start = Date.parse(item.StartDate || '');
  const end = Date.parse(item.EndDate || '');
  return end > start ? Math.max(0, Math.min(100, (now - start) / (end - start) * 100)) : 0;
}
export function isLive(item: Item, now = Date.now()): boolean {
  return Date.parse(item.StartDate || '') <= now && Date.parse(item.EndDate || '') > now;
}
export function playable(item: Item): boolean {
  return !!item.Id && item.PlayAccess !== 'None' && !item.IsMissing && !item.IsVirtualItem && !item.IsPlaceHolder && item.LocationType !== 'Virtual';
}
export function plainText(value?: string): string {
  if (!value) return '';
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return doc.body.textContent || '';
}
