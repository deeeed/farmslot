import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { BotComment } from '@farmslot/protocol';

const runsDir = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ci-timeout-'));
process.env.FARMSLOT_RUNS_DIR = runsDir;
after(async () => {
  await Promise.all(getAllRuns().map((run) => persistRunNow(run)));
  rmSync(runsDir, { recursive: true, force: true });
});

let checkStatus = 'fail';
let mergeConflict = false;
let comments: BotComment[] = [];
let onDedup = () => {};
let dedupCalls = 0;
let fixCalls = 0;
let polls = 0;
mock.module('../methods/pr.js', {
  namedExports: {
    prStatus: async () => {
      polls++;
      return {
        pr: {
          prState: 'OPEN',
          merged: false,
          mergeConflict,
          checks: [{ name: 'lint', status: checkStatus }],
          checkSummary: {
            passed: Number(checkStatus === 'pass'),
            failed: Number(checkStatus === 'fail'),
            pending: Number(checkStatus === 'pending'),
            skipped: 0,
            total: 1,
          },
          allPassed: checkStatus === 'pass',
          anyFailed: checkStatus === 'fail',
          failedNames: checkStatus === 'fail' ? ['lint'] : [],
          actionableBotComments: comments,
          recommendation: 'NEEDS_ATTENTION',
        },
      };
    },
    computePRRecommendation: () => 'NEEDS_ATTENTION',
  },
});
mock.module('./inline-fix.js', {
  namedExports: {
    getSlotHeadSha: async () => null,
    isInlineFixDedupedNow: async () => {
      dedupCalls++;
      setImmediate(onDedup);
      return true;
    },
    rerunFailedChecks: async () => {},
    tryInlineCIFix: async () => {
      fixCalls++;
      return null;
    },
  },
});

const { initCIMonitor, monitorCI, pokeCIPoll, resolveCIDecision } = await import('./service.js');
const { createRun, getRun, getAllRuns, loadAllRuns, persistRunNow, updateRun } =
  await import('../runs/store.js');
await loadAllRuns();

function fixture(
  status: string,
  expired = true,
  mode: 'validation' | 'interactive' = 'validation',
) {
  checkStatus = status;
  mergeConflict = false;
  comments = [];
  onDedup = () => {};
  dedupCalls = fixCalls = polls = 0;
  initCIMonitor(() => {});
  const run = createRun({
    flowType: 'dev',
    mode,
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000046',
  });
  const since = new Date(expired ? 0 : Date.now()).toISOString();
  updateRun(run.id, {
    ciWatchState: {
      consecutiveAttempts: 0,
      totalAttempts: 1,
      skips: 35,
      lastCheckFingerprint: `lint:${status}`,
      timeoutWindowStartedAt: since,
      lastProgressAt: since,
    },
  });
  return run;
}

for (const status of ['fail', 'pending']) {
  test(`expired ${status} checks request a timeout decision before another fix or dedup wait`, async () => {
    const run = fixture(status);
    const controller = new AbortController();
    onDedup = () => controller.abort();
    try {
      const result = await monitorCI(run.id, 404, 'deeeed/farmslot', controller.signal);
      assert.equal(result.result, 'timeout');
      assert.equal(dedupCalls, 0);
      assert.equal(fixCalls, 0);
      assert.equal(getRun(run.id)?.decisions.length, 1);
    } finally {
      controller.abort();
    }
  });
}

test('passing checks finish even when the old wait window expired', async () => {
  const run = fixture('pass');
  const result = await monitorCI(run.id, 404, 'deeeed/farmslot', new AbortController().signal);
  assert.equal(result.result, 'passed');
  assert.equal(getRun(run.id)?.decisions.length, 0);
});

test('keep waiting grants a fresh window without inventing CI progress', async () => {
  const run = fixture('fail', true, 'interactive');
  const controller = new AbortController();
  let decisions = 0;
  initCIMonitor((event, payload) => {
    if (event !== 'run.decision.new') return;
    decisions++;
    const decision = (payload as { decision: { id: string } }).decision;
    queueMicrotask(() => resolveCIDecision(decision.id, 'continue'));
    setImmediate(() => pokeCIPoll(run.id));
  });
  onDedup = () => controller.abort();
  try {
    await monitorCI(run.id, 404, 'deeeed/farmslot', controller.signal);
    assert.equal(decisions, 1);
    assert.equal(polls, 2);
    assert.equal(dedupCalls, 1);
    assert.equal(getRun(run.id)?.ciWatchState?.lastProgressAt, new Date(0).toISOString());
    assert.ok(Date.parse(getRun(run.id)!.ciWatchState!.timeoutWindowStartedAt!) > 0);
  } finally {
    controller.abort();
    initCIMonitor(() => {});
  }
});

test('merge conflicts retain their repair path when CI wait has expired', async () => {
  const run = fixture('pending');
  mergeConflict = true;
  const result = await monitorCI(run.id, 404, 'deeeed/farmslot', new AbortController().signal);
  assert.equal(result.dispatchAction, 'dispatch-update-branch');
  assert.notEqual(result.result, 'timeout');
});

test('new actionable feedback gets handled before an old no-progress timeout', async () => {
  const run = fixture('pass');
  comments = [
    {
      author: 'review-bot',
      label: 'review',
      action: 'fix',
      bodyPreview: 'new finding',
      createdAt: new Date().toISOString(),
      source: 'issue_comment',
      workerResponded: false,
    },
  ];
  const result = await monitorCI(run.id, 404, 'deeeed/farmslot', new AbortController().signal);
  assert.equal(result.result, 'comments');
  assert.equal(fixCalls, 1);
  assert.equal(getRun(run.id)?.ciWatchState?.lastProgressReason, 'new actionable comment');
});
