export type PublicProfile = { Id: string; Name: string; CanSwitchDirectly: boolean; PrimaryImageTag?: string };
type NativePublicProfile = Pick<PublicProfile, 'Id' | 'Name' | 'PrimaryImageTag'>;
type AuthenticationResult = { User?: { Id?: string }; AccessToken?: string; ServerId?: string };
type NativeAuthClient = {
  getCurrentUserId(): string; serverId(): string;
  getPublicUsers(): Promise<NativePublicProfile[]>;
  getUserImageUrl?(id: string, options: Record<string, string | number>): string;
  getUrl(path: string): string;
  getJSON?(url: string): Promise<unknown>;
  ajax(request: { type: 'POST'; url: string; data: string; dataType: 'json'; contentType: 'application/json' }): Promise<AuthenticationResult>;
  onAuthenticated?: (client: NativeAuthClient, result: AuthenticationResult) => Promise<unknown>;
};
type NativeAuthDashboard = {
  logout(): void; navigate(route: string): unknown;
  onServerChanged?(id: string, accessToken: string, client: NativeAuthClient): void;
};
export type ProfileSession = { client: NativeAuthClient; dashboard: NativeAuthDashboard; userId: string; serverId: string };
export type ProfileSwitchPhase = 'checking' | 'signing-out' | 'signing-in' | 'opening';
export class ProfileLoginRequired extends Error { }
const identity = (id: string) => /^[\da-f]{32}$|^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) ? id.replace(/-/g, '').toLowerCase() : id;
const loginRoute = () => /^#\/?(?:login|selectserver)\/?(?:\?|$)/i.test(window.location.hash);
const abort = () => new DOMException('A troca de perfil foi cancelada.', 'AbortError');
// Native logout and session adoption cannot be cancelled. Keep this lock even
// if the owning view is destroyed so a retry cannot overtake their callbacks.
let switching = false;
export const profileSwitchPending = () => switching;

export async function openProfileLogin(session: ProfileSession, signal = new AbortController().signal): Promise<void> {
  if (switching) throw new Error('O Jellyfin ainda está finalizando a troca de perfil anterior.');
  check(session, signal);
  switching = true;
  try { await signOut(session, signal); }
  finally { switching = false; }
}

export function profileSession(): ProfileSession | null {
  const host = window as Window & { ApiClient?: NativeAuthClient; Dashboard?: NativeAuthDashboard };
  const client = host.ApiClient, dashboard = host.Dashboard;
  if (typeof client?.getCurrentUserId !== 'function' || typeof client.serverId !== 'function'
    || typeof client.getPublicUsers !== 'function' || typeof client.getUrl !== 'function' || typeof client.ajax !== 'function'
    || typeof client.onAuthenticated !== 'function' || typeof dashboard?.logout !== 'function'
    || typeof dashboard.navigate !== 'function' || typeof dashboard.onServerChanged !== 'function') return null;
  const userId = client.getCurrentUserId(), serverId = client.serverId();
  return userId && serverId ? { client, dashboard, userId, serverId } : null;
}
export function sameProfileServer(session: ProfileSession): boolean {
  const host = window as Window & { ApiClient?: NativeAuthClient; Dashboard?: NativeAuthDashboard };
  return host.ApiClient === session.client && host.Dashboard === session.dashboard && session.client.serverId() === session.serverId;
}
export function sameProfileSession(session: ProfileSession): boolean {
  return sameProfileServer(session) && identity(session.client.getCurrentUserId()) === identity(session.userId);
}
function check(session: ProfileSession, signal?: AbortSignal): void {
  if (signal?.aborted || !sameProfileSession(session)) throw abort();
}
async function directProfileIds(session: ProfileSession): Promise<Set<string>> {
  try {
    // Jellyfin 12's public UserDto password flags are intentionally not an
    // eligibility signal. Only Cinema's authenticated server check may permit
    // the empty-password path; never probe an account to discover its policy.
    const response = await session.client.getJSON?.(session.client.getUrl('TvItemLayout/ProfileSwitchEligibility'));
    if (!response || typeof response !== 'object' || Array.isArray(response)) return new Set();
    const ids = (response as { ProfileIds?: unknown }).ProfileIds;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && !!id && id.trim() === id)) return new Set();
    return new Set(ids.map(identity));
  } catch { return new Set(); }
}
export async function publicProfiles(session: ProfileSession, signal?: AbortSignal): Promise<PublicProfile[]> {
  check(session, signal);
  const users = await session.client.getPublicUsers();
  check(session, signal);
  if (!Array.isArray(users)) throw new Error('O Jellyfin não conseguiu carregar os perfis públicos. Tente novamente.');
  const eligible = await directProfileIds(session);
  check(session, signal);
  return users.filter(user => typeof user?.Id === 'string' && !!user.Id && typeof user.Name === 'string' && !!user.Name)
    .map(user => ({
      Id: user.Id, Name: user.Name, CanSwitchDirectly: eligible.has(identity(user.Id)),
      ...(typeof user.PrimaryImageTag === 'string' ? { PrimaryImageTag: user.PrimaryImageTag } : {})
    }));
}
export function profileImage(session: ProfileSession, profile: PublicProfile): string | undefined {
  if (!profile.PrimaryImageTag || !session.client.getUserImageUrl) return;
  try { return session.client.getUserImageUrl(profile.Id, { type: 'Primary', width: 240, tag: profile.PrimaryImageTag }); } catch { return; }
}

type ServerSelectionShell = { selectServer?: (...args: unknown[]) => unknown };

/** Dashboard.logout finishes credential, query and view cleanup before calling
 * this public shell bridge. webOS's selectServer unloads the server web frame,
 * so route this one completed logout to the captured server's native login.
 * No native cleanup, client identity check or credential hook is replaced. */
function keepServerDuringLogout(session: ProfileSession, start: string, signal: AbortSignal, bypassed: () => void, failed: (error: unknown) => void): () => void {
  const host = window as Window & { NativeShell?: ServerSelectionShell };
  const shell = host.NativeShell, original = shell?.selectServer;
  if (!shell || typeof original !== 'function') return () => { };
  const descriptor = Object.getOwnPropertyDescriptor(shell, 'selectServer');
  let active = true;
  const restore = () => {
    active = false;
    signal.removeEventListener('abort', restore);
    // A different owner may replace the bridge while logout is pending.
    // Never overwrite its newer handler. If it freezes this property, the
    // inactive wrapper still delegates every later call to the native method.
    if (shell.selectServer !== selectServer) return;
    try {
      if (descriptor) Object.defineProperty(shell, 'selectServer', descriptor);
      else delete shell.selectServer;
    } catch { /* The inactive wrapper retains native behavior. */ }
  };
  function selectServer(this: ServerSelectionShell, ...args: unknown[]): unknown {
    const owned = active && !signal.aborted && host.NativeShell === shell
      && sameProfileServer(session) && !session.client.getCurrentUserId() && window.location.hash === start;
    restore();
    if (!owned) { bypassed(); return original!.apply(this, args); }
    try {
      // Jellyfin's native route restores the server context without invoking
      // the TV wrapper's separate server chooser or reloading the document.
      void Promise.resolve(session.dashboard.navigate(`login?serverid=${encodeURIComponent(session.serverId)}`)).catch(failed);
    } catch (error) { failed(error); }
  }
  try {
    if (descriptor && !('value' in descriptor)) throw new Error('Unsupported shell bridge');
    Object.defineProperty(shell, 'selectServer', descriptor ? { ...descriptor, value: selectServer }
      : { value: selectServer, writable: true, enumerable: true, configurable: true });
  } catch {
    throw new ProfileLoginRequired('Este cliente Jellyfin precisa da tela de login padrão para trocar de perfil.');
  }
  signal.addEventListener('abort', restore, { once: true });
  return restore;
}

/** Dashboard.logout is intentionally void. Its login/server navigation happens
 * after ServerConnections.logout, query-cache clearing and native view reset.
 * Wait for that transition; authenticating earlier could log out the new user. */
function signOut(session: ProfileSession, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = window.location.hash;
    let arrived = false, invalid = false, finished = false;
    let restoreServerSelection = () => { };
    const cleanup = () => {
      restoreServerSelection();
      window.removeEventListener('hashchange', changed); window.removeEventListener('popstate', changed);
      document.removeEventListener('viewshow', changed, true);
      window.clearInterval(poll);
    };
    const finish = (error?: unknown) => { if (finished) return; finished = true; cleanup(); if (error) reject(error); else resolve(); };
    const inspect = () => {
      const userId = session.client.getCurrentUserId();
      invalid ||= signal.aborted || !sameProfileServer(session)
        || !!userId && identity(userId) !== identity(session.userId)
        || window.location.hash !== start && !loginRoute();
      // Aborting only cancels the later sign-in. Native logout still owns an
      // unabortable cleanup callback; wait for its completed navigation before
      // releasing the lock. Its transport also owns the network timeout.
      if (arrived && loginRoute() && !userId) finish(invalid ? abort() : undefined);
    };
    const changed = () => { if (loginRoute() && window.location.hash !== start) arrived = true; inspect(); };
    const poll = window.setInterval(inspect, 100);
    window.addEventListener('hashchange', changed); window.addEventListener('popstate', changed);
    document.addEventListener('viewshow', changed, true);
    try {
      check(session, signal);
      restoreServerSelection = keepServerDuringLogout(session, start, signal, () => { invalid = true; }, error => finish(error));
      session.dashboard.logout(); changed();
    } catch (error) { finish(error); }
  });
}

export async function switchPublicProfile(session: ProfileSession, profileId: string, signal: AbortSignal,
  phase: (value: ProfileSwitchPhase) => void): Promise<void> {
  if (switching) throw new Error('O Jellyfin ainda está finalizando a troca de perfil anterior.');
  switching = true;
  try { await performSwitch(session, profileId, signal, phase); }
  finally { switching = false; }
}

async function performSwitch(session: ProfileSession, profileId: string, signal: AbortSignal,
  phase: (value: ProfileSwitchPhase) => void): Promise<void> {
  const start = window.location.hash;
  phase('checking');
  // Re-read the signed-in server eligibility immediately before logout. A
  // profile shown as eligible in an older chooser must not authorize a switch.
  const users = await publicProfiles(session, signal);
  if (window.location.hash !== start) throw abort();
  const profile = users.find(user => identity(user.Id) === identity(profileId));
  if (!profile?.CanSwitchDirectly) throw new ProfileLoginRequired('Esse perfil precisa da tela de login do Jellyfin. As regras de senha e acesso ainda se aplicam.');
  if (identity(profile.Id) === identity(session.userId)) return;
  check(session, signal);
  phase('signing-out');
  await signOut(session, signal);
  if (signal.aborted || !sameProfileServer(session) || !loginRoute() || session.client.getCurrentUserId()) throw abort();
  phase('signing-in');
  // Use ApiClient's exact native authentication request, but defer its existing
  // onAuthenticated hook until the response is still current. Calling the
  // convenience authenticateUserByName method would persist credentials before
  // a cancelled/late response could be checked. The native hook alone owns
  // session persistence; Cinema keeps no passwords or saved-account tokens.
  const result = await session.client.ajax({
    type: 'POST', url: session.client.getUrl('Users/authenticatebyname'),
    data: JSON.stringify({ Username: profile.Name, Pw: '' }), dataType: 'json', contentType: 'application/json'
  });
  if (signal.aborted || !sameProfileServer(session) || !loginRoute() || session.client.getCurrentUserId()) throw abort();
  if (typeof result?.User?.Id !== 'string' || identity(result.User.Id) !== identity(profile.Id)
    || typeof result.ServerId !== 'string' || identity(result.ServerId) !== identity(session.serverId)
    || typeof result.AccessToken !== 'string' || !result.AccessToken.trim()) {
    throw new Error('O Jellyfin retornou um perfil diferente. Faça login novamente.');
  }
  phase('opening');
  await session.client.onAuthenticated!(session.client, result);
  if (signal.aborted || !sameProfileServer(session) || !loginRoute() || identity(session.client.getCurrentUserId()) !== identity(profile.Id)) throw abort();
  session.dashboard.onServerChanged!(profile.Id, result.AccessToken, session.client);
  await session.dashboard.navigate('home');
}
