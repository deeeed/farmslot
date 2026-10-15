import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Principal, RunExtendReviewBudgetParams } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

import {
  admitReviewRound,
  nextReviewBudgetScopeBrief,
  reviewBudgetScopeBrief,
  runReviewRoundBudget,
} from '../../review/review-round-budget.js';
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
  const result = await runExtendReviewBudget(params, emit, deps);
  assert.equal(result.budget.used, 5);
  assert.equal(result.budget.remaining, 2);
  const upcoming = await nextReviewBudgetScopeBrief(getRun(run.id)!);
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
