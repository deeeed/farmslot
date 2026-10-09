import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { awaitSlotClaimable, EXPLICIT_SLOT_RELEASE_WAIT_MS } from './find-slot-step.js';

const releasingSince = '2026-10-09T11:04:16.694Z';
const releasingRow = {
  slot: 'macpro-mm-pixel6',
  lifecycle: 'busy',
  phase: 'releasing',
  releasing_since: releasingSince,
  current_run_id: 'prior-run',
};
const readyRow = { slot: 'macpro-mm-pixel6', lifecycle: 'ready', phase: null };

function fakeClock() {
  const clock = { nowMs: 0, sleeps: 0 };
  return {
    clock,
    now: () => clock.nowMs,
    sleep: async (ms: number) => {
      clock.nowMs += ms;
      clock.sleeps += 1;
    },
  };
}

const runs: Record<string, { status: string }> = {
  'prior-run': { status: 'cancelled' },
  'live-run': { status: 'monitoring' },
};
const ownerRunLookup = (id: string) => runs[id];

test('an explicit slot mid-release is claimable once the release lands inside the bound', async () => {
  const { clock, now, sleep } = fakeClock();
  const rows = [releasingRow, releasingRow, releasingRow, readyRow];
  await awaitSlotClaimable('macpro-mm-pixel6', 'new-run', {
    readRow: async () => rows.shift() ?? readyRow,
    ownerRunLookup,
    now,
    sleep,
  });
  assert.equal(clock.sleeps, 3);
  assert.ok(clock.nowMs < EXPLICIT_SLOT_RELEASE_WAIT_MS);
});

test('a release that never lands fails after the bound, naming when it started', async () => {
  const { clock, now, sleep } = fakeClock();
  await assert.rejects(
    awaitSlotClaimable('macpro-mm-pixel6', 'new-run', {
      readRow: async () => releasingRow,
      ownerRunLookup,
      now,
      sleep,
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'SLOT_CLAIM_REFUSED');
      assert.match(error.message, /Slot macpro-mm-pixel6 cannot be claimed/);
      assert.match(error.message, new RegExp(`release in progress since ${releasingSince}`));
      assert.match(error.message, /still releasing after 5m/);
      return true;
    },
  );
  assert.ok(clock.nowMs >= EXPLICIT_SLOT_RELEASE_WAIT_MS);
});

test('a slot claimed by a live run fails at once, naming the run and its state', async () => {
  const { clock, now, sleep } = fakeClock();
  await assert.rejects(
    awaitSlotClaimable('macpro-mm-pixel6', 'new-run', {
      readRow: async () => ({
        slot: 'macpro-mm-pixel6',
        lifecycle: 'busy',
        phase: 'working',
        current_run_id: 'live-run',
      }),
      ownerRunLookup,
      now,
      sleep,
    }),
    /cannot be claimed: slot is claimed by live run live-run \(monitoring\)/,
  );
  assert.equal(clock.sleeps, 0);
});

test('a workspace-occupancy hold fails at once naming its reason, since when and which run left it', async () => {
  const heldReason = 'Process 50176 still uses the slot repository; slot teardown was skipped';
  const { clock, now, sleep } = fakeClock();
  await assert.rejects(
    awaitSlotClaimable('macpro-mme-1', 'new-run', {
      readRow: async () => ({
        slot: 'macpro-mme-1',
        lifecycle: 'held',
        phase: 'occupied',
        current_run_id: null,
        held_reason: heldReason,
      }),
      ownerRunLookup,
      listSlotRuns: async () => [
        {
          id: 'older-run',
          status: 'cancelled',
          slotId: 'macpro-mme-1',
          slotTeardownSkipped: heldReason,
          statusChangedAt: '2026-10-09T07:00:00.000Z',
        },
        {
          id: 'canceller-run',
          status: 'cancelled',
          slotId: 'macpro-mme-1',
          slotTeardownSkipped: heldReason,
          statusChangedAt: '2026-10-09T11:40:00.000Z',
        },
        {
          id: 'other-slot-run',
          status: 'cancelled',
          slotId: 'macpro-mme-2',
          slotTeardownSkipped: heldReason,
          statusChangedAt: '2026-10-09T11:44:00.000Z',
        },
      ],
      now,
      sleep,
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /slot remains occupied since 2026-10-09T11:40:00\.000Z, left by run canceller-run \(cancelled\): Process 50176 still uses the slot repository/,
      );
      assert.match(error.message, /release it with `farmslot slot release macpro-mme-1`/);
      assert.doesNotMatch(error.message, /mid-release/);
      return true;
    },
  );
  assert.equal(clock.sleeps, 0);
});

test('a slot still pointing at a terminal run is claimable without waiting', async () => {
  const { clock, now, sleep } = fakeClock();
  await awaitSlotClaimable('macpro-mm-pixel6', 'new-run', {
    readRow: async () => ({ ...readyRow, current_run_id: 'prior-run' }),
    ownerRunLookup,
    now,
    sleep,
  });
  assert.equal(clock.sleeps, 0);
});

test('FIND_SLOT waits on an explicit slot before previewing it', () => {
  // Preview refuses a releasing slot as busy, so the wait must come first.
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'find-slot-step.ts'),
    'utf-8',
  );
  const step = source.slice(source.indexOf('export async function executeFindSlotStep('));
  const wait = step.indexOf('awaitSlotClaimable(explicitSlotId, runId)');
  assert.ok(wait > 0, 'executeFindSlotStep waits on the explicit slot');
  assert.ok(wait < step.indexOf('await dispatchPreview('), 'the wait precedes the preview');
});
