import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

import { html } from 'lit';

import { litBinding, litText } from '../../testing/lit-text.js';

import {
  COLLAPSIBLE_PANEL_HEADER_HEIGHT,
  collapsiblePanelOpen,
  renderCollapsiblePanel,
  toggleCollapsiblePanel,
} from './collapsible-panel.js';

const original = new Map(
  ['localStorage', 'location', 'history'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
const location = { hash: '#runs' };
const history = {
  state: null,
  pushState: (_data: unknown, _unused: string, url: string) => {
    location.hash = url;
  },
  replaceState: (_data: unknown, _unused: string, url: string) => {
    location.hash = url;
  },
};
Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
Object.defineProperty(globalThis, 'history', { configurable: true, value: history });
const values = new Map<string, string>();
let storageThrows = false;
const storage = {
  getItem: (key: string) => {
    if (storageThrows) throw new Error('blocked');
    return values.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    if (storageThrows) throw new Error('blocked');
    values.set(key, value);
  },
  removeItem: (key: string) => {
    values.delete(key);
  },
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
beforeEach(() => {
  location.hash = '#runs';
  values.clear();
  storageThrows = false;
});
after(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a panel opens as its default until the viewer chooses', () => {
  assert.equal(collapsiblePanelOpen('default-open', true), true);
  assert.equal(collapsiblePanelOpen('default-closed', false), false);
});

test('a URL choice wins over the configured default, keyed by panel id', () => {
  location.hash = '#runs?panels=stored-open,!stored-closed';
  values.set('cc:panel-open:stored-open', '1');
  values.set('cc:panel-open:stored-closed', '0');
  assert.equal(collapsiblePanelOpen('stored-open', false), true);
  assert.equal(collapsiblePanelOpen('stored-closed', true), false);
});

test('a toggle persists for the next page load', () => {
  assert.equal(toggleCollapsiblePanel('persisted', false), true);
  assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('panels'), 'persisted');
  assert.equal(toggleCollapsiblePanel('persisted', false), false);
  assert.equal(new URLSearchParams(location.hash.split('?')[1]).has('panels'), false);
});

test('blocked storage falls back to the default and still toggles', () => {
  storageThrows = true;
  try {
    assert.equal(collapsiblePanelOpen('blocked', true), true);
    assert.equal(toggleCollapsiblePanel('blocked', true), false);
    assert.equal(collapsiblePanelOpen('blocked', true), false);
  } finally {
    storageThrows = false;
  }
});

test('a collapsed panel shows its header and summary but not its body', () => {
  let rendered = 0;
  const panel = (open: boolean) =>
    renderCollapsiblePanel({
      id: 'run-artifacts',
      label: 'Artifacts',
      summary: '12',
      open,
      onToggle: () => {},
      body: () => {
        rendered++;
        return html`<div data-body></div>`;
      },
    });
  const closed = litText(panel(false));
  assert.match(closed, /data-panel="run-artifacts"/);
  assert.match(closed, /Artifacts/);
  assert.match(closed, /\(12\)/);
  assert.doesNotMatch(closed, /data-body/);
  assert.equal(rendered, 0, 'a collapsed body is never rendered');
  const open = litText(panel(true));
  assert.match(open, /data-body/);
  assert.match(open, /\(12\)/);
  assert.equal(litBinding(panel(false), 'data-testid='), 'run-artifacts-toggle');
});

test('the header is the same fixed height open and closed', () => {
  const style = (open: boolean) =>
    litText(
      renderCollapsiblePanel({
        id: 'height',
        label: 'Grade',
        summary: 'a long rationale that must stay on one line',
        open,
        onToggle: () => {},
        body: () => html`<p>body</p>`,
      }),
    ).match(/<button[\s\S]*?style="([^"]*)"/)?.[1] ?? '';
  for (const open of [true, false]) {
    assert.match(
      style(open),
      new RegExp(`height:${COLLAPSIBLE_PANEL_HEADER_HEIGHT}; box-sizing:border-box;`),
    );
  }
});

test('the URL owns panel choices and a default choice stays out of the link', () => {
  location.hash = '#runs?run=run-1&round=review-2';
  values.set('cc:panel-open:run-review-history', '1');
  assert.equal(
    collapsiblePanelOpen('run-review-history', false),
    false,
    'an absent URL choice is the configured default',
  );
  assert.equal(toggleCollapsiblePanel('run-review-history', false), true);
  const params = new URLSearchParams(location.hash.split('?')[1]);
  assert.equal(params.get('panels'), 'run-review-history');
  assert.equal(params.get('run'), 'run-1');
  assert.equal(params.get('round'), 'review-2');
  assert.equal(toggleCollapsiblePanel('run-review-history', false), false);
  assert.equal(new URLSearchParams(location.hash.split('?')[1]).has('panels'), false);
});
