import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { persistRunPrNumber, recordRunPRPublication } from '../integrations/pr-linkage.js';
import { retentionContext } from '../methods/run/retention.js';

import { runRetentionHold } from './retention.js';
import { createRun, deleteRun, getRun, updateRun } from './store.js';

const MERGED_AT = '2026-10-01T12:00:00.000Z';

/** A dev run whose CI watch recorded PR `prNumber` as merged; each test run binds its own PR. */
function mergedRun(t: test.TestContext, ticket: string, prNumber: number): Run {
  const run = createRun({ flowType: 'dev', project: 'project', ticketOrPr: ticket });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
  });
  updateRun(run.id, { prNumber, prState: 'MERGED', mergedAt: MERGED_AT });
  return run;
}

const settlement = (id: string) => {
  const run = getRun(id);
  return { prNumber: run?.prNumber, prState: run?.prState, mergedAt: run?.mergedAt };
};

test('relinking a run to another PR clears the old PR merge record', async (t) => {
  const relinked = mergedRun(t, 'SETTLEMENT-RELINK', 9101);
  await persistRunPrNumber(relinked.id, 9102);
  assert.deepEqual(settlement(relinked.id), {
    prNumber: 9102,
    prState: undefined,
    mergedAt: undefined,
  });

  const forced = mergedRun(t, 'SETTLEMENT-FORCE', 9103);
  updateRun(forced.id, { prNumber: 9104 });
  assert.deepEqual(settlement(forced.id), {
    prNumber: 9104,
    prState: undefined,
    mergedAt: undefined,
  });

  const same = mergedRun(t, 'SETTLEMENT-SAME', 9105);
  await persistRunPrNumber(same.id, 9105);
  updateRun(same.id, { prNumber: 9105 });
  assert.deepEqual(settlement(same.id), {
    prNumber: 9105,
    prState: 'MERGED',
    mergedAt: MERGED_AT,
  });
});

test('publishing to a PR in another repository clears it; the same PR keeps it', async (t) => {
  const run = mergedRun(t, 'SETTLEMENT-PUBLICATION', 9106);
  // The first PR link names the number the merge was recorded for; repository case differs after.
  await recordRunPRPublication(run.id, 'owner/repo', 9106);
  await recordRunPRPublication(run.id, 'Owner/Repo', 9106);
  assert.deepEqual(settlement(run.id), {
    prNumber: 9106,
    prState: 'MERGED',
    mergedAt: MERGED_AT,
  });
  await recordRunPRPublication(run.id, 'owner/other', 9106);
  assert.deepEqual(settlement(run.id), {
    prNumber: 9106,
    prState: undefined,
    mergedAt: undefined,
  });
});

test('retention holds a relinked run whose new PR cannot be read', async (t) => {
  const run = mergedRun(t, 'SETTLEMENT-RETENTION', 9107);
  await persistRunPrNumber(run.id, 9108);
  updateRun(run.id, { status: 'done', completedAt: '2026-01-01T00:00:00.000Z' });
  const relinked = getRun(run.id)!;
  const context = await retentionContext([relinked], Date.parse('2026-11-13T00:00:00.000Z'), {
    projectRepo: async () => 'owner/repo',
    openPrs: async () => {
      throw new Error('rate limited');
    },
  });
  assert.equal(runRetentionHold(relinked, context), 'PR state unknown');
});
