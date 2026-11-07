import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  type ReadyGatePayload,
  reviewRoundBudgetForRun,
  reviewRoundBudgetLabel,
  type ReviewStatus,
  type Run,
  type RunDecision,
  workspaceReviewRoundAdmissionId,
} from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { GatewayMethodError } from '../core/method-error.js';
import {
  archiveRun,
  createRun,
  deleteRun,
  getRun,
  persistRunNow,
  runsDirectory,
  updateRun,
} from '../runs/store.js';

import {
  recordedReviewRound as reviewedRound,
  recordedReviewRounds as recordedRounds,
} from './recorded-review-rounds.test-support.js';
import {
  admitReviewRound,
  assertReviewRoundAvailable,
  attachReviewRoundBudget,
  nextReviewBudgetScopeBrief,
  prepareReviewRoundAvailabilityCheck,
  recordReviewRoundVerdict,
  reviewAttemptPolicyRound,
  reviewBudgetScopeBrief,
  reviewLaunchStartedAt,
  reviewNoVerdictCapReason,
  reviewPolicyRound,
  reviewRoundAdmissionId,
  runReviewRoundBudget,
  settleReviewRoundNoVerdict,
} from './review-round-budget.js';

function fixture(
  t: TestContext,
  ref = `example/budget-${randomUUID()}#42`,
  flowType: Run['flowType'] = 'dev',
) {
  const run = createRun({
    project: 'review-round-budget',
    flowType,
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

test('the reviewer task states its review round so the round-3 rule can apply', async (t) => {
  const run = fixture(t);
  const { limit } = await runReviewRoundBudget(run);
  assert.match(
    await nextReviewBudgetScopeBrief(getRun(run.id)!),
    new RegExp(`Review round 1 of ${limit}\\.`),
  );
  for (let index = 0; index < 2; index++) await reviewedRound(run.id, `round-${index}`);
  await admitReviewRound(run.id, 'round-2');
  // A launched reviewer is admitted before its task document is written.
  assert.match(
    reviewBudgetScopeBrief(getRun(run.id)!),
    new RegExp(`Review round 3 of ${limit}\\.`),
  );
  await recordReviewRoundVerdict(run.id, 'round-2');
  assert.match(
    await nextReviewBudgetScopeBrief(getRun(run.id)!),
    new RegExp(`Review round 4 of ${limit}\\.`),
  );
});

test('normalized issue references do not pool pre-PR rounds or contaminate a later PR', async (t) => {
  const ref = `example/issue-${randomUUID()}#42`;
  const first = fixture(t, ref);
  const second = fixture(t, ref);
  for (const run of [first, second]) updateRun(run.id, { links: [] });
  for (let index = 0; index < 3; index++) await reviewedRound(first.id, `pre-pr-${index}`);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 0);
  updateRun(second.id, {
    links: [{ label: 'PR', url: `https://github.com/${ref.replace('#42', '/pull/99')}` }],
  });
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 3);
});

test('review-pr requests have own rounds after six archived requests spent the same PR budget', async (t) => {
  const ref = `example/review-request-${randomUUID()}#10693`;
  for (let i = 0; i < 6; i++) {
    const prior = fixture(t, ref, 'review-pr');
    updateRun(prior.id, {
      ...recordedRounds([`old-request-${i}`]),
      status: 'failed',
      completedAt: new Date().toISOString(),
    });
    assert.equal(await archiveRun(prior.id), true);
    t.after(() => rm(path.join(runsDirectory(), 'archive', `${prior.id}.json`), { force: true }));
  }
  const request = fixture(t, ref, 'review-pr');
  const sibling = fixture(t, ref, 'review-pr');
  const feature = fixture(t, ref);
  // Legacy receipts already copied into a feature snapshot keep their charge.
  updateRun(feature.id, recordedRounds(['old-request-0']));
  assert.equal((await runReviewRoundBudget(getRun(request.id)!)).used, 0);
  const check = await prepareReviewRoundAvailabilityCheck(request.id);
  check();
  await assertReviewRoundAvailable(getRun(request.id)!);
  await reviewedRound(request.id, 'own-first');
  updateRun(request.id, { engineState: { generation: 2 } });
  await reviewedRound(request.id, 'own-first');
  assert.equal((await runReviewRoundBudget(getRun(request.id)!)).used, 1);
  assert.equal((await runReviewRoundBudget(getRun(sibling.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(feature.id)!)).used, 1);
  for (let i = 1; i < 5; i++) await reviewedRound(request.id, `own-${i}`);
  assert.throws(check, /All 5 review rounds/);
  await assert.rejects(reviewedRound(request.id, 'own-sixth'), /All 5 review rounds/);
  await reviewedRound(sibling.id, 'sibling-first');
  assert.equal((await runReviewRoundBudget(getRun(sibling.id)!)).used, 1);
  assert.deepEqual(getRun(request.id)!.reviewRoundAdmissions, [
    'own-first',
    'own-1',
    'own-2',
    'own-3',
    'own-4',
  ]);
  assert.deepEqual(getRun(feature.id)!.reviewRoundAdmissions, ['old-request-0']);
});

test('update-branch has two own rounds after the parent PR spent five, preserving raw receipts', async (t) => {
  const parent = fixture(t);
  const update = fixture(t, parent.ticketOrPr, 'update-branch');
  const sibling = fixture(t, parent.ticketOrPr, 'update-branch');
  const gate: RunDecision = {
    id: 'ready',
    type: 'engine_human_gate',
    title: 'Ready',
    description: '',
    actions: [],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'ready',
      prNumber: 42,
      repo: null,
      branch: 'feature',
      workerReport: '',
      diffStat: { files: 0, additions: 0, deletions: 0 },
    },
  };
  for (const run of [parent, update]) updateRun(run.id, { decisions: [gate] });
  for (let i = 0; i < 5; i++) await reviewedRound(parent.id, `parent-${i}`);
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).label, 'Review rounds 0/2');
  const check = await prepareReviewRoundAvailabilityCheck(update.id);
  check();
  await reviewedRound(update.id, 'merge-review');
  updateRun(update.id, { engineState: { generation: 2 } });
  await reviewedRound(update.id, 'merge-review');
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 1);
  const last = await Promise.allSettled([
    reviewedRound(update.id, 'last-a'),
    reviewedRound(update.id, 'last-b'),
  ]);
  assert.equal(last.filter((result) => result.status === 'fulfilled').length, 1);
  assert.throws(check, /All 2 review rounds.*update-branch/);
  await assert.rejects(reviewedRound(update.id, 'third'), /All 2 review rounds/);
  await assert.rejects(reviewedRound(parent.id, 'parent-sixth'), /five review rounds/);
  assert.equal((await runReviewRoundBudget(getRun(sibling.id)!)).label, 'Review rounds 0/2');
  await reviewedRound(sibling.id, 'sibling-first');
  for (const [run, label] of [
    [parent, 'Review rounds 5/5'],
    [update, 'Review rounds 2/2'],
  ] as const) {
    const current = getRun(run.id)!;
    assert.equal((await runReviewRoundBudget(current)).label, label);
    assert.equal(
      (current.decisions[0].payload as ReadyGatePayload).reviewRoundBudget?.label,
      label,
    );
    const persisted = JSON.parse(
      await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
    );
    assert.equal(persisted.reviewRoundOwners['merge-review'], update.id);
    assert.equal(persisted.reviewRoundOwners['sibling-first'], sibling.id);
    assert.equal(persisted.reviewRoundAdmissions.length, 8);
  }
});

test('legacy copied receipts keep their PR charge when an update-branch reattaches', async (t) => {
  const parent = fixture(t);
  const update = fixture(t, parent.ticketOrPr, 'update-branch');
  for (const run of [parent, update]) updateRun(run.id, recordedRounds(['legacy']));
  await reviewedRound(update.id, 'legacy');
  assert.equal(getRun(update.id)!.reviewRoundOwners, undefined);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).used, 1);
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 0);
  await reviewedRound(update.id, 'new-owned');
  await reviewedRound(parent.id, 'new-feature');
  updateRun(update.id, { status: 'failed' });
  await deleteRun(update.id);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).used, 2);
  assert.equal(getRun(parent.id)!.reviewRoundOwners?.['new-owned'], update.id);
  const successor = fixture(t, parent.ticketOrPr);
  assert.equal((await runReviewRoundBudget(getRun(successor.id)!)).used, 2);
});

test('update-branch settlements and recovered verdicts affect only their own budget and no-verdict cap', async (t) => {
  const parent = fixture(t);
  const update = fixture(t, parent.ticketOrPr, 'update-branch');
  for (let i = 0; i < 3; i++) {
    await admitReviewRound(parent.id, `parent-failed-${i}`);
    await settleReviewRoundNoVerdict(parent.id, `parent-failed-${i}`, 'parent timeout');
  }
  assert.equal(await reviewNoVerdictCapReason(getRun(update.id)!), undefined);
  for (let i = 0; i < 3; i++) {
    await admitReviewRound(update.id, `update-failed-${i}`);
    await settleReviewRoundNoVerdict(update.id, `update-failed-${i}`, `update failure ${i}`);
  }
  await admitReviewRound(update.id, 'update-failed-0');
  assert.deepEqual(
    [
      (await runReviewRoundBudget(getRun(update.id)!)).used,
      (await runReviewRoundBudget(getRun(update.id)!)).noVerdict,
    ],
    [0, 3],
  );
  const reason = await reviewNoVerdictCapReason(getRun(update.id)!);
  assert.match(reason ?? '', /Last: update failure 0; update failure 1; update failure 2$/);
  assert.doesNotMatch(reason ?? '', /parent timeout/);
  await recordReviewRoundVerdict(update.id, 'update-failed-0');
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 1);
  assert.equal(await reviewNoVerdictCapReason(getRun(update.id)!), undefined);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).noVerdict, 3);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).used, 0);
});

test('archived update-branch admissions do not spend a later feature or update run budget', async (t) => {
  const update = fixture(t, undefined, 'update-branch');
  await reviewedRound(update.id, 'archived-update');
  updateRun(update.id, { status: 'failed', completedAt: new Date().toISOString() });
  assert.equal(await archiveRun(update.id), true);
  t.after(() => rm(path.join(runsDirectory(), 'archive', `${update.id}.json`), { force: true }));
  const feature = fixture(t, update.ticketOrPr);
  const next = fixture(t, update.ticketOrPr, 'update-branch');
  assert.equal((await runReviewRoundBudget(getRun(feature.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(next.id)!)).used, 0);
  await reviewedRound(next.id, 'later-update');
  assert.equal(getRun(feature.id)!.reviewRoundOwners?.['archived-update'], update.id);
  assert.equal((await runReviewRoundBudget(getRun(next.id)!)).used, 1);
});

test('pipeline and gate chains share five admissions persisted before launch', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 5; index++) {
    const id = reviewRoundAdmissionId(index < 2 ? 'pipeline' : 'gate', index + 1, `start-${index}`);
    await reviewedRound(run.id, id);
    const persisted = JSON.parse(
      await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
    );
    assert.ok(persisted.reviewRoundAdmissions.includes(id), 'receipt is durable before dispatch');
    assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, index + 1);
  }
  await assert.rejects(reviewedRound(run.id, 'sixth'), (error: unknown) => {
    assert.ok(error instanceof GatewayMethodError);
    assert.equal(error.code, 'REVIEW_ROUND_LIMIT_REACHED');
    assert.match(error.message, /design problem or scope creep/);
    return true;
  });
  assert.equal(getRun(run.id)!.reviewRoundAdmissions!.length, 5);
});

test('a recovered admission survives replay without spending another round', async (t) => {
  const run = fixture(t);
  await reviewedRound(run.id, 'same-attempt');
  updateRun(run.id, { engineState: { generation: 2 }, steps: [] });
  await reviewedRound(run.id, 'same-attempt');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
  await reviewedRound(run.id, 'fresh-attempt');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 2);
});

test('a review context relaunched after a restart reuses the round it reserved', async (t) => {
  // Run 8cff6e80: the invalid-JSON relaunch reserved a round and created its
  // context, the gateway restarted before the reviewer started, and recovery
  // reserved a second round for the same loop. Five rounds ran out after two verdicts.
  const run = fixture(t);
  const lineage = `pipeline-review-${run.id}`;
  const admit = (startedAt: string) =>
    reviewedRound(run.id, reviewRoundAdmissionId(lineage, 1, startedAt));
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
  for (let index = 0; index < 4; index++) await reviewedRound(first.id, `spent-${index}`);
  const results = await Promise.allSettled([
    reviewedRound(first.id, 'first-fifth'),
    reviewedRound(second.id, 'second-fifth'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 5);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 5);
  assert.equal((await runReviewRoundBudget(getRun(foreign.id)!)).used, 0);
  await assert.rejects(assertReviewRoundAvailable(getRun(second.id)!), /five review rounds/);
});

test('copied legacy history charges only recorded verdicts, not failed or cancelled attempts', async (t) => {
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
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 1);
  await reviewedRound(first.id, 'new-fourth');
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 2);
  updateRun(first.id, { engineState: { generation: 3 } });
  assert.equal((await runReviewRoundBudget(getRun(first.id)!)).used, 2);
});

test('retiring an earlier run does not refund the PR budget in its successor', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.ticketOrPr);
  await reviewedRound(first.id, 'earlier-round');
  updateRun(first.id, { status: 'failed' });
  await deleteRun(first.id);
  assert.equal((await runReviewRoundBudget(getRun(second.id)!)).used, 1);
  await reviewedRound(second.id, 'successor-round');
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
            verdict: 'pass',
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
        status: 'complete',
        updatedAt: '2026-10-12T01:02:00.000Z',
        attemptStartedAt: '2026-10-12T01:00:00.000Z',
      },
    ],
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});

test('a new run inherits all spent rounds after its predecessor was archived', async (t) => {
  const first = fixture(t);
  for (let index = 0; index < 5; index++) await reviewedRound(first.id, `archived-${index}`);
  updateRun(first.id, { status: 'failed', completedAt: new Date().toISOString() });
  assert.equal(await archiveRun(first.id), true);
  t.after(() => rm(path.join(runsDirectory(), 'archive', `${first.id}.json`), { force: true }));
  const successor = fixture(t, first.ticketOrPr);
  assert.equal((await runReviewRoundBudget(getRun(successor.id)!)).used, 5);
  await assert.rejects(reviewedRound(successor.id, 'sixth-after-archive'), /five review rounds/);
});

test('a no-verdict settlement frees pending capacity once and ignores receipts never admitted', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 5; index++) await admitReviewRound(run.id, `round-${index}`);
  await assert.rejects(admitReviewRound(run.id, 'sixth'), { code: 'REVIEW_ROUND_PENDING' });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
  await settleReviewRoundNoVerdict(run.id, 'round-3', 'Native reviewer did not complete');
  await settleReviewRoundNoVerdict(run.id, 'round-3', 'a second end is not recorded');
  await settleReviewRoundNoVerdict(run.id, 'never-admitted', 'not a round of this work');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.remaining, budget.noVerdict], [0, 5, 1]);
  assert.equal(
    getRun(run.id)!.reviewRoundSettlements?.['round-3']?.reason,
    'Native reviewer did not complete',
  );
  await admitReviewRound(run.id, 'replacement');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
  await recordReviewRoundVerdict(run.id, 'replacement');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 1);
});

test('a farm fallback keeps its refund after a verdict, persisted recovery and reattach', async (t) => {
  const run = fixture(t);
  await reviewedRound(run.id, 'original-code');
  await admitReviewRound(run.id, 'failed-warm');
  const replacement = {
    reviewFallback: {
      reason: 'session-unavailable' as const,
      detail: 'the retained reviewer could not resume',
      comparedRanges: [],
    },
  };
  await settleReviewRoundNoVerdict(
    run.id,
    'failed-warm',
    'resume never started',
    'infrastructure-fallback',
  );
  await recordReviewRoundVerdict(run.id, 'failed-warm', replacement);
  await admitReviewRound(run.id, 'failed-warm');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [1, 1]);
  const persisted = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.equal(persisted.reviewRoundSettlements['failed-warm'].kind, 'infrastructure-fallback');
  const successor = fixture(t, run.ticketOrPr);
  await recordReviewRoundVerdict(successor.id, 'failed-warm', replacement);
  assert.equal((await runReviewRoundBudget(getRun(successor.id)!)).used, 1);
  await settleReviewRoundNoVerdict(run.id, 'original-code', 'ordinary late result');
  await recordReviewRoundVerdict(run.id, 'original-code');
  await reviewedRound(run.id, 'next-genuine-review');
  assert.deepEqual(
    [
      (await runReviewRoundBudget(getRun(run.id)!)).used,
      (await runReviewRoundBudget(getRun(run.id)!)).noVerdict,
    ],
    [2, 1],
  );
  // A genuine WARM retry of the original failed context has no COLD fallback
  // provenance and counts normally if it eventually supplies a valid verdict.
  await recordReviewRoundVerdict(run.id, 'failed-warm');
  const resumed = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([resumed.used, resumed.noVerdict], [3, 0]);
});

test('settlements reach every run and open gate in the PR scope and survive retiring a run', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.ticketOrPr);
  updateRun(second.id, {
    decisions: [
      {
        id: 'open-gate',
        type: 'engine_human_gate',
        title: 'Ready',
        description: '',
        actions: [],
        payload: {
          kind: 'ready',
          prNumber: 42,
          repo: null,
          branch: 'feature',
          workerReport: '',
          diffStat: { files: 0, additions: 0, deletions: 0 },
        },
        createdAt: new Date().toISOString(),
      },
    ],
  });
  await admitReviewRound(first.id, 'lost-attempt');
  await reviewedRound(second.id, 'counted-attempt');
  await settleReviewRoundNoVerdict(second.id, 'lost-attempt', 'lost on restart');
  for (const run of [first, second]) {
    const budget = await runReviewRoundBudget(getRun(run.id)!);
    assert.deepEqual([budget.used, budget.noVerdict], [1, 1]);
    assert.equal(
      getRun(run.id)!.reviewRoundSettlements?.['lost-attempt']?.reason,
      'lost on restart',
    );
  }
  const gate = getRun(second.id)!.decisions[0].payload as ReadyGatePayload;
  assert.equal(gate.reviewRoundBudget?.noVerdict, 1);
  updateRun(first.id, { status: 'failed' });
  await deleteRun(first.id);
  const after = await runReviewRoundBudget(getRun(second.id)!);
  assert.deepEqual([after.used, after.noVerdict], [1, 1]);
});

test('a reattach admits its settled receipt again without spending the round or clearing it', async (t) => {
  const run = fixture(t);
  const receipt = reviewRoundAdmissionId('reattached-review', 1, '2026-10-19T08:00:00.000Z');
  await admitReviewRound(run.id, receipt);
  await settleReviewRoundNoVerdict(run.id, receipt, 'Native review was superseded');
  await admitReviewRound(run.id, receipt);
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [0, 1]);
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, [receipt]);
  assert.equal(
    getRun(run.id)!.reviewRoundSettlements?.[receipt]?.reason,
    'Native review was superseded',
  );
});

test('the third no-verdict attempt reaches the cap, naming the count and the last failures', async (t) => {
  const run = fixture(t);
  for (const [index, reason] of ['timeout', 'invalid JSON', 'lost on restart'].entries()) {
    await admitReviewRound(run.id, `failed-${index}`);
    assert.equal(await reviewNoVerdictCapReason(getRun(run.id)!), undefined);
    await settleReviewRoundNoVerdict(run.id, `failed-${index}`, reason);
  }
  const reason = await reviewNoVerdictCapReason(getRun(run.id)!);
  assert.match(reason ?? '', /^3\/3 reviewer attempts ended without a verdict/);
  assert.match(reason ?? '', /Last: timeout; invalid JSON; lost on restart$/);
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.remaining], [0, 5]);
  assert.equal(reviewRoundBudgetLabel(budget), 'Review rounds 0/5 · 3/3 no-verdict');
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
    ...recordedRounds(['one', 'two', 'three', 'four', 'five']),
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

test('an admitted reviewer with no recorded verdict never spends a round', async (t) => {
  const run = fixture(t);
  const startedAt = new Date().toISOString();
  const id = reviewRoundAdmissionId('unstarted-reviewer', 1, startedAt);
  await admitReviewRound(run.id, id);
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.equal(budget.used, 0);
  assert.equal(budget.noVerdict, 0, 'pending is not a failed attempt');
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'unstarted-reviewer',
        runId: run.id,
        slotId: run.slotId ?? null,
        role: 'review',
        label: 'review',
        status: 'failed',
        reviewId: 'unstarted-reviewer',
        reviewLoopNumber: 1,
        startedAt,
      },
    ],
  });
  assert.equal(
    (await runReviewRoundBudget(getRun(run.id)!)).used,
    0,
    'a missing failure settlement must not spend a round',
  );
});

test('terminal reviewers with missing failure settlements release capacity without spending rounds', async (t) => {
  const run = fixture(t);
  const contexts: NonNullable<Run['agentContexts']> = [];
  for (let index = 0; index < 6; index++) {
    const startedAt = `2026-11-06T00:00:0${index}.000Z`;
    const id = `lost-review-${index}`;
    await admitReviewRound(run.id, reviewRoundAdmissionId(id, 1, startedAt));
    contexts.push({
      id,
      runId: run.id,
      slotId: run.slotId ?? null,
      role: 'review',
      label: 'Review',
      status: 'failed',
      reviewId: id,
      reviewLoopNumber: 1,
      startedAt,
    });
    updateRun(run.id, { agentContexts: [...contexts] });
  }
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.remaining, budget.noVerdict], [0, 5, 0]);
  await assertReviewRoundAvailable(getRun(run.id)!);
});

test('an unconfirmed native stop reserves capacity without charging a verdict', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 4; index++) await reviewedRound(run.id, `recorded-${index}`);
  const startedAt = new Date().toISOString();
  const id = reviewRoundAdmissionId('uncertain-stop', 1, startedAt);
  await admitReviewRound(run.id, id);
  const context: NonNullable<Run['agentContexts']>[number] = {
    id: 'uncertain-stop',
    runId: run.id,
    slotId: null,
    role: 'review',
    label: 'Review',
    status: 'failed',
    reviewId: 'uncertain-stop',
    reviewLoopNumber: 1,
    startedAt,
    nativeSession: {
      sessionId: 'session',
      executionNodeId: 'mini',
      ownerPrincipalId: 'owner',
      leaseId: 'lease',
      commandId: 'command',
    },
  };
  updateRun(run.id, { agentContexts: [context] });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 4);
  await assert.rejects(admitReviewRound(run.id, 'duplicate'), { code: 'REVIEW_ROUND_PENDING' });
  updateRun(run.id, {
    agentContexts: [
      {
        ...context,
        nativeSession: { ...context.nativeSession!, closedAt: new Date().toISOString() },
      },
    ],
  });
  await admitReviewRound(run.id, 'replacement');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 4);
});

test('a copied legacy verdict cannot erase its original infrastructure-fallback refund', async (t) => {
  const run = fixture(t);
  const startedAt = '2026-10-18T00:00:00.000Z';
  const id = reviewRoundAdmissionId('free-fallback', 1, startedAt);
  await admitReviewRound(run.id, id);
  await settleReviewRoundNoVerdict(run.id, id, 'resume unavailable', 'infrastructure-fallback');
  const successor = fixture(t, run.ticketOrPr);
  updateRun(successor.id, {
    reviewRoundAdmissions: [id],
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'free-fallback',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            startedAt,
          },
        ],
      },
    },
  });
  const budget = await runReviewRoundBudget(getRun(successor.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [0, 1]);
});

test('legacy in-flight reviewers reserve capacity without a recorded verdict', async (t) => {
  const run = fixture(t);
  updateRun(run.id, {
    agentContexts: Array.from({ length: 5 }, (_, index) => ({
      id: `legacy-live-${index}`,
      runId: run.id,
      slotId: null,
      role: 'review' as const,
      label: 'Review',
      status: 'working' as const,
      startedAt: `2026-10-18T00:00:0${index}.000Z`,
      attemptStartedAt: `2026-10-18T00:01:0${index}.000Z`,
    })),
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
  await assert.rejects(admitReviewRound(run.id, 'another'), { code: 'REVIEW_ROUND_PENDING' });
});

test('orphaned pending admissions from a previous gateway do not exhaust capacity', async (t) => {
  const run = fixture(t);
  const ids = Array.from({ length: 5 }, (_, index) => `orphan-${index}`);
  updateRun(run.id, {
    reviewRoundAdmissions: ids,
    reviewRoundSettlements: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          kind: 'pending' as const,
          reason: 'Previous gateway launch',
          at: '2026-10-18T00:00:00.000Z',
        },
      ]),
    ),
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
  await admitReviewRound(run.id, 'new-launch');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 0);
});

test('a saved terminal workspace reviewer retains its reservation across restart', async (t) => {
  const run = fixture(t, undefined, 'review-pr');
  const subject = {
    repository: 'example/project',
    repositoryUrl: 'https://github.com/example/project',
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    branch: 'feature',
    title: 'Review',
    body: '',
    capturedAt: run.createdAt,
  };
  const withSubject = updateRun(run.id, {
    reviewWorkspaceSubject: subject,
    engineState: { workspaceReviewDispatchGeneration: 4 },
  });
  const id = workspaceReviewRoundAdmissionId(withSubject);
  const prior = recordedRounds(['one', 'two', 'three', 'four']);
  updateRun(run.id, {
    reviewRoundAdmissions: [...prior.reviewRoundAdmissions!, id],
    reviewRoundSettlements: {
      ...prior.reviewRoundSettlements,
      [id]: { kind: 'pending', reason: 'Reviewer pending', at: run.createdAt },
    },
    agentContexts: [
      {
        id: 'review',
        runId: run.id,
        slotId: null,
        role: 'review',
        label: 'Review',
        status: 'working',
        reviewId: 'terminal-session',
        startedAt: run.createdAt,
      },
    ],
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 4);
  await assert.rejects(admitReviewRound(run.id, 'duplicate'), { code: 'REVIEW_ROUND_PENDING' });
});

test('a persisted validated verdict is charged once after reload even before accounting finishes', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 4; index++) await reviewedRound(run.id, `earlier-${index}`);
  const startedAt = new Date().toISOString();
  const id = reviewRoundAdmissionId('interrupted-accounting', 1, startedAt);
  await admitReviewRound(run.id, id);
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'interrupted-accounting',
        runId: run.id,
        slotId: null,
        role: 'review',
        label: 'Review',
        status: 'complete',
        reviewId: 'interrupted-accounting',
        reviewLoopNumber: 1,
        startedAt,
        reviewResultValidatedAt: new Date().toISOString(),
      },
    ],
  });
  await persistRunNow(getRun(run.id)!);
  const restored: Run = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.equal(restored.reviewRoundSettlements?.[id]?.kind, 'pending');
  assert.equal(reviewRoundBudgetForRun(restored).used, 5);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 5);
  await recordReviewRoundVerdict(run.id, id);
  const stamp = getRun(run.id)!.reviewRoundSettlements?.[id]?.at;
  await recordReviewRoundVerdict(run.id, id);
  assert.equal(getRun(run.id)!.reviewRoundSettlements?.[id]?.at, stamp);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 5);
});

test('a closed native session releases pending capacity despite a stale working signal', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 4; index++) await reviewedRound(run.id, `completed-${index}`);
  const startedAt = new Date().toISOString();
  await admitReviewRound(run.id, reviewRoundAdmissionId('closed-review', 1, startedAt));
  updateRun(run.id, {
    agentContexts: [
      {
        id: 'closed-review',
        runId: run.id,
        slotId: null,
        role: 'review',
        label: 'Review',
        status: 'working',
        reviewId: 'closed-review',
        reviewLoopNumber: 1,
        startedAt,
        nativeSession: {
          sessionId: 'session',
          executionNodeId: 'mini',
          ownerPrincipalId: 'owner',
          leaseId: 'lease',
          commandId: 'command',
          closedAt: new Date().toISOString(),
        },
      },
    ],
  });
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 4);
  await admitReviewRound(run.id, 'replacement-for-closed');
});

test('policy round binds the retained attempt to the spent admission prefix, not the local loop or current total', (t) => {
  const run = fixture(t);
  const early = reviewRoundAdmissionId('review', 1, '2026-11-07T00:00:00Z');
  const ninth = reviewRoundAdmissionId('review', 2, '2026-11-07T06:08:44.510Z');
  const admissions = [early, ...Array.from({ length: 7 }, (_, i) => `other-${i}`), ninth];
  const snapshot = { ...run, ...recordedRounds(admissions) };
  const review: ReviewStatus = {
    id: 'review',
    mode: 'warm',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    attempts: [
      {
        mode: 'cold',
        loopNumber: 1,
        verdict: 'issues',
        unresolvedCount: 1,
        startedAt: '2026-11-07T00:00:00Z',
      },
      {
        mode: 'warm',
        loopNumber: 2,
        verdict: 'issues',
        unresolvedCount: 1,
        startedAt: '2026-11-07T06:08:44.510Z',
      },
    ],
  };
  assert.equal(reviewAttemptPolicyRound(snapshot, review), 9);
  assert.equal(reviewAttemptPolicyRound(snapshot, review, review.attempts![0]), 1);
  assert.equal(reviewPolicyRound(snapshot, 'unknown'), undefined);
  assert.equal(reviewPolicyRound(run, ninth), undefined);
  snapshot.reviewRoundSettlements!['other-0'] = { at: '2026-11-07T01:00:00Z', reason: 'No result' };
  assert.equal(reviewPolicyRound(snapshot, ninth), 8, 'a refunded launch is not a policy round');
  snapshot.reviewRoundSettlements!['other-1'] = {
    at: '2026-11-07T01:00:00Z',
    kind: 'pending',
    reason: 'Not yet returned',
  };
  assert.equal(reviewPolicyRound(snapshot, ninth), 7, 'a reservation is not a spent round');
});
