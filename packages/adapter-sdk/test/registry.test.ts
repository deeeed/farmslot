import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADAPTER_SDK_VERSION,
  createAdapterRegistry,
  defineAdapter,
  type PlatformAdapter,
} from '../src/index.js';

function adapter(id: string, extra: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    id,
    sdkVersion: ADAPTER_SDK_VERSION,
    headless: true,
    resolveSlotPorts() {},
    runtimeStatus: async () => ({ decision: 'ready', reasons: [] }),
    devServer: {
      label: 'none',
      describe: () => 'no dev server',
      stop: () => ({ kind: 'headless', message: 'nothing to stop', userAction: 'run a recipe' }),
    },
    logSources: () => [],
    appLogSource: () => null,
    hints: { launch: 'launch', relaunch: 'relaunch', runtimeProbeRecovery: () => 'recover' },
    actions: {
      manifestPath: () => 'manifest.json',
      semantic: [],
      cdpTarget: { transport: 'none', probePath: '/json/version' },
    },
    harness: {
      install: { entry: 'install.sh', fallback: 'install.sh' },
      cleanup: { entry: 'cleanup.sh', fallback: 'cleanup.sh' },
      verify: () => ({ error: 'no verify' }),
    },
    runtimeContext: { forbiddenFields: [] },
    ...extra,
  };
}

test('lists adapters in registration order and returns the registered object', () => {
  const registry = createAdapterRegistry();
  const web = adapter('web');
  registry.register(web);
  registry.register(adapter('node'));
  assert.deepEqual(registry.list(), ['web', 'node']);
  assert.equal(registry.get('web'), web);
  assert.equal(registry.has('node'), true);
  assert.equal(registry.has('rn'), false);
});

test('refuses a duplicate id and names the registered ones for an unknown id', () => {
  const registry = createAdapterRegistry();
  registry.register(adapter('web'));
  assert.throws(() => registry.register(adapter('web')), {
    message: "adapter 'web' is already registered",
  });
  assert.throws(() => registry.get('rn'), { message: "unknown adapter 'rn' (registered: web)" });
});

test('registries are independent', () => {
  const first = createAdapterRegistry();
  const second = createAdapterRegistry();
  first.register(adapter('web'));
  assert.equal(second.has('web'), false);
  second.register(adapter('web'));
});

test('refuses an adapter written for another SDK version or without an id', () => {
  const registry = createAdapterRegistry();
  const future = { ...adapter('next'), sdkVersion: 2 } as unknown as PlatformAdapter;
  assert.throws(() => registry.register(future), {
    message: "adapter 'next' targets adapter SDK 2; this host implements 1",
  });
  assert.throws(() => defineAdapter(future), {
    message: "adapter 'next' targets adapter SDK 2; this host implements 1",
  });
  assert.throws(() => registry.register(adapter(' ')), {
    message: 'adapter id must be a non-empty string',
  });
  assert.deepEqual(registry.list(), []);
});

test('defineAdapter keeps the host-specific members of an extended adapter type', () => {
  interface HostAdapter extends PlatformAdapter {
    fixtures: { operations: readonly string[] };
  }
  const registry = createAdapterRegistry<HostAdapter>();
  const host = defineAdapter<HostAdapter>({
    ...adapter('host'),
    fixtures: { operations: ['init'] },
  });
  registry.register(host);
  assert.deepEqual(registry.get('host').fixtures.operations, ['init']);
});
