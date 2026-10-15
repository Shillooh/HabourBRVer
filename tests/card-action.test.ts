import test from 'node:test';
import assert from 'node:assert/strict';
import { isCardAction } from '../src/dom';

type MockNode = {
  tag: string;
  classes: Set<string>;
  attrs: Map<string, string>;
  parent: MockNode | null;
  children: MockNode[];
  closest: (selector: string) => MockNode | null;
  contains: (other: MockNode | null) => boolean;
};

function createMockNode(tag: string, className = '', attrs: Record<string, string> = {}): MockNode {
  const classes = new Set(className.split(/\s+/).filter(Boolean));
  const nodeAttrs = new Map(Object.entries(attrs));
  const node: MockNode = {
    tag: tag.toLowerCase(),
    classes,
    attrs: nodeAttrs,
    parent: null,
    children: [],
    closest(selector: string): MockNode | null {
      // Split selectors by comma
      const parts = selector.split(',').map(s => s.trim());
      let current: MockNode | null = this;
      while (current) {
        for (const part of parts) {
          if (matches(current, part)) return current;
        }
        current = current.parent;
      }
      return null;
    },
    contains(other: MockNode | null): boolean {
      let current = other;
      while (current) {
        if (current === this) return true;
        current = current.parent;
      }
      return false;
    }
  };
  return node;
}

function append(parent: MockNode, ...children: MockNode[]): void {
  for (const child of children) {
    child.parent = parent;
    parent.children.push(child);
  }
}

function matches(node: MockNode, selector: string): boolean {
  if (selector === 'button') return node.tag === 'button';
  if (selector === '[role="button"]') return node.attrs.get('role') === 'button';
  if (selector.startsWith('.')) {
    const cls = selector.slice(1);
    return node.classes.has(cls);
  }
  return false;
}

test('isCardAction returns false when target is the card itself or its media children', () => {
  const card = createMockNode('button', 'tvl-library-card');
  const cover = createMockNode('div', 'tvl-library-art');
  const img = createMockNode('img');
  const caption = createMockNode('div', 'tvl-library-caption');
  const title = createMockNode('h3');
  append(cover, img);
  append(caption, title);
  append(card, cover, caption);

  assert.equal(isCardAction(card as unknown as HTMLElement, card as unknown as HTMLElement), false);
  assert.equal(isCardAction(img as unknown as HTMLElement, card as unknown as HTMLElement), false);
  assert.equal(isCardAction(cover as unknown as HTMLElement, card as unknown as HTMLElement), false);
  assert.equal(isCardAction(title as unknown as HTMLElement, card as unknown as HTMLElement), false);
  assert.equal(isCardAction(caption as unknown as HTMLElement, card as unknown as HTMLElement), false);
});

test('isCardAction returns true when clicking an action button or overlay inside a card', () => {
  const card = createMockNode('button', 'tvl-home-row-card');
  const overlayBtn = createMockNode('button', 'cardOverlayButton');
  const icon = createMockNode('i');
  append(overlayBtn, icon);
  append(card, overlayBtn);

  assert.equal(isCardAction(overlayBtn as unknown as HTMLElement, card as unknown as HTMLElement), true);
  assert.equal(isCardAction(icon as unknown as HTMLElement, card as unknown as HTMLElement), true);
});

test('isCardAction returns true for action controls like context menu or admin item', () => {
  const card = createMockNode('div', 'tvl-collection-card');
  const optionsBtn = createMockNode('div', 'btnCardOptions');
  const adminBtn = createMockNode('button', 'tvl-admin-item');
  append(card, optionsBtn, adminBtn);

  assert.equal(isCardAction(optionsBtn as unknown as HTMLElement, card as unknown as HTMLElement), true);
  assert.equal(isCardAction(adminBtn as unknown as HTMLElement, card as unknown as HTMLElement), true);
});
