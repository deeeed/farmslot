import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { ReadyGatePayload, ReviewStatus, RunDecision } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { GatewayMethodError } from '../core/method-error.js';
import {
  archiveRun,
  createRun,
  deleteRun,
  getRun,
  runsDirectory,
  updateRun,
} from '../runs/store.js';

import {
  admitReviewRound,
  assertReviewRoundAvailable,
  attachReviewRoundBudget,
  reviewLaunchStartedAt,
  reviewRoundAdmissionId,
  runReviewRoundBudget,
} from './review-round-budget.js';

function fixture(t: TestContext, ref = `example/budget-${randomUUID()}#42`) {
  const run = createRun({
    project: 'review-round-budget',
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: ref,
    runner: 'scripted',
  });
  updateRun(run.id, {
    links: [{ label: 'PR', url: `https://github.com/${ref.replace('#', '/pull/')}` }],
  });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  return getRun(run.id)!;
}

test('normalized issue references do not pool pre-PR rounds or contaminate a later PR', async (t) => {
  const ref = `example/issue-${randomUUID()}#42`;
  const first = fixture(t, ref);
  const second = fixture(t, ref);
  for (const run of [first, second]) updateRun(run.id, { links: [] });
  for (let index = 0; index < 3; index++) await admitReviewRound(first.id, `pre-pr-${index}`);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 0);
  updateRun(second.id, {
    links: [{ label: 'PR', url: `https://github.com/${ref.replace('#42', '/pull/99')}` }],
  });
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 3);
});

test('pipeline and gate chains share five admissions persisted before launch', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 5; index++) {
    const id = reviewRoundAdmissionId(index < 2 ? 'pipeline' : 'gate', index + 1, `start-${index}`);
    await admitReviewRound(run.id, id);
    const persisted = JSON.parse(
      await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
    );
    assert.ok(persisted.reviewRoundAdmissions.includes(id), 'receipt is durable before dispatch');
    assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, index + 1);
  }
  await assert.rejects(admitReviewRound(run.id, 'sixth'), (error: unknown) => {
    assert.ok(error instanceof GatewayMethodError);
    assert.equal(error.code, 'REVIEW_ROUND_LIMIT_REACHED');
    assert.match(error.message, /design problem or scope creep/);
    return true;
  });
  assert.equal(getRun(run.id)!.reviewRoundAdmissions!.length, 5);
});

test('a recovered admission survives replay without spending another round', async (t) => {
  const run = fixture(t);
  await admitReviewRound(run.id, 'same-attempt');
  updateRun(run.id, { engineState: { generation: 2 }, steps: [] });
  await admitReviewRound(run.id, 'same-attempt');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
  await admitReviewRound(run.id, 'fresh-attempt');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 2);
});

test('a review context relaunched after a restart reuses the round it reserved', async (t) => {
  // Run 8cff6e80: the invalid-JSON relaunch reserved a round and created its
  // context, the gateway restarted before the reviewer started, and recovery
  // reserved a second round for the same loop. Five rounds ran out after two verdicts.
  const run = fixture(t);
  const lineage = `pipeline-review-${run.id}`;
  const admit = (startedAt: string) =>
    admitReviewRound(run.id, reviewRoundAdmissionId(lineage, 1, startedAt));
  await admit('2026-10-18T08:08:24.066Z');
  await admit('2026-10-18T10:09:14.551Z');
  const reserved = reviewLaunchStartedAt(undefined, '2026-10-18T10:19:15.799Z');
  await admit(reserved);
  const interrupted = { startedAt: reserved, attemptStartedAt: reserved };

  await admit(reviewLaunchStartedAt(interrupted, '2026-10-18T10:20:13.664Z'));
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 3);

  // Its reviewer's mark start later rewrites attemptStartedAt; a mid-review
  // restart still recovers the same round.
  const launched = { ...interrupted, attemptStartedAt: '2026-10-18T10:20:55.000Z' };
  await admit(reviewLaunchStartedAt(launched, '2026-10-18T10:30:00.000Z'));
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 3);
});

test('concurrent runs for the same PR cannot both spend the last round', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.ticketOrPr);
  const foreign = fixture(t);
  for (let index = 0; index < 4; index++) await admitReviewRound(first.id, `spent-${index}`);
  const results = await Promise.allSettled([
    admitReviewRound(first.id, 'first-fifth'),
    admitReviewRound(second.id, 'second-fifth'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 5);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 5);
  assert.equal((await runReviewRoundBudget(getRun(foreign.id)!)).used, 0);
  await assert.rejects(assertReviewRoundAvailable(getRun(second.id)!), /five review rounds/);
});

test('copied legacy lineage attempts count once, including failed and cancelled rounds', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.ticketOrPr);
  const review: ReviewStatus = {
    id: 'legacy-lineage',
    mode: 'cold',
    loopNumber: 1,
    verdict: 'failed',
    unresolvedCount: 1,
    attempts: ['failed', 'cancelled', 'issues'].map((verdict, index) => ({
      mode: 'cold',
      loopNumber: index + 1,
      verdict: verdict as 'failed' | 'cancelled' | 'issues',
      unresolvedCount: 1,
      startedAt: `old-${index}`,
    })),
  };
  for (const run of [first, second])
    updateRun(run.id, { engineState: { publishGate: { reviews: [review] } } });
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 3);
  await admitReviewRound(first.id, 'new-fourth');
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 4);
  updateRun(first.id, { engineState: { generation: 3 } });
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 4);
});

test('retiring an earlier run does not refund the PR budget in its successor', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.ticketOrPr);
  await admitReviewRound(first.id, 'earlier-round');
  updateRun(first.id, { status: 'failed' });
  await deleteRun(first.id);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 1);
  await admitReviewRound(second.id, 'successor-round');
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 2);
});

test('a legacy result and its launch context are one round despite completion timestamps', async (t) => {
  const run = fixture(t);
  updateRun(run.id, {
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'legacy-native',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'failed',
            unresolvedCount: 0,
            startedAt: '2026-10-12T01:02:00.000Z',
          },
        ],
      },
    },
    agentContexts: [
      {
        id: 'native-review',
        role: 'review',
        runId: run.id,
        slotId: run.slotId ?? null,
        reviewId: 'legacy-native',
        reviewLoopNumber: 1,
        label: 'Review',
        status: 'failed',
        updatedAt: '2026-10-12T01:02:00.000Z',
        attemptStartedAt: '2026-10-12T01:00:00.000Z',
      },
    ],
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});

test('a new run inherits all spent rounds after its predecessor was archived', async (t) => {
  const first = fixture(t);
  for (let index = 0; index < 5; index++) await admitReviewRound(first.id, `archived-${index}`);
  updateRun(first.id, { status: 'failed', completedAt: new Date().toISOString() });
  assert.equal(await archiveRun(first.id), true);
  t.after(() => rm(path.join(runsDirectory(), 'archive', `${first.id}.json`), { force: true }));
  const successor = fixture(t, first.ticketOrPr);
  assert.equal((await runReviewRoundBudget(getRun(successor.id)!)).used, 5);
  await assert.rejects(admitReviewRound(successor.id, 'sixth-after-archive'), /five review rounds/);
});

test('legacy gate display adds the budget without changing its captured fields or resolved gates', async (t) => {
  const run = fixture(t);
  const payload: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    branch: 'unchanged-captured-branch',
    workerReport: 'Captured report',
    diffStat: { files: 0, additions: 0, deletions: 0 },
  };
  const gate: RunDecision = {
    id: 'legacy-gate',
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    actions: [],
    payload,
    createdAt: new Date().toISOString(),
  };
  updateRun(run.id, {
    decisions: [gate],
    reviewRoundAdmissions: ['one', 'two', 'three', 'four', 'five'],
  });
  const projected = await attachReviewRoundBudget(getRun(run.id)!);
  assert.equal(projected.decisions[0].payload?.kind, 'ready');
  const { reviewRoundBudget, ...captured } = projected.decisions[0].payload as ReadyGatePayload;
  assert.equal(reviewRoundBudget?.label, 'Review rounds 5/5');
  assert.deepEqual(captured, payload);
  assert.equal(
    (getRun(run.id)!.decisions[0].payload as ReadyGatePayload).reviewRoundBudget,
    undefined,
  );
  updateRun(run.id, { decisions: [{ ...gate, resolvedAt: new Date().toISOString() }] });
  const resolved = getRun(run.id)!;
  assert.equal(await attachReviewRoundBudget(resolved), resolved);
});
