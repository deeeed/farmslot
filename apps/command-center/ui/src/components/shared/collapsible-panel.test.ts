import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { html } from 'lit';

import { litBinding, litText } from '../../testing/lit-text.js';

import {
  COLLAPSIBLE_PANEL_HEADER_HEIGHT,
  collapsiblePanelOpen,
  renderCollapsiblePanel,
  toggleCollapsiblePanel,
} from './collapsible-panel.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
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
after(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('a panel opens as its default until the viewer chooses', () => {
  assert.equal(collapsiblePanelOpen('default-open', true), true);
  assert.equal(collapsiblePanelOpen('default-closed', false), false);
});

test('a stored choice wins over the default, keyed by panel id', () => {
  values.set('cc:panel-open:stored-open', '1');
  values.set('cc:panel-open:stored-closed', '0');
  assert.equal(collapsiblePanelOpen('stored-open', false), true);
  assert.equal(collapsiblePanelOpen('stored-closed', true), false);
});

test('a toggle persists for the next page load', () => {
  assert.equal(toggleCollapsiblePanel('persisted', false), true);
  assert.equal(values.get('cc:panel-open:persisted'), '1');
  assert.equal(toggleCollapsiblePanel('persisted', false), false);
  assert.equal(values.get('cc:panel-open:persisted'), '0');
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
