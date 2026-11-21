import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { withProjectSources } from '@farmslot/slot-config';

import { sourceTestLock, sourceTestMaterialization } from '../sources/source.test-support.js';

import { withCleanupSignal } from './cleanup-scope.js';
import type { SlotVars } from './config.js';

// execOnSlot is the seam every hook goes through on a remote slot. These pin
// its wiring to the bundle resolver (ledger F15); the resolver itself is
// covered in node-support/remote-command.test.ts.

class NodeSupportPendingError extends Error {}
const resolved: Array<{ cmd: string; budgetMs: number | undefined }> = [];
let resolveElapsedMs = 0;
let now = 0;
let pending = false;
const sent: Array<{ cmd: string; timeout: number | undefined; signal?: AbortSignal }> = [];
let verifySources: () => Promise<void>;

mock.module('../sources/runtime.js', {
  namedExports: { verifyExecutionSources: () => verifySources() },
});

mock.module('../node-support/remote-command.js', {
  namedExports: {
    NodeSupportPendingError,
    resolveRemoteFarmCommand: async (
      _vars: unknown,
      cmd: string,
      options: { budgetMs?: number },
    ) => {
      resolved.push({ cmd, budgetMs: options.budgetMs });
      if (pending) throw new NodeSupportPendingError('still being delivered');
      now += resolveElapsedMs;
      return cmd
        .replaceAll('~/farmslot-node/', '~/farmslot-node/support/h/')
        .replaceAll('/configured/farm-node/', '~/farmslot-node/support/h/');
    },
  },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExec: async (
      _machine: string,
      cmd: string,
      _cwd: string,
      opts: { timeout?: number; signal?: AbortSignal },
    ) => {
      sent.push({ cmd, timeout: opts.timeout, signal: opts.signal });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    nodeExecArgv: async () => assert.fail('argv exec is not under test'),
    sendNodeRequest: async () => assert.fail('source observation RPC is not under test'),
  },
});

const { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } = await import('./exec.js');

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

test('local exec reports dispatch only when a child spawns', async () => {
  let finishVerification!: () => void;
  let startVerification!: () => void;
  const verified = new Promise<void>((resolve) => {
    finishVerification = resolve;
  });
  const verifying = new Promise<void>((resolve) => {
    startVerification = resolve;
  });
  verifySources = () => {
    startVerification();
    return verified;
  };
  const materialization = sourceTestMaterialization(sourceTestLock(), 'gateway');
  const sources = {
    project: 'demo',
    pack: materialization.lock.packBindings.demo,
    materialization,
  };
  const vars = { ...remote, host: 'localhost', remoteRepo: tmpdir() };
  const controller = new AbortController();
  let dispatches = 0;
  const onDispatch = (node: unknown) => {
    assert.equal(node, undefined);
    dispatches++;
  };
  const cancelled = withProjectSources(sources, () =>
    execOnSlot(vars, 'printf ran', {
      signal: controller.signal,
      onDispatch,
    }),
  );
  await verifying;
  controller.abort();
  finishVerification();
  assert.equal((await cancelled).exitCode, 130);
  assert.equal(dispatches, 0);

  const failedSpawn = await execOnSlot(vars, 'printf ran', {
    cwd: fileURLToPath(new URL('./missing-exec-dispatch-cwd', import.meta.url)),
    onDispatch,
  });
  assert.match(failedSpawn.stderr, /spawn error/);
  assert.equal(dispatches, 0);

  const spawned = await withProjectSources(sources, () =>
    execOnSlot(vars, 'printf ran', { onDispatch }),
  );
  assert.equal(spawned.stdout, 'ran');
  assert.equal(dispatches, 1);
});

function reset(): void {
  resolved.length = 0;
  sent.length = 0;
  resolveElapsedMs = 0;
  now = 0;
  pending = false;
}

test('a remote hook that calls a farm script runs the resolved command', async () => {
  reset();
  await execOnSlot(remote, 'bash ~/farmslot-node/projects/x/scripts/unlock-wallet.sh', {
    timeout: 60_000,
  });
  assert.deepEqual(
    sent.map((call) => call.cmd),
    ['bash ~/farmslot-node/support/h/projects/x/scripts/unlock-wallet.sh'],
  );
  assert.equal(resolved[0]!.budgetMs, 60_000, 'delivery retains its configured wait budget');
});

test('a configured workspace hook passes through the shared support resolver', async () => {
  reset();
  const vars = { ...remote, machineEnv: { FARMSLOT_WORKSPACE: '/configured/farm-node' } };
  await execOnSlot(vars, 'bash /configured/farm-node/projects/x/scripts/preflight.sh');
  assert.equal(resolved.length, 1);
  assert.equal(sent[0]?.cmd, 'bash ~/farmslot-node/support/h/projects/x/scripts/preflight.sh');
});

for (const elapsedMs of [0, 9_998, 9_999, 10_000, 54_524, 465_238]) {
  test(`remote prepare retains its 10s command timeout after ${elapsedMs}ms of support resolution`, async (t) => {
    reset();
    resolveElapsedMs = elapsedMs;
    t.mock.method(Date, 'now', () => now);
    const result = await execOnSlot(remote, 'bash ~/farmslot-node/scripts/check-paths.sh', {
      timeout: 10_000,
      selectNodeSupport: false,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(resolved[0]!.budgetMs, 10_000);
    assert.equal(sent[0]!.timeout, 10_000);
  });
}

test('a probe whose budget runs out during delivery times out instead of hanging', async () => {
  reset();
  pending = true;
  const result = await execOnSlot(remote, 'bash ~/farmslot-node/scripts/x.sh', { timeout: 5_000 });
  assert.equal(result.exitCode, EXEC_TIMEOUT_EXIT_CODE);
  assert.match(result.stderr, /still being delivered/);
  assert.equal(sent.length, 0, 'nothing ran from the stale copy');
});

test('commands without a farm reference skip the resolver', async () => {
  reset();
  await execOnSlot(remote, 'git status', { timeout: 5_000 });
  assert.equal(resolved.length, 0);
  assert.deepEqual(
    sent.map((call) => call.cmd),
    ['git status'],
  );
});

test('remote cleanup is cancellable while independent requests retain their transport policy', async () => {
  reset();
  const controller = new AbortController();
  await withCleanupSignal(controller.signal, () => execOnSlot(remote, 'cleanup'));
  await execOnSlot(remote, 'independent');
  assert.equal(
    sent[0]?.signal,
    controller.signal,
    'node RPC requires cancellation and refuses reconnect replay',
  );
  assert.equal(sent[1]?.signal, undefined, 'ordinary requests keep the existing retry behavior');
  const reason = new Error('cleanup expired');
  controller.abort(reason);
  await withCleanupSignal(controller.signal, () =>
    assert.rejects(execOnSlot(remote, 'late'), reason),
  );
  assert.equal(sent.length, 2, 'expired cleanup cannot send another command');
});
