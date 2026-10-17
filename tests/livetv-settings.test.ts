import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultLiveTvSettings,
  defaultSenadoUrls,
  isBrazilianPremiere,
  isChannelInState,
  liveTvSettingsKey,
  parseLiveTvSettings,
  type LiveTvSettings
} from '../src/livetv-settings';
import {
  createLiveTvTransport,
  LiveTvStore,
  LiveTvSyncError,
  liveTvSnapshot,
  subscribeLiveTv,
  type LiveTvSnapshot
} from '../src/livetv-settings-store';

function cache() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }
  };
}

test('live tv default settings provide TV Senado and 5 resilient fallback URLs', () => {
  const def = defaultLiveTvSettings();
  assert.equal(def.version, 1);
  assert.equal(def.enabled, true);
  assert.equal(def.defaultChannelEnabled, true);
  assert.equal(def.defaultChannelName, 'TV Senado');
  assert.equal(def.defaultChannelDescription, 'Canal de Boas-Vindas · Ao Vivo 24h');
  assert.equal(def.defaultChannelUrls.length, 5);
  assert.deepEqual(def.defaultChannelUrls, defaultSenadoUrls);
  assert.equal(def.customM3uPathOrUrl, '');
  assert.equal(def.userAgent, 'VLC/3.0.20 LibVLC/3.0.20');
  assert.equal(def.localRegion, 'none');
});

test('live tv settings parser validates and sanitizes input', () => {
  const valid = defaultLiveTvSettings();
  assert.deepEqual(parseLiveTvSettings(valid), valid);

  // Custom valid values
  const custom: LiveTvSettings = {
    version: 1,
    enabled: false,
    defaultChannelEnabled: false,
    defaultChannelName: 'Canal Teste',
    defaultChannelDescription: 'Descricao do canal',
    defaultChannelUrls: ['http://example.com/stream.m3u8'],
    customM3uPathOrUrl: 'http://example.com/playlist.m3u',
    userAgent: 'okhttp/5.0.0-alpha.2',
    localRegion: 'SP'
  };
  assert.deepEqual(parseLiveTvSettings(custom), custom);

  // Fallback to default Senado URLs if array is empty
  const emptyUrls = { ...valid, defaultChannelUrls: [] };
  const parsedEmpty = parseLiveTvSettings(emptyUrls);
  assert.deepEqual(parsedEmpty.defaultChannelUrls, defaultSenadoUrls);
});

test('live tv settings parser rejects malformed and out-of-bound inputs', () => {
  const def = defaultLiveTvSettings();
  const invalidCases = [
    null,
    undefined,
    [],
    'string',
    { ...def, version: 2 },
    { ...def, enabled: 'true' },
    { ...def, defaultChannelEnabled: 1 },
    { ...def, defaultChannelName: 'x'.repeat(121) },
    { ...def, defaultChannelDescription: 'y'.repeat(201) },
    { ...def, defaultChannelName: 'Canal\nInvalido' },
    { ...def, defaultChannelDescription: 'Descricao\0Invalida' },
    { ...def, customM3uPathOrUrl: 'z'.repeat(501) },
    { ...def, defaultChannelUrls: 'not-an-array' }
  ];

  for (const item of invalidCases) {
    assert.throws(() => parseLiveTvSettings(item), /inv[aá]lidas/i);
  }
});

test('live tv snapshot handles PascalCase, camelCase and empty snapshots', () => {
  const def = defaultLiveTvSettings();
  assert.deepEqual(liveTvSnapshot({ Revision: null, Settings: null }), { Revision: null, Settings: null });
  assert.deepEqual(liveTvSnapshot({ revision: null, settings: null }), { Revision: null, Settings: null });
  assert.deepEqual(liveTvSnapshot({ Revision: null, Settings: def }), { Revision: null, Settings: def });
  assert.deepEqual(liveTvSnapshot({ revision: null, settings: def }), { Revision: null, Settings: def });

  const pascalSnap = liveTvSnapshot({ Revision: 'rev-1', Settings: def });
  assert.equal(pascalSnap.Revision, 'rev-1');
  assert.deepEqual(pascalSnap.Settings, def);

  const camelSnap = liveTvSnapshot({ revision: 'rev-2', settings: def });
  assert.equal(camelSnap.Revision, 'rev-2');
  assert.deepEqual(camelSnap.Settings, def);

  assert.throws(() => liveTvSnapshot(null), /inv[aá]lidas/i);
  assert.throws(() => liveTvSnapshot({}), /inv[aá]lidas/i);
  assert.throws(() => liveTvSnapshot({ Revision: 'x'.repeat(101), Settings: def }), /inv[aá]lidas/i);
});

test('live tv preferences are isolated by storage key', () => {
  const key1 = liveTvSettingsKey('serverA', 'user1');
  const key2 = liveTvSettingsKey('serverA', 'user2');
  const key3 = liveTvSettingsKey('serverB', 'user1');
  assert.notEqual(key1, key2);
  assert.notEqual(key1, key3);
  assert.match(key1, /serverA/);
  assert.match(key1, /user1/);
});

test('live tv store loads, caches and saves settings successfully', async () => {
  const storage = cache();
  let serverSettings: LiveTvSettings = defaultLiveTvSettings();
  let serverRev = 'initial-rev';

  const transport = {
    isCurrent: () => true,
    load: async (): Promise<LiveTvSnapshot> => ({ Revision: serverRev, Settings: serverSettings }),
    save: async (settings: LiveTvSettings): Promise<LiveTvSnapshot> => {
      serverRev = 'updated-rev';
      serverSettings = settings;
      return { Revision: serverRev, Settings: serverSettings };
    },
    resetDefaults: async (): Promise<LiveTvSnapshot> => {
      serverRev = 'reset-rev';
      serverSettings = defaultLiveTvSettings();
      return { Revision: serverRev, Settings: serverSettings };
    }
  };

  const store = new LiveTvStore(transport, storage, 'test-livetv-key');
  assert.deepEqual(store.cached, defaultLiveTvSettings());

  const loaded = await store.load();
  assert.deepEqual(loaded, defaultLiveTvSettings());
  assert.equal(store.currentRevision, 'initial-rev');

  const modified: LiveTvSettings = {
    ...defaultLiveTvSettings(),
    defaultChannelName: 'Novo Canal'
  };
  await store.save(modified);
  assert.equal(store.currentRevision, 'updated-rev');
  assert.equal(store.cached.defaultChannelName, 'Novo Canal');
  assert.match(storage.data.get('test-livetv-key') || '', /Novo Canal/);

  // Test reset defaults
  await store.resetDefaults();
  assert.equal(store.currentRevision, 'reset-rev');
  assert.equal(store.cached.defaultChannelName, 'TV Senado');
});

test('live tv store rejects stale sessions during transport requests', async () => {
  let isCurrent = true;
  const transport = createLiveTvTransport(
    {
      getUrl: (path: string) => path,
      getJSON: async () => ({ Revision: '1', Settings: defaultLiveTvSettings() }),
      ajax: async () => ({ Revision: '1', Settings: defaultLiveTvSettings() })
    },
    () => isCurrent
  );

  isCurrent = false;
  await assert.rejects(transport.load(), (err: Error) => err instanceof LiveTvSyncError && err.kind === 'stale');
});

test('live tv store notifies subscribers on changes', async () => {
  const storage = cache();
  const transport = {
    isCurrent: () => true,
    load: async (): Promise<LiveTvSnapshot> => ({ Revision: '1', Settings: defaultLiveTvSettings() }),
    save: async (settings: LiveTvSettings): Promise<LiveTvSnapshot> => ({ Revision: '2', Settings: settings })
  };

  const store = new LiveTvStore(transport, storage, 'notif-key');
  let notifiedCount = 0;
  let lastNotifiedName = '';

  const unsubscribe = subscribeLiveTv((_store, settings) => {
    notifiedCount++;
    lastNotifiedName = settings.defaultChannelName;
  });

  await store.load();
  assert.equal(notifiedCount, 1);
  assert.equal(lastNotifiedName, 'TV Senado');

  await store.save({ ...defaultLiveTvSettings(), defaultChannelName: 'Canal Notificado' });
  assert.equal(notifiedCount, 2);
  assert.equal(lastNotifiedName, 'Canal Notificado');

  unsubscribe();
  await store.save({ ...defaultLiveTvSettings(), defaultChannelName: 'Sem Notificacao' });
  assert.equal(notifiedCount, 2);
});

test('brazilian premiere channels are isolated and international channels are rejected', () => {
  // Brazilian Premiere channels
  assert.equal(isBrazilianPremiere('BR: Premiere 2', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('BR: Premiere Clubes', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 3', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 4', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 5', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 6', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 7', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE 8', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('PREMIERE8', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('Premiere HD', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('Premiere 2 4K', 'Esportes'), true);
  assert.equal(isBrazilianPremiere('Canal Premiere HD', 'Esportes'), true);

  // International / cinema / non-Brazilian channels MUST be rejected
  assert.equal(isBrazilianPremiere('UK- Sky Cinema Premiere', 'Esportes'), false);
  assert.equal(isBrazilianPremiere('|DE| PREMIERE 1', 'Esportes'), false);
  assert.equal(isBrazilianPremiere('|DE| PREMIERE 2', 'Esportes'), false);
  assert.equal(isBrazilianPremiere('|FR| PARIS PREMIERE', 'Esportes'), false);
  assert.equal(isBrazilianPremiere('VIP SKY CINEMA PREMIEREN +24 /', '▶ Canais - Alemanha'), false);
  assert.equal(isBrazilianPremiere('PFC', '▶ Canais - Portugal'), false);
  assert.equal(isBrazilianPremiere('SporTV', 'Esportes'), false);
  assert.equal(isBrazilianPremiere('ESPN', 'Esportes'), false);
});

test('state channel isolation prevents Paraiba channels from leaking into Bahia', () => {
  // Paraíba channels MUST match PB and NEVER match BA
  const paraibaChannels = [
    { name: 'SBT TV PARAÍBA', groupTitle: 'TV Aberta' },
    { name: 'TV GLOBO PARAIBA', groupTitle: 'TV Aberta' },
    { name: 'BAND PB TV ARAPUAN', groupTitle: 'TV Aberta' },
    { name: 'GLOBO PB TV CABO BRANCO', groupTitle: 'TV Aberta' },
    { name: 'RECORD PB TV CORREIO', groupTitle: 'TV Aberta' },
    { name: 'SBT PB', groupTitle: 'TV Aberta' },
    { name: 'RECORDTV PARAIBA', groupTitle: 'Canais - H264' },
    { name: 'CAMPEONATO PARAIBANO 01', groupTitle: 'Canais - Esportes PPV' },
    { name: 'CAMPEONATO PARAIBANO 02', groupTitle: 'Canais - Esportes PPV' }
  ];

  for (const ch of paraibaChannels) {
    assert.equal(isChannelInState(ch, 'BA'), false, `Channel ${ch.name} must NOT match BA`);
    assert.equal(isChannelInState(ch, 'PB'), true, `Channel ${ch.name} must match PB`);
  }

  // São Paulo / Minas Gerais edge cases:
  // "Vale do Paraíba" is a region in SP, not PB or BA
  const valeDoParaiba = { name: 'RECORD LITORAL VALE DO PARAÍBA', groupTitle: 'TV Aberta' };
  assert.equal(isChannelInState(valeDoParaiba, 'BA'), false);
  assert.equal(isChannelInState(valeDoParaiba, 'PB'), false);
  assert.equal(isChannelInState(valeDoParaiba, 'SP'), true);

  // "Paranaíba" is in Minas Gerais, not BA or PB
  const paranaiba = { name: 'RECORD MG TV PARANAÍBA', groupTitle: 'TV Aberta' };
  assert.equal(isChannelInState(paranaiba, 'BA'), false);
  assert.equal(isChannelInState(paranaiba, 'PB'), false);
  assert.equal(isChannelInState(paranaiba, 'MG'), true);

  // Bahia channels MUST match BA
  const bahiaChannels = [
    { name: 'BAND BA', groupTitle: 'TV Aberta' },
    { name: 'BAND BAHIA', groupTitle: 'TV Aberta' },
    { name: 'BR: Globo Bahia', groupTitle: 'TV Aberta' },
    { name: 'GLOBO BA OESTE', groupTitle: 'TV Aberta' },
    { name: 'GLOBO BA TV BAHIA', groupTitle: 'TV Aberta' },
    { name: 'RECORD BAHIA', groupTitle: 'TV Aberta' },
    { name: 'RECORD BA ITABUNA', groupTitle: 'TV Aberta' },
    { name: 'SBT BA BAHIA', groupTitle: 'TV Aberta' },
    { name: 'TVE BAHIA', groupTitle: 'TV Aberta' },
    { name: 'TV GAZETA BA', groupTitle: 'TV Aberta' }
  ];

  for (const ch of bahiaChannels) {
    assert.equal(isChannelInState(ch, 'BA'), true, `Bahia channel ${ch.name} must match BA`);
    assert.equal(isChannelInState(ch, 'PB'), false, `Bahia channel ${ch.name} must NOT match PB`);
  }

  // Goiás channels MUST match GO
  const goiasChannels = [
    { name: 'TV ANHANGUERA GO', groupTitle: 'TV Aberta' },
    { name: 'GLOBO GOIANIA', groupTitle: 'TV Aberta' },
    { name: 'RECORD GOIAS', groupTitle: 'TV Aberta' }
  ];

  for (const ch of goiasChannels) {
    assert.equal(isChannelInState(ch, 'GO'), true, `Goiás channel ${ch.name} must match GO`);
    assert.equal(isChannelInState(ch, 'BA'), false, `Goiás channel ${ch.name} must NOT match BA`);
  }
});

