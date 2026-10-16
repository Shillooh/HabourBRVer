import { defaultProviderHomes, parseProviderHomes, providerHomesKey, maxProviderSettingsBytes, type ProviderHomesSettings } from './provider-settings';
import type { MediaApi } from './types';

export type ProviderHomesSnapshot = {
  Revision: string | null;
  Settings: ProviderHomesSettings | null;
  HasUserOverride?: boolean;
  GlobalRevision?: string | null;
};
export type ProviderHomesTransport = {
  isCurrent(): boolean;
  load(): Promise<ProviderHomesSnapshot>;
  save(settings: ProviderHomesSettings, revision: string | null): Promise<ProviderHomesSnapshot>;
  resetUserOverride?(): Promise<ProviderHomesSnapshot>;
  resetAllUsers?(): Promise<void>;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Client = {
  getUrl(path: string): string;
  getJSON(url: string): Promise<unknown>;
  ajax(options: { type: 'PUT' | 'POST' | 'DELETE'; url: string; data?: string; contentType?: 'application/json'; dataType?: 'json' }): Promise<unknown>;
};
export class ProviderHomesSyncError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable' | 'stale' | 'invalid', message: string) { super(message); }
}
const stale = () => new ProviderHomesSyncError('stale', 'Your Jellyfin account changed. Reopen streaming services for the current account.');
export function boundedProviderHomes(value: unknown): ProviderHomesSettings {
  try { return parseProviderHomes(value); }
  catch { throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.'); }
}
export function providerHomesSnapshot(value: unknown): ProviderHomesSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  const val = value as Record<string, unknown>;
  const hasPascal = 'Revision' in val && 'Settings' in val;
  const hasCamel = 'revision' in val && 'settings' in val;
  if (!hasPascal && !hasCamel)
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  const allowedKeys = new Set(['Revision', 'Settings', 'revision', 'settings', 'HasUserOverride', 'hasUserOverride', 'GlobalRevision', 'globalRevision']);
  for (const k of Object.keys(val)) {
    if (!allowedKeys.has(k)) throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  }
  const revision = (hasPascal ? val.Revision : val.revision) as string | null;
  const settings = hasPascal ? val.Settings : val.settings;
  const hasUserOverride = val.HasUserOverride !== undefined ? Boolean(val.HasUserOverride) : val.hasUserOverride !== undefined ? Boolean(val.hasUserOverride) : undefined;
  const globalRevision = ((hasPascal ? val.GlobalRevision : val.globalRevision) as string | null) ?? null;
  if (revision === null && settings === null) {
    const res: ProviderHomesSnapshot = { Revision: null, Settings: null };
    if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
    if (globalRevision !== null) res.GlobalRevision = globalRevision;
    return res;
  }
  if (typeof revision !== 'string' || !revision || revision.length > 100)
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  const res: ProviderHomesSnapshot = { Revision: revision, Settings: boundedProviderHomes(settings) };
  if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
  if (globalRevision !== null) res.GlobalRevision = globalRevision;
  return res;
}

/** Authentication belongs to Jellyfin's native client. The authenticated server
 * session chooses the owner; there is no user-id parameter to impersonate. */
export function createProviderHomesTransport(client: Client, isCurrent: () => boolean, scope: 'user' | 'global' = 'user', targetUserId?: string): ProviderHomesTransport {
  const current = () => { if (!isCurrent()) throw stale(); };
  const basePath = targetUserId
    ? `TvItemLayout/ProviderHomes/User/${encodeURIComponent(targetUserId)}`
    : (scope === 'global' ? 'TvItemLayout/ProviderHomes/Global' : 'TvItemLayout/ProviderHomes');
  const request = async (operation: () => Promise<unknown>) => {
    current();
    try { const result = await operation(); current(); return providerHomesSnapshot(result); }
    catch (error) {
      current();
      if (error instanceof ProviderHomesSyncError) throw error;
      const response = error as { status?: number; statusCode?: number; response?: { status?: number } } | null;
      const status = response?.status || response?.statusCode || response?.response?.status;
      if (status === 409) throw new ProviderHomesSyncError('conflict', 'Streaming services changed on another device. Your draft is still here. Reload saved settings before saving again.');
      if (status === 401 || status === 403) throw new ProviderHomesSyncError('unavailable', 'Sign in again to sync streaming services. Your changes have not been saved.');
      if (status === 404) throw new ProviderHomesSyncError('unavailable', 'Update ScreenHarbour on the server to sync streaming services. Your changes have not been saved.');
      if (status === 413) throw new ProviderHomesSyncError('invalid', 'These streaming-service settings are too large to sync. Your changes have not been saved.');
      throw new ProviderHomesSyncError('unavailable', 'Streaming services could not sync with Jellyfin. Check your connection and try again. Your changes have not been saved.');
    }
  };
  return {
    isCurrent,
    load: () => request(() => client.getJSON(client.getUrl(basePath))),
    save: (settings, revision) => request(() => client.ajax({ type: 'PUT', url: client.getUrl(basePath),
      data: JSON.stringify({ Revision: revision, Settings: boundedProviderHomes(settings) }), contentType: 'application/json', dataType: 'json' })),
    resetUserOverride: () => request(() => client.ajax({
      type: 'DELETE',
      url: client.getUrl(targetUserId ? `TvItemLayout/ProviderHomes/User/${encodeURIComponent(targetUserId)}` : 'TvItemLayout/ProviderHomes/User'),
      contentType: 'application/json', dataType: 'json'
    })),
    resetAllUsers: () => client.ajax({ type: 'POST', url: client.getUrl('TvItemLayout/ProviderHomes/ResetAllUsers') }).then(() => {})
  };
}

export function createProviderHomesStore(api: MediaApi & { providerHomes?: ProviderHomesTransport }, scope: 'user' | 'global' = 'user', targetUserId?: string): ProviderHomesStore {
  const user = targetUserId ? `target_${targetUserId}` : (scope === 'global' ? '_global' : (api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous')));
  const client = (window as unknown as { ApiClient?: Client }).ApiClient;
  const transport = ((scope === 'global' || targetUserId) && client)
    ? createProviderHomesTransport(client, () => true, scope, targetUserId)
    : api.providerHomes;
  return new ProviderHomesStore(providerHomesKey(api.serverId || location.origin, user),
    { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, transport);
}

/** Local storage is an account-scoped offline cache. A new server snapshot
 * chooses defaults without saving them, including when an older cache exists. */
export class ProviderHomesStore {
  private revision: string | null | undefined;
  private value: ProviderHomesSettings;
  private disposed = false;
  private generation = 0;
  private writing = false;
  hasUserOverride = false;
  globalRevision: string | null = null;
  readonly synced: boolean;

  constructor(readonly key: string, private storage: StorageLike, private transport?: ProviderHomesTransport) {
    this.synced = !!transport; this.value = this.readLocal();
  }
  allowSave(): void {
    if (this.revision === undefined) this.revision = null;
  }
  get cached(): ProviderHomesSettings { return boundedProviderHomes(this.value); }
  private readLocal(): ProviderHomesSettings {
    try {
      const raw = this.storage.getItem(this.key);
      return raw && raw.length <= maxProviderSettingsBytes ? boundedProviderHomes(JSON.parse(raw)) : defaultProviderHomes();
    } catch { return defaultProviderHomes(); }
  }
  private current(generation: number): void {
    if (this.disposed || generation !== this.generation || this.transport && !this.transport.isCurrent()) throw stale();
  }
  private remember(snapshot: ProviderHomesSnapshot): ProviderHomesSettings {
    this.revision = snapshot.Revision;
    this.hasUserOverride = snapshot.HasUserOverride ?? true;
    this.globalRevision = snapshot.GlobalRevision ?? null;
    this.value = snapshot.Settings || defaultProviderHomes();
    // The server read or save already succeeded even when device storage is full.
    try {
      this.storage.setItem(this.key, JSON.stringify(this.value));
      if (this.globalRevision) this.storage.setItem(`${this.key}:globalRevision`, this.globalRevision);
    } catch { /* Server remains authoritative. */ }
    return this.cached;
  }
  async load(): Promise<ProviderHomesSettings> {
    if (this.writing) throw new ProviderHomesSyncError('unavailable', 'Streaming services are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    // A failed reload must not leave an old revision eligible for a later save.
    this.revision = undefined;
    if (!this.transport) { this.value = this.readLocal(); this.revision = null; return this.cached; }
    const response = await this.transport.load(); this.current(generation);
    return this.remember(providerHomesSnapshot(response));
  }
  async save(value: ProviderHomesSettings): Promise<ProviderHomesSettings> {
    if (this.writing) throw new ProviderHomesSyncError('unavailable', 'Streaming services are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (this.revision === undefined) throw new ProviderHomesSyncError('unavailable', 'Load the saved streaming-service settings before saving changes.');
    const settings = boundedProviderHomes(value);
    if (!this.transport) {
      try { this.storage.setItem(this.key, JSON.stringify(settings)); }
      catch { throw new ProviderHomesSyncError('unavailable', 'These settings could not be saved on this device. Check browser storage and try again.'); }
      this.value = settings; return this.cached;
    }
    this.writing = true;
    try {
      const response = await this.transport.save(settings, this.revision); this.current(generation);
      const snapshot = providerHomesSnapshot(response);
      if (!snapshot.Settings) throw new ProviderHomesSyncError('invalid', 'Jellyfin did not confirm the saved streaming-service settings. Try again.');
      return this.remember(snapshot);
    } catch (error) {
      this.current(generation);
      if (error instanceof ProviderHomesSyncError && error.kind === 'conflict') this.revision = undefined;
      throw error;
    } finally { this.writing = false; }
  }
  async resetUserOverride(): Promise<ProviderHomesSettings> {
    if (this.writing) throw new ProviderHomesSyncError('unavailable', 'Streaming services are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (!this.transport?.resetUserOverride) throw new ProviderHomesSyncError('unavailable', 'Reset is not supported on this connection.');
    this.writing = true;
    try {
      const snapshot = await this.transport.resetUserOverride(); this.current(generation);
      return this.remember(providerHomesSnapshot(snapshot));
    } finally { this.writing = false; }
  }
  async resetAllUsers(): Promise<void> {
    if (!this.transport?.resetAllUsers) throw new ProviderHomesSyncError('unavailable', 'Reset is not supported on this connection.');
    await this.transport.resetAllUsers();
  }
  destroy(): void { this.disposed = true; this.generation++; }
}
