import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isSuccessfulRun } from '@farmslot/protocol';

import { archiveRun, createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { captureRunOutput } from './output.js';
import { closeRunOutput } from './output-close.js';

test('closing retained partial output preserves gaps and history, and retries only failed cleanup', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'close-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(
    path.join(dir, 'artifacts/report.html'),
    '<h1>Partial report</h1><p>One gap remains.</p>',
  );
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'close-output',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    }
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    completionPolicy: 'artifact-only',
    taskFile: path.join(dir, 'TASK.md'),
    completedAt: new Date().toISOString(),
    error: 'One criterion was not proved',
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [
      { name: 'monitor', status: 'failed', detail: 'Original partial attempt' },
      { name: 'complete', status: 'skipped' },
    ],
  });
  await captureRunOutput(run.id, false);
  const captured = getRun(run.id)!;
  const decision = captured.decisions.find((d) => !d.resolvedAt)!;
  assert.equal(captured.output?.reportPath, 'artifacts/report.html');
  const originalSteps = structuredClone(captured.steps);
  const originalMetrics = structuredClone(captured.metrics);
  // Bind only a nonexistent fixture slot; the injected release cannot reach a runtime.
  updateRun(run.id, { slotId: 'output-close-test-slot' });
  let failCleanup = true;
  let refuseCleanup = false;
  let releases = 0;
  const deps = {
    publish: async (current: typeof captured) => {
      assert.equal(current.status, 'done');
      assert.deepEqual(current.metrics, originalMetrics);
      assert.equal(isSuccessfulRun(current), false);
      return current;
    },
    releaseSlot: async () => {
      releases++;
      if (failCleanup) throw new Error('Fixture release failed');
      return { released: !refuseCleanup };
    },
    slotOwner: async () => run.id,
  };
  const failedCleanup = await closeRunOutput(run.id, decision.id, deps);
  assert.equal(failedCleanup.status, 'done');
  assert.equal(failedCleanup.error, 'One criterion was not proved');
  assert.deepEqual(failedCleanup.steps, originalSteps);
  assert.equal(failedCleanup.output?.closeError, 'Fixture release failed');
  assert.equal(failedCleanup.output?.cleanupPending, true);
  await assert.rejects(archiveRun(run.id), /closeout cleanup/);
  await assert.rejects(deleteRun(run.id), /closeout cleanup/);
  assert.equal(
    failedCleanup.decisions.find((d) => d.id === decision.id)?.resolvedAction,
    'close-run',
  );
  failCleanup = false;
  refuseCleanup = true;
  const refused = await closeRunOutput(run.id, decision.id, deps);
  assert.match(refused.output?.closeError ?? '', /still owns the slot/);
  assert.equal(refused.output?.cleanupPending, true);
  await assert.rejects(archiveRun(run.id), /closeout cleanup/);
  await assert.rejects(deleteRun(run.id), /closeout cleanup/);
  refuseCleanup = false;
  await writeFile(path.join(dir, 'artifacts/report.html'), '<h1>Changed during cleanup</h1>');
  await captureRunOutput(run.id, false);
  const [closed] = await Promise.all([
    closeRunOutput(run.id, decision.id, deps),
    closeRunOutput(run.id, decision.id, deps),
  ]);
  assert.equal(closed.output?.closeError, undefined);
  assert.equal(closed.output?.cleanupPending, false);
  assert.deepEqual(closed.metrics, originalMetrics);
  await closeRunOutput(run.id, decision.id, deps);
  assert.equal(releases, 3, 'Repeated close does not repeat successful teardown');
  await captureRunOutput(run.id, false);
  assert.ok(getRun(run.id)?.output?.closedAt, 'Refresh cannot reopen closed execution');
  assert.ok(!getRun(run.id)!.decisions.some((d) => !d.resolvedAt));
  await writeFile(path.join(dir, 'artifacts/report.html'), '<h1>Changed snapshot</h1>');
  const repeated = await closeRunOutput(run.id, decision.id, deps);
  assert.equal(repeated.output?.closedAt, closed.output?.closedAt);
  assert.equal(releases, 3, 'Changed report bytes do not repeat successful cleanup or approval');
  await captureRunOutput(run.id, false);
  assert.ok(
    !getRun(run.id)!.decisions.some((d) => !d.resolvedAt),
    'Changed bytes cannot reopen a closed run',
  );
});

test('refused release does not retain a cleanup obligation for another slot owner', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'close-unowned-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.html'), '<h1>Partial report</h1>');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'unowned-output',
  });
  t.after(async () => {
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'blocked',
    completionPolicy: 'artifact-only',
    taskFile: path.join(dir, 'TASK.md'),
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'partial' },
    steps: [],
  });
  await captureRunOutput(run.id, false);
  updateRun(run.id, { slotId: 'output-close-unowned-test-slot' });
  const decision = getRun(run.id)!.decisions.find((d) => !d.resolvedAt)!;
  const closed = await closeRunOutput(run.id, decision.id, {
    publish: async (current) => current,
    releaseSlot: async () => ({ released: false }),
    slotOwner: async () => 'another-run',
  });
  assert.equal(closed.output?.cleanupPending, false);
  assert.equal(closed.output?.closeError, undefined);
});

test('close refuses a worker that is still running or another unresolved gate', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'close-active-output-'));
  await mkdir(path.join(dir, 'artifacts'));
  await writeFile(path.join(dir, 'artifacts/report.md'), '# Preliminary output');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'active-output',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'done' });
    await deleteRun(run.id);
    await rm(dir, { recursive: true, force: true });
  });
  updateRun(run.id, {
    status: 'monitoring',
    metrics: { ...run.metrics, outcome: 'partial' },
    completionPolicy: 'artifact-only',
    taskFile: path.join(dir, 'TASK.md'),
    steps: [{ name: 'monitor', status: 'running' }],
  });
  await captureRunOutput(run.id, false, true);
  const pending = getRun(run.id)!.decisions[0];
  await assert.rejects(closeRunOutput(run.id, pending.id), /Wait for the worker/);
  updateRun(run.id, {
    status: 'blocked',
    steps: [{ name: 'monitor', status: 'done' }],
    decisions: [
      pending,
      { ...pending, id: 'other-gate', type: 'engine_human_gate', payload: undefined },
    ],
  });
  await assert.rejects(closeRunOutput(run.id, pending.id), /other pending/);
  assert.equal(getRun(run.id)?.status, 'blocked');
});
