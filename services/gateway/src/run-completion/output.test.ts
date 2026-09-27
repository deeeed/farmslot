import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RunOutput } from '@farmslot/protocol';

import { runResolveDecision } from '../methods/run.js';
import { makeRun } from '../methods/run/test-fixtures.js';
import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { captureRunOutput, failRunOutputCapture, outputReviewDecisions } from './output.js';

const output: RunOutput = {
  workerFinished: true,
  capturedAt: new Date().toISOString(),
  manifestDigest: 'digest',
  reportPath: 'artifacts/report.md',
  artifactManifest: [],
};

test('report review applies across projects and flows without changing outcome', () => {
  for (const flowType of ['qa', 'dev', 'fix-bug'] as const) {
    const run = makeRun({
      flowType,
      project: 'arbitrary-project',
      status: 'blocked',
      completionPolicy: 'artifact-only',
    });
    const decisions = outputReviewDecisions(run, output);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].payload?.kind, 'output-review');
    assert.equal(run.status, 'blocked');
    assert.equal(outputReviewDecisions({ ...run, decisions }, output).length, 1);
    decisions[0].resolvedAt = new Date().toISOString();
    decisions[0].resolvedAction = 'mark-reviewed';
    assert.equal(outputReviewDecisions({ ...run, decisions }, output).length, 1);
    const changed = outputReviewDecisions(
      { ...run, decisions },
      { ...output, manifestDigest: 'new' },
    );
    assert.equal(changed.filter((decision) => !decision.resolvedAt).length, 1);
  }
});

test('running output, eval packages and publication flows do not acquire an output gate', () => {
  const run = makeRun({ completionPolicy: 'artifact-only' });
  assert.equal(outputReviewDecisions(run, { ...output, workerFinished: false }).length, 0);
  assert.equal(outputReviewDecisions({ ...run, lane: 'comparison' }, output).length, 0);
  assert.equal(outputReviewDecisions({ ...run, completionPolicy: 'default' }, output).length, 0);
  assert.equal(
    outputReviewDecisions(run, { ...output, captureError: 'failed transfer' }).length,
    0,
  );
});

test('a failed manual refresh does not mark an active worker finished', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'active-output',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed' });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'monitoring' });
  const failed = failRunOutputCapture(run.id, new Error('Unavailable worker files'));
  assert.equal(failed.status, 'monitoring');
  assert.equal(failed.output?.workerFinished, false);
});

test('capture follows the existing narrative report names for every flow', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flow-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    ['qa', 'qa-report.md'],
    ['dev', 'pr-description.md'],
    ['fix-bug', 'pr-description.md'],
    ['review-pr', 'review.md'],
    ['pr-complete', 'comments-report.md'],
    ['update-branch', 'report.md'],
  ] as const;
  for (const [, name] of cases) await writeFile(path.join(dir, 'artifacts', name), `# ${name}\n`);
  for (const [flowType, name] of cases) {
    const run = createRun({
      flowType: 'dev',
      project: 'generic-project',
      ticketOrPr: 'report-name-test',
    });
    t.after(async () => {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    });
    updateRun(run.id, {
      flowType,
      status: 'done',
      completionPolicy: 'artifact-only',
      taskFile: path.join(dir, 'TASK.md'),
    });
    await captureRunOutput(run.id, false);
    const captured = getRun(run.id)!;
    assert.equal(captured.output?.reportPath, `artifacts/${name}`, flowType);
    assert.equal(captured.decisions[0].payload?.kind, 'output-review', flowType);
  }
});

test('partial output can be reviewed without resuming the worker; changed bytes require another review', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'run-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Partial report\nOne gap remains.\n');
  await writeFile(path.join(dir, 'artifacts/coverage.json'), '{"passed":1,"untested":2}\n');
  const run = createRun({ flowType: 'dev', project: 'generic-project', ticketOrPr: 'output test' });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed' });
      await deleteRun(run.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    completedAt: new Date().toISOString(),
    taskFile: path.join(dir, 'TASK.md'),
    completionPolicy: 'artifact-only',
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [
      { name: 'monitor', status: 'done' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(run.id, false);
  const captured = getRun(run.id)!;
  assert.equal(captured.output?.artifactManifest.length, 2);
  const pending = captured.decisions.find((decision) => !decision.resolvedAt)!;
  const events: string[] = [];
  const result = await runResolveDecision(
    { runId: run.id, decisionId: pending.id, actionId: 'mark-reviewed' },
    (event) => events.push(event),
  );
  assert.equal(result.run.status, 'blocked');
  assert.equal(result.run.metrics.outcome, 'partial');
  assert.equal(result.run.steps[1].status, 'skipped');
  assert.ok(events.includes('run.decision.resolved'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(getRun(run.id)?.status, 'blocked');
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Changed report\n');
  await captureRunOutput(run.id, false);
  const next = getRun(run.id)!.decisions.find((decision) => !decision.resolvedAt)!;
  await writeFile(path.join(dir, 'artifacts/coverage.json'), '{"passed":0}\n');
  await assert.rejects(
    runResolveDecision({ runId: run.id, decisionId: next.id, actionId: 'mark-reviewed' }, () => {}),
    /output changed/,
  );
  assert.equal(
    getRun(run.id)!.decisions.find((decision) => decision.id === next.id)?.resolvedAt,
    undefined,
  );
  updateRun(run.id, { status: 'paused', completedAt: undefined });
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.workerFinished,
    true,
    'refresh preserves a finished worker at an operator hold',
  );
  updateRun(run.id, { status: 'monitoring' });
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.workerFinished,
    true,
    'refresh preserves terminal capture before monitor routes the run status',
  );
  const reviewBeforeFailure = getRun(run.id)!.decisions.find((decision) => !decision.resolvedAt)!;
  failRunOutputCapture(run.id, new Error('Could not fingerprint output'));
  assert.equal(getRun(run.id)?.output?.captureError, 'Could not fingerprint output');
  assert.equal(getRun(run.id)?.output?.artifactManifest.length, 2);
  assert.equal(
    getRun(run.id)!.decisions.find((d) => d.id === reviewBeforeFailure.id)?.resolvedAction,
    'superseded',
  );
  assert.equal(
    getRun(run.id)!.decisions.some((d) => !d.resolvedAt),
    false,
  );
  await captureRunOutput(run.id, false);
  assert.equal(getRun(run.id)?.output?.captureError, undefined);
  assert.ok(
    getRun(run.id)!.decisions.some((d) => !d.resolvedAt && d.id !== reviewBeforeFailure.id),
  );
  updateRun(run.id, { status: 'cancelled' });
  const decisionsBefore = getRun(run.id)!.decisions.length;
  await captureRunOutput(run.id, false);
  assert.equal(
    getRun(run.id)?.output?.artifactManifest.length,
    2,
    'cancelled runs keep readable output',
  );
  assert.equal(
    getRun(run.id)!.decisions.length,
    decisionsBefore,
    'cancel does not introduce another gate',
  );
});
