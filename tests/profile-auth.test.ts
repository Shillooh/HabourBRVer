import test from 'node:test';
import assert from 'node:assert/strict';
import { openProfileLogin, profileSession, profileSwitchPending, ProfileLoginRequired, publicProfiles, switchPublicProfile, type ProfileSwitchPhase } from '../src/profile-auth';

const originalWindow = globalThis.window, originalDocument = globalThis.document;
test.afterEach(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const state = { user: 'family', server: 'server', logout: 0, auth: [] as unknown[], adopted: 0, handoff: 0, routes: [] as string[], phases: [] as ProfileSwitchPhase[],
    eligible: ['family', 'child'], eligibilityRequests: [] as string[] };
  const host = Object.assign(new EventTarget(), { location: { hash: '#/home' }, setInterval, clearInterval });
  const route = (hash: string) => { host.location.hash = hash; host.dispatchEvent(new Event('hashchange')); };
  const result = { User: { Id: 'child' }, ServerId: 'server', AccessToken: 'dummy-test-session' };
  const client = {
    getCurrentUserId: () => state.user, serverId: () => state.server,
    // Jellyfin 12 returns both flags as true even for passwordless accounts.
    getPublicUsers: async () => [{ Id: 'family', Name: 'Family', HasPassword: true, HasConfiguredPassword: true }, { Id: 'child', Name: 'Child', HasPassword: true, HasConfiguredPassword: true }, { Id: 'adult', Name: 'Adult', HasPassword: true, HasConfiguredPassword: true }],
    getUrl: (path: string) => 'http://example.invalid/' + path,
    getJSON: async (url: string): Promise<unknown> => { state.eligibilityRequests.push(url); return { ProfileIds: [...state.eligible] }; },
    ajax: async (request: unknown) => { state.auth.push(request); return result; },
    onAuthenticated: async (_client: unknown, response: typeof result) => { state.adopted++; state.user = response.User.Id; }
  };
  const finishLogout = () => { state.user = ''; route('#/login'); };
  const dashboard = { logout() { state.logout++; finishLogout(); }, navigate(value: string) { state.routes.push(value); route('#/' + value); }, onServerChanged() { state.handoff++; } };
  Object.assign(host, { ApiClient: client, Dashboard: dashboard });
  globalThis.window = host as unknown as Window & typeof globalThis;
  globalThis.document = new EventTarget() as Document;
  const session = profileSession()!; assert.ok(session);
  const controller = new AbortController();
  const start = (id = 'child') => switchPublicProfile(session, id, controller.signal, phase => state.phases.push(phase));
  return { state, client, dashboard, route, session, controller, start, finishLogout, result };
}

test('server eligibility overrides Jellyfin 12 password flags and uses native cleanup and session adoption before Home', async () => {
  const { state, start } = setup(); await start();
  assert.equal(state.logout, 1); assert.equal(state.adopted, 1); assert.equal(state.handoff, 1); assert.deepEqual(state.routes, ['home']);
  assert.deepEqual(state.phases, ['checking', 'signing-out', 'signing-in', 'opening']);
  assert.deepEqual(state.auth, [{ type: 'POST', url: 'http://example.invalid/Users/authenticatebyname', data: JSON.stringify({ Username: 'Child', Pw: '' }), dataType: 'json', contentType: 'application/json' }]);
  assert.deepEqual(state.eligibilityRequests, ['http://example.invalid/TvItemLayout/ProfileSwitchEligibility']);
  assert.equal(profileSwitchPending(), false);
});

test('only the intersection of native public profiles and server eligibility permits switching', async () => {
  const { client, state, start } = setup();
  state.eligible.push('missing');
  await assert.rejects(start('adult'), ProfileLoginRequired); await assert.rejects(start('missing'), ProfileLoginRequired);
  state.eligible = [];
  client.getPublicUsers = async () => [{ Id: 'child', Name: 'Child', HasPassword: false, HasConfiguredPassword: false }];
  await assert.rejects(start(), ProfileLoginRequired);
  assert.equal(state.logout, 0); assert.deepEqual(state.auth, []);
});

test('public profiles normalize server eligibility IDs and ignore IDs absent from the public list', async () => {
  const { client, state, session } = setup();
  client.getPublicUsers = async () => [{ Id: '12345678-1234-1234-1234-123456789abc', Name: 'Child', HasPassword: true, HasConfiguredPassword: true }];
  state.eligible = ['12345678123412341234123456789ABC', 'hidden'];
  assert.deepEqual(await publicProfiles(session), [{ Id: '12345678-1234-1234-1234-123456789abc', Name: 'Child', CanSwitchDirectly: true }]);
  assert.equal(state.logout, 0); assert.deepEqual(state.auth, []);
});

test('eligibility revoked after displaying the chooser prevents logout and authentication', async () => {
  const { state, session, start } = setup();
  assert.equal((await publicProfiles(session)).find(profile => profile.Id === 'child')?.CanSwitchDirectly, true);
  state.eligible = [];
  await assert.rejects(start(), ProfileLoginRequired);
  assert.equal(state.eligibilityRequests.length, 2); assert.equal(state.logout, 0); assert.deepEqual(state.auth, []);
});

test('missing, unavailable or malformed eligibility fails closed while public profiles still display', async () => {
  const { client, state, session, start } = setup();
  const responses = [undefined, null, [], {}, { ProfileIds: 'child' }, { ProfileIds: ['child', 4] }, { ProfileIds: ['child', ''] }, { ProfileIds: ['child', '  '] }];
  for (const response of responses) {
    client.getJSON = async () => response;
    const profiles = await publicProfiles(session);
    assert.equal(profiles.length, 3); assert.ok(profiles.every(profile => !profile.CanSwitchDirectly));
    await assert.rejects(start(), ProfileLoginRequired);
  }
  client.getJSON = async () => { throw new Error('404 or unavailable'); };
  assert.ok((await publicProfiles(session)).every(profile => !profile.CanSwitchDirectly));
  await assert.rejects(start(), ProfileLoginRequired);
  delete (client as { getJSON?: unknown }).getJSON;
  assert.ok((await publicProfiles(session)).every(profile => !profile.CanSwitchDirectly));
  await assert.rejects(start(), ProfileLoginRequired);
  assert.equal(state.logout, 0); assert.deepEqual(state.auth, []); assert.equal(profileSwitchPending(), false);
});

for (const change of ['user', 'server', 'route', 'abort'] as const) test(`stale ${change} during eligibility never signs out`, async () => {
  const { client, state, route, controller, start } = setup();
  const pending = deferred<unknown>(); client.getJSON = () => pending.promise;
  const work = start(); await tick();
  if (change === 'user') state.user = 'other'; else if (change === 'server') state.server = 'other'; else if (change === 'route') route('#/search'); else controller.abort();
  pending.resolve({ ProfileIds: ['child'] }); await assert.rejects(work, { name: 'AbortError' });
  assert.equal(state.logout, 0); assert.equal(state.adopted, 0); assert.deepEqual(state.auth, []);
});

for (const change of ['user', 'route', 'abort'] as const) test(`stale ${change} during discovery never signs out`, async () => {
  const { client, state, route, controller, start } = setup();
  const list = await client.getPublicUsers(), pending = deferred<typeof list>(); client.getPublicUsers = () => pending.promise;
  const work = start(); if (change === 'user') state.user = 'other'; else if (change === 'route') route('#/search'); else controller.abort();
  pending.resolve(list); await assert.rejects(work, { name: 'AbortError' }); assert.equal(state.logout, 0); assert.equal(state.adopted, 0);
});

test('void native logout must finish its login navigation before authentication', async () => {
  const { dashboard, state, start, route } = setup(); dashboard.logout = () => { state.logout++; };
  const work = start(); await tick(); assert.equal(state.logout, 1); assert.deepEqual(state.auth, []);
  state.user = ''; await tick(); assert.deepEqual(state.auth, []);
  route('#/login'); await work; assert.equal(state.adopted, 1);
});

test('aborted deferred logout retains its lock until native completion and cannot overtake a retry', async () => {
  const { dashboard, state, start, controller, finishLogout, session, route } = setup(); dashboard.logout = () => { state.logout++; };
  const work = start(); await tick(); controller.abort(); await tick();
  assert.equal(profileSwitchPending(), true);
  await assert.rejects(switchPublicProfile(session, 'child', new AbortController().signal, () => {}), /previous profile switch|troca de perfil anterior/i);
  await assert.rejects(openProfileLogin(session), /previous profile switch|troca de perfil anterior/i);
  assert.equal(state.logout, 1); assert.deepEqual(state.auth, []);
  finishLogout(); await assert.rejects(work, { name: 'AbortError' }); assert.equal(profileSwitchPending(), false);
  state.user = 'family'; route('#/home'); dashboard.logout = finishLogout;
  await switchPublicProfile(session, 'child', new AbortController().signal, () => {}); assert.equal(state.adopted, 1);
});

test('native-login fallback shares the pending logout lock', async () => {
  const { dashboard, state, session, start, finishLogout } = setup(); dashboard.logout = () => { state.logout++; };
  const work = openProfileLogin(session); await tick(); await assert.rejects(start(), /previous profile switch|troca de perfil anterior/i);
  finishLogout(); await work; assert.equal(state.logout, 1); assert.deepEqual(state.auth, []); assert.equal(profileSwitchPending(), false);
});

test('server-rejected authentication leaves the signed-out native login usable', async () => {
  const { client, state, start } = setup(); let attempts = 0; client.ajax = async () => { attempts++; throw new Error('401'); };
  await assert.rejects(start(), /401/); assert.equal(state.user, ''); assert.equal(window.location.hash, '#/login');
  assert.equal(state.adopted, 0); assert.deepEqual(state.routes, []); assert.equal(profileSwitchPending(), false);
  assert.equal(attempts, 1);
});

for (const change of ['user', 'server', 'route', 'abort'] as const) test(`late authentication after ${change} cannot adopt credentials`, async () => {
  const { client, state, start, route, controller, result } = setup(); const pending = deferred<typeof result>(); client.ajax = () => pending.promise;
  const work = start(); await tick();
  if (change === 'user') state.user = 'another'; else if (change === 'server') state.server = 'other'; else if (change === 'route') route('#/search'); else controller.abort();
  pending.resolve(result); await assert.rejects(work, { name: 'AbortError' }); assert.equal(state.adopted, 0); assert.equal(state.handoff, 0); assert.deepEqual(state.routes, []);
});

test('mismatched server or user responses never reach native credential persistence', async () => {
  const { client, state, start, result, route } = setup(); client.ajax = async () => ({ ...result, ServerId: 'different-server' });
  await assert.rejects(start(), /different profile|perfil diferente/i); assert.equal(state.adopted, 0);
  state.user = 'family'; route('#/home'); client.ajax = async () => ({ ...result, User: { Id: 'other' } });
  await assert.rejects(start(), /different profile|perfil diferente/i); assert.equal(state.adopted, 0);
});

test('missing server identity and empty or malformed tokens never reach native persistence', async () => {
  const { client, state, start, result, route } = setup();
  for (const invalid of [{ ...result, ServerId: undefined }, { ...result, AccessToken: '' }, { ...result, AccessToken: '  ' }, { ...result, AccessToken: 123 }]) {
    state.user = 'family'; route('#/home'); client.ajax = async () => invalid as typeof result;
    await assert.rejects(start(), /different profile|perfil diferente/i); assert.equal(state.adopted, 0);
  }
});

// Replay Dashboard.logout's real ordering: native logout, query cache clear,
// view reset, then NativeShell.selectServer on a MultiServer TV. The production
// webOS callback unloads its content frame; this unit substitute records that
// boundary and uses an in-document selector so a failing test can still settle.
function nativeTvLogout(fixture: ReturnType<typeof setup>) {
  const { state, dashboard, route } = fixture;
  const native = { serverSelections: 0, queryClears: 0, viewResets: 0 };
  const shell = { selectServer() { native.serverSelections++; route('#/selectserver'); } };
  (window as unknown as { NativeShell: typeof shell }).NativeShell = shell;
  dashboard.logout = () => {
    state.logout++;
    void Promise.resolve().then(() => {
      state.user = ''; native.queryClears++; native.viewResets++;
      shell.selectServer();
    });
  };
  return { shell, native, original: shell.selectServer };
}

test('MultiServer TV preserves native logout cleanup but keeps the profile switch on the same server', async () => {
  const fixture = setup(), { state, start } = fixture;
  const { shell, native, original } = nativeTvLogout(fixture);
  await start();
  assert.deepEqual(native, { serverSelections: 0, queryClears: 1, viewResets: 1 });
  assert.deepEqual(state.routes, ['login?serverid=server', 'home']);
  assert.equal(state.auth.length, 1); assert.equal(state.adopted, 1); assert.equal(state.handoff, 1);
  assert.equal(shell.selectServer, original);
  // An ordinary later server-selection request still reaches the TV shell.
  shell.selectServer(); assert.equal(native.serverSelections, 1);
});

test('explicit Use login screen also preserves the selected TV server without authenticating', async () => {
  const fixture = setup(), { state, session } = fixture;
  const { shell, native, original } = nativeTvLogout(fixture);
  await openProfileLogin(session);
  assert.deepEqual(native, { serverSelections: 0, queryClears: 1, viewResets: 1 });
  assert.deepEqual(state.routes, ['login?serverid=server']);
  assert.deepEqual(state.auth, []); assert.equal(state.adopted, 0); assert.equal(shell.selectServer, original);
});


test('TV shell callback is restored if native logout or same-server navigation fails', async () => {
  for (const failure of ['logout', 'navigation'] as const) {
    const fixture = setup(), { dashboard, state, start } = fixture;
    const { shell, original } = nativeTvLogout(fixture);
    if (failure === 'logout') dashboard.logout = () => { throw new Error('logout failed'); };
    else dashboard.navigate = () => { throw new Error('navigation failed'); };
    await assert.rejects(start(), new RegExp(failure + ' failed'));
    assert.equal(shell.selectServer, original); assert.equal(profileSwitchPending(), false);
    assert.deepEqual(state.auth, []); assert.equal(state.adopted, 0);
  }
});

test('unmodifiable TV shell fails before logout rather than losing the selected profile', async () => {
  const fixture = setup(), { state, start } = fixture;
  const { shell, original } = nativeTvLogout(fixture);
  Object.defineProperty(shell, 'selectServer', { value: original, writable: false, configurable: false });
  await assert.rejects(start(), ProfileLoginRequired);
  assert.equal(state.logout, 0); assert.deepEqual(state.auth, []); assert.equal(profileSwitchPending(), false);
  assert.equal(shell.selectServer, original);
});

test('TV cancellation restores the shell callback immediately but keeps the lock through pending native cleanup', async () => {
  const fixture = setup(), { state, start, dashboard, controller } = fixture;
  const { shell, original, native } = nativeTvLogout(fixture);
  dashboard.logout = () => { state.logout++; };
  const work = start(); await tick();
  assert.notEqual(shell.selectServer, original);
  controller.abort(); assert.equal(shell.selectServer, original); assert.equal(profileSwitchPending(), true);
  assert.deepEqual(state.auth, []);
  state.user = ''; native.queryClears++; native.viewResets++; shell.selectServer();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(profileSwitchPending(), false); assert.deepEqual(state.auth, []); assert.equal(state.adopted, 0);
});

for (const change of ['client', 'server', 'route'] as const) test(`TV logout cannot override a changed ${change}`, async () => {
  const fixture = setup(), { state, start, dashboard, route, client } = fixture;
  const { shell, original, native } = nativeTvLogout(fixture);
  dashboard.logout = () => { state.logout++; };
  const work = start(); await tick();
  if (change === 'client') (window as unknown as { ApiClient: typeof client }).ApiClient = { ...client };
  else if (change === 'server') state.server = 'different-server';
  else route('#/search');
  state.user = ''; native.queryClears++; native.viewResets++; shell.selectServer();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(native.serverSelections, 1); assert.deepEqual(state.routes, []); assert.deepEqual(state.auth, []);
  assert.equal(shell.selectServer, original);
});

test('a separate server-selection request during logout is delegated and cancels later profile authentication', async () => {
  const fixture = setup(), { state, start, dashboard } = fixture;
  const { shell, original, native } = nativeTvLogout(fixture);
  dashboard.logout = () => { state.logout++; };
  const work = start(); await tick();
  // The current user still exists: this is not Dashboard's completed logout.
  shell.selectServer(); assert.equal(native.serverSelections, 1); assert.equal(shell.selectServer, original);
  state.user = ''; shell.selectServer();
  await assert.rejects(work, { name: 'AbortError' });
  assert.deepEqual(state.auth, []); assert.equal(state.adopted, 0);
});

test('cleanup never overwrites a newer shell bridge handler', async () => {
  const fixture = setup(), { state, start, dashboard, controller, route } = fixture;
  const { shell } = nativeTvLogout(fixture);
  dashboard.logout = () => { state.logout++; };
  const work = start(); await tick();
  const replacement = () => route('#/selectserver'); shell.selectServer = replacement;
  controller.abort(); state.user = ''; shell.selectServer();
  await assert.rejects(work, { name: 'AbortError' }); assert.equal(shell.selectServer, replacement);
  assert.deepEqual(state.auth, []); assert.equal(profileSwitchPending(), false);
});
