import { defaultLiveTvSettings, parseLiveTvSettings, liveTvSettingsKey, maxLiveTvSettingsBytes, type LiveTvSettings } from './livetv-settings';
import type { MediaApi } from './types';

export type LiveTvSnapshot = {
  Revision: string | null;
  Settings: LiveTvSettings | null;
  HasUserOverride?: boolean;
  GlobalRevision?: string | null;
};

export type LiveTvTransport = {
  isCurrent(): boolean;
  load(): Promise<LiveTvSnapshot>;
  save(settings: LiveTvSettings, revision: string | null): Promise<LiveTvSnapshot>;
  resetDefaults?(): Promise<LiveTvSnapshot>;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type LiveTvListener = (store: LiveTvStore, settings: LiveTvSettings) => void;
const listeners = new Set<LiveTvListener>();

export function subscribeLiveTv(listener: LiveTvListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(store: LiveTvStore): void {
  for (const listener of listeners) {
    try { listener(store, store.cached); } catch { /* Ignore view errors */ }
  }
}

type Client = {
  getUrl(path: string): string;
  getJSON(url: string): Promise<unknown>;
  ajax(options: { type: 'PUT' | 'POST' | 'DELETE'; url: string; data?: string; contentType?: 'application/json'; dataType?: 'json' }): Promise<unknown>;
};

export class LiveTvSyncError extends Error {
  constructor(readonly kind: 'conflict' | 'unavailable' | 'stale' | 'invalid', message: string) { super(message); }
}

const stale = () => new LiveTvSyncError('stale', 'Sua conta do Jellyfin mudou. Reabra as configurações de TV Ao Vivo.');

export function boundedLiveTvSettings(value: unknown): LiveTvSettings {
  try { return parseLiveTvSettings(value); }
  catch { throw new LiveTvSyncError('invalid', 'Jellyfin retornou configurações de TV Ao Vivo inválidas.'); }
}

export function liveTvSnapshot(value: unknown): LiveTvSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LiveTvSyncError('invalid', 'Jellyfin retornou configurações de TV Ao Vivo inválidas.');
  const val = value as Record<string, unknown>;
  const hasPascal = 'Revision' in val && 'Settings' in val;
  const hasCamel = 'revision' in val && 'settings' in val;
  if (!hasPascal && !hasCamel)
    throw new LiveTvSyncError('invalid', 'Jellyfin retornou configurações de TV Ao Vivo inválidas.');

  const revision = (hasPascal ? val.Revision : val.revision) as string | null;
  const settings = hasPascal ? val.Settings : val.settings;
  const hasUserOverride = val.HasUserOverride !== undefined ? Boolean(val.HasUserOverride) : val.hasUserOverride !== undefined ? Boolean(val.hasUserOverride) : undefined;
  const globalRevision = ((hasPascal ? val.GlobalRevision : val.globalRevision) as string | null) ?? null;

  if (revision !== null && (typeof revision !== 'string' || !revision || revision.length > 100))
    throw new LiveTvSyncError('invalid', 'Jellyfin retornou configurações de TV Ao Vivo inválidas.');

  const res: LiveTvSnapshot = { Revision: revision, Settings: settings ? boundedLiveTvSettings(settings) : null };
  if (hasUserOverride !== undefined) res.HasUserOverride = hasUserOverride;
  if (globalRevision !== null) res.GlobalRevision = globalRevision;
  return res;
}

export function createLiveTvTransport(client: Client, isCurrent: () => boolean, scope: 'user' | 'global' = 'global', targetUserId?: string): LiveTvTransport {
  const current = () => { if (!isCurrent()) throw stale(); };
  const basePath = 'TvItemLayout/LiveTv/Settings/Global';

  const request = async (operation: () => Promise<unknown>) => {
    current();
    try {
      const result = await operation();
      current();
      return liveTvSnapshot(result);
    } catch (error) {
      current();
      if (error instanceof LiveTvSyncError) throw error;
      const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status?: unknown }).status) : undefined;
      if (status === 409) throw new LiveTvSyncError('conflict', 'As configurações foram alteradas em outro dispositivo. Recarregue antes de salvar.');
      if (status === 400 || status === 413) throw new LiveTvSyncError('invalid', 'Dados de TV Ao Vivo rejeitados pelo servidor.');
      throw new LiveTvSyncError('unavailable', 'Não foi possível conectar ao servidor Jellyfin.');
    }
  };

  return {
    isCurrent,
    load: () => request(() => client.getJSON(client.getUrl(basePath))),
    save: (settings, revision) => request(() => client.ajax({
      type: 'PUT',
      url: client.getUrl(basePath),
      data: JSON.stringify({ Revision: revision, Settings: settings }),
      contentType: 'application/json',
      dataType: 'json'
    })),
    resetDefaults: () => request(() => client.ajax({
      type: 'POST',
      url: client.getUrl('TvItemLayout/LiveTv/Settings/ResetDefaults'),
      dataType: 'json'
    }))
  };
}

export function createLiveTvStore(api: MediaApi & { liveTv?: LiveTvTransport }, scope: 'user' | 'global' = 'global', targetUserId?: string): LiveTvStore {
  const user = targetUserId ? `target_${targetUserId}` : (scope === 'global' ? '_global' : (api.userId || (typeof window !== 'undefined' && (window as any).TvItemLayoutDemo ? 'demo' : 'anonymous')));
  const win = typeof window !== 'undefined' ? (window as unknown as { ApiClient?: Client }) : undefined;
  const globalAny = typeof globalThis !== 'undefined' ? (globalThis as unknown as { ApiClient?: Client }) : undefined;
  const client = win?.ApiClient || globalAny?.ApiClient || (api as unknown as { client?: Client })?.client;
  const transport = client
    ? createLiveTvTransport(client, () => true, scope, targetUserId)
    : api.liveTv;
  if (!transport) throw new Error('Transporte de TV Ao Vivo não disponível.');
  const key = liveTvSettingsKey(api.serverId || (typeof location !== 'undefined' ? location.origin : 'default'), user);
  const storage = typeof localStorage !== 'undefined' ? localStorage : { getItem: () => null, setItem: () => {} };
  return new LiveTvStore(transport, storage, key);
}

export class LiveTvStore {
  private revision: string | null = null;
  private settings: LiveTvSettings;
  private saving = false;

  constructor(
    private transport: LiveTvTransport,
    private storage: StorageLike = localStorage,
    private storageKey: string = 'jellyfin-cinema.livetv-settings'
  ) {
    this.settings = this.readStorage() ?? defaultLiveTvSettings();
  }

  get cached(): LiveTvSettings { return this.settings; }
  get currentRevision(): string | null { return this.revision; }

  private readStorage(): LiveTvSettings | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      return parseLiveTvSettings(JSON.parse(raw));
    } catch { return null; }
  }

  private writeStorage(settings: LiveTvSettings): void {
    try { this.storage.setItem(this.storageKey, JSON.stringify(settings)); } catch { /* Ignore quota errors */ }
  }

  async load(): Promise<LiveTvSettings> {
    const snap = await this.transport.load();
    this.revision = snap.Revision;
    if (snap.Settings) {
      this.settings = snap.Settings;
      this.writeStorage(this.settings);
      changed(this);
    }
    return this.settings;
  }

  async save(newSettings: LiveTvSettings): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    try {
      const snap = await this.transport.save(newSettings, this.revision);
      this.revision = snap.Revision;
      this.settings = snap.Settings ?? newSettings;
      this.writeStorage(this.settings);
      changed(this);
    } finally {
      this.saving = false;
    }
  }

  async resetDefaults(): Promise<LiveTvSettings> {
    if (this.transport.resetDefaults) {
      const snap = await this.transport.resetDefaults();
      this.revision = snap.Revision;
      this.settings = snap.Settings ?? defaultLiveTvSettings();
      this.writeStorage(this.settings);
      changed(this);
      return this.settings;
    }
    await this.save(defaultLiveTvSettings());
    return this.settings;
  }
}
