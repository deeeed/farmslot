// @farmslot:serial
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { makeRun } from '../methods/run/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'interrupted-release-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'runs', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Private release fixture\n');
await writeFile(path.join(root, 'scripts/dev.sh'), 'exit 1\n');
await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
Object.assign(process.env, {
  NODE_TEST_CONTEXT: '1',
  FARMSLOT_ROOT: root,
  FARMSLOT_HOME: path.join(root, 'home'),
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_TEST_STATUS_FILE: path.join(root, 'status.json'),
});
after(() => rm(root, { recursive: true, force: true }));
const state = await import('../core/state.js');
const { reconcileOrphanedSlots, STALE_RELEASE_RECLAIM_MS } = await import('./recovery.js');
type Deps = Parameters<typeof reconcileOrphanedSlots>[0];

test('expired release fence keeps a dirty eval checkout held until owner retry completes Git cleanup', async (t) => {
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  git('init', '-q', '-b', 'main');
  for (const file of ['one.ts', 'two.ts', 'three.ts'])
    await writeFile(path.join(repo, file), 'base\n');
  git('add', '.');
  git('commit', '-qm', 'test: release fixture');
  git('checkout', '-qb', 'fix/eval-interrupted');
  for (const file of ['one.ts', 'two.ts', 'three.ts'])
    await writeFile(path.join(repo, file), 'retained work\n');
  const before = createHash('sha256')
    .update(git('diff', 'HEAD', '--binary'))
    .digest('hex');
  const now = Date.parse('2026-11-16T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  t.after(() => t.mock.timers.reset());
  const owner = makeRun({ id: 'cancelled-release', status: 'cancelled', slotId: 'fixture-slot' });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: 'fixture-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slot_epoch: 4,
          current_run_id: owner.id,
          releasing_since: new Date(now - STALE_RELEASE_RECLAIM_MS - 1).toISOString(),
          release_gateway_instance: 'previous-gateway',
          branch: 'fix/eval-interrupted',
        },
      ],
    }),
  );
  const deps: Deps = {
    listRuns: () => ({ runs: [owner] }),
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'fixture-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slotEpoch: 4,
          currentRunId: owner.id,
        },
      ],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: state.readSlotField,
    getRun: (id) => (id === owner.id ? owner : undefined),
    updateRun: (_id, fields) => {
      Object.assign(owner, fields);
    },
    resetSlot: state.resetSlot,
    resetSlotIf: state.resetSlotIf,
    updateSlotStatusIf: state.updateSlotStatusIf,
    broadcast: () => {},
    retryOccupiedRunSlot: async () => false,
    resumeInterruptedRecovery: () => {
      throw new Error('Ordinary release has no workspace recovery journal');
    },
    absentExecutionNode: async () => null,
  };
  await reconcileOrphanedSlots(deps);
  const row = await state.readSlotRow('fixture-slot');
  assert.ok(row);
  assert.equal(row.lifecycle, 'held', 'A clock cannot attest checkout cleanup');
  assert.equal(row.phase, 'occupied');
  assert.equal(row.current_run_id, owner.id, 'Retry retains its exact terminal owner');
  assert.equal(row.slot_epoch, 4);
  assert.equal(row.cleanup_stop_unconfirmed, true);
  assert.match(String(row.held_reason), /interrupted|retry/i);
  assert.equal(git('branch', '--show-current'), 'fix/eval-interrupted');
  assert.equal(git('status', '--porcelain').split('\n').length, 3);
  assert.equal(
    createHash('sha256')
      .update(git('diff', 'HEAD', '--binary'))
      .digest('hex'),
    before,
  );
  assert.equal(JSON.parse(await readFile(state.statusFile, 'utf8')).slots[0].lifecycle, 'held');
});

interface DeadFence {
  instance?: string;
  ownerStatus: 'done' | 'cancelled' | 'failed' | 'monitoring';
  token?: string | null;
  ageMs?: number;
  census?: string | null;
}

/** A fence a previous gateway raised for this run's cleanup, read by the restarted gateway. */
async function reconcileFence({
  instance = 'previous-gateway',
  ownerStatus,
  token = `${state.RUN_CLEANUP_TOKEN_PREFIX}previous`,
  ageMs = 0,
  census = null,
}: DeadFence) {
  const owner = makeRun({
    id: `owner-${ownerStatus}`,
    status: ownerStatus,
    slotId: 'restart-slot',
  });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: 'restart-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slot_epoch: 2,
          current_run_id: owner.id,
          releasing_since: new Date(Date.now() - ageMs).toISOString(),
          release_gateway_instance: instance,
          cleanup_release_token: token,
        },
      ],
    }),
  );
  const retried: Array<Record<string, unknown> | null> = [];
  const inspected: string[] = [];
  const deps: Deps = {
    listRuns: () => ({ runs: [owner] }),
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'restart-slot',
          lifecycle: 'busy',
          phase: 'releasing',
          slotEpoch: 2,
          currentRunId: owner.id,
        },
      ],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: state.readSlotField,
    getRun: (id) => (id === owner.id ? owner : undefined),
    updateRun: () => {},
    resetSlot: state.resetSlot,
    resetSlotIf: state.resetSlotIf,
    updateSlotStatusIf: state.updateSlotStatusIf,
    broadcast: () => {},
    retryOccupiedRunSlot: async (slotId) => {
      retried.push(await state.readSlotRow(slotId));
      return false;
    },
    resumeInterruptedRecovery: () => {
      throw new Error('Ordinary release has no workspace recovery journal');
    },
    absentExecutionNode: async () => null,
    releaseFenceBlocker: async (run) => {
      inspected.push(run.id);
      const row = await state.readSlotRow('restart-slot');
      assert.equal(row?.phase, 'releasing', 'the census runs while the fence still stands');
      return census;
    },
  };
  await reconcileOrphanedSlots(deps);
  return { owner, retried, inspected, row: await state.readSlotRow('restart-slot') };
}

for (const ownerStatus of ['done', 'failed'] as const) {
  test(`a previous gateway’s ${ownerStatus}-run cleanup fence reopens after a clean census and is retried`, async () => {
    const { owner, retried, inspected, row } = await reconcileFence({ ownerStatus });
    assert.deepEqual(inspected, [owner.id]);
    assert.equal(row?.lifecycle, 'held');
    assert.equal(row?.phase, 'occupied');
    assert.equal(row?.current_run_id, owner.id);
    assert.equal(row?.slot_epoch, 2);
    assert.equal(row?.cleanup_stop_unconfirmed ?? null, null, 'the retry re-runs the stops itself');
    assert.equal(row?.releasing_since ?? null, null);
    assert.equal(row?.cleanup_release_token ?? null, null);
    assert.equal(retried.length, 1, 'the same terminal cleanup is retried, not a full release');
    assert.equal(retried[0]?.lifecycle, 'held');
  });
}

test('a process still live in the checkout keeps the interrupted cleanup fenced', async () => {
  const { retried, row } = await reconcileFence({
    ownerStatus: 'done',
    census: 'Process 4242 still uses the slot repository; slot teardown was skipped',
  });
  assert.equal(row?.phase, 'releasing');
  assert.equal(row?.release_gateway_instance, 'previous-gateway');
  assert.deepEqual(retried, []);
});

test('fences whose intent or quiescence is unproven keep the wait and the backstop', async () => {
  for (const fence of [
    { instance: state.currentReleaseGatewayInstance(), ownerStatus: 'done' },
    { ownerStatus: 'monitoring' },
    { ownerStatus: 'cancelled' },
    { ownerStatus: 'done', token: null },
    { ownerStatus: 'done', token: 'release-retry-token' },
  ] satisfies DeadFence[]) {
    const { retried, inspected, row } = await reconcileFence(fence);
    assert.equal(row?.phase, 'releasing', JSON.stringify(fence));
    assert.deepEqual([retried, inspected], [[], []], JSON.stringify(fence));
  }
  const expired = await reconcileFence({
    ownerStatus: 'done',
    ageMs: STALE_RELEASE_RECLAIM_MS + 1,
  });
  assert.equal(expired.row?.lifecycle, 'held');
  assert.equal(expired.row?.cleanup_stop_unconfirmed, true, 'an expired fence takes the backstop');
  assert.deepEqual(expired.retried, []);
});

test('a terminal run’s own cleanup fence carries the run-cleanup token recovery recognises', async () => {
  const owner = makeRun({ id: 'fenced-owner', status: 'done', slotId: 'fence-writer' });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: 'fence-writer',
          lifecycle: 'busy',
          phase: 'working',
          slot_epoch: 3,
          current_run_id: owner.id,
        },
      ],
    }),
  );
  const { fenceRunSlotCleanup } = await import('../run-lifecycle/slot-teardown.js');
  const fence = await fenceRunSlotCleanup(owner, null);
  const row = await state.readSlotRow('fence-writer');
  assert.equal(row?.phase, 'releasing');
  assert.equal(row?.cleanup_release_token, fence.token);
  assert.ok(String(fence.token).startsWith(state.RUN_CLEANUP_TOKEN_PREFIX));
  assert.equal(row?.release_gateway_instance, state.currentReleaseGatewayInstance());
});
