import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let localCalls = 0;
let node: unknown;
let remoteError: Error | undefined;
const sentCmds: string[] = [];
const sentTimeouts: number[] = [];
let resolutionMs = 0;
let now = 0;
let bundlePending = false;
let machineEnv: Record<string, string> | undefined;
class NodeSupportPendingError extends Error {}
mock.module('../node-support/remote-command.js', {
  namedExports: {
    NodeSupportPendingError,
    resolveSlotFarmCommand: async (_slotId: string, cmd: string) => {
      if (bundlePending) throw new NodeSupportPendingError('still being delivered');
      now += resolutionMs;
      return cmd
        .replaceAll('~/farmslot-node/', '~/farmslot-node/support/h/')
        .replaceAll('/configured/farm-node/', '~/farmslot-node/support/h/');
    },
  },
});
mock.module('../core/exec.js', {
  namedExports: {
    isLocal: () => false,
    execLocal: async () => {
      localCalls++;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('./machine-registry.js', { namedExports: { getNode: () => node } });
mock.module('./node-rpc.js', {
  namedExports: {
    getSlotLocality: async () => ({ isLocal: false, machine: 'remote', machineEnv }),
    sendNodeRequest: async (
      _node: unknown,
      _method: string,
      params: { cmd: string; timeout: number },
    ) => {
      sentCmds.push(params.cmd);
      sentTimeouts.push(params.timeout);
      if (remoteError) throw remoteError;
      return { stdout: 'remote', stderr: '', exitCode: 0 };
    },
  },
});

const { execResourceCommand } = await import('./resource-exec.js');
const { ResourceCommandUnavailableError } = await import('../core/resource-command-error.js');

test('a slow support resolution leaves the resource probe its execution timeout', async (t) => {
  node = {};
  remoteError = undefined;
  now = 1_000;
  resolutionMs = 31_000;
  t.mock.method(Date, 'now', () => now);
  t.after(() => {
    resolutionMs = 0;
  });
  sentTimeouts.length = 0;
  await execResourceCommand('slot', '/tmp', 'bash ~/farmslot-node/scripts/health.sh', 5_000);
  assert.deepEqual(sentTimeouts, [5_000]);
});

test('remote commands never execute locally across disconnect and reconnect', async () => {
  node = undefined;
  await assert.rejects(
    execResourceCommand('slot', '/tmp', 'echo proof', 1000),
    ResourceCommandUnavailableError,
  );
  assert.equal(localCalls, 0);
  node = {};
  remoteError = new Error('transport disconnected');
  await assert.rejects(
    execResourceCommand('slot', '/tmp', 'echo proof', 1000),
    ResourceCommandUnavailableError,
  );
  assert.equal(localCalls, 0);
  remoteError = undefined;
  assert.equal((await execResourceCommand('slot', '/tmp', 'echo proof', 1000)).stdout, 'remote');
  assert.equal(localCalls, 0);
});

test('resource hooks that call farm scripts run them from the bundle (ledger F15)', async () => {
  node = {};
  remoteError = undefined;
  sentCmds.length = 0;
  await execResourceCommand(
    'slot',
    '/tmp',
    "bash ~/farmslot-node/projects/x/scripts/physical-android-health.sh 'serial'",
    5_000,
  );
  assert.deepEqual(sentCmds, [
    "bash ~/farmslot-node/support/h/projects/x/scripts/physical-android-health.sh 'serial'",
  ]);

  // A pending delivery is "could not run", never "probe failed": shutdown
  // reads a failed health probe as already stopped and would skip its hook.
  bundlePending = true;
  await assert.rejects(
    execResourceCommand('slot', '/tmp', 'bash ~/farmslot-node/scripts/x.sh', 5_000),
    ResourceCommandUnavailableError,
  );
  bundlePending = false;
  assert.equal(sentCmds.length, 1, 'nothing ran from the stale copy');
});

test('configured workspace resource health uses the selected support resolver', async (t) => {
  node = {};
  remoteError = undefined;
  sentCmds.length = 0;
  machineEnv = { FARMSLOT_WORKSPACE: '/configured/farm-node' };
  t.after(() => {
    machineEnv = undefined;
  });
  await execResourceCommand(
    'slot',
    '/tmp',
    'bash /configured/farm-node/projects/farmslot-farm/setup/sandbox-dev.sh health',
    5_000,
  );
  assert.deepEqual(sentCmds, [
    'bash ~/farmslot-node/support/h/projects/farmslot-farm/setup/sandbox-dev.sh health',
  ]);
});
