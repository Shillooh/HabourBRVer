import { defaultLoadingScreen, parseLoadingScreen, loadingScreenKey, maxLoadingSettingsBytes, type LoadingScreenSettings } from './loading-settings';
import type { MediaApi } from './types';

export type LoadingScreenSnapshot = {
  Revision: string | null;
  Settings: LoadingScreenSettings | null;
  HasUserOverride?: boolean;
  GlobalRevision?: string | null;
};
export type LoadingScreenTransport = {
  isCurrent(): boolean;
  load(): Promise<LoadingScreenSnapshot>;
  save(settings: LoadingScreenSettings, revision: string | null): Promise<LoadingScreenSnapshot>;
  resetUserOverride?(): Promise<LoadingScreenSnapshot>;
  resetAllUsers?(): Promise<void>;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type LoadingScreenListener = (store: LoadingScreenStore, settings: LoadingScreenSettings) => void;
const listeners = new Set<LoadingScreenListener>();
/** Only confirmed reads/saves are published; editor drafts stay private. */
export function subscribeLoadingScreen(listener: LoadingScreenListener): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
function changed(store: LoadingScreenStore): void {
  for (const listener of listeners) { try { listener(store, store.cached); } catch { /* A view cannot fail a confirmed save. */ } }
}
type Client = {
  getUrl(path: string): string;
  getJSON(url: string): Promise<unknown>;
  ajax(options: { type: 'PUT' | 'POST' | 'DELETE'; url: string; data?: string; contentType?: 'application/json'; dataType?: 'json' }): Promise<unknown>;
};
export class LoadingScreenSyncError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable' | 'stale' | 'invalid', message: string) { super(message); }
}
const stale = () => new LoadingScreenSyncError('stale', 'Your Jellyfin account changed. Reopen loading screen for the current account.');
export function boundedLoadingScreen(value: unknown): LoadingScreenSettings {
  try { return parseLoadingScreen(value); }
  catch { throw new LoadingScreenSyncError('invalid', 'Jellyfin returned invalid loading-screen settings. Try again.'); }
}
export function loadingScreenSnapshot(value: unknown): LoadingScreenSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LoadingScreenSyncError('invalid', 'Jellyfin returned invalid loading-screen settings. Try again.');
  const val = value as Record<string, unknown>;
  const hasPascal = 'Revision' in val && 'Settings' in val;
  const hasCamel = 'revision' in val && 'settings' in val;
  if (!hasPascal && !hasCamel)
    throw new LoadingScreenSyncError('invalid', 'Jellyfin returned invalid loading-screen settings. Try again.');
  const allowedKeys = new Set(['Revision', 'Settings', 'revision', 'settings', 'HasUserOverride', 'hasUserOverride', 'GlobalRevision', 'globalRevision']);
  for (const k of Object.keys(val)) {
    if (!allowedKeys.has(k)) throw new LoadingScreenSyncError('invalid', 'Jellyfin returned invalid loading-screen settings. Try again.');
  }
  const revision = (hasPascal ? val.Revision : val.revision) as string | null;
  const settings = hasPascal ? val.Settings : val.settings;
  const hasUserOverride = val.HasUserOverride !== undefined ? Boolean(val.HasUserOverride) : val.hasUserOverride !== undefined ? Boolean(val.hasUserOverride) : undefined;
  const globalRevision = ((hasPascal ? val.GlobalRevision : val.globalRevision) as string | null) ?? null;
  if (revision === null && settings === null) {
    const res: LoadingScreenSnapshot = { Revision: null, Settings: null };
    if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
    if (globalRevision !== null) res.GlobalRevision = globalRevision;
    return res;
  }
  if (typeof revision !== 'string' || !revision || revision.length > 100)
    throw new LoadingScreenSyncError('invalid', 'Jellyfin returned invalid loading-screen settings. Try again.');
  const res: LoadingScreenSnapshot = { Revision: revision, Settings: boundedLoadingScreen(settings) };
  if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
  if (globalRevision !== null) res.GlobalRevision = globalRevision;
  return res;
}

/** Authentication belongs to Jellyfin's native client. The authenticated server
 * session chooses the owner; there is no user-id parameter to impersonate. */
export function createLoadingScreenTransport(client: Client, isCurrent: () => boolean, scope: 'user' | 'global' = 'user', targetUserId?: string): LoadingScreenTransport {
  const current = () => { if (!isCurrent()) throw stale(); };
  const basePath = targetUserId
    ? `TvItemLayout/LoadingScreen/User/${encodeURIComponent(targetUserId)}`
    : (scope === 'global' ? 'TvItemLayout/LoadingScreen/Global' : 'TvItemLayout/LoadingScreen');
  const request = async (operation: () => Promise<unknown>) => {
    current();
    try { const result = await operation(); current(); return loadingScreenSnapshot(result); }
    catch (error) {
      current();
      if (error instanceof LoadingScreenSyncError) throw error;
      const response = error as { status?: number; statusCode?: number; response?: { status?: number } } | null;
      const status = response?.status || response?.statusCode || response?.response?.status;
      if (status === 409) throw new LoadingScreenSyncError('conflict', 'Loading screen changed on another device. Your draft is still here. Reload saved settings before saving again.');
      if (status === 401 || status === 403) throw new LoadingScreenSyncError('unavailable', 'Sign in again to sync loading screen. Your changes have not been saved.');
      if (status === 404) throw new LoadingScreenSyncError('unavailable', 'Update ScreenHarbour on the server to sync loading screen. Your changes have not been saved.');
      if (status === 413) throw new LoadingScreenSyncError('invalid', 'These loading-screen settings are too large to sync. Your changes have not been saved.');
      throw new LoadingScreenSyncError('unavailable', 'Loading screen could not sync with Jellyfin. Check your connection and try again. Your changes have not been saved.');
    }
  };
  return {
    isCurrent,
    load: () => request(() => client.getJSON(client.getUrl(basePath))),
    save: (settings, revision) => request(() => client.ajax({ type: 'PUT', url: client.getUrl(basePath),
      data: JSON.stringify({ Revision: revision, Settings: boundedLoadingScreen(settings) }), contentType: 'application/json', dataType: 'json' })),
    resetUserOverride: () => request(() => client.ajax({
      type: 'DELETE',
      url: client.getUrl(targetUserId ? `TvItemLayout/LoadingScreen/User/${encodeURIComponent(targetUserId)}` : 'TvItemLayout/LoadingScreen/User'),
      contentType: 'application/json', dataType: 'json'
    })),
    resetAllUsers: () => client.ajax({ type: 'POST', url: client.getUrl('TvItemLayout/LoadingScreen/ResetAllUsers') }).then(() => {})
  };
}

export function createLoadingScreenStore(api: MediaApi & { loadingScreen?: LoadingScreenTransport }, scope: 'user' | 'global' = 'user', targetUserId?: string): LoadingScreenStore {
  const user = targetUserId ? `target_${targetUserId}` : (scope === 'global' ? '_global' : (api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous')));
  const client = (window as unknown as { ApiClient?: Client }).ApiClient;
  const transport = ((scope === 'global' || targetUserId) && client)
    ? createLoadingScreenTransport(client, () => true, scope, targetUserId)
    : api.loadingScreen;
  return new LoadingScreenStore(loadingScreenKey(api.serverId || location.origin, user),
    { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, transport);
}

/** Local storage is an account-scoped offline cache. A new server snapshot
 * chooses defaults without saving them, including when an older cache exists. */
export class LoadingScreenStore {
  private revision: string | null | undefined;
  private value: LoadingScreenSettings;
  private disposed = false;
  private generation = 0;
  private writing = false;
  hasUserOverride = false;
  globalRevision: string | null = null;
  readonly synced: boolean;

  constructor(readonly key: string, private storage: StorageLike, private transport?: LoadingScreenTransport) {
    this.synced = !!transport; this.value = this.readLocal();
  }
  allowSave(): void {
    if (this.revision === undefined) this.revision = null;
  }
  get cached(): LoadingScreenSettings { return boundedLoadingScreen(this.value); }
  private cachedText(): string | null | undefined {
    try { return this.storage.getItem(this.key); } catch { return undefined; }
  }
  private readLocal(): LoadingScreenSettings {
    try {
      const raw = this.storage.getItem(this.key);
      return raw && raw.length <= maxLoadingSettingsBytes ? boundedLoadingScreen(JSON.parse(raw)) : defaultLoadingScreen();
    } catch { return defaultLoadingScreen(); }
  }
  private current(generation: number): void {
    if (this.disposed || generation !== this.generation || this.transport && !this.transport.isCurrent()) throw stale();
  }
  private remember(snapshot: LoadingScreenSnapshot): LoadingScreenSettings {
    this.revision = snapshot.Revision;
    this.hasUserOverride = snapshot.HasUserOverride ?? true;
    this.globalRevision = snapshot.GlobalRevision ?? null;
    const settings = snapshot.Settings || defaultLoadingScreen();
    if (settings.brandText === 'KiKoTV') settings.brandText = 'HabourBR';
    this.value = settings;
    // The server read or save already succeeded even when device storage is full.
    try {
      this.storage.setItem(this.key, JSON.stringify(this.value));
      if (this.globalRevision) this.storage.setItem(`${this.key}:globalRevision`, this.globalRevision);
    } catch { /* Server remains authoritative. */ }
    changed(this);
    return this.cached;
  }
  async load(): Promise<LoadingScreenSettings> {
    if (this.writing) throw new LoadingScreenSyncError('unavailable', 'Loading screen are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    // A failed reload must not leave an old revision eligible for a later save.
    this.revision = undefined;
    if (!this.transport) { this.value = this.readLocal(); this.revision = null; changed(this); return this.cached; }
    const before = this.cachedText();
    const response = await this.transport.load(); this.current(generation);
    const snapshot = loadingScreenSnapshot(response), after = this.cachedText();
    // Another store/tab may have confirmed a newer choice while this GET was
    // pending. Reject a differing late result before it can overwrite the cache
    // or notify any interface branding subscribers. Identical reads may coexist.
    if (before !== undefined && after !== undefined && after !== before
      && after !== JSON.stringify(snapshot.Settings || defaultLoadingScreen()))
      throw new LoadingScreenSyncError('conflict', 'Loading screen changed while loading. Reload saved settings.');
    return this.remember(snapshot);
  }
  async save(value: LoadingScreenSettings): Promise<LoadingScreenSettings> {
    if (this.writing) throw new LoadingScreenSyncError('unavailable', 'Loading screen are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (this.revision === undefined) throw new LoadingScreenSyncError('unavailable', 'Load the saved loading-screen settings before saving changes.');
    const settings = boundedLoadingScreen(value);
    if (!this.transport) {
      try { this.storage.setItem(this.key, JSON.stringify(settings)); }
      catch { throw new LoadingScreenSyncError('unavailable', 'These settings could not be saved on this device. Check browser storage and try again.'); }
      this.value = settings; changed(this); return this.cached;
    }
    this.writing = true;
    try {
      const response = await this.transport.save(settings, this.revision); this.current(generation);
      const snapshot = loadingScreenSnapshot(response);
      if (!snapshot.Settings) throw new LoadingScreenSyncError('invalid', 'Jellyfin did not confirm the saved loading-screen settings. Try again.');
      return this.remember(snapshot);
    } catch (error) {
      this.current(generation);
      if (error instanceof LoadingScreenSyncError && error.kind === 'conflict') this.revision = undefined;
      throw error;
    } finally { this.writing = false; }
  }
  async resetUserOverride(): Promise<LoadingScreenSettings> {
    if (this.writing) throw new LoadingScreenSyncError('unavailable', 'Loading screen are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (!this.transport?.resetUserOverride) throw new LoadingScreenSyncError('unavailable', 'Reset is not supported on this connection.');
    this.writing = true;
    try {
      const snapshot = await this.transport.resetUserOverride(); this.current(generation);
      return this.remember(loadingScreenSnapshot(snapshot));
    } finally { this.writing = false; }
  }
  async resetAllUsers(): Promise<void> {
    if (!this.transport?.resetAllUsers) throw new LoadingScreenSyncError('unavailable', 'Reset is not supported on this connection.');
    await this.transport.resetAllUsers();
  }
  destroy(): void { this.disposed = true; this.generation++; }
}
