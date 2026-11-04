import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

mock.module('../shared/media-lightbox.js', { namedExports: { openMediaLightbox() {} } });
mock.module('../../gateway-client.js', {
  namedExports: { gateway: { connectionState: 'disconnected' } },
});
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => undefined,
    getResourceWorkspaceAccess: () => 'farm',
    getResourceWorkspaceKey: () => undefined,
    subscribeResourceCache: () => () => undefined,
  },
});
const { RunCompare } = await import('./run-compare.js');

test('a requested comparison step survives loading both runs', (t) => {
  const original = new Map(
    ['location', 'history'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const location = { hash: '#runs/compare?a=first&b=second&compareStep=review' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      pushState(_data: unknown, _title: string, url: string) {
        location.hash = url;
      },
    },
  });
  const view = new RunCompare();
  view.runIdA = 'first';
  view.runIdB = 'second';
  const bindings = Reflect.get(view, 'displayChoices');
  bindings.hostConnected();
  t.after(() => {
    bindings.hostDisconnected();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  Reflect.get(view, 'observeRuns').call(view);
  Reflect.get(view, 'syncFamily').call(view);
  bindings.hostUpdate();
  assert.equal(Reflect.get(view, 'selectedStepName'), 'review');
  assert.match(location.hash, /compareStep=review/);
});
