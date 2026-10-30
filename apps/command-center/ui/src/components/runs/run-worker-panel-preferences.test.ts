import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rememberRunWorkerPanel,
  runWorkerPanelOpen,
  toggleRunWorkerPanel,
} from './run-worker-panel-preferences.js';

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
  assert.equal(values.size, 0, 'Closing removes the default-valued durable preference');
  const count = values.size;
  rememberRunWorkerPanel(undefined, 'run-a', 'conversation', true);
  assert.equal(values.size, count);
  assert.equal(runWorkerPanelOpen(undefined, 'run-a', 'conversation'), false);
});

test('disclosure remains interactive when browser storage refuses both reads and writes', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('Storage is blocked');
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  assert.equal(toggleRunWorkerPanel('blocked-owner', 'run-a', 'conversation'), true);
  assert.equal(runWorkerPanelOpen('blocked-owner', 'run-a', 'conversation'), true);
  assert.equal(runWorkerPanelOpen('another-owner', 'run-a', 'conversation'), false);
  assert.equal(toggleRunWorkerPanel('blocked-owner', 'run-a', 'conversation'), false);
  assert.equal(runWorkerPanelOpen('blocked-owner', 'run-a', 'conversation'), false);
});
