import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Principal, ReadyGatePayload, RunExtendReviewBudgetParams } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import { resourceRevisions } from '../../resources/revisions.js';
import {
  admitReviewRound,
  assertReviewRoundAvailable,
  nextReviewBudgetScopeBrief,
  reviewBudgetScopeBrief,
  runReviewRoundBudget,
} from '../../review/review-round-budget.js';
import {
  createEngineDecision,
  hasEngineDecisionWaiter,
  resolveEngineDecision,
} from '../../run-engine/engine-decisions.js';
import { createRun, deleteRun, getRun, runsDirectory, updateRun } from '../../runs/store.js';

import { runExtendReviewBudget } from './extend-review-budget.js';

const principal: Principal = {
  id: 'fixture-lead-service',
  subject: { type: 'service', displayName: 'Fixture lead' },
  roles: [{ role: 'admin', scope: { kind: 'global' } }],
};
const head = 'a'.repeat(40);
const emit = () => {};

function fixture(t: TestContext, ref = `example/budget-${randomUUID()}#42`) {
  const run = createRun({
    project: 'budget-extension',
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: ref,
  });
  updateRun(run.id, { branch: 'owned-change', slotId: 'missing-test-slot' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
  });
  const params: RunExtendReviewBudgetParams = {
    runId: run.id,
    requestId: randomUUID(),
    expectedLimit: 5,
    limit: 7,
    headSha: head,
    scopeBrief: 'Review the scoped correction and its regression tests.',
  };
  return {
    run: getRun(run.id)!,
    params,
    deps: {
      authorize: () => principal,
      source: async () => ({ headSha: head, branch: 'owned-change', slotEpoch: 1 }),
    },
  };
}

test('five spent rounds stay spent; durable grant admits sixth/seventh and blocks eighth', async (t) => {
  const { run, params, deps } = fixture(t);
  for (let i = 0; i < 5; i++) await admitReviewRound(run.id, `spent-${i}`);
  await assert.rejects(admitReviewRound(run.id, 'sixth'), /five review rounds/);
  const watched = resourceRevisions.sample([
    { family: 'run', runId: run.id },
    { family: 'review', runId: run.id },
    { family: 'decisions', scope: 'farm' },
  ]).dependencies;
  const result = await runExtendReviewBudget(params, emit, deps);
  for (const { key, revision } of watched)
    assert(
      resourceRevisions.revision(key) > revision,
      'A durable review grant must invalidate its readers',
    );
  assert.equal(result.budget.used, 5);
  assert.equal(result.budget.remaining, 2);
  const upcoming = await nextReviewBudgetScopeBrief(getRun(run.id)!);
  assert.match(upcoming, /Review round 6 of 7\./);
  assert.match(upcoming, /Attempt 6\/7/);
  assert.match(upcoming, /scoped correction/);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 5);
  assert.equal(result.receipt.principalSubject.type, 'service');
  const persisted = JSON.parse(
    await readFile(path.join(runsDirectory(), `${run.id}.json`), 'utf8'),
  );
  assert.deepEqual(persisted.reviewBudgetExtensions, [result.receipt]);
  await admitReviewRound(run.id, 'sixth');
  assert.match(reviewBudgetScopeBrief(getRun(run.id)!), /Attempt 6\/7/);
  assert.match(reviewBudgetScopeBrief(getRun(run.id)!), /scoped correction/);
  updateRun(run.id, { engineState: { generation: 2 } });
  await admitReviewRound(run.id, 'sixth');
  await admitReviewRound(run.id, 'seventh');
  await assert.rejects(admitReviewRound(run.id, 'eighth'), /All 7 authorized/);
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).used, 7);
});

test('exact retry retains original receipt after a fix head changes; conflicting key refuses', async (t) => {
  const { params, deps } = fixture(t);
  const first = await runExtendReviewBudget(params, emit, deps);
  const replay = await runExtendReviewBudget(params, emit, {
    ...deps,
    source: async () => ({ headSha: 'b'.repeat(40), branch: 'owned-change', slotEpoch: 1 }),
  });
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(replay.run.reviewBudgetExtensions!.length, 1);
  await assert.rejects(
    runExtendReviewBudget({ ...params, scopeBrief: 'Different scope' }, emit, deps),
    /different grant/,
  );
});

test('unauthorized, stale head, oversized grants and empty scope cannot raise the limit', async (t) => {
  const { run, params, deps } = fixture(t);
  await assert.rejects(runExtendReviewBudget(params, emit), /authenticated admin/);
  await assert.rejects(
    runExtendReviewBudget(params, emit, {
      ...deps,
      authorize: () => ({ ...principal, roles: [] }),
    }),
    /authenticated admin/,
  );
  await assert.rejects(
    runExtendReviewBudget(params, emit, {
      ...deps,
      source: async () => ({ headSha: '', branch: 'owned-change', slotEpoch: 1 }),
    }),
    /head, ownership or approver changed/,
  );
  await assert.rejects(runExtendReviewBudget({ ...params, limit: 50 }, emit, deps), /one and five/);
  await assert.rejects(
    runExtendReviewBudget({ ...params, scopeBrief: ' ' }, emit, deps),
    /Invalid review budget/,
  );
  assert.equal((await runReviewRoundBudget(getRun(run.id)!)).limit, 5);
  assert.equal(getRun(run.id)!.reviewBudgetExtensions, undefined);
});

test('two concurrent grants cannot both increase an expected limit', async (t) => {
  const { run, params, deps } = fixture(t);
  const results = await Promise.allSettled([
    runExtendReviewBudget(params, emit, deps),
    runExtendReviewBudget({ ...params, requestId: randomUUID(), limit: 8 }, emit, deps),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(getRun(run.id)!.reviewBudgetExtensions!.length, 1);
});

test('a parent PR grant preserves the update-branch limit, gate refusal and instruction scope', async (t) => {
  const parent = fixture(t);
  const update = fixture(t, parent.run.ticketOrPr);
  const url = `https://github.com/${parent.run.ticketOrPr.replace('#', '/pull/')}`;
  for (const entry of [parent, update]) updateRun(entry.run.id, { links: [{ label: 'PR', url }] });
  const gate: ReadyGatePayload = {
    kind: 'ready',
    prNumber: 42,
    repo: null,
    branch: 'owned-change',
    workerReport: '',
    diffStat: { files: 0, additions: 0, deletions: 0 },
  };
  updateRun(update.run.id, {
    flowType: 'update-branch',
    decisions: [
      {
        id: 'ready',
        type: 'engine_human_gate',
        title: 'Ready',
        description: '',
        actions: [],
        createdAt: new Date().toISOString(),
        payload: gate,
      },
    ],
    engineState: {
      publishGate: {
        reviewLaunchRejection: {
          code: 'REVIEW_ROUND_LIMIT_REACHED',
          message: 'Two maintenance rounds spent',
          userAction: 'Stop and narrow the branch update.',
          rejectedAt: new Date().toISOString(),
        },
      },
    },
  });
  await admitReviewRound(update.run.id, 'maintenance-one');
  await admitReviewRound(update.run.id, 'maintenance-two');
  await runExtendReviewBudget(parent.params, emit, parent.deps);
  const budget = await runReviewRoundBudget(getRun(update.run.id)!);
  assert.deepEqual([budget.used, budget.limit, budget.extensions], [2, 2, undefined]);
  const current = getRun(update.run.id)!;
  assert.equal(
    (current.decisions[0].payload as ReadyGatePayload).reviewRoundBudget?.label,
    'Review rounds 2/2',
  );
  assert.equal(
    current.engineState?.publishGate?.reviewLaunchRejection?.code,
    'REVIEW_ROUND_LIMIT_REACHED',
  );
  // The current reviewer is told its round; a spent budget has no next round to state.
  assert.equal(reviewBudgetScopeBrief(current), '\n## Review round\n\nReview round 2 of 2.\n');
  assert.equal(await nextReviewBudgetScopeBrief(current), '');
  await assert.rejects(
    runExtendReviewBudget({ ...update.params, expectedLimit: 2, limit: 4 }, emit, update.deps),
    /update-branch/,
  );
});

test('PR-scoped grant survives retirement of its original run and retains spent history', async (t) => {
  const first = fixture(t);
  const second = fixture(t, first.run.ticketOrPr);
  const url = `https://github.com/${first.run.ticketOrPr.replace('#', '/pull/')}`;
  for (const entry of [first, second]) updateRun(entry.run.id, { links: [{ label: 'PR', url }] });
  for (let i = 0; i < 5; i++) await admitReviewRound(first.run.id, `past-${i}`);
  await runExtendReviewBudget(first.params, emit, first.deps);
  updateRun(first.run.id, { status: 'failed' });
  await deleteRun(first.run.id);
  const budget = await runReviewRoundBudget(getRun(second.run.id)!);
  assert.equal(budget.used, 5);
  assert.equal(budget.limit, 7);
  await admitReviewRound(second.run.id, 'successor-sixth');
  assert.match(reviewBudgetScopeBrief(getRun(second.run.id)!), /scoped correction/);
});

test('revoked authority or generation drift during head read refuses before receipt publication', async (t) => {
  const { run, params, deps } = fixture(t);
  await assert.rejects(
    runExtendReviewBudget(params, emit, {
      ...deps,
      source: async () => {
        updateRun(run.id, { engineState: { generation: 9 } });
        return { headSha: head, branch: 'owned-change', slotEpoch: 1 };
      },
    }),
    /ownership or approver changed/,
  );
  assert.equal(getRun(run.id)!.reviewBudgetExtensions, undefined);
  let allowed = true;
  await assert.rejects(
    runExtendReviewBudget(params, emit, {
      authorize: () => {
        if (!allowed) throw new Error('Credential revoked');
        return principal;
      },
      source: async () => {
        allowed = false;
        return { headSha: head, branch: 'owned-change', slotEpoch: 1 };
      },
    }),
    /Credential revoked/,
  );
  assert.equal(getRun(run.id)!.reviewBudgetExtensions, undefined);
});

test('a spent PR budget points at an extension only for the run that can receive one', async (t) => {
  // core #10855: review-pr run 6e7ec0e1 was told to request an extension the RPC refuses.
  const owner = fixture(t);
  const url = `https://github.com/${owner.run.ticketOrPr.replace('#', '/pull/')}`;
  updateRun(owner.run.id, { links: [{ label: 'PR', url }] });
  for (let i = 0; i < 5; i++) await admitReviewRound(owner.run.id, `past-${i}`);
  await runExtendReviewBudget(owner.params, emit, owner.deps);
  for (let i = 5; i < 7; i++) await admitReviewRound(owner.run.id, `extended-${i}`);
  const ownerBudget = await runReviewRoundBudget(getRun(owner.run.id)!);
  assert.match(ownerBudget.diagnosis ?? '', /request a lead-approved scoped extension/);

  const review = createRun({
    project: 'budget-extension',
    flowType: 'review-pr',
    mode: 'autonomous',
    ticketOrPr: owner.run.ticketOrPr,
  });
  t.after(async () => {
    updateRun(review.id, { status: 'failed' });
    await deleteRun(review.id);
  });
  updateRun(review.id, {
    links: [{ label: 'PR', url }],
    branch: 'owned-change',
    slotId: 'missing-test-slot',
  });
  const only =
    'only the unpublished dev or fix-bug run that owns the branch can be granted more review rounds';
  const reviewBudget = await runReviewRoundBudget(getRun(review.id)!);
  assert.deepEqual(
    [reviewBudget.used, reviewBudget.limit, reviewBudget.extensions],
    [0, 5, undefined],
  );
  await assertReviewRoundAvailable(getRun(review.id)!);
  for (let i = 0; i < 5; i++) await admitReviewRound(review.id, `review-own-${i}`);
  assert.equal((await runReviewRoundBudget(getRun(owner.run.id)!)).used, 7);
  await assert.rejects(assertReviewRoundAvailable(getRun(review.id)!), (error: Error) => {
    assert.equal(
      error.message,
      `All 5 review rounds for this work are spent, and this run is a review-pr run; ${only}. Stop and narrow the change or redesign it.`,
    );
    return true;
  });
  await assert.rejects(
    runExtendReviewBudget(
      { ...owner.params, runId: review.id, requestId: randomUUID(), expectedLimit: 5, limit: 6 },
      emit,
      owner.deps,
    ),
    { message: `Review budget extension refused: this run is a review-pr run; ${only}.` },
  );

  updateRun(owner.run.id, {
    engineState: {
      ...getRun(owner.run.id)!.engineState,
      publishGate: { publicationStatus: 'published_ready' },
    },
  });
  const published = await runReviewRoundBudget(getRun(owner.run.id)!);
  assert.match(published.diagnosis ?? '', /this run is already published; only the unpublished/);
});

test('a grant re-presents a waiting publish gate (TAT-4145 bda11b1a)', async (t) => {
  // bda11b1a: the 16:11Z grant (5 -> 6) left gate 22ae4d45 saying five rounds were spent.
  const { run, params, deps } = fixture(t);
  for (let i = 0; i < 5; i++) await admitReviewRound(run.id, `spent-${i}`);
  updateRun(run.id, { status: 'human-gating' });
  const payload: ReadyGatePayload = {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 47, additions: 1811, deletions: 140 },
    workerReport: 'Cross margin in the Terminal order form.',
    branch: 'owned-change',
  };
  const waiting = createEngineDecision(
    run.id,
    'human_gate',
    '**Review launch paused:** The five review rounds are spent. A design problem or scope creep has exhausted the review budget; stop and narrow the change or redesign it.',
    [
      { id: 'hold', label: 'Hold', style: 'secondary' },
      { id: 'request-review', label: 'Request Review', style: 'secondary' },
    ],
    payload,
    { readProgress: async () => ({ kind: 'idle' }) },
  );
  let gateId: string | undefined;
  for (let i = 0; i < 400 && !(gateId && hasEngineDecisionWaiter(gateId)); i++) {
    gateId = getRun(run.id)!.decisions[0]?.id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  t.after(() => resolveEngineDecision(gateId!, 'abort'));
  await runExtendReviewBudget({ ...params, limit: 6 }, emit, deps);
  assert.equal(hasEngineDecisionWaiter(gateId!), false, 'the grant woke the waiting gate');
  assert.equal(await waiting, 'hold');
  const decisions = getRun(run.id)!.decisions;
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.resolvedAction, 'hold');
  assert.ok(decisions[0]!.resolvedAt, 'the stored card is resolved, so one gate stays pending');
});
