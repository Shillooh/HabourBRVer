import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProviderHomes } from '../src/provider-settings';
import { defaultLoadingScreen } from '../src/loading-settings';
import type { MediaApi } from '../src/types';

// Minimal DOM mock for Node test runner
class MockElement extends EventTarget {
  className = '';
  style = {
    setProperty: (_k: string, _v: string) => {},
    getPropertyValue: (_k: string) => ''
  };
  attributes = new Map<string, string>();
  dataset: Record<string, string | undefined> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  private _textContent = '';
  get textContent(): string {
    if (this._textContent) return this._textContent;
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v: string) {
    this._textContent = v;
  }

  innerHTML = '';
  disabled = false;
  hidden = false;
  value = '';
  checked = false;
  type = '';
  min = '';
  max = '';
  step = '';
  maxLength = 100;
  selectedIndex = 0;
  options: MockElement[] = [];

  constructor(public tagName: string) {
    super();
  }

  get classList() {
    return {
      _classes: new Set(this.className.split(/\s+/).filter(Boolean)),
      add: (...names: string[]) => {
        names.forEach(n => this.classList._classes.add(n));
        this.className = Array.from(this.classList._classes).join(' ');
      },
      remove: (...names: string[]) => {
        names.forEach(n => this.classList._classes.delete(n));
        this.className = Array.from(this.classList._classes).join(' ');
      },
      contains: (name: string) => this.className.split(/\s+/).includes(name)
    };
  }

  append(...children: (MockElement | string)[]) {
    for (const child of children) {
      if (typeof child === 'string') {
        const textNode = new MockElement('span');
        textNode.textContent = child;
        textNode.parentElement = this;
        this.children.push(textNode);
      } else {
        child.parentElement = this;
        this.children.push(child);
      }
    }
  }

  prepend(...children: (MockElement | string)[]) {
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (typeof child === 'string') {
        const textNode = new MockElement('span');
        textNode.textContent = child;
        textNode.parentElement = this;
        this.children.unshift(textNode);
      } else {
        child.parentElement = this;
        this.children.unshift(child);
      }
    }
  }

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
  }

  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  hasAttribute(k: string): boolean {
    return this.attributes.has(k);
  }

  removeAttribute(k: string) {
    this.attributes.delete(k);
  }

  focus() {
    if (globalThis.document) (globalThis.document as unknown as { activeElement: MockElement }).activeElement = this;
  }

  click() {
    this.dispatchEvent(new Event('click'));
  }

  private matchesSelector(selector: string): boolean {
    const s = selector.trim();
    if (s.startsWith('.')) return this.className.split(/\s+/).includes(s.slice(1));
    if (s.startsWith('#')) return this.getAttribute('id') === s.slice(1);
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1);
      if (inner.includes('=')) {
        const [k, v] = inner.split('=');
        const cleanV = v.replace(/^['"]|['"]$/g, '');
        if (k.startsWith('data-')) {
          const camel = k.slice(5).replace(/-([a-z])/g, (_, g) => g.toUpperCase());
          return this.dataset[camel] === cleanV || this.dataset[k.slice(5)] === cleanV;
        }
        return this.getAttribute(k) === cleanV;
      }
      return this.hasAttribute(inner);
    }
    return this.tagName.toLowerCase() === s.toLowerCase();
  }

  querySelector<T extends MockElement = MockElement>(selector: string): T | null {
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      const first = this.querySelector(parts[0]);
      return first ? first.querySelector<T>(parts.slice(1).join(' ')) : null;
    }
    for (const child of this.children) {
      if (child.matchesSelector(selector)) return child as T;
      const found = child.querySelector<T>(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll<T extends MockElement = MockElement>(selector: string): T[] {
    const parts = selector.trim().split(/\s+/);
    if (parts.length > 1) {
      const firsts = this.querySelectorAll(parts[0]);
      const res: T[] = [];
      for (const f of firsts) res.push(...f.querySelectorAll<T>(parts.slice(1).join(' ')));
      return res;
    }
    const results: T[] = [];
    const selectors = selector.split(',').map(part => part.trim());
    const walk = (node: MockElement) => {
      for (const child of node.children) {
        if (selectors.some(sel => child.matchesSelector(sel))) {
          results.push(child as T);
        }
        walk(child);
      }
    };
    walk(this);
    return results;
  }

  closest<T extends MockElement = MockElement>(selector: string): T | null {
    let curr: MockElement | null = this;
    while (curr) {
      if (curr.matchesSelector(selector)) return curr as T;
      curr = curr.parentElement;
    }
    return null;
  }
}

const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
function setGlobal(name: string, value: unknown) {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function restoreGlobals() {
  for (const [name, desc] of savedGlobals) {
    if (desc) Object.defineProperty(globalThis, name, desc);
    else Reflect.deleteProperty(globalThis, name);
  }
  savedGlobals.clear();
}

function setupDom() {
  const body = new MockElement('body');
  const doc = Object.assign(new EventTarget(), {
    body,
    documentElement: new MockElement('html'),
    activeElement: body,
    createElement: (tag: string) => {
      if (tag === 'button') {
        const b = new MockElement('button');
        b.type = 'button';
        return b;
      }
      if (tag === 'input') return new MockElement('input');
      if (tag === 'select') return new MockElement('select');
      return new MockElement(tag);
    },
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s)
  });

  const win = Object.assign(new EventTarget(), {
    location: { hash: '#/cinema-providers?cinemaGlobal=1', search: '', pathname: '', origin: 'http://localhost' },
    history: { replaceState: () => {}, state: null },
    localStorage: {
      _data: new Map<string, string>(),
      getItem(k: string) { return this._data.get(k) ?? null; },
      setItem(k: string, v: string) { this._data.set(k, v); },
      removeItem(k: string) { this._data.delete(k); },
      clear() { this._data.clear(); }
    },
    dispatchEvent: () => true
  });

  setGlobal('document', doc);
  setGlobal('window', win);
  setGlobal('localStorage', win.localStorage);
  setGlobal('location', win.location);
  setGlobal('history', win.history);
  setGlobal('HTMLButtonElement', MockElement);
  setGlobal('HTMLInputElement', MockElement);
  setGlobal('HTMLSelectElement', MockElement);
  setGlobal('HTMLElement', MockElement);

  return { doc, win };
}

function createMockApi(overrides: Record<string, unknown> = {}): MediaApi {
  const getUrl = (p: string) => p;
  const getJSON = async (url: string) => {
    if (url.includes('TvItemLayout/ProviderHomes/Global') || url.includes('TvItemLayout/ProviderHomes/User/')) {
      return { Revision: null, Settings: null, HasUserOverride: false, GlobalRevision: null };
    }
    if (url.includes('TvItemLayout/ProviderHomes/Users') || url.includes('TvItemLayout/LoadingScreen/Users')) {
      return [{ Id: 'target-user-456', Name: 'Usuario 1' }, { Id: 'target-user-789', Name: 'Usuario 2' }];
    }
    if (url === 'TvItemLayout/ProviderHomes') {
      return { Revision: 'admin-rev-1', Settings: defaultProviderHomes(), HasUserOverride: true };
    }
    if (url.includes('TvItemLayout/LoadingScreen/Global') || url.includes('TvItemLayout/LoadingScreen/User/')) {
      return { Revision: null, Settings: null, HasUserOverride: false, GlobalRevision: null };
    }
    if (url === 'TvItemLayout/LoadingScreen') {
      return { Revision: 'admin-load-1', Settings: defaultLoadingScreen(), HasUserOverride: true };
    }
    return null;
  };
  const ajax = async (opts: { type: string; url: string; data?: string }) => {
    if (opts.url.includes('ProviderHomes')) {
      return { Revision: 'saved-rev-123', Settings: defaultProviderHomes(), HasUserOverride: true };
    }
    if (opts.url.includes('LoadingScreen')) {
      return { Revision: 'saved-load-123', Settings: defaultLoadingScreen(), HasUserOverride: true };
    }
    return { success: true };
  };

  const client = {
    getCurrentUserId: () => 'admin-user',
    serverId: () => 'server-1',
    getUrl,
    getJSON,
    ajax,
    ...overrides
  };
  setGlobal('ApiClient', client);

  return {
    serverId: 'server-1',
    userId: 'admin-user',
    getCollectionList: async () => [],
    getSeriesItems: async () => ({ Items: [], TotalRecordCount: 0 }),
    getLibraryItems: async () => ({ Items: [], TotalRecordCount: 0 }),
    getWatchlist: async () => [],
    ...overrides
  } as unknown as MediaApi;
}

test('ProviderSettingsEditor in Global mode: form controls, sidebar and save button are not disabled', async () => {
  setupDom();
  try {
    const { ProviderSettingsEditor } = await import('../src/provider-settings-editor');
    const api = createMockApi();
    const editor = new ProviderSettingsEditor(api, {
      onBack: () => {},
      loadPreview: async () => [],
      scope: 'global'
    });

    await editor.load();

    const root = editor.element as unknown as MockElement;

    // Check save button
    const saveButton = root.querySelector('[data-provider-settings-focus="save"]');
    assert.ok(saveButton, 'Save button must exist');
    assert.equal(saveButton.disabled, false, 'Save button must NOT be disabled in Global mode');
    assert.equal(saveButton.textContent.includes('Salvar Padrão Global'), true);

    // Check sidebar service buttons
    const sidebar = root.querySelector('.tvl-provider-settings-sidebar');
    assert.ok(sidebar, 'Sidebar must exist');
    const sidebarButtons = sidebar.querySelectorAll('button');
    assert.ok(sidebarButtons.length > 0, 'Sidebar must render service buttons');
    for (const btn of sidebarButtons) {
      if (btn.dataset.providerSettingsFocus !== 'add-service') {
        assert.equal(btn.disabled, false, `Sidebar button "${btn.textContent}" must not be disabled`);
      }
    }

    // Check workspace inputs (checkboxes, text inputs)
    const workspace = root.querySelector('.tvl-provider-settings-workspace');
    assert.ok(workspace, 'Workspace must exist');
    const inputs = workspace.querySelectorAll('input');
    assert.ok(inputs.length > 0, 'Workspace must contain inputs');
    for (const input of inputs) {
      if (input.disabled) {
        console.log('Disabled input found:', input.type, input.dataset.providerSettingsFocus, input.className);
      }
      assert.equal(input.disabled, false, `Input "${input.dataset.providerSettingsFocus || input.type}" must not be disabled`);
    }
  } finally {
    restoreGlobals();
  }
});

test('ProviderSettingsEditor with targetUserId: controls and dynamic button are active for specific user', async () => {
  setupDom();
  try {
    const { ProviderSettingsEditor } = await import('../src/provider-settings-editor');
    const api = createMockApi();
    const editor = new ProviderSettingsEditor(api, {
      onBack: () => {},
      loadPreview: async () => [],
      targetUserId: 'target-user-456'
    });

    await editor.load();
    const root = editor.element as unknown as MockElement;

    const saveButton = root.querySelector('[data-provider-settings-focus="save"]');
    assert.ok(saveButton, 'Save button must exist');
    assert.equal(saveButton.disabled, false, 'Save button must not be disabled for target user');

    const sidebar = root.querySelector('.tvl-provider-settings-sidebar');
    assert.ok(sidebar, 'Sidebar must exist');
    const sidebarButtons = sidebar.querySelectorAll('button');
    assert.ok(sidebarButtons.length > 0, 'Sidebar buttons must exist');
    for (const btn of sidebarButtons) {
      if (btn.dataset.providerSettingsFocus !== 'add-service') {
        assert.equal(btn.disabled, false, `Sidebar button "${btn.textContent}" must not be disabled for target user`);
      }
    }
  } finally {
    restoreGlobals();
  }
});

test('LoadingSettingsEditor in Global and User target modes: inputs, choices and save button are fully interactive', async () => {
  setupDom();
  try {
    const { LoadingSettingsEditor } = await import('../src/loading-settings-editor');
    const api = createMockApi();

    // Test Global mode
    const globalEditor = new LoadingSettingsEditor(api, {
      onBack: () => {},
      scope: 'global'
    });
    await globalEditor.load();
    const globalRoot = globalEditor.element as unknown as MockElement;

    const globalSave = globalRoot.querySelector('.tvl-primary');
    assert.ok(globalSave, 'Save button in global loading editor must exist');
    assert.equal(globalSave.disabled, false, 'Save button in global loading editor must not be disabled');

    const inputs = globalRoot.querySelectorAll('.tvl-loading-settings-fields input');
    assert.ok(inputs.length >= 2, 'Brand and Message inputs must exist');
    assert.equal(inputs[0].disabled, false, 'Brand input must not be disabled');
    assert.equal(inputs[1].disabled, false, 'Message input must not be disabled');

    const choices = globalRoot.querySelectorAll('.tvl-loading-choice');
    assert.ok(choices.length > 0, 'Choices must exist');
    for (const choice of choices) {
      assert.equal(choice.disabled, false, 'Animation choice button must not be disabled');
    }

    // Test Target User mode
    const userEditor = new LoadingSettingsEditor(api, {
      onBack: () => {},
      targetUserId: 'target-user-456'
    });
    await userEditor.load();
    const userRoot = userEditor.element as unknown as MockElement;

    const userSave = userRoot.querySelector('.tvl-primary');
    assert.ok(userSave, 'Save button for target user must exist');
    assert.equal(userSave.disabled, false, 'Save button for target user must not be disabled');
  } finally {
    restoreGlobals();
  }
});
