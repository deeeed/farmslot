import assert from 'node:assert/strict';
import test from 'node:test';

import { rememberRunWorkerPanel, runWorkerPanelOpen } from './run-worker-panel-preferences.js';

test('disclosures default closed and remember choices only for their owner, run and panel', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  assert.equal(runWorkerPanelOpen('owner-a', 'run-a', 'conversation'), false);
  rememberRunWorkerPanel('owner-a', 'run-a', 'conversation', true);
  assert.equal(runWorkerPanelOpen('owner-a', 'run-a', 'conversation'), true);
  assert.equal(runWorkerPanelOpen('owner-b', 'run-a', 'conversation'), false);
  assert.equal(runWorkerPanelOpen('owner-a', 'run-b', 'conversation'), false);
  assert.equal(runWorkerPanelOpen('owner-a', 'run-a', 'terminal'), false);
  rememberRunWorkerPanel('owner-a', 'run-a', 'conversation', false);
  assert.equal(runWorkerPanelOpen('owner-a', 'run-a', 'conversation'), false);
  const count = values.size;
  rememberRunWorkerPanel(undefined, 'run-a', 'conversation', true);
  assert.equal(values.size, count);
  assert.equal(runWorkerPanelOpen(undefined, 'run-a', 'conversation'), false);
});
