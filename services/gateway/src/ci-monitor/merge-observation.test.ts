import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

process.env.FARMSLOT_RUNS_DIR = mkdtempSync(path.join(os.tmpdir(), 'farmslot-ci-merge-test-'));

const prStatusCalls: number[] = [];
/** Runs while the PR read is still in flight, before its response arrives. */
let whileReading: (() => void) | undefined;

mock.module('../methods/pr.js', {
  namedExports: {
    prStatus: async (params: { pr: number }) => {
      prStatusCalls.push(params.pr);
      whileReading?.();
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
const { createRun, getRun, loadAllRuns, updateRun } = await import('../runs/store.js');

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

test('a merge response for a PR the run no longer links does not settle it', async () => {
  await loadAllRuns();
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000047',
    prNumber: 406,
  });
  // Force-complete attaches another PR while the read for PR 406 is in flight.
  whileReading = () => updateRun(run.id, { prNumber: 407 });
  try {
    const outcome = await monitorCI(run.id, 406, 'deeeed/farmslot', new AbortController().signal);
    assert.equal(outcome.result, 'aborted');
  } finally {
    whileReading = undefined;
  }
  const observed = getRun(run.id);
  assert.equal(observed?.prNumber, 407);
  assert.equal(observed?.prState, undefined, "PR 406's merge must not settle PR 407");
  assert.equal(observed?.mergedAt, undefined);
});

const prLink = (repo: string, number: number) => ({
  label: 'PR',
  url: `https://github.com/${repo}/pull/${number}`,
});

test('a merge response does not settle a run whose PR link moved to another repository', async () => {
  await loadAllRuns();
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000048',
    prNumber: 408,
  });
  updateRun(run.id, { links: [prLink('owner/repo', 408)] });
  // The run is republished to the same number in another repository mid-read.
  whileReading = () => updateRun(run.id, { links: [prLink('owner/other', 408)] });
  try {
    const outcome = await monitorCI(run.id, 408, 'owner/repo', new AbortController().signal);
    assert.equal(outcome.result, 'aborted');
  } finally {
    whileReading = undefined;
  }
  assert.equal(
    getRun(run.id)?.prState,
    undefined,
    'owner/repo#408 must not settle owner/other#408',
  );
});

test('a watch stopped mid-read still records the merge of the PR the run links', async () => {
  await loadAllRuns();
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000049',
    prNumber: 409,
  });
  const watch = new AbortController();
  whileReading = () => watch.abort();
  try {
    const outcome = await monitorCI(run.id, 409, 'deeeed/farmslot', watch.signal);
    assert.equal(outcome.result, 'passed');
  } finally {
    whileReading = undefined;
  }
  assert.equal(getRun(run.id)?.prState, 'MERGED');
  assert.equal(getRun(run.id)?.mergedAt, '2026-07-27T12:50:12Z');
});

function dropLine(lines: string[], prNumber: number): string {
  const line = lines.find((entry) => entry.includes(`dropped PR #${prNumber}`));
  assert.ok(line, `expected a drop log for PR #${prNumber}`);
  return line;
}

test('a merge response for a run with no PR does not say it links PR #none', async () => {
  await loadAllRuns();
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000051',
    prNumber: 411,
  });
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  whileReading = () => updateRun(run.id, { prNumber: null });
  try {
    const outcome = await monitorCI(run.id, 411, 'deeeed/farmslot', new AbortController().signal);
    assert.equal(outcome.result, 'aborted');
  } finally {
    whileReading = undefined;
    log.mock.restore();
  }
  const line = dropLine(lines, 411);
  assert.match(line, /the run no longer links a PR/);
  assert.doesNotMatch(line, /#none/);
  assert.equal(getRun(run.id)?.prState, undefined);
});
