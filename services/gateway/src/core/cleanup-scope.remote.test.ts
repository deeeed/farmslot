import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { NodeExecOpts } from '../fleet/node-rpc.js';

import { withCleanupSignal } from './cleanup-scope.js';
import type { SlotVars } from './config.js';

const sent: Array<AbortSignal | undefined> = [];
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExec: async (
      _machine: string,
      _command: string,
      _cwd: string | undefined,
      options?: NodeExecOpts,
    ) => {
      sent.push(options?.signal);
      return { exitCode: 0, stdout: 'observed', stderr: '' };
    },
    nodeExecArgv: async () => assert.fail('unexpected argv request'),
    sendNodeRequest: async () => assert.fail('unexpected source observation'),
  },
});
await import('../runtime/mock-pty.test-support.js');
const { execOnSlot } = await import('./exec.js');
const remote: SlotVars = {
  slotId: 'cleanup-remote',
  machine: 'proof-remote',
  host: 'proof-remote.invalid',
  platform: 'cli',
  sshUser: 'proof',
  osType: 'darwin',
  remoteRepo: '/owned/repo',
  repo: '/owned/repo',
  session: 'cleanup-remote',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'proof@proof-remote.invalid',
  projectName: 'proof',
  resourceVars: {},
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
};

test('remote cleanup is cancellable while independent requests retain their transport policy', async () => {
  const controller = new AbortController();
  await withCleanupSignal(controller.signal, () => execOnSlot(remote, 'cleanup'));
  await execOnSlot(remote, 'independent');
  assert.equal(
    sent[0],
    controller.signal,
    'node RPC requires cancellation and refuses reconnect replay',
  );
  assert.equal(sent[1], undefined, 'ordinary requests keep the existing retry behavior');
  const reason = new Error('cleanup expired');
  controller.abort(reason);
  await withCleanupSignal(controller.signal, () =>
    assert.rejects(execOnSlot(remote, 'late'), reason),
  );
  assert.equal(sent.length, 2, 'expired cleanup cannot send another command');
});
