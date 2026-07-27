import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ci-merge-test-'));

const prStatusCalls: number[] = [];

mock.module('../methods/pr.js', {
  namedExports: {
    prStatus: async (params: { pr: number }) => {
      prStatusCalls.push(params.pr);
      return {
        pr: {
          prNumber: params.pr,
          prState: 'MERGED',
          merged: true,
          mergedAt: '2026-07-27T12:50:12Z',
          mergeConflict: false,
          mergeable: 'MERGEABLE',
          headSha: 'deadbeef',
          reviewDecision: 'APPROVED',
          checks: [],
          checkSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
          allCheckSummary: { passed: 0, failed: 0, pending: 0, skipped: 0, total: 0 },
          allPendingNames: [],
          allFailedNames: [],
          allPassed: true,
          anyFailed: false,
          failedNames: [],
          botComments: [],
          actionableBotComments: [],
          recommendation: 'MERGE',
        },
      };
    },
    computePRRecommendation: () => 'MERGE',
  },
});

// core/config.js is deliberately NOT mocked: replacing a module replaces all of
// it, and half the gateway imports something from there. The CI config it feeds
// only sets poll timings, which a merged-on-first-poll PR never reaches.

const { monitorCI } = await import('./service.js');
const { createRun, getRun, loadAllRuns } = await import('../runs/store.js');

test('ci-watch records the merge it observes so downstream gates can see it', async () => {
  // The gateway learns a PR merged in exactly one place: this poll. It used to
  // return `passed` without writing anything to the run, so the observation died
  // here — and a work-graph `merged` edge, which can only read merge state off
  // the run, stayed pending forever behind an upstream that had actually shipped.
  await loadAllRuns();
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000046',
    prNumber: 404,
  });

  const outcome = await monitorCI(run.id, 404, 'deeeed/farmslot', new AbortController().signal);

  assert.equal(outcome.result, 'passed');
  assert.deepEqual(prStatusCalls, [404]);

  const observed = getRun(run.id);
  assert.equal(observed?.prState, 'MERGED', 'the merge observation must be persisted on the run');
  assert.equal(observed?.mergedAt, '2026-07-27T12:50:12Z');
});
