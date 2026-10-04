import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// execOnSlot is the seam every hook goes through on a remote slot. These pin
// its wiring to the bundle resolver (ledger F15); the resolver itself is
// covered in node-support/remote-command.test.ts.

class NodeSupportPendingError extends Error {}
const resolved: Array<{ cmd: string; budgetMs: number | undefined }> = [];
let resolveDelayMs = 0;
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
      await new Promise((resolve) => setTimeout(resolve, resolveDelayMs));
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
  resolveDelayMs = 0;
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
  assert.equal(resolved[0]!.budgetMs, 60_000, 'the delivery wait counts against the budget');
});

test('time spent delivering the bundle comes off the command timeout', async () => {
  reset();
  resolveDelayMs = 200;
  await execOnSlot(remote, 'bash ~/farmslot-node/scripts/x.sh', { timeout: 5_000 });
  assert.ok(sent[0]!.timeout! <= 4_850, `remaining budget passed on: ${sent[0]!.timeout}`);
});

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
