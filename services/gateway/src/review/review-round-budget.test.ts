import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  type ReadyGatePayload,
  reviewRoundBudgetLabel,
  type ReviewStatus,
  type Run,
  type RunDecision,
} from '@farmslot/protocol';

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
  clearReviewRoundSettlement,
  nextReviewBudgetScopeBrief,
  prepareReviewRoundAvailabilityCheck,
  reviewBudgetScopeBrief,
  reviewLaunchStartedAt,
  reviewNoVerdictCapReason,
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
  for (let index = 0; index < 3; index++) await admitReviewRound(run.id, `round-${index}`);
  // A launched reviewer is admitted before its task document is written.
  assert.match(
    reviewBudgetScopeBrief(getRun(run.id)!),
    new RegExp(`Review round 3 of ${limit}\\.`),
  );
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
  for (let index = 0; index < 3; index++) await admitReviewRound(first.id, `pre-pr-${index}`);
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
      reviewRoundAdmissions: [`old-request-${i}`],
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
  updateRun(feature.id, { reviewRoundAdmissions: ['old-request-0'] });
  assert.equal((await runReviewRoundBudget(getRun(request.id)!)).used, 0);
  const check = await prepareReviewRoundAvailabilityCheck(request.id);
  check();
  await assertReviewRoundAvailable(getRun(request.id)!);
  await admitReviewRound(request.id, 'own-first');
  updateRun(request.id, { engineState: { generation: 2 } });
  await admitReviewRound(request.id, 'own-first');
  assert.equal((await runReviewRoundBudget(getRun(request.id)!)).used, 1);
  assert.equal((await runReviewRoundBudget(getRun(sibling.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(feature.id)!)).used, 1);
  for (let i = 1; i < 5; i++) await admitReviewRound(request.id, `own-${i}`);
  assert.throws(check, /All 5 review rounds/);
  await assert.rejects(admitReviewRound(request.id, 'own-sixth'), /All 5 review rounds/);
  await admitReviewRound(sibling.id, 'sibling-first');
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
  for (let i = 0; i < 5; i++) await admitReviewRound(parent.id, `parent-${i}`);
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).label, 'Review rounds 0/2');
  const check = await prepareReviewRoundAvailabilityCheck(update.id);
  check();
  await admitReviewRound(update.id, 'merge-review');
  updateRun(update.id, { engineState: { generation: 2 } });
  await admitReviewRound(update.id, 'merge-review');
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 1);
  const last = await Promise.allSettled([
    admitReviewRound(update.id, 'last-a'),
    admitReviewRound(update.id, 'last-b'),
  ]);
  assert.equal(last.filter((result) => result.status === 'fulfilled').length, 1);
  assert.throws(check, /All 2 review rounds.*update-branch/);
  await assert.rejects(admitReviewRound(update.id, 'third'), /All 2 review rounds/);
  await assert.rejects(admitReviewRound(parent.id, 'parent-sixth'), /five review rounds/);
  assert.equal((await runReviewRoundBudget(getRun(sibling.id)!)).label, 'Review rounds 0/2');
  await admitReviewRound(sibling.id, 'sibling-first');
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
  for (const run of [parent, update]) updateRun(run.id, { reviewRoundAdmissions: ['legacy'] });
  await admitReviewRound(update.id, 'legacy');
  assert.equal(getRun(update.id)!.reviewRoundOwners, undefined);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).used, 1);
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 0);
  await admitReviewRound(update.id, 'new-owned');
  await admitReviewRound(parent.id, 'new-feature');
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
  await clearReviewRoundSettlement(update.id, 'update-failed-0');
  assert.equal((await runReviewRoundBudget(getRun(update.id)!)).used, 1);
  assert.equal(await reviewNoVerdictCapReason(getRun(update.id)!), undefined);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).noVerdict, 3);
  assert.equal((await runReviewRoundBudget(getRun(parent.id)!)).used, 0);
});

test('archived update-branch admissions do not spend a later feature or update run budget', async (t) => {
  const update = fixture(t, undefined, 'update-branch');
  await admitReviewRound(update.id, 'archived-update');
  updateRun(update.id, { status: 'failed', completedAt: new Date().toISOString() });
  assert.equal(await archiveRun(update.id), true);
  t.after(() => rm(path.join(runsDirectory(), 'archive', `${update.id}.json`), { force: true }));
  const feature = fixture(t, update.ticketOrPr);
  const next = fixture(t, update.ticketOrPr, 'update-branch');
  assert.equal((await runReviewRoundBudget(getRun(feature.id)!)).used, 0);
  assert.equal((await runReviewRoundBudget(getRun(next.id)!)).used, 0);
  await admitReviewRound(next.id, 'later-update');
  assert.equal(getRun(feature.id)!.reviewRoundOwners?.['archived-update'], update.id);
  assert.equal((await runReviewRoundBudget(getRun(next.id)!)).used, 1);
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

test('a no-verdict settlement frees its round once and ignores receipts never admitted', async (t) => {
  const run = fixture(t);
  for (let index = 0; index < 5; index++) await admitReviewRound(run.id, `round-${index}`);
  await assert.rejects(admitReviewRound(run.id, 'sixth'), /five review rounds/);
  await settleReviewRoundNoVerdict(run.id, 'round-3', 'Native reviewer did not complete');
  await settleReviewRoundNoVerdict(run.id, 'round-3', 'a second end is not recorded');
  await settleReviewRoundNoVerdict(run.id, 'never-admitted', 'not a round of this work');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.remaining, budget.noVerdict], [4, 1, 1]);
  const persisted = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.deepEqual(Object.keys(persisted.reviewRoundSettlements), ['round-3']);
  assert.equal(
    persisted.reviewRoundSettlements['round-3'].reason,
    'Native reviewer did not complete',
  );
  await admitReviewRound(run.id, 'replacement');
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 5);
});

test('a farm fallback keeps its refund after a verdict, persisted recovery and reattach', async (t) => {
  const run = fixture(t);
  await admitReviewRound(run.id, 'original-code');
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
  await clearReviewRoundSettlement(run.id, 'failed-warm', replacement);
  await admitReviewRound(run.id, 'failed-warm');
  const budget = await runReviewRoundBudget(getRun(run.id)!);
  assert.deepEqual([budget.used, budget.noVerdict], [1, 1]);
  const persisted = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.equal(persisted.reviewRoundSettlements['failed-warm'].kind, 'infrastructure-fallback');
  const successor = fixture(t, run.ticketOrPr);
  await clearReviewRoundSettlement(successor.id, 'failed-warm', replacement);
  assert.equal((await runReviewRoundBudget(getRun(successor.id)!)).used, 1);
  await settleReviewRoundNoVerdict(run.id, 'original-code', 'ordinary late result');
  await clearReviewRoundSettlement(run.id, 'original-code');
  await admitReviewRound(run.id, 'next-genuine-review');
  assert.deepEqual(
    [
      (await runReviewRoundBudget(getRun(run.id)!)).used,
      (await runReviewRoundBudget(getRun(run.id)!)).noVerdict,
    ],
    [2, 1],
  );
  // A genuine WARM retry of the original failed context has no COLD fallback
  // provenance and counts normally if it eventually supplies a valid verdict.
  await clearReviewRoundSettlement(run.id, 'failed-warm');
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
  await admitReviewRound(second.id, 'counted-attempt');
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
