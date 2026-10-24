import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// execOnSlot is the seam every hook goes through on a remote slot. These pin
// its wiring to the bundle resolver (ledger F15); the resolver itself is
// covered in node-support/remote-command.test.ts.

class NodeSupportPendingError extends Error {}
const resolved: Array<{ cmd: string; budgetMs: number | undefined }> = [];
let resolveElapsedMs = 0;
let now = 0;
let pending = false;
const sent: Array<{ cmd: string; timeout: number | undefined }> = [];

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
      return cmd.replaceAll('~/farmslot-node/', '~/farmslot-node/support/h/');
    },
  },
});
mock.module('../fleet/node-rpc.js', {
  namedExports: {
    nodeExec: async (_machine: string, cmd: string, _cwd: string, opts: { timeout?: number }) => {
      sent.push({ cmd, timeout: opts.timeout });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    nodeExecArgv: async () => assert.fail('argv exec is not under test'),
    sendNodeRequest: async () => assert.fail('source observation RPC is not under test'),
  },
});

const { EXEC_TIMEOUT_EXIT_CODE, execOnSlot } = await import('./exec.js');

const remote = {
  slotId: 'mini-mm-1',
  host: 'mini.local',
  machine: 'mini',
  remoteRepo: '/r',
} as unknown as Parameters<typeof execOnSlot>[0];

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
