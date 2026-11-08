import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import type { CapturedProcessActivity } from '../runs/process-capture.js';

let entered = () => {},
  release = () => {};
const reached = new Promise<void>((resolve) => {
  entered = resolve;
});
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let pendingCapture: CapturedProcessActivity;
await import('../runtime/mock-pty.test-support.js');
const { bindProcessActivityBundle } = await import('../runs/process-capture.js');
mock.module('../runs/process-capture.js', {
  namedExports: {
    captureOriginalProcessActivity: async () => {
      entered();
      await gate;
      return pendingCapture;
    },
    bindProcessActivityBundle,
  },
});

const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { activityForRun } = await import('../runs/process-activity.js');
const { buildAnalyticsRecord, emitAnalyticsForTerminalRun, readAllAnalyticsRecords } =
  await import('../runs/analytics.js');
const { buildRunEpisode } = await import('./run-episode.js');
const { captureRunOutput } = await import('./output.js');
const { runBundleStore } = await import('./retained-artifacts.js');
const { readRetainedRunBundle } = await import('@farmslot/run-bundle');

function workerSnapshot(run: Run, document: string): CapturedProcessActivity {
  const activity = activityForRun(run);
  const digest = createHash('sha256').update(document).digest('hex');
  activity.process.attempt = {
    ...activity.process.attempt,
    contextId: 'dev',
    attemptId: 'attempt',
    role: 'dev',
    executionNodeId: 'node',
  };
  activity.process.sources = [
    {
      id: 'worker-document',
      kind: 'task-artifact',
      contextId: 'dev',
      executionNodeId: 'node',
      clockId: 'node:node',
      path: 'TASK.md.worker',
      sha256: digest,
    },
  ];
  activity.process.rootCause = { present: true, source: { sourceId: 'worker-document' } };
  activity.process.coverage.rootCause = { status: 'complete', reason: 'FROZEN_WORKER_DOCUMENT' };
  return {
    activity,
    artifacts: [
      {
        path: 'TASK.md.worker',
        purpose: 'task-input',
        sha256: digest,
        sizeBytes: Buffer.byteLength(document),
      },
    ],
  };
}

test('cancellation freezes the shared unavailable record before late output acquisition commits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'process-capture-race-'));
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'TASK.md'), '# Task\n');
  const document = '# Task\n\n## Root Cause\nThe callback captured stale state.\n';
  await writeFile(path.join(root, 'TASK.md.worker'), document);
  await writeFile(path.join(root, 'artifacts/report.md'), 'Recorded outcome.\n');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'owner/repo#1',
  });
  let acquisition: Promise<number> | undefined;
  t.after(async () => {
    release();
    try {
      if (acquisition) await acquisition;
    } finally {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'cancelled' });
        await deleteRun(run.id);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(root, 'TASK.md'),
    slotId: 'process-fixture',
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'working',
        slotId: 'process-fixture',
        runId: run.id,
        signalAttemptId: 'attempt',
        taskFile: path.join(root, 'TASK.md'),
      },
    ],
  });
  pendingCapture = workerSnapshot(getRun(run.id)!, document);
  acquisition = captureRunOutput(run.id, false, true);
  await reached;
  updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  const terminal = getRun(run.id)!;
  const frozen = terminal.metrics.activity;
  assert.ok(frozen, 'terminal emission freezes missing data before its async append');
  assert.equal(frozen.process.rootCause.present, null);
  release();
  await acquisition;
  const latest = getRun(run.id)!;
  assert.strictEqual(latest.metrics.activity, frozen);
  assert.strictEqual(buildAnalyticsRecord(latest).activity, frozen);
  assert.strictEqual(buildRunEpisode(latest, [], [], latest.updatedAt).process, frozen.process);
  assert.equal(latest.status, 'cancelled');
  await emitAnalyticsForTerminalRun(latest);
  const rows = (await readAllAnalyticsRecords()).records.filter(
    (record) => record.runId === run.id,
  );
  assert.ok(rows.length);
  assert.ok(rows.every((record) => JSON.stringify(record.activity) === JSON.stringify(frozen)));
});

test('successful output freezes one projection and retains its original document after review recapture', async (t) => {
  release();
  const root = await mkdtemp(path.join(os.tmpdir(), 'process-capture-success-'));
  const document = '## Root Cause\nThe listener captured stale state.\n';
  await mkdir(path.join(root, 'artifacts'));
  await writeFile(path.join(root, 'TASK.md'), '# Server-owned task\n');
  await writeFile(path.join(root, 'TASK.md.worker'), document);
  await writeFile(path.join(root, 'artifacts/report.md'), 'Recorded outcome.\n');
  const run = createRun({
    flowType: 'dev',
    project: 'generic-project',
    ticketOrPr: 'owner/repo#2',
  });
  t.after(async () => {
    try {
      if (getRun(run.id)) {
        updateRun(run.id, { status: 'cancelled' });
        await deleteRun(run.id);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  updateRun(run.id, {
    status: 'monitoring',
    taskFile: path.join(root, 'TASK.md'),
    slotId: 'process-fixture',
    agentContexts: [
      {
        id: 'dev',
        role: 'dev',
        label: 'Worker',
        status: 'working',
        slotId: 'process-fixture',
        runId: run.id,
        signalAttemptId: 'attempt',
        taskFile: path.join(root, 'TASK.md'),
      },
    ],
  });
  pendingCapture = workerSnapshot(getRun(run.id)!, document);
  await captureRunOutput(run.id, false, true);
  const first = getRun(run.id)!.metrics.activity!;
  assert.equal(first.process.rootCause.present, true);
  assert.ok(first.process.sourceBundle);
  await writeFile(path.join(root, 'TASK.md.worker'), '# A later review-fix body\n');
  await captureRunOutput(run.id, false, true);
  const latest = getRun(run.id)!;
  assert.strictEqual(latest.metrics.activity, first);
  const original = await readRetainedRunBundle(
    await runBundleStore(),
    first.process.sourceBundle,
    run.id,
  );
  assert.equal(await original.readText('TASK.md.worker'), document);
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  await emitAnalyticsForTerminalRun(getRun(run.id)!);
  const rows = (await readAllAnalyticsRecords()).records.filter(
    (record) => record.runId === run.id,
  );
  assert.ok(rows.length);
  assert.ok(rows.every((record) => JSON.stringify(record.activity) === JSON.stringify(first)));
  assert.strictEqual(
    buildRunEpisode(getRun(run.id)!, [], [], latest.updatedAt).process,
    first.process,
  );
});
