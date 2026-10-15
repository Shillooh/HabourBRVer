import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowseApi, type BrowseClient } from '../src/browse-api';
import { createJellyfinApi } from '../src/api';
import { dispatchPlayback } from '../src/local-playback';
import type { Item } from '../src/types';

type Request = { path: string; query: Record<string, string | number | boolean> };
const track = (entry: string, Id = 'song'): Item => ({ Id, Name: Id, Type: 'Audio', PlaylistItemId: entry });
const playlist: Item = { Id: 'playlist', Name: 'A playlist', Type: 'Playlist' };
const saved = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown) {
  if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
afterEach(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } saved.clear(); });
function transport(handler: (request: Request) => unknown) {
  const requests: Request[] = [];
  const client: BrowseClient = {
    getUrl: (path, query = {}) => JSON.stringify({ path, query }),
    getJSON: async url => { const request = JSON.parse(url); requests.push(request); return handler(request); },
    getItems: async (user, query) => { assert.equal(user, 'user'); const request = { path: 'Items', query }; requests.push(request); return handler(request) as never; }
  };
  return { client, requests };
}

test('playlist library queries stay account scoped and do not use a music-library ParentId', async () => {
  const { client, requests } = transport(() => ({ Items: [playlist], TotalRecordCount: 1 }));
  const api = createBrowseApi(client, 'user', action => action());
  assert.equal((await api.getMusic({ kind: 'playlists', parentId: 'music-library', search: ' Quiet ', favorite: true, letter: 'Q' })).items[0].Id, 'playlist');
  assert.equal(requests[0].query.UserId, 'user'); assert.equal(requests[0].query.IncludeItemTypes, 'Playlist');
  assert.equal(requests[0].query.SearchTerm, 'Quiet'); assert.equal(requests[0].query.IsFavorite, true);
  assert.equal(requests[0].query.NameStartsWith, 'Q'); assert.ok(!('ParentId' in requests[0].query));
});

test('playlist contents preserve duplicate tracks, entry IDs, server order and the raw pagination cursor', async () => {
  const { client, requests } = transport(() => ({ Items: [track('third'), { ...track('missing'), PlayAccess: 'None' }, track('first')], TotalRecordCount: 9 }));
  const api = createBrowseApi(client, 'user', action => action());
  const result = await api.getPlaylistItems('list/with space', { startIndex: 4, limit: 3 });
  assert.deepEqual(result.items.map(item => [item.Id, item.PlaylistItemId]), [['song', 'third'], ['song', 'first']]);
  assert.equal(result.total, 9); assert.equal(result.nextStartIndex, 7);
  assert.equal(requests[0].path, 'Playlists/list%2Fwith%20space/Items'); assert.equal(requests[0].query.UserId, 'user');
  assert.ok(!('SortBy' in requests[0].query));
  const broken = createBrowseApi(transport(() => ({ Items: [track('')], TotalRecordCount: 1 })).client, 'user', action => action());
  await assert.rejects(broken.getPlaylistItems('playlist'), /invalid playlist entry/i);
});

function bridge() {
  const queues: { items: Item[]; startIndex: number }[] = [];
  const actions: { event: string; data: Record<string, string> }[] = [];
  const pending: Promise<unknown>[] = [];
  const containers: Element[] = [];
  class Element {
    dataset: Record<string, string> = {}; style = {}; children: Element[] = []; parent?: Element;
    isConnected = false; removed = false; attachedCallback?: () => void;
    fetchData?: () => Promise<{ Items: Item[] }>;
    setAttribute() {} addEventListener() {}
    appendChild(child: Element) { this.children.push(child); child.parent = this; }
    dispatchEvent(event: Event) {
      actions.push({ event: event.type, data: { ...this.dataset } });
      if (event.type === 'click' && this.dataset.action === 'playallfromhere') {
        // Native shortcuts.onClick -> playAllFromHere: use the selected sibling
        // index and fetchData's complete queue, not only visible page cards.
        const parent = this.parent!; const index = parent.children.indexOf(this);
        pending.push(parent.fetchData!().then(result => queues.push({ items: result.Items, startIndex: index })));
      }
      event.preventDefault(); return false;
    }
    remove() { this.removed = true; this.isConnected = false; }
  }
  global('MouseEvent', Event);
  global('document', { body: { appendChild: (node: Element) => { node.isConnected = true; } },
    createElement: (_name: string, extension?: string) => { const node = new Element(); if (extension) { node.attachedCallback = () => {}; containers.push(node); } return node; } });
  return { queues, actions, pending, containers };
}
function apiClient(handler: (request: Request) => unknown, currentUser = () => 'user') {
  const { client, requests } = transport(handler);
  global('ApiClient', { ...client, getCurrentUserId: currentUser, serverId: () => 'server' });
  return { api: createJellyfinApi()!, requests };
}

test('playlist playback loads the full ordered queue and selects the exact repeated entry through native click playback', async () => {
  const native = bridge();
  const entries = [track('first'), { ...track('video', 'clip'), Type: 'Video', MediaType: 'Video' }, track('repeat')];
  const { api, requests } = apiClient(({ query }) => ({ Items: entries.slice(Number(query.StartIndex), Number(query.StartIndex) + 2), TotalRecordCount: 3 }));
  await api.playPlaylist(playlist, 'repeat', () => true); await Promise.all(native.pending);
  assert.deepEqual(requests.map(request => request.query.StartIndex), [0, 2]);
  assert.equal(native.actions[0].event, 'click'); assert.equal(native.actions[0].data.action, 'playallfromhere');
  assert.equal(native.actions[0].data.serverid, 'server'); assert.equal(native.actions[0].data.mediatype, 'Audio');
  assert.equal(native.queues[0].startIndex, 2);
  assert.deepEqual(native.queues[0].items.map(item => [item.Id, item.PlaylistItemId]), [['song', 'first'], ['clip', 'video'], ['song', 'repeat']]);
  assert.ok(native.queues[0].items.every(item => (item as Item & { ServerId: string }).ServerId === 'server'));
  assert.ok(native.containers.every(container => container.removed));
});

test('failed, empty, changed or cancelled playlist loads never launch a partial queue', async () => {
  const native = bridge();
  const unavailable = apiClient(({ query }) => { if (query.StartIndex) throw new Error('offline'); return { Items: [track('one')], TotalRecordCount: 2 }; });
  await assert.rejects(unavailable.api.playPlaylist(playlist, undefined, () => true), /offline/);
  const empty = apiClient(() => ({ Items: [], TotalRecordCount: 0 }));
  await assert.rejects(empty.api.playPlaylist(playlist, undefined, () => true), /no available items|disponíveis para reprodução/i);
  const changed = apiClient(() => ({ Items: [track('one')], TotalRecordCount: 1 }));
  await assert.rejects(changed.api.playPlaylist(playlist, 'removed', () => true), /no longer in the playlist/i);
  let user = 'user';
  const switched = apiClient(() => { user = 'other'; return { Items: [track('one')], TotalRecordCount: 1 }; }, () => user);
  await assert.rejects(switched.api.playPlaylist(playlist, undefined, () => true), /account changed/i);
  const cancelled = apiClient(() => ({ Items: [track('one')], TotalRecordCount: 1 }));
  await assert.rejects(cancelled.api.playPlaylist(playlist, undefined, () => false), /closed/i);
  assert.equal(native.actions.length, 0);
});

test('native Playlist playback does not invent an Audio media type for an unknown or video playlist', async () => {
  const native = bridge();
  await dispatchPlayback({ serverId: () => 'server' }, playlist, 0, () => true);
  await dispatchPlayback({ serverId: () => 'server' }, { ...playlist, MediaType: 'Video' }, 0, () => true);
  assert.ok(!('mediatype' in native.actions[0].data)); assert.equal(native.actions[0].data.isfolder, 'true');
  assert.equal(native.actions[1].data.mediatype, 'Video');
});
