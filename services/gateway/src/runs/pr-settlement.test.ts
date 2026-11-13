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
    retentionDays: () => 7,
    projectRepo: async () => 'owner/repo',
    openPrs: async () => {
      throw new Error('rate limited');
    },
  });
  assert.equal(runRetentionHold(relinked, context), 'PR state unknown');
});

const jira = { label: 'Jira', url: 'https://jira.example/browse/SETTLEMENT-1' };
const prLink = (repo: string, number: number) => ({
  label: 'PR',
  url: `https://github.com/${repo}/pull/${number}`,
});

test('a removed PR link clears the record, so a later publication elsewhere starts unsettled', async (t) => {
  const run = mergedRun(t, 'SETTLEMENT-REMOVED', 9109);
  updateRun(run.id, { links: [jira, prLink('owner/repo', 9109)] });
  // A link refresh that keeps only Jira drops the PR link.
  updateRun(run.id, { links: [jira] });
  assert.equal(getRun(run.id)?.prState, undefined);
  await recordRunPRPublication(run.id, 'owner/other', 9109);
  assert.deepEqual(settlement(run.id), {
    prNumber: 9109,
    prState: undefined,
    mergedAt: undefined,
  });
});

test('a links-only move to another repository clears; a different guessed link number keeps', async (t) => {
  const moved = mergedRun(t, 'SETTLEMENT-LINKS', 9110);
  updateRun(moved.id, { links: [prLink('owner/repo', 9110)] });
  // The link names the highest number the ticket mentions; prNumber stays authoritative.
  updateRun(moved.id, { links: [prLink('Owner/Repo', 9999)] });
  assert.equal(getRun(moved.id)?.prState, 'MERGED');
  updateRun(moved.id, { links: [prLink('owner/other', 9110)] });
  assert.equal(getRun(moved.id)?.prState, undefined);
});

test('values the relinking update sets itself win over the cleared record', async (t) => {
  const run = mergedRun(t, 'SETTLEMENT-EXPLICIT', 9111);
  updateRun(run.id, { prNumber: 9112, prState: 'CLOSED', mergedAt: null });
  assert.deepEqual(settlement(run.id), { prNumber: 9112, prState: 'CLOSED', mergedAt: null });
});
