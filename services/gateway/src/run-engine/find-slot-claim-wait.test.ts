import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
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
