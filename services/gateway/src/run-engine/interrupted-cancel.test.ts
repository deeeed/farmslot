// @farmslot:serial
// A cancel's slot cleanup that a gateway restart interrupted is finished by reconcile, from the
// intent its fence carries, instead of waiting for an operator's owner-bound release.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'interrupted-cancel-'));
for (const dir of ['scripts', 'services/gateway', 'pool', 'projects', 'runs', 'home'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'CLAUDE.md'), '# Private cancel fixture\n');
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
type Result = import('./recovery.js').InterruptedCancelResult;
type Intent = 'replay' | 'release';

interface Fence {
  slot?: string;
  intent?: Intent | null;
  token?: string;
  ownerStatus?: Run['status'];
  instance?: string;
  ageMs?: number;
  owned?: boolean;
  handoff?: string;
  stopUnconfirmed?: boolean;
  workspaceRecovery?: boolean;
  ownerSlot?: string;
  native?: boolean;
  /** What the run already names as kept or deferred cleanup. */
  skipped?: string;
}

function fenceRow(fence: Fence, owner: Run) {
  const owned = fence.owned ?? true;
  return {
    slot: fence.slot ?? 'cancel-slot',
    lifecycle: 'busy',
    phase: 'releasing',
    slot_epoch: 5,
    current_run_id: owned ? owner.id : null,
    cleanup_run_id: owned ? null : owner.id,
    releasing_since: new Date(Date.now() - (fence.ageMs ?? 0)).toISOString(),
    release_gateway_instance: fence.instance ?? 'previous-gateway',
    cleanup_release_token:
      fence.token ??
      state.runCleanupToken(fence.intent === null ? undefined : (fence.intent ?? 'release'), 'id'),
    ...(fence.handoff ? { handoff_run_id: fence.handoff } : {}),
    ...(fence.stopUnconfirmed ? { cleanup_stop_unconfirmed: true } : {}),
    ...(fence.workspaceRecovery ? { workspace_recovery: { runId: owner.id } } : {}),
  };
}

interface Pass {
  fences: Fence[];
  absentNode?: string | null;
  census?: string | null;
  replayBlocker?: string | null;
  resume?: (run: Run, slotId: string, intent: Intent) => Promise<Result>;
  gateThrows?: boolean;
  extraRuns?: Run[];
}

async function reconcile(pass: Pass) {
  const owners = pass.fences.map((fence, index) => ({
    ...makeRun({
      id: `cancelled-${index}`,
      status: fence.ownerStatus ?? 'cancelled',
      slotId: fence.ownerSlot ?? fence.slot ?? 'cancel-slot',
    }),
    ...(fence.native ? { transport: 'native' as const } : {}),
    ...(fence.skipped ? { slotTeardownSkipped: fence.skipped } : {}),
  }));
  const rows = pass.fences.map((fence, index) => fenceRow(fence, owners[index]!));
  await writeFile(state.statusFile, JSON.stringify({ slots: rows }));
  const runs = [...owners, ...(pass.extraRuns ?? [])];
  const resumed: Array<[string, string, Intent]> = [];
  const observed: Array<Parameters<NonNullable<Deps['resumeInterruptedCancel']>>[2]> = [];
  const runUpdates: Array<[string, Partial<Run>]> = [];
  const census: string[] = [];
  const replayChecks: string[] = [];
  const retried: string[] = [];
  const recoveries: string[] = [];
  const deps: Deps = {
    listRuns: (options) => ({
      runs: options?.active
        ? runs.filter((run) => !['cancelled', 'done', 'failed'].includes(run.status))
        : runs,
    }),
    loadFleetStatus: async () => ({
      slots: rows.map((row) => ({
        slot: row.slot,
        lifecycle: 'busy',
        phase: 'releasing',
        slotEpoch: 5,
        currentRunId: row.current_run_id,
        cleanupRunId: row.cleanup_run_id,
      })),
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: state.readSlotField,
    getRun: (id) => runs.find((run) => run.id === id),
    updateRun: (id, fields) => {
      runUpdates.push([id, fields]);
      Object.assign(runs.find((run) => run.id === id) ?? {}, fields);
    },
    resetSlot: state.resetSlot,
    resetSlotIf: state.resetSlotIf,
    updateSlotStatusIf: state.updateSlotStatusIf,
    broadcast: () => {},
    retryOccupiedRunSlot: async (slotId) => {
      retried.push(slotId);
      return false;
    },
    resumeInterruptedRecovery: (slotId) => {
      recoveries.push(slotId);
    },
    absentExecutionNode: async () => pass.absentNode ?? null,
    releaseFenceBlocker: async (run) => {
      census.push(run.id);
      if (pass.gateThrows) throw new Error('census command failed');
      return pass.census ?? null;
    },
    cancelledReplayBlocker: async (run) => {
      replayChecks.push(run.id);
      if (pass.gateThrows) throw new Error('ownership read failed');
      return pass.replayBlocker ?? null;
    },
    resumeInterruptedCancel: async (run, slotId, fence) => {
      resumed.push([run.id, slotId, fence.intent]);
      observed.push(fence);
      return pass.resume ? pass.resume(run, slotId, fence.intent) : { kind: 'finished' };
    },
  };
  await reconcileOrphanedSlots(deps);
  const read = async (slot = 'cancel-slot') => state.readSlotRow(slot);
  return {
    owners,
    rows,
    recoveries,
    resumed,
    observed,
    runUpdates,
    census,
    replayChecks,
    retried,
    read,
  };
}

test('a release intent is finished after a clean census', async () => {
  const pass = await reconcile({ fences: [{ intent: 'release' }] });
  assert.deepEqual(pass.resumed, [['cancelled-0', 'cancel-slot', 'release']]);
  assert.deepEqual(pass.census, ['cancelled-0'], 'a released slot needs a quiet checkout');
  assert.deepEqual(pass.replayChecks, []);
});

test('a replay intent is finished after the ownership check, not the census', async () => {
  const pass = await reconcile({ fences: [{ intent: 'replay' }] });
  assert.deepEqual(pass.resumed, [['cancelled-0', 'cancel-slot', 'replay']]);
  assert.deepEqual(pass.census, [], 'the replay hold keeps survivors, as the cancel did');
  assert.deepEqual(pass.replayChecks, ['cancelled-0']);
});

test('the resume gets the exact fence reconcile observed', async () => {
  const pass = await reconcile({ fences: [{ intent: 'release' }] });
  const row = pass.rows[0]!;
  assert.deepEqual(pass.observed, [
    {
      intent: 'release',
      token: row.cleanup_release_token,
      instance: 'previous-gateway',
      releasingSince: row.releasing_since,
      slotEpoch: 5,
    },
  ]);
});

test('a blocked or failing gate keeps the fence inside the bound and takes the backstop after it', async () => {
  for (const pass of [
    { fences: [{ intent: 'replay' }], replayBlocker: 'A publication gate still holds this slot' },
    { fences: [{ intent: 'replay' }], gateThrows: true },
    { fences: [{ intent: 'release' }], gateThrows: true },
  ] satisfies Pass[]) {
    const label = JSON.stringify(pass);
    const fresh = await reconcile(pass);
    assert.deepEqual(fresh.resumed, [], label);
    assert.equal((await fresh.read())?.phase, 'releasing', label);
    const fence = { ...pass.fences[0]!, ageMs: STALE_RELEASE_RECLAIM_MS + 1 };
    const expired = await reconcile({ ...pass, fences: [fence] });
    assert.deepEqual(expired.resumed, [], label);
    assert.equal((await expired.read())?.cleanup_stop_unconfirmed, true, label);
  }
});

test('a resume refused past the bound leaves the slot to the backstop hold', async () => {
  for (const refusal of [
    { kind: 'refused', reason: 'the release fence changed' },
    { kind: 'not-finished', reason: 'node lost' },
  ] satisfies Result[]) {
    const label = JSON.stringify(refusal);
    const pass = await reconcile({
      fences: [{ intent: 'release', ageMs: STALE_RELEASE_RECLAIM_MS + 1 }],
      resume: async () => refusal,
    });
    assert.equal(pass.resumed.length, 1, label);
    const row = await pass.read();
    assert.equal(row?.lifecycle, 'held', label);
    assert.equal(row?.cleanup_stop_unconfirmed, true, label);
  }
});

test('a resume busy past the bound keeps the fence for the next pass', async () => {
  for (const reason of ['a transition holds the run', 'another teardown owns this slot']) {
    const pass = await reconcile({
      fences: [{ intent: 'release', ageMs: STALE_RELEASE_RECLAIM_MS + 1 }],
      resume: async () => ({ kind: 'busy', reason }),
    });
    assert.equal(pass.resumed.length, 1, reason);
    const row = await pass.read();
    assert.equal(row?.phase, 'releasing', reason);
    assert.equal(row?.cleanup_stop_unconfirmed ?? null, null, reason);
  }
});

test('the node wait keeps the cancel’s own reason and goes as soon as the node is back', async () => {
  const wait = 'Cancel cleanup interrupted by a gateway restart waits for node node-a';
  for (const prior of [undefined, 'Process 7 survived the cancel']) {
    const label = String(prior);
    const away = await reconcile({
      fences: [{ intent: 'replay', ...(prior ? { skipped: prior } : {}) }],
      absentNode: 'node-a',
    });
    const noted = prior ? `${prior}; ${wait}` : wait;
    assert.equal(away.owners[0]!.slotTeardownSkipped, noted, label);
    const again = await reconcile({
      fences: [{ intent: 'replay', skipped: noted }],
      absentNode: 'node-a',
    });
    assert.deepEqual(again.runUpdates, [], `${label}: one note per wait`);
    // Whatever the pass then finds, the node is back and the note goes.
    for (const back of [
      { fences: [{ intent: 'replay', skipped: noted }] },
      {
        fences: [{ intent: 'replay', skipped: noted }],
        resume: async () => ({ kind: 'busy', reason: 'a transition holds the run' }),
      },
      { fences: [{ intent: 'release', skipped: noted }], census: 'Process 7 is live' },
      {
        fences: [{ intent: 'release', skipped: noted, ageMs: STALE_RELEASE_RECLAIM_MS + 1 }],
        census: 'Process 7 is live',
      },
    ] satisfies Pass[]) {
      const pass = await reconcile(back);
      assert.equal(pass.owners[0]!.slotTeardownSkipped, prior, `${label} ${JSON.stringify(back)}`);
    }
  }
});

test('an absent node keeps the fence, even past the reclaim bound', async () => {
  for (const ageMs of [0, STALE_RELEASE_RECLAIM_MS + 1]) {
    const pass = await reconcile({ fences: [{ intent: 'release', ageMs }], absentNode: 'node-a' });
    const row = await pass.read();
    assert.deepEqual(pass.resumed, [], `age ${ageMs}`);
    assert.equal(row?.phase, 'releasing', 'no backstop hold while the node is away');
    assert.equal(row?.cleanup_stop_unconfirmed ?? null, null);
    assert.deepEqual(pass.runUpdates, [
      [
        'cancelled-0',
        {
          slotTeardownSkipped:
            'Cancel cleanup interrupted by a gateway restart waits for node node-a',
        },
      ],
    ]);
  }
});

test('a live census keeps the fence inside the bound and takes the backstop after it', async () => {
  const fresh = await reconcile({ fences: [{ intent: 'release' }], census: 'Process 7 is live' });
  assert.deepEqual(fresh.resumed, []);
  assert.equal((await fresh.read())?.phase, 'releasing');
  const expired = await reconcile({
    fences: [{ intent: 'release', ageMs: STALE_RELEASE_RECLAIM_MS + 1 }],
    census: 'Process 7 is live',
  });
  assert.deepEqual(expired.resumed, []);
  const row = await expired.read();
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.cleanup_stop_unconfirmed, true);
});

test('a resume that throws or stops leaves the fence and the next slot is still finished', async () => {
  const pass = await reconcile({
    fences: [
      { slot: 'broken-slot', intent: 'release' },
      { slot: 'healthy-slot', intent: 'replay' },
    ],
    resume: async (_run, slotId) => {
      if (slotId === 'broken-slot') throw new Error('node command hung');
      return { kind: 'finished' };
    },
  });
  assert.deepEqual(
    pass.resumed.map(([, slotId]) => slotId),
    ['broken-slot', 'healthy-slot'],
  );
  assert.equal((await pass.read('broken-slot'))?.phase, 'releasing');
});

test('a fence without an intent, this gateway’s own fence and a handoff row keep today’s wait', async () => {
  for (const fence of [
    { intent: null },
    { intent: 'release', instance: state.currentReleaseGatewayInstance() },
    { intent: 'release', handoff: 'successor-run' },
    { intent: 'release', ownerStatus: 'monitoring' },
    { intent: 'release', stopUnconfirmed: true },
    { intent: 'release', native: true },
    { intent: 'release', ownerSlot: 'another-slot' },
    // The replay hold is written for the slot's owner, which a cleanup-only row has lost.
    { intent: 'replay', owned: false },
  ] satisfies Fence[]) {
    const pass = await reconcile({ fences: [fence] });
    assert.deepEqual(pass.resumed, [], JSON.stringify(fence));
    assert.equal((await pass.read())?.phase, 'releasing', JSON.stringify(fence));
  }
});

test('a fence with a workspace recovery journal is left to that recovery', async () => {
  const pass = await reconcile({ fences: [{ intent: 'release', workspaceRecovery: true }] });
  assert.deepEqual(pass.resumed, []);
  assert.deepEqual(pass.recoveries, ['cancel-slot']);
});

test('a run pinned to the slot, still waiting to claim it, does not stop the resume', async () => {
  const pin = makeRun({ id: 'pinned-requester', status: 'slot-finding', slotId: 'cancel-slot' });
  const pass = await reconcile({ fences: [{ intent: 'release' }], extraRuns: [pin] });
  assert.deepEqual(pass.resumed, [['cancelled-0', 'cancel-slot', 'release']]);
});

test('a pinned requester never exempts this gateway’s own fence or one with no instance', async () => {
  for (const instance of [state.currentReleaseGatewayInstance(), '']) {
    const pin = makeRun({ id: 'pinned-requester', status: 'slot-finding', slotId: 'cancel-slot' });
    const pass = await reconcile({
      fences: [{ intent: 'release', instance, ageMs: STALE_RELEASE_RECLAIM_MS + 1 }],
      extraRuns: [pin],
    });
    assert.deepEqual(pass.resumed, [], `instance '${instance}'`);
    const row = await pass.read();
    assert.equal(row?.phase, 'releasing', 'the pin keeps the slot out of this pass');
    assert.equal(row?.cleanup_stop_unconfirmed ?? null, null);
  }
});

test('a cancelled run’s own cleanup hold, interrupted by a restart, is reopened and retried', async () => {
  const pass = await reconcile({
    fences: [{ intent: null, owned: false, token: `${state.RUN_CLEANUP_TOKEN_PREFIX}previous` }],
  });
  const row = await pass.read();
  assert.equal(row?.lifecycle, 'held');
  assert.equal(row?.phase, 'occupied');
  assert.deepEqual(pass.retried, ['cancel-slot']);
  assert.deepEqual(pass.resumed, []);
});

test('the cancel fence token carries its intent; finished-run fences carry none', () => {
  assert.equal(state.runCleanupTokenIntent(state.runCleanupToken('replay', 'a')), 'replay');
  assert.equal(state.runCleanupTokenIntent(state.runCleanupToken('release', 'a')), 'release');
  assert.equal(state.runCleanupTokenIntent(state.runCleanupToken(undefined, 'a')), undefined);
  assert.equal(state.runCleanupTokenIntent('release-retry-token'), undefined);
  assert.ok(state.runCleanupToken('release', 'a').startsWith(state.RUN_CLEANUP_TOKEN_PREFIX));
});

test('fenceRunSlotCleanup writes the intent it is given into the slot token', async () => {
  const owner = makeRun({ id: 'fence-owner', status: 'cancelled', slotId: 'fence-slot' });
  await writeFile(
    state.statusFile,
    JSON.stringify({
      slots: [
        {
          slot: 'fence-slot',
          lifecycle: 'busy',
          phase: 'working',
          slot_epoch: 1,
          current_run_id: owner.id,
        },
      ],
    }),
  );
  const { fenceRunSlotCleanup } = await import('../run-lifecycle/slot-teardown.js');
  const fence = await fenceRunSlotCleanup(owner, null, 'replay');
  const row = await state.readSlotRow('fence-slot');
  assert.equal(row?.cleanup_release_token, fence.token);
  assert.equal(state.runCleanupTokenIntent(row?.cleanup_release_token), 'replay');
});
