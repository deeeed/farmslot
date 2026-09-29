import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let localCalls = 0;
let node: unknown;
let remoteError: Error | undefined;
mock.module('../core/exec.js', {
  namedExports: {
    execLocal: async () => {
      localCalls++;
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
});
mock.module('./machine-registry.js', { namedExports: { getNode: () => node } });
mock.module('./node-rpc.js', {
  namedExports: {
    getSlotLocality: async () => ({ isLocal: false, machine: 'remote' }),
    sendNodeRequest: async () => {
      if (remoteError) throw remoteError;
      return { stdout: 'remote', stderr: '', exitCode: 0 };
    },
  },
});
const { execResourceCommand } = await import('./resource-exec.js');
const { ResourceCommandUnavailableError } = await import('../core/resource-command-error.js');

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
