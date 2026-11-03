import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Principal } from '@farmslot/protocol';

const reader: Principal = {
  id: 'reader',
  generation: 1,
  subject: { type: 'person', displayName: 'Reader' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
let owner = 'owner-a';
const node = { nativeSessions: { supportsProfiles: true } };
let loadSlot: () => Promise<void> = async () => {};
mock.module('../core/config.js', {
  namedExports: {
    poolDir: '/fixture',
    loadSlotVars: async () => {
      await loadSlot();
      return { remoteRepo: '/old/project', projectName: 'fixture' };
    },
  },
});
mock.module('../core/index.js', { namedExports: { isLocal: () => false } });
mock.module('../fleet/state.js', {
  namedExports: {
    loadPoolConfigs: async () => [{ machine: 'node', slots: [{ id: 'slot', repo: '~/project' }] }],
  },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    sendNodeRequest: async () => ({
      homeDirectory: '/Users/owner-a',
      supportsStandaloneDelegation: true,
    }),
  },
});
mock.module('../runners/native/node.js', {
  namedExports: { resolveNativeExecutionNode: () => node },
});
mock.module('../runners/native/manager.js', { namedExports: { nativeSessionManager: {} } });
mock.module('../security/native-standalone.js', {
  namedExports: {
    assertStandaloneAdmin: () => {},
    standaloneOwners: () => new Map([['node', owner]]),
    standaloneOwner: () => owner,
  },
});
const { standaloneCatalogTargets } = await import('./native-catalog-targets.js');

test('catalog revalidates assignment after the last asynchronous slot-directory read', async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  loadSlot = async () => {
    entered();
    await held;
  };
  const pending = standaloneCatalogTargets(reader);
  await started;
  owner = 'owner-b';
  release();
  const result = await pending;
  assert.deepEqual(result.contexts, []);
  assert.match(result.executionNodes[0].unavailableReason ?? '', /changed/);
  assert.equal(result.contextMachines.size, 0);
});
