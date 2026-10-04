import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// A resource whose health hook calls a farm script, on a remote slot, while
// that script's bundle is still on its way to the node (ledger F15). Shutdown
// first asks health whether the resource runs; a pending delivery must not
// read as "not running", or cleanup skips the hook and drops ownership of a
// resource that is still alive.

class NodeSupportPendingError extends Error {}
const sent: string[] = [];
let deliveryPending = true;

// Real exports spread in, so every other importer of these modules still loads.
const realConfig = await import('../core/config.js');
const realRegistry = await import('./machine-registry.js');
const realRpc = await import('./node-rpc.js');
mock.module('../core/config.js', {
  namedExports: {
    ...realConfig,
    resolveSlot: async () => ({
      pool: { project: 'p-farm' },
      slot: { id: 'mini-p-1', project: 'p-farm', resources: { probe: {} } },
    }),
    loadProjectVars: async () => ({
      projectJson: {
        resources: {
          probe: {
            type: 'process',
            hooks: {
              health: 'bash ~/farmslot-node/projects/p-farm/scripts/health.sh',
              shutdown: 'bash ~/farmslot-node/projects/p-farm/scripts/stop.sh',
            },
          },
        },
      },
    }),
    loadSlotVars: async () => ({
      slotId: 'mini-p-1',
      host: 'mini.local',
      machine: 'mini',
      repo: '/r',
      remoteRepo: '/r',
      resourceVars: {},
    }),
  },
});
mock.module('./machine-registry.js', {
  namedExports: { ...realRegistry, getNode: () => ({}), getAllNodes: () => [] },
});
mock.module('./node-rpc.js', {
  namedExports: {
    ...realRpc,
    getSlotLocality: async () => ({ isLocal: false, machine: 'mini' }),
    sendNodeRequest: async (_node: unknown, _method: string, params: { cmd: string }) => {
      sent.push(params.cmd);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
const resolve = async (_target: unknown, cmd: string) => {
  if (deliveryPending) throw new NodeSupportPendingError('bundle still being delivered');
  return cmd.replaceAll('~/farmslot-node/', '~/farmslot-node/support/h/');
};
mock.module('../node-support/remote-command.js', {
  namedExports: {
    NodeSupportPendingError,
    resolveRemoteFarmCommand: resolve,
    resolveSlotFarmCommand: resolve,
  },
});

const { executeResourceControl } = await import('./resource-manager.js');
const { ResourceCommandUnavailableError } = await import('../core/resource-command-error.js');

test('shutdown during a pending delivery is unavailable, never "already stopped"', async () => {
  await assert.rejects(
    executeResourceControl('mini-p-1', 'probe', 'shutdown'),
    ResourceCommandUnavailableError,
  );
  assert.deepEqual(sent, [], 'neither the health probe nor the hook ran from the stale copy');
});

test('once delivered, health and shutdown both run from the bundle', async () => {
  deliveryPending = false;
  sent.length = 0;
  const result = await executeResourceControl('mini-p-1', 'probe', 'shutdown');
  assert.equal(result.ok, true);
  assert.deepEqual(sent, [
    'bash ~/farmslot-node/support/h/projects/p-farm/scripts/health.sh',
    'bash ~/farmslot-node/support/h/projects/p-farm/scripts/stop.sh',
  ]);
});
