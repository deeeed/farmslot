import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// A remote slot's publish package is measured by one exec on the worker node,
// never by walking its tree file by file over RPC.

const sent: Array<{ machine: string; cmd: string }> = [];

mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExec: async (machine: string, cmd: string) => {
      sent.push({ machine, cmd });
      return {
        exitCode: 0,
        stdout: '      9 ./report.md\n 2048 ./goal/run/shot.png\n 2057 total\n',
        stderr: '',
      };
    },
    nodeExecArgv: async () => assert.fail('argv exec is not under test'),
    // The rest of the module, imported by the config chain but not called here.
    handleNodeResponse: () => {},
    handleNodeExecOutput: () => {},
    NodeTransportUnavailableError: class extends Error {},
    NodeRpcTimeoutError: class extends Error {},
    isNodeTransportUnavailableError: () => false,
    sendNodeRequest: async () => assert.fail('node RPC is not under test'),
    getSlotLocality: async () => assert.fail('slot locality is not under test'),
  },
});

const { buildPublishPackageScanCommand, scanPublishPackage } =
  await import('./publish-package-scope.js');

test('scanPublishPackage on a remote slot sends the scan command in one node exec', async () => {
  const remote = {
    slotId: 'mini-mm-3',
    host: 'remote-worker.invalid',
    machine: 'remote-worker',
    remoteRepo: '/r',
  } as unknown as Parameters<typeof scanPublishPackage>[0];

  const entries = await scanPublishPackage(remote, '/r/temp/tasks/t/artifacts', [
    'goal/run/shot.png',
  ]);

  assert.deepEqual(sent, [
    {
      machine: 'remote-worker',
      cmd: buildPublishPackageScanCommand('/r/temp/tasks/t/artifacts', ['goal/run/shot.png']),
    },
  ]);
  assert.deepEqual(entries, [
    { path: 'report.md', bytes: 9 },
    { path: 'goal/run/shot.png', bytes: 2048 },
  ]);
});
