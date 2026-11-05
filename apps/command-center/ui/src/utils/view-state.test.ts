import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveController, ReactiveControllerHost } from 'lit';

import { viewTextField, viewToggleField } from '@farmslot/protocol';

import { browserViewState, viewBinding, ViewStateBindings } from './view-state.js';

class Host implements ReactiveControllerHost {
  readonly controllers = new Set<ReactiveController>();
  readonly updateComplete = Promise.resolve(true);
  updates = 0;
  addController(controller: ReactiveController) {
    this.controllers.add(controller);
  }
  removeController(controller: ReactiveController) {
    this.controllers.delete(controller);
  }
  requestUpdate() {
    this.updates++;
  }
}

test('configured fields restore before render and persist a control update atomically', (t) => {
  const original = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { hash: '#runs?run=kept&choice=timeline' };
  const entries: string[] = [];
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      pushState(_data: unknown, _title: string, url: string) {
        location.hash = url;
        entries.push(url);
      },
    },
  });
  const host = new Host();
  let choice = 'evidence',
    query = '',
    restored = 0;
  const bindings = new ViewStateBindings(
    host,
    [
      viewBinding(
        viewTextField('choice', 'evidence'),
        () => choice,
        (value) => {
          choice = value;
        },
      ),
      viewBinding(
        viewTextField('q'),
        () => query,
        (value) => {
          query = value;
        },
      ),
    ],
    () => restored++,
  );
  t.after(() => {
    bindings.hostDisconnected();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  bindings.hostConnected();
  assert.equal(choice, 'timeline', 'restoration needs no later render or effect');
  assert.equal(restored, 1);
  choice = 'files';
  query = 'round';
  bindings.hostUpdate();
  assert.equal(entries.length, 1, 'sibling choices share one history entry');
  assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('run'), 'kept');
  assert.equal(restored, 1, 'our own history write does not restart display reads');
  location.hash = '#runs?run=kept';
  bindings.restore();
  assert.equal(choice, 'evidence');
  assert.equal(query, '');
  bindings.hostUpdate();
  assert.equal(entries.length, 1, 'restored defaults are not rewritten');
  bindings.hostDisconnected();
  browserViewState.set(viewTextField('choice', 'evidence'), 'other');
  assert.equal(choice, 'evidence', 'a disconnected host receives no route updates');
  const sidebar = viewToggleField('panels', 'sidebar', false);
  browserViewState.set(sidebar, true);
  assert.equal(sidebar.read(new URLSearchParams(location.hash.split('?')[1])), true);
  browserViewState.set(sidebar, false);
  assert.equal(
    sidebar.read(new URLSearchParams(location.hash.split('?')[1])),
    false,
    'a collapsed default must not inherit the old expanded value',
  );
});
