import { emptyHomeCollections, homeCollectionKey, parseHomeCollections, type HomeCollectionSettings } from './home-collection-settings';
import type { MediaApi } from './types';

// Leave room for the revision/envelope under the server's 512 KiB request cap.
export const maxHomeSettingsBytes = 512 * 1024 - 1024;
export type HomeCollectionSnapshot = {
  Revision: string | null;
  Settings: HomeCollectionSettings | null;
  HasUserOverride?: boolean;
  GlobalRevision?: string | null;
};
export type HomeCollectionTransport = {
  isCurrent(): boolean;
  load(): Promise<HomeCollectionSnapshot>;
  save(settings: HomeCollectionSettings, revision: string | null): Promise<HomeCollectionSnapshot>;
  resetUserOverride?(): Promise<HomeCollectionSnapshot>;
  resetAllUsers?(): Promise<void>;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export class HomeCollectionSyncError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable' | 'stale' | 'invalid', message: string) { super(message); }
}
export function createHomeCollectionStore(api: MediaApi, scope: 'user' | 'global' = 'user', targetUserId?: string): HomeCollectionStore {
  const user = targetUserId ? `target_${targetUserId}` : (scope === 'global' ? '_global' : (api.userId || (window.TvItemLayoutDemo ? 'demo' : 'anonymous')));
  const key = homeCollectionKey(api.serverId || location.origin, user);
  const client = (window as unknown as { ApiClient?: Parameters<typeof import('./home-collection-transport').createHomeCollectionTransport>[0] }).ApiClient;
  const transport = ((scope === 'global' || targetUserId) && client)
    ? require('./home-collection-transport').createHomeCollectionTransport(client, () => true, scope, targetUserId)
    : api.homeCollections;
  return new HomeCollectionStore(key, { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) },
    transport, [homeCollectionKey(location.origin, user)]);
}
const stale = () => new HomeCollectionSyncError('stale', 'Your Jellyfin account changed. Reopen collection rows for the current account.');
export function boundedHomeSettings(value: unknown): HomeCollectionSettings {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('rows' in value) || !Array.isArray(value.rows)) throw new HomeCollectionSyncError('invalid', 'Jellyfin returned invalid collection-row settings. Try again.');
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxHomeSettingsBytes)
    throw new HomeCollectionSyncError('invalid', 'These collection rows are too large to sync. Reduce custom item orders and try again.');
  return parseHomeCollections(value);
}
export function homeCollectionSnapshot(value: unknown): HomeCollectionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HomeCollectionSyncError('invalid', 'Jellyfin returned invalid collection-row settings. Try again.');
  const val = value as Record<string, unknown>;
  const hasPascal = 'Revision' in val && 'Settings' in val;
  const hasCamel = 'revision' in val && 'settings' in val;
  if (!hasPascal && !hasCamel)
    throw new HomeCollectionSyncError('invalid', 'Jellyfin returned invalid collection-row settings. Try again.');
  const allowedKeys = new Set(['Revision', 'Settings', 'revision', 'settings', 'HasUserOverride', 'hasUserOverride', 'GlobalRevision', 'globalRevision']);
  for (const k of Object.keys(val)) {
    if (!allowedKeys.has(k)) throw new HomeCollectionSyncError('invalid', 'Jellyfin returned invalid collection-row settings. Try again.');
  }
  const revision = (hasPascal ? val.Revision : val.revision) as string | null;
  const settings = hasPascal ? val.Settings : val.settings;
  const hasUserOverride = val.HasUserOverride !== undefined ? Boolean(val.HasUserOverride) : val.hasUserOverride !== undefined ? Boolean(val.hasUserOverride) : undefined;
  const globalRevision = ((hasPascal ? val.GlobalRevision : val.globalRevision) as string | null) ?? null;
  if (revision === null && settings === null) {
    const res: HomeCollectionSnapshot = { Revision: null, Settings: null };
    if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
    if (globalRevision !== null) res.GlobalRevision = globalRevision;
    return res;
  }
  if (typeof revision !== 'string' || !revision || revision.length > 100)
    throw new HomeCollectionSyncError('invalid', 'Jellyfin returned invalid collection-row settings. Try again.');
  const res: HomeCollectionSnapshot = { Revision: revision, Settings: boundedHomeSettings(settings) };
  if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
  if (globalRevision !== null) res.GlobalRevision = globalRevision;
  return res;
}

/** Server revisions protect migration and concurrent editors; local data is only
 * an offline cache once a server copy exists, including an explicitly empty one. */
export class HomeCollectionStore {
  private revision: string | null | undefined;
  private disposed = false;
  private generation = 0;
  private writing = false;
  private value: HomeCollectionSettings;
  private legacy: HomeCollectionSettings;
  hasUserOverride = false;
  globalRevision: string | null = null;
  readonly synced: boolean;

  constructor(readonly key: string, private storage: StorageLike, private transport?: HomeCollectionTransport,
    legacyKeys: string[] = []) {
    this.synced = !!transport;
    this.legacy = [key, ...legacyKeys].map(key => this.readLocal(key)).find(settings => settings.rows.length) || emptyHomeCollections();
    this.value = this.legacy;
    if (transport) {
      try {
        const raw = storage.getItem(`${key}:synced`);
        if (raw && raw.length <= maxHomeSettingsBytes) this.value = homeCollectionSnapshot(JSON.parse(raw)).Settings || this.legacy;
      } catch { /* Keep the valid legacy cache if the synced cache is damaged. */ }
    } else this.value = this.readLocal(key);
  }
  allowSave(): void {
    if (this.revision === undefined) this.revision = null;
  }
  get cached(): HomeCollectionSettings { return parseHomeCollections(this.value); }
  private readLocal(key: string): HomeCollectionSettings {
    try { const raw = this.storage.getItem(key); return raw && raw.length <= maxHomeSettingsBytes ? boundedHomeSettings(JSON.parse(raw)) : emptyHomeCollections(); }
    catch { return emptyHomeCollections(); }
  }
  private current(generation: number): void {
    if (this.disposed || generation !== this.generation || this.transport && !this.transport.isCurrent()) throw stale();
  }
  private remember(snapshot: HomeCollectionSnapshot): HomeCollectionSettings {
    this.revision = snapshot.Revision;
    this.hasUserOverride = snapshot.HasUserOverride ?? true;
    this.globalRevision = snapshot.GlobalRevision ?? null;
    this.value = snapshot.Settings || emptyHomeCollections();
    if (snapshot.Settings) {
      // Cache failures cannot turn a completed server save into a failed save.
      try { this.storage.setItem(`${this.key}:synced`, JSON.stringify(snapshot)); this.storage.setItem(this.key, JSON.stringify(this.value)); } catch { /* Server remains authoritative. */ }
      this.legacy = this.value;
    }
    return this.cached;
  }
  async load(): Promise<HomeCollectionSettings> {
    if (this.writing) throw new HomeCollectionSyncError('unavailable', 'Collection rows are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (!this.transport) { this.value = this.readLocal(this.key); this.revision = null; return this.cached; }
    let snapshot = homeCollectionSnapshot(await this.transport.load()); this.current(generation);
    if (snapshot.Settings === null && this.legacy.rows.length) {
      // Only a populated old device may migrate. A fresh TV never writes an
      // empty default, and a simultaneous migration must not replace its winner.
      try {
        snapshot = homeCollectionSnapshot(await this.transport.save(this.legacy, null));
        if (snapshot.Settings === null) throw new HomeCollectionSyncError('invalid', 'Jellyfin did not confirm the migrated collection rows. Try again.');
      }
      catch (error) {
        this.current(generation);
        if (!(error instanceof HomeCollectionSyncError) || error.kind !== 'conflict') throw error;
        snapshot = homeCollectionSnapshot(await this.transport.load());
      }
      this.current(generation);
    }
    return this.remember(snapshot);
  }
  async save(value: HomeCollectionSettings): Promise<HomeCollectionSettings> {
    if (this.writing) throw new HomeCollectionSyncError('unavailable', 'Collection rows are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (this.revision === undefined) throw new HomeCollectionSyncError('unavailable', 'Load the saved collection rows before saving changes.');
    const settings = boundedHomeSettings(value);
    if (!this.transport) {
      try { this.storage.setItem(this.key, JSON.stringify(settings)); }
      catch { throw new HomeCollectionSyncError('unavailable', 'These settings could not be saved on this device. Check browser storage and try again.'); }
      this.value = settings; return this.cached;
    }
    this.writing = true;
    try {
      const snapshot = homeCollectionSnapshot(await this.transport.save(settings, this.revision)); this.current(generation);
      if (snapshot.Settings === null) throw new HomeCollectionSyncError('invalid', 'Jellyfin did not confirm the saved collection rows. Try again.');
      return this.remember(snapshot);
    } catch (error) {
      if (error instanceof HomeCollectionSyncError && error.kind === 'conflict') this.revision = undefined;
      throw error;
    } finally { this.writing = false; }
  }
  async resetUserOverride(): Promise<HomeCollectionSettings> {
    if (this.writing) throw new HomeCollectionSyncError('unavailable', 'Collection rows are still saving. Please wait.');
    const generation = ++this.generation; this.current(generation);
    if (!this.transport?.resetUserOverride) throw new HomeCollectionSyncError('unavailable', 'Reset is not supported on this connection.');
    this.writing = true;
    try {
      const snapshot = homeCollectionSnapshot(await this.transport.resetUserOverride()); this.current(generation);
      return this.remember(snapshot);
    } finally { this.writing = false; }
  }
  async resetAllUsers(): Promise<void> {
    if (!this.transport?.resetAllUsers) throw new HomeCollectionSyncError('unavailable', 'Reset is not supported on this connection.');
    await this.transport.resetAllUsers();
  }
  destroy(): void { this.disposed = true; this.generation++; }
}
