import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'farmslot-blocked-ci-fix-'));

const failedCheck = { name: 'Check changelog', status: 'fail' };
const passedCheck = { name: 'Check changelog', status: 'pass' };
const pendingCheck = { name: 'Check changelog', status: 'pending' };
const comment = {
  author: 'review-bot',
  label: 'review',
  action: 'fix',
  bodyPreview: 'Review the change',
  createdAt: '2026-09-23T00:00:00Z',
  source: 'issue',
  workerResponded: false,
};
const snapshots: Array<{
  checks: (typeof failedCheck)[];
  allPassed: boolean;
  comments?: (typeof comment)[];
}> = [];
const forcedReads: boolean[] = [];

mock.module('../methods/pr.js', {
  namedExports: {
    prStatus: async ({ force }: { force?: boolean }) => {
      forcedReads.push(force === true);
      const snapshot = snapshots.shift() ?? { checks: [failedCheck], allPassed: false };
      const failed = snapshot.checks.filter((check) => check.status === 'fail').length;
      const pending = snapshot.checks.filter((check) => check.status === 'pending').length;
      const comments = 'comments' in snapshot ? (snapshot.comments ?? []) : [];
      return {
        pr: {
          prNumber: 10384,
          prState: 'OPEN',
          merged: false,
          mergeConflict: false,
          checks: snapshot.checks,
          checkSummary: {
            passed: snapshot.allPassed ? 1 : 0,
            failed,
            pending,
            skipped: 0,
            total: 1,
          },
          allPassed: snapshot.allPassed,
          anyFailed: failed > 0,
          failedNames: failed > 0 ? ['Check changelog'] : [],
          actionableBotComments: comments,
          recommendation: snapshot.allPassed && comments.length === 0 ? 'READY' : 'NEEDS_ATTENTION',
        },
      };
    },
    computePRRecommendation: () => 'MERGE',
  },
});

mock.module('./inline-fix.js', {
  namedExports: {
    getSlotHeadSha: async () => 'unchanged-head',
    isInlineFixDedupedNow: async () => false,
    rerunFailedChecks: async () => {},
    tryInlineCIFix: async () => ({
      attempted: true,
      success: false,
      blocked: true,
      blockedReason: 'Worker reported success without advancing HEAD',
      attempts: 1,
    }),
  },
});

const { monitorCI, resolveCIDecision } = await import('./service.js');
const { createRun, getRun, loadAllRuns } = await import('../runs/store.js');

test('ci-watch rechecks GitHub and completes when the unchanged HEAD turns green', async () => {
  await loadAllRuns();
  snapshots.push(
    { checks: [failedCheck], allPassed: false },
    { checks: [passedCheck], allPassed: true },
    { checks: [passedCheck], allPassed: true },
  );
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'passed');
  assert.deepEqual(forcedReads, [false, true, true]);
  assert.equal(getRun(run.id)?.decisions.length, 0);
});

async function expectBlockedFixDecision(initial: (typeof snapshots)[number]): Promise<void> {
  snapshots.push(initial, initial);
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });
  const monitoring = monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  let decision = getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked');
  for (let attempts = 0; !decision && attempts < 100; attempts++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    decision = getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked');
  }
  assert.ok(decision);
  assert.equal(getRun(run.id)?.status, 'blocked');
  assert.deepEqual(forcedReads, [false, true]);

  resolveCIDecision(decision.id, 'abort');
  assert.equal((await monitoring).result, 'aborted');
  assert.equal(
    getRun(run.id)?.decisions.find((item) => item.id === decision.id)?.resolvedAction,
    'abort',
  );
}

test('ci-watch exposes an operator decision when the fresh checks still fail', async () => {
  await expectBlockedFixDecision({ checks: [failedCheck], allPassed: false });
});

test('validation runs abort instead of waiting for an operator decision', async () => {
  snapshots.push(
    { checks: [failedCheck], allPassed: false },
    { checks: [failedCheck], allPassed: false },
  );
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'CI-TEST',
    mode: 'validation',
  });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'aborted');
  assert.equal(
    getRun(run.id)?.decisions.find((item) => item.type === 'ci_inline_fix_blocked')?.resolvedAction,
    'abort',
  );
});

test('ci-watch exposes an operator decision when actionable comments remain', async () => {
  await expectBlockedFixDecision({ checks: [passedCheck], allPassed: true, comments: [comment] });
});

test('ci-watch rechecks pending CI and finishes when checks turn green', async () => {
  snapshots.push(
    { checks: [pendingCheck], allPassed: false, comments: [comment] },
    { checks: [passedCheck], allPassed: true },
    { checks: [passedCheck], allPassed: true },
  );
  forcedReads.length = 0;
  const run = createRun({ flowType: 'dev', project: 'farmslot-farm', ticketOrPr: 'CI-TEST' });

  const outcome = await monitorCI(run.id, 10384, 'MetaMask/core', new AbortController().signal);

  assert.equal(outcome.result, 'passed');
  assert.deepEqual(forcedReads, [false, true, true]);
  assert.equal(getRun(run.id)?.decisions.length, 0);
});
