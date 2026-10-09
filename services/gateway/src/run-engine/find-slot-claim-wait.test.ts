import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  commitSlotClaim,
  EXPLICIT_SLOT_RELEASE_WAIT_MS,
  previewWhenSlotClaimable,
  slotClaimAllowed,
} from './find-slot-step.js';

const SLOT = 'macpro-mm-pixel6';
const releasingSince = '2026-10-09T11:04:16.694Z';
const releasingRow = {
  slot: SLOT,
  lifecycle: 'busy',
  phase: 'releasing',
  releasing_since: releasingSince,
  current_run_id: 'prior-run',
};
const readyRow = { slot: SLOT, lifecycle: 'ready', phase: null, current_run_id: null };

type Lookup = Pick<Run, 'status' | 'engineState'>;
type SlotRuns = NonNullable<
  NonNullable<Parameters<typeof previewWhenSlotClaimable>[4]>['listSlotRuns']
>;

/**
 * Fake clock, slot rows served in order (the last one repeats), a run table,
 * and counters for everything the helper may touch.
 */
function harness(rows: Array<Record<string, unknown>>, runs: Record<string, Lookup> = {}) {
  const state = { nowMs: 0, sleeps: 0, reads: 0, waits: 0, previews: 0 };
  const table: Record<string, Lookup> = {
    'new-run': { status: 'slot-finding' },
    'prior-run': { status: 'cancelled' },
    ...runs,
  };
  const queue = [...rows];
  return {
    state,
    table,
    preview: async () => {
      state.previews += 1;
      return 'previewed';
    },
    deps: {
      readRow: async () => {
        state.reads += 1;
        return queue.length > 1 ? queue.shift()! : queue[0];
      },
      runLookup: (id: string) => table[id],
      listSlotRuns: (async () => []) as SlotRuns,
      now: () => state.nowMs,
      sleep: async (ms: number) => {
        state.nowMs += ms;
        state.sleeps += 1;
      },
      wrapWait: <W>(wait: () => Promise<W>) => {
        state.waits += 1;
        return wait();
      },
    },
  };
}

test('an explicit slot mid-release is previewed only after the release lands', async () => {
  const h = harness([releasingRow, releasingRow, releasingRow, readyRow]);
  const sleep = h.deps.sleep;
  h.deps.sleep = async (ms: number) => {
    assert.equal(h.state.previews, 0, 'preview must not run while the release is pending');
    await sleep(ms);
  };
  const result = await previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps);
  assert.equal(result, 'previewed');
  assert.equal(h.state.previews, 1);
  assert.equal(h.state.sleeps, 3);
  assert.equal(h.state.waits, 1, 'the wait counts as queue time');
  assert.ok(h.state.nowMs < EXPLICIT_SLOT_RELEASE_WAIT_MS);
});

test('a release that never lands fails after the bound, naming when it started', async () => {
  const h = harness([releasingRow]);
  await assert.rejects(
    previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'SLOT_CLAIM_REFUSED');
      assert.match(error.message, /Slot macpro-mm-pixel6 cannot be claimed/);
      assert.match(error.message, new RegExp(`release in progress since ${releasingSince}`));
      assert.match(error.message, /still releasing after 5m/);
      return true;
    },
  );
  assert.ok(h.state.nowMs >= EXPLICIT_SLOT_RELEASE_WAIT_MS);
  assert.equal(h.state.previews, 0);
});

for (const [change, mutate] of [
  ['cancelled', (run: Lookup) => ({ ...run, status: 'cancelled' })],
  ['paused', (run: Lookup) => ({ ...run, status: 'paused' })],
  ['replayed', (run: Lookup) => ({ ...run, engineState: { generation: 1 } })],
] as const) {
  test(`a run ${change} while waiting stops without previewing or claiming`, async () => {
    const h = harness([releasingRow, releasingRow, readyRow]);
    const sleep = h.deps.sleep;
    h.deps.sleep = async (ms: number) => {
      await sleep(ms);
      h.table['new-run'] = mutate(h.table['new-run']) as Lookup;
    };
    await assert.rejects(
      previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps),
      /Run new-run changed while waiting for slot macpro-mm-pixel6/,
    );
    assert.equal(h.state.previews, 0);
    assert.equal(h.state.reads, 1, 'no row is read after the run changed');
  });
}

test('a slot claimed by a live run fails at once, naming the run and its state', async () => {
  const h = harness(
    [{ ...readyRow, lifecycle: 'busy', phase: 'working', current_run_id: 'live' }],
    {
      live: { status: 'monitoring' },
    },
  );
  await assert.rejects(
    previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps),
    /cannot be claimed: slot is claimed by live run live \(monitoring\)/,
  );
  assert.equal(h.state.sleeps, 0);
  assert.equal(h.state.waits, 0);
  assert.equal(h.state.previews, 0);
});

test('a rival that claims after the release lands is named, not reported as busy', async () => {
  const rivalRow = { ...readyRow, lifecycle: 'busy', phase: 'preparing', current_run_id: 'rival' };
  const h = harness([releasingRow, readyRow, rivalRow], { rival: { status: 'slot-finding' } });
  await assert.rejects(
    previewWhenSlotClaimable(
      'new-run',
      0,
      SLOT,
      async () => {
        throw new Error('Slot macpro-mm-pixel6: Slot is busy (preparing)');
      },
      h.deps,
    ),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'SLOT_CLAIM_REFUSED');
      assert.match(error.message, /slot is claimed by live run rival \(slot-finding\)/);
      return true;
    },
  );
});

test('a preview failure with nothing holding the slot is passed through', async () => {
  const h = harness([readyRow]);
  await assert.rejects(
    previewWhenSlotClaimable(
      'new-run',
      0,
      SLOT,
      async () => {
        throw new Error('Slot repo cannot prepare: single-branch clone');
      },
      h.deps,
    ),
    /^Error: Slot repo cannot prepare: single-branch clone$/,
  );
});

test('an occupancy hold fails at once naming its reason, since when and the run that left it', async () => {
  const heldReason = 'Process 50176 still uses the slot repository; slot teardown was skipped';
  const bound = [{ name: 'find-slot', status: 'done' }] as Run['steps'];
  const refused = [{ name: 'find-slot', status: 'failed' }] as Run['steps'];
  const h = harness([
    {
      slot: 'macpro-mme-1',
      lifecycle: 'held',
      phase: 'occupied',
      current_run_id: null,
      held_reason: heldReason,
    },
  ]);
  h.deps.listSlotRuns = async () => [
    {
      id: 'older-run',
      status: 'done',
      slotId: 'macpro-mme-1',
      slotTeardownSkipped: heldReason,
      statusChangedAt: '2026-10-09T07:00:00.000Z',
      steps: bound,
    },
    {
      id: 'leaver-run',
      status: 'done',
      slotId: 'macpro-mme-1',
      slotTeardownSkipped: heldReason,
      statusChangedAt: '2026-10-09T11:40:00.000Z',
      steps: bound,
    },
    {
      id: 'never-bound-run',
      status: 'cancelled',
      slotId: 'macpro-mme-1',
      slotTeardownSkipped: heldReason,
      statusChangedAt: '2026-10-09T11:44:00.000Z',
      steps: refused,
    },
    {
      id: 'other-slot-run',
      status: 'cancelled',
      slotId: 'macpro-mme-2',
      slotTeardownSkipped: heldReason,
      statusChangedAt: '2026-10-09T11:45:00.000Z',
      steps: bound,
    },
  ];
  await assert.rejects(
    previewWhenSlotClaimable('new-run', 0, 'macpro-mme-1', h.preview, h.deps),
    (error: Error) => {
      assert.match(
        error.message,
        /slot remains occupied since 2026-10-09T11:40:00\.000Z, left by run leaver-run \(done\): Process 50176 still uses the slot repository/,
      );
      assert.match(error.message, /release it with `farmslot slot release macpro-mme-1`/);
      assert.doesNotMatch(error.message, /mid-release/);
      return true;
    },
  );
  assert.equal(h.state.sleeps, 0);
  assert.equal(h.state.previews, 0);
});

test('a slot still pointing at a terminal run is previewed without waiting', async () => {
  const h = harness([{ ...readyRow, current_run_id: 'prior-run' }]);
  assert.equal(await previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps), 'previewed');
  assert.equal(h.state.sleeps, 0);
  assert.equal(h.state.waits, 0);
});

test('a scored pick previews directly without reading the slot', async () => {
  const h = harness([releasingRow]);
  assert.equal(
    await previewWhenSlotClaimable('new-run', 0, undefined, h.preview, h.deps),
    'previewed',
  );
  assert.equal(h.state.reads, 0);
});

test('a cancel that lands after the preview still blocks the claim write', async () => {
  // The step persists the pressure ref and queues the claim after the
  // preview returns; the claim CAS must re-read the run, not trust the guard.
  const h = harness([readyRow]);
  assert.equal(await previewWhenSlotClaimable('new-run', 0, SLOT, h.preview, h.deps), 'previewed');
  assert.equal(slotClaimAllowed(readyRow, 'new-run', 0, h.deps.runLookup, false), true);
  for (const changed of [
    { status: 'cancelled' },
    { status: 'paused' },
    { status: 'slot-finding', engineState: { generation: 1 } },
  ] as Lookup[]) {
    h.table['new-run'] = changed;
    assert.equal(slotClaimAllowed(readyRow, 'new-run', 0, h.deps.runLookup, false), false);
    assert.equal(slotClaimAllowed(readyRow, 'new-run', 0, h.deps.runLookup, true), false);
  }
  h.table['new-run'] = { status: 'slot-finding' };
  assert.equal(
    slotClaimAllowed(readyRow, 'new-run', 0, () => undefined, false),
    false,
  );
});

test('the claim CAS keeps takeover semantics for a current run', () => {
  const lookup = (id: string) =>
    ({ 'new-run': { status: 'slot-finding' }, live: { status: 'monitoring' } })[id as 'new-run'] as
      | Lookup
      | undefined;
  const liveOwned = { ...readyRow, lifecycle: 'busy', phase: 'working', current_run_id: 'live' };
  assert.equal(slotClaimAllowed(liveOwned, 'new-run', 0, lookup, false), false);
  assert.equal(slotClaimAllowed(liveOwned, 'new-run', 0, lookup, true), true);
  assert.equal(slotClaimAllowed(releasingRow, 'new-run', 0, lookup, true), false);
  assert.equal(
    slotClaimAllowed({ ...liveOwned, handoff_run_id: 'other' }, 'new-run', 0, lookup, true),
    false,
  );
});

/**
 * In-memory slot status with the claim write's rename held open: the CAS
 * predicate runs, then the write waits on `release` before it lands, as
 * claimSlotStatusIf does while atomicWriteStatus renames the file.
 */
function pendingWriteStatus(
  row: Record<string, unknown>,
  afterWrite?: (slot: Record<string, unknown>) => void,
) {
  const rows = new Map([[String(row.slot), { ...row }]]);
  let release!: () => void;
  const written = new Promise<void>((resolve) => (release = resolve));
  let predicatePassed!: () => void;
  const predicateDone = new Promise<void>((resolve) => (predicatePassed = resolve));
  const applyIf = (
    slotId: string,
    predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
    fields: Record<string, unknown>,
  ) => {
    const slot = rows.get(slotId)!;
    if (!predicate(slot)) return false;
    Object.assign(slot, fields);
    return true;
  };
  return {
    rows,
    release,
    predicateDone,
    deps: {
      claimSlotStatusIf: async (
        slotId: string,
        predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
        fields: Record<string, unknown>,
      ) => {
        const slot = rows.get(slotId)!;
        if (!predicate(slot)) return { claimed: false, epoch: null };
        predicatePassed();
        await written;
        const epoch = (Number(slot.slot_epoch) || 0) + 1;
        Object.assign(slot, fields, { slot_epoch: epoch });
        afterWrite?.(slot);
        return { claimed: true, epoch };
      },
      resetSlotIf: async (
        slotId: string,
        predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
        warm = false,
      ) =>
        applyIf(slotId, predicate, {
          lifecycle: 'ready',
          phase: null,
          agent: 'idle',
          warm,
          current_run_id: null,
          handoff_run_id: null,
        }),
      updateSlotStatusIf: async (
        slotId: string,
        predicate: (slot: Readonly<Record<string, unknown>>) => boolean,
        fields: Record<string, unknown>,
      ) => applyIf(slotId, predicate, fields),
      readRow: async (slotId: string) => rows.get(slotId) ?? null,
    },
  };
}

test('a cancel that lands while the claim write is pending leaves the slot free', async () => {
  const status = pendingWriteStatus({ ...readyRow, slot_epoch: 4, warm: true });
  const runs: Record<string, Lookup> = { 'new-run': { status: 'slot-finding' } };
  const claim = commitSlotClaim(SLOT, 'new-run', 0, 'preparing', undefined, undefined, {
    ...status.deps,
    runLookup: (id) => runs[id],
  });
  await status.predicateDone;
  runs['new-run'] = { status: 'cancelled' };
  status.release();
  await assert.rejects(claim, (error: Error & { code?: string }) => {
    assert.equal(error.code, 'SLOT_CLAIM_REFUSED');
    assert.match(error.message, /Run new-run changed while waiting for slot macpro-mm-pixel6/);
    return true;
  });
  const row = status.rows.get(SLOT)!;
  assert.equal(row.current_run_id, null, 'the cancelled run must not keep the slot');
  assert.equal(row.lifecycle, 'ready');
  assert.equal(row.slot_epoch, 5);
  assert.equal(row.warm, true);
  assert.equal(runs['new-run'].status, 'cancelled');
});

const liveOwned = {
  ...readyRow,
  lifecycle: 'busy',
  phase: 'working',
  agent: 'working',
  current_run_id: 'live',
  handoff_run_id: null,
  slot_epoch: 7,
};

for (const [shape, prior, claimPhase, agent] of [
  ['a nudge into the live worker', liveOwned, 'working', 'working'],
  ['a fresh-reuse fence that relabels the phase', liveOwned, 'preparing', undefined],
  [
    'a warm-session handoff over a ci-watch hold',
    { ...liveOwned, lifecycle: 'held', phase: 'ci-watch', agent: 'idle' },
    'working',
    'working',
  ],
] as const) {
  test(`a takeover superseded mid-write (${shape}) restores the live owner's row`, async () => {
    const status = pendingWriteStatus({ ...prior });
    const runs: Record<string, Lookup> = {
      'new-run': { status: 'slot-finding' },
      live: { status: 'monitoring' },
    };
    const claim = commitSlotClaim(
      SLOT,
      'new-run',
      0,
      claimPhase,
      agent,
      { takeoverLiveOwner: true },
      { ...status.deps, runLookup: (id) => runs[id] },
    );
    await status.predicateDone;
    runs['new-run'] = { status: 'paused' };
    status.release();
    await assert.rejects(claim, /Run new-run changed while waiting/);
    assert.deepEqual(status.rows.get(SLOT), { ...prior, slot_epoch: 8 });
  });
}

test('a takeover undo leaves the row alone once ownership moved under the reservation', async () => {
  let after: Record<string, unknown> = {};
  const status = pendingWriteStatus({ ...liveOwned }, (slot) => {
    slot.current_run_id = 'successor';
    after = { ...slot };
  });
  const runs: Record<string, Lookup> = {
    'new-run': { status: 'slot-finding' },
    live: { status: 'monitoring' },
  };
  const claim = commitSlotClaim(
    SLOT,
    'new-run',
    0,
    'preparing',
    undefined,
    { takeoverLiveOwner: true },
    { ...status.deps, runLookup: (id) => runs[id] },
  );
  await status.predicateDone;
  runs['new-run'] = { status: 'cancelled' };
  status.release();
  await assert.rejects(claim, /Run new-run changed while waiting/);
  assert.deepEqual(status.rows.get(SLOT), after);
});

test('a claim the CAS refuses is named; one refused for a superseded run says so', async () => {
  const runs: Record<string, Lookup> = {
    'new-run': { status: 'slot-finding' },
    live: { status: 'monitoring' },
  };
  const owned = pendingWriteStatus({
    ...readyRow,
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: 'live',
  });
  await assert.rejects(
    commitSlotClaim(SLOT, 'new-run', 0, 'preparing', undefined, undefined, {
      ...owned.deps,
      runLookup: (id) => runs[id],
    }),
    /cannot be claimed: slot is claimed by live run live \(monitoring\)/,
  );
  const free = pendingWriteStatus({ ...readyRow });
  runs['new-run'] = { status: 'cancelled' };
  await assert.rejects(
    commitSlotClaim(SLOT, 'new-run', 0, 'preparing', undefined, undefined, {
      ...free.deps,
      runLookup: (id) => runs[id],
    }),
    /Run new-run changed while waiting for slot/,
  );
  assert.equal(free.rows.get(SLOT)!.current_run_id, null, 'nothing was written');
});

test('a claim for a current run binds the slot', async () => {
  const status = pendingWriteStatus({ ...readyRow, slot_epoch: 2 });
  const claim = commitSlotClaim(SLOT, 'new-run', 0, 'preparing', undefined, undefined, {
    ...status.deps,
    runLookup: () => ({ status: 'slot-finding' }),
  });
  await status.predicateDone;
  status.release();
  await claim;
  const row = status.rows.get(SLOT)!;
  assert.equal(row.current_run_id, 'new-run');
  assert.equal(row.phase, 'preparing');
  assert.equal(row.slot_epoch, 3);
});

for (const [shape, prior] of [
  ['a free slot', { ...readyRow, agent: 'idle', warm: false, handoff_run_id: null, slot_epoch: 3 }],
  [
    'a retained-ready slot',
    {
      ...readyRow,
      agent: 'working',
      warm: true,
      current_run_id: 'prior-run',
      handoff_run_id: null,
      slot_epoch: 3,
    },
  ],
] as const) {
  test(`a fresh-reuse reservation on ${shape} cancelled mid-write restores the slot`, async () => {
    const status = pendingWriteStatus({ ...prior });
    const runs: Record<string, Lookup> = {
      'new-run': { status: 'slot-finding' },
      'prior-run': { status: 'done' },
    };
    const claim = commitSlotClaim(
      SLOT,
      'new-run',
      0,
      'preparing',
      undefined,
      { reserveOnly: true },
      { ...status.deps, runLookup: (id) => runs[id] },
    );
    await status.predicateDone;
    runs['new-run'] = { status: 'cancelled' };
    status.release();
    await assert.rejects(claim, /Run new-run changed while waiting/);
    assert.deepEqual(status.rows.get(SLOT), { ...prior, slot_epoch: 4 });
  });
}

// What may land on the row between this claim's write and its undo. Claims
// bump the epoch (a rival's, or this run's own replayed attempt reclaiming
// its slot); marks do not (a release fence, or a cancel settling ownership).
// Each case pins one clause of the undo fence.
const laterWriters = [
  [
    'a rival claim',
    { generation: 0 },
    () => ({
      lifecycle: 'busy',
      phase: 'preparing',
      current_run_id: 'rival',
      handoff_run_id: 'rival',
    }),
    true,
  ],
  [
    "this run's replayed attempt reclaiming the slot",
    { generation: 1 },
    () => ({ lifecycle: 'busy', phase: 'preparing' }),
    true,
  ],
  [
    'a release fence over this claim',
    { generation: 0 },
    () => ({ lifecycle: 'busy', phase: 'releasing', releasing_since: releasingSince }),
    false,
  ],
  [
    'a cancel settling the slot it never owned',
    { generation: 0 },
    () => ({
      lifecycle: 'held',
      phase: 'occupied',
      current_run_id: null,
      handoff_run_id: null,
      held_reason: 'Process 1 still uses the slot repository; slot teardown was skipped',
    }),
    false,
  ],
  [
    'a cancel clearing only the reservation',
    { generation: 0 },
    () => ({ handoff_run_id: null }),
    false,
  ],
] as const;

for (const [kind, opts] of [
  ['an ordinary claim', undefined],
  ['a fresh-reuse reservation', { reserveOnly: true }],
] as const) {
  for (const [writer, supersede, later, bumps] of laterWriters) {
    // An ordinary claim holds no reservation for that cancel to clear.
    if (!opts && writer === 'a cancel clearing only the reservation') continue;
    test(`undoing ${kind} leaves ${writer} alone`, async () => {
      let after: Record<string, unknown> = {};
      const status = pendingWriteStatus({ ...readyRow, slot_epoch: 1 }, (slot) => {
        Object.assign(slot, later(), {
          slot_epoch: Number(slot.slot_epoch) + (bumps ? 1 : 0),
        });
        after = { ...slot };
      });
      const runs: Record<string, Lookup> = {
        'new-run': { status: 'slot-finding' },
        rival: { status: 'slot-finding' },
      };
      const claim = commitSlotClaim(SLOT, 'new-run', 0, 'preparing', undefined, opts, {
        ...status.deps,
        runLookup: (id) => runs[id],
      });
      await status.predicateDone;
      runs['new-run'] = {
        status: supersede.generation ? 'slot-finding' : 'cancelled',
        engineState: { generation: supersede.generation },
      };
      status.release();
      await assert.rejects(claim, /Run new-run changed while waiting/);
      assert.deepEqual(status.rows.get(SLOT), after);
    });
  }
}
