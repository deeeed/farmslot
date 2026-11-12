import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSuccessfulRun } from '@farmslot/protocol';

import { evalTrialResultGet } from '../methods/eval.js';
import { inferRetrospectiveOutcome } from '../run-completion/retrospective.js';
import { startRun } from '../run-engine/orchestrator.js';
import { deleteTestRunIfPresent } from '../run-engine/test-fixtures.js';
import { aggregateAnalytics, buildAnalyticsRecord } from '../runs/analytics.js';
import { createRun, getRun, persistRunNow, updateRun } from '../runs/store.js';

import { firstOutputFixture } from './first-output.test-support.js';
import { finalizeEvalResultPackageForRun, freezeEvalFirstOutputPackage } from './package-store.js';

test('a completed trial with a skipped judge reads back as unjudged and contributes no success or failure', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eval-unjudged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = createRun({
    project: 'unjudged-fixture',
    flowType: 'fix-bug',
    mode: 'autonomous',
    ticketOrPr: 'EVAL-UNJUDGED',
    completionPolicy: 'artifact-only',
    lane: 'comparison',
    variant: 'unjudged',
  });
  t.after(() => deleteTestRunIfPresent(run.id));
  const fixture = await firstOutputFixture(root, run);
  updateRun(run.id, {
    taskFile: fixture.taskFile,
    engineState: fixture.engineState,
    status: 'completing',
    steps: run.steps.map((step) => ({
      ...step,
      status: 'done',
      ...(step.name === 'review'
        ? { outputs: { skipped: true, reason: 'disabled-for-project', retryCount: 0 } }
        : {}),
    })),
  });
  await freezeEvalFirstOutputPackage(getRun(run.id)!, {});
  await finalizeEvalResultPackageForRun(getRun(run.id)!);
  assert.equal(inferRetrospectiveOutcome(getRun(run.id)!), 'unjudged');
  await startRun(run.id);
  await persistRunNow(getRun(run.id)!);
  const result = await evalTrialResultGet({ runId: run.id });
  assert.equal(result.run.status, 'done');
  assert.equal(result.candidatePackage.status, 'final');
  assert.deepEqual(result.candidatePackage.reviewEvidence, []);
  assert.equal(result.experimentManifest?.trials[0].status, 'final');
  assert.equal(result.run.metrics.outcome, 'unjudged');
  assert.equal(isSuccessfulRun(result.run), false);
  const record = buildAnalyticsRecord(result.run);
  assert.equal(record.outcome, 'unjudged');
  assert.equal(record.failedStep, null);
  assert.equal(record.failureReason, null);
  const aggregate = aggregateAnalytics([record], {}, new Date().toISOString());
  assert.deepEqual(aggregate.failureByStep, {});
  assert.deepEqual(aggregate.failureByReason, {});
});
