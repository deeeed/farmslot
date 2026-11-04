import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { CheckResult } from './outcome.mjs';
import type { RemoteNodeStack } from '../lib/remote-node-stack.mjs';
import type { Reaper } from '../lib/isolated-stack.mjs';

await import('../../../services/gateway/src/runtime/mock-pty.test-support.js');
const { makeRun } = await import('../../../services/gateway/src/run-engine/test-fixtures.js');
const { runOutcome } = await import('./outcome.mjs');
const root = await mkdtemp(path.join(os.tmpdir(), 'baseline-report-'));
await mkdir(path.join(root, 'holds'));
after(() => rm(root, { recursive: true, force: true }));
const unexpected = () => {
  throw new Error('No process or RPC is expected in this recorded-baseline test');
};
const stack: RemoteNodeStack = {
  fixture: root,
  holds: path.join(root, 'holds'),
  slotRepo: (slot) => path.join(root, slot),
  connection: unexpected,
  call: async () => unexpected(),
  restartGateway: async () => unexpected(),
  waitForNode: async () => unexpected(),
  panes: unexpected,
  cleanup: async () => [],
};
mock.module('../lib/remote-node-stack.mjs', {
  namedExports: { startRemoteNodeStack: async () => stack },
});
const run = makeRun({
  id: 'failed-native-baseline',
  flowType: 'dev',
  status: 'reconciling',
  error:
    'Native worker launch is unconfirmed: Native host unavailable; inspect host.log. No command was retried.',
  steps: [
    { name: 'find-slot', status: 'done' },
    { name: 'write-task', status: 'done' },
    { name: 'prepare', status: 'done' },
    { name: 'dispatch', status: 'done' },
    { name: 'monitor', status: 'done' },
    {
      name: 'review',
      status: 'failed',
      detail: 'Native host unavailable',
      outputs: { nativeWorkerOperationUncertain: 'launch' },
    },
    { name: 'complete', status: 'skipped' },
    { name: 'human-gate', status: 'skipped' },
    { name: 'finalize', status: 'skipped' },
    { name: 'ci-watch', status: 'skipped' },
  ],
});
const driver = await import('./run-driver.mjs');
let runs = 0;
mock.module('./run-driver.mjs', {
  namedExports: {
    ...driver,
    driveRun: async (options: Parameters<typeof driver.driveRun>[0]) => {
      runs++;
      return {
        runId: run.id,
        run,
        outcome: runOutcome(run, { lifecycle: 'busy', phase: 'occupied' }),
        durationS: 1,
        timingsS: {},
        refused: [],
        evidence: options.dir,
      };
    },
    retire: async () => undefined,
  },
});
const { runIsolated } = await import('./isolated.mjs');
const reaper: Reaper = {
  group: unexpected,
  command: unexpected,
  path: unexpected,
  done: unexpected,
};
test('a failed review baseline is a linked failure, with dependent checks unverified', async () => {
  const checks: CheckResult[] = [];
  await runIsolated({
    root,
    evidence: root,
    log: async () => {},
    reaper,
    ownerTag: 'fixture',
    cliSnapshots: root,
    budgetsS: {},
    nodeAwayMs: 1,
    reviewFixNodeAwayMs: 1,
    reviewNodeAwayMs: 1,
    survive: ['review', 'review-fix'],
    onCheck: (check) => {
      checks.push(check);
    },
  });
  const baseline = checks.find((check) => check.case === 'baseline');
  assert.ok(baseline, 'the failed baseline must not disappear behind skipped comparisons');
  assert.equal(baseline.status, 'fail');
  assert.equal(baseline.runId, run.id);
  assert.equal(baseline.observed?.status, 'reconciling');
  assert.equal(baseline.evidence, path.join(root, 'baseline-scripted-review'));
  assert.match(baseline.failureText ?? '', /Native host unavailable/);
  assert.ok(
    baseline.differences.some((diff) => diff.includes('expected done, observed reconciling')),
  );
  assert.equal(checks.filter((check) => check.status === 'unverified').length, 2);
  assert.equal(runs, 1, 'one failed baseline is retained for both dependent checks');
});
