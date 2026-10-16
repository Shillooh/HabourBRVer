import { HomeCollectionSyncError, boundedHomeSettings, homeCollectionSnapshot, type HomeCollectionTransport } from './home-collection-store';

type Client = {
  getUrl(path: string): string;
  getJSON(url: string): Promise<unknown>;
  ajax(options: { type: 'PUT' | 'POST' | 'DELETE'; url: string; data?: string; contentType?: 'application/json'; dataType?: 'json'; headers?: Record<string, string> }): Promise<unknown>;
};

/** The current native client alone supplies authentication. No user ID is sent
 * to the endpoint: the server resolves the owner from the authenticated session. */
export function createHomeCollectionTransport(client: Client, isCurrent: () => boolean, scope: 'user' | 'global' = 'user', targetUserId?: string): HomeCollectionTransport {
  const current = () => { if (!isCurrent()) throw new HomeCollectionSyncError('stale', 'Your Jellyfin account changed. Reopen collection rows for the current account.'); };
  const basePath = targetUserId
    ? `TvItemLayout/HomeCollections/User/${encodeURIComponent(targetUserId)}`
    : (scope === 'global' ? 'TvItemLayout/HomeCollections/Global' : 'TvItemLayout/HomeCollections');
  const request = async (operation: () => Promise<unknown>) => {
    current();
    try { const result = await operation(); current(); return homeCollectionSnapshot(result); }
    catch (error) {
      current();
      if (error instanceof HomeCollectionSyncError) throw error;
      const response = error as { status?: number; statusCode?: number; response?: { status?: number } } | null;
      const status = response?.status || response?.statusCode || response?.response?.status;
      if (status === 409) throw new HomeCollectionSyncError('conflict', 'Collection rows changed on another device. Reload saved rows to review them before saving. Your current draft has not been saved.');
      if (status === 401 || status === 403) throw new HomeCollectionSyncError('unavailable', 'Sign in again to sync collection rows. Your changes have not been saved.');
      if (status === 404) throw new HomeCollectionSyncError('unavailable', 'Update ScreenHarbour on the server to sync collection rows. Your changes have not been saved.');
      if (status === 413) throw new HomeCollectionSyncError('invalid', 'These collection rows are too large to sync. Reduce custom item orders and try again. Your changes have not been saved.');
      throw new HomeCollectionSyncError('unavailable', 'Collection rows could not sync with Jellyfin. Check your connection and try again. Your changes have not been saved.');
    }
  };
  return {
    isCurrent,
    load: () => request(() => client.getJSON(client.getUrl(basePath))),
    save: (settings, revision) => request(() => client.ajax({ type: 'PUT', url: client.getUrl(basePath),
      data: JSON.stringify({ Revision: revision, Settings: boundedHomeSettings(settings) }), contentType: 'application/json', dataType: 'json',
      headers: { 'X-ScreenHarbour-Home-Rows': '6' } })),
    resetUserOverride: () => request(() => client.ajax({
      type: 'DELETE',
      url: client.getUrl(targetUserId ? `TvItemLayout/HomeCollections/User/${encodeURIComponent(targetUserId)}` : 'TvItemLayout/HomeCollections/User'),
      contentType: 'application/json', dataType: 'json'
    })),
    resetAllUsers: () => client.ajax({ type: 'POST', url: client.getUrl('TvItemLayout/HomeCollections/ResetAllUsers') }).then(() => {})
  };
}
