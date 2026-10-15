import { defaultProviderHomes, parseProviderHomes, providerHomesKey, maxProviderSettingsBytes, type ProviderHomesSettings } from './provider-settings';
import type { MediaApi } from './types';

export type ProviderHomesSnapshot = { Revision: string | null; Settings: ProviderHomesSettings | null };
export type ProviderHomesTransport = {
  isCurrent(): boolean;
  load(): Promise<ProviderHomesSnapshot>;
  save(settings: ProviderHomesSettings, revision: string | null): Promise<ProviderHomesSnapshot>;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Client = {
  getUrl(path: string): string;
  getJSON(url: string): Promise<unknown>;
  ajax(options: { type: 'PUT'; url: string; data: string; contentType: 'application/json'; dataType: 'json' }): Promise<unknown>;
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
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2)
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  const val = value as Record<string, unknown>;
  const hasPascal = 'Revision' in val && 'Settings' in val;
  const hasCamel = 'revision' in val && 'settings' in val;
  if (!hasPascal && !hasCamel)
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  const revision = (hasPascal ? val.Revision : val.revision) as string | null;
  const settings = hasPascal ? val.Settings : val.settings;
  if (revision === null && settings === null) return { Revision: null, Settings: null };
  if (typeof revision !== 'string' || !revision || revision.length > 100)
    throw new ProviderHomesSyncError('invalid', 'Jellyfin returned invalid provider-home settings. Try again.');
  return { Revision: revision, Settings: boundedProviderHomes(settings) };
}

/** Authentication belongs to Jellyfin's native client. The authenticated server
 * session chooses the owner; there is no user-id parameter to impersonate. */
export function createProviderHomesTransport(client: Client, isCurrent: () => boolean): ProviderHomesTransport {
  const current = () => { if (!isCurrent()) throw stale(); };
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
  return { isCurrent, load: () => request(() => client.getJSON(client.getUrl('TvItemLayout/ProviderHomes'))),
    save: (settings, revision) => request(() => client.ajax({ type: 'PUT', url: client.getUrl('TvItemLayout/ProviderHomes'),
      data: JSON.stringify({ Revision: revision, Settings: boundedProviderHomes(settings) }), contentType: 'application/json', dataType: 'json' })) };
}

export function createProviderHomesStore(api: MediaApi & { providerHomes?: ProviderHomesTransport }): ProviderHomesStore {
  const user = api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous');
  return new ProviderHomesStore(providerHomesKey(api.serverId || location.origin, user),
    { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }, api.providerHomes);
}

/** Local storage is an account-scoped offline cache. A new server snapshot
 * chooses defaults without saving them, including when an older cache exists. */
export class ProviderHomesStore {
  private revision: string | null | undefined;
  private value: ProviderHomesSettings;
  private disposed = false;
  private generation = 0;
  private writing = false;
  readonly synced: boolean;

  constructor(readonly key: string, private storage: StorageLike, private transport?: ProviderHomesTransport) {
    this.synced = !!transport; this.value = this.readLocal();
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
    this.revision = snapshot.Revision; this.value = snapshot.Settings || defaultProviderHomes();
    // The server read or save already succeeded even when device storage is full.
    try { this.storage.setItem(this.key, JSON.stringify(this.value)); } catch { /* Server remains authoritative. */ }
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
  destroy(): void { this.disposed = true; this.generation++; }
}
