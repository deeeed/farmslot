import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rememberRunWorkerPanel,
  runWorkerPanelOpen,
  toggleRunWorkerPanel,
} from './run-worker-panel-preferences.js';

test('worker disclosures round-trip through the URL, retain run binding and omit defaults', (t) => {
  const descriptors = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { hash: '#runs?run=run-a' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      pushState(_data: unknown, _title: string, url: string) {
        location.hash = url;
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  assert.equal(runWorkerPanelOpen('owner', 'run-a', 'conversation'), false);
  assert.equal(toggleRunWorkerPanel('owner', 'run-a', 'conversation'), true);
  const selected = location.hash;
  assert.match(selected, /workers=run-a%3Aconversation/);
  assert.equal(runWorkerPanelOpen('owner', 'run-b', 'conversation'), false);
  assert.equal(runWorkerPanelOpen('owner', 'run-a', 'terminal'), false);
  assert.equal(runWorkerPanelOpen(undefined, 'run-a', 'conversation'), false);
  assert.equal(toggleRunWorkerPanel('owner', 'run-a', 'conversation'), false);
  assert.equal(location.hash, '#runs?run=run-a');
  location.hash = selected;
  assert.equal(runWorkerPanelOpen('owner', 'run-a', 'conversation'), true);
  rememberRunWorkerPanel(undefined, 'run-a', 'conversation', false);
  assert.equal(location.hash, selected);
});
