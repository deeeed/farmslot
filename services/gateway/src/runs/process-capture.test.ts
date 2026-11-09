import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

import type { ProcessCaptureResult } from '@farmslot/agent-runtime/native/process-capture';
import type { WorkerSignal } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';

await import('../runtime/mock-pty.test-support.js');
const config = await import('../core/config.js');
const { DEFAULT_SOURCE_DIFF_FILTER } = await import('../core/source-diff-filter.js');
let owners: string[] = [],
  calls = 0,
  exitCode = 0;
let facts: ProcessCaptureResult;
mock.module('../core/config.js', {
  namedExports: {
    ...config,
    loadSlotVars: async () => ({ remoteRepo: '/repo', machine: 'node' }),
    loadProjectVars: async () => ({ projectJson: {} }),
    resolveProjectRuntimeDir: async () => '.agent',
    resolveProjectTaskDirName: () => '.task',
    getOrchestratorTaskRoot: () => '/gateway/tasks',
    resolveTaskRelDir: () => 'fix/case',
  },
});
mock.module('../core/state.js', { namedExports: { readSlotField: async () => owners.shift() } });
mock.module('../core/exec.js', {
  namedExports: {
    execArgvOnSlot: async () => {
      calls++;
      return { exitCode, stdout: JSON.stringify(facts), stderr: '' };
    },
  },
});
mock.module('../run-engine/diff-artifacts.js', {
  namedExports: {
    resolveProjectSourceDiffFilter: async () => ({ sourceFilter: DEFAULT_SOURCE_DIFF_FILTER }),
  },
});
mock.module('../runners/registry.js', {
  namedExports: { getRunnerSessionUsageProvider: () => null },
});
mock.module('../tasks/sidecars.js', { namedExports: { WORKER_MIRROR_SUFFIX: '.worker' } });
mock.module('../tasks/agent-runtime-script.js', {
  namedExports: {
    agentRuntimeScriptForSlot: async () => '/runtime/scripts/task-init-cli.mjs',
  },
});
const { captureOriginalProcessActivity } = await import('./process-capture.js');

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'original-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = '2026-11-08T01:00:00.000Z';
  const run = makeRun({
    id: 'original',
    taskFile: path.join(root, 'TASK.md'),
    status: 'monitoring',
    output: undefined,
  });
  run.agentContexts = [
    {
      id: 'worker',
      runId: 'original',
      slotId: 'slot-1',
      role: 'fix-bug',
      runner: 'pi',
      label: 'Worker',
      status: 'working',
      signalAttemptId: 'attempt',
      startedAt: at,
    },
  ];
  const signal: WorkerSignal = {
    status: 'complete',
    timestamp: at,
    contextId: 'worker',
    role: 'fix-bug',
    attemptId: 'attempt',
    checklistTiming: {
      schemaVersion: 1,
      source: 'CHECKLIST.md',
      events: [{ stepNumber: 1, label: 'Start', checkedAt: at }],
    },
  };
  await writeFile(path.join(root, 'SIGNAL.json.worker'), JSON.stringify(signal));
  await writeFile(path.join(root, 'CHECKLIST.md.worker'), '- [x] 1. Start\n');
  await writeFile(path.join(root, 'TASK.md.worker'), '## Root Cause\nA stale callback.\n');
  const complete = { status: 'complete' as const, reason: 'qualified runtime fixture' };
  facts = {
    schemaVersion: 1,
    contextId: 'worker',
    capturedAt: at,
    sources: [
      {
        id: 'history',
        kind: 'native-events',
        contextId: 'worker',
        executionNodeId: 'node',
        clockId: 'node:node',
      },
    ],
    commits: [],
    productPaths: [],
    edits: [],
    markCalls: [],
    gitCoverage: complete,
    historyCoverage: complete,
    uncertainWrites: false,
    uncertainMarks: false,
  };
  owners = [run.id, run.id];
  calls = 0;
  exitCode = 0;
  return { run, root, signal };
}

test('the actual collector qualifies the worker signal and records capture time', async (t) => {
  const { run } = await fixture(t);
  const result = await captureOriginalProcessActivity(run, null, []);
  assert.equal(calls, 1);
  assert.equal(result.activity.process.attempt.contextId, 'worker');
  assert.equal(result.activity.process.rootCause.present, true);
  assert.equal(result.activity.process.coverage.checklist.status, 'complete');
  assert.ok(Date.parse(result.activity.process.capturedAt) > Date.parse(run.createdAt));
  assert.equal(result.artifacts.length, 3);
});

test('a review-fix context or mismatched signal never supplies original-worker facts', async (t) => {
  const { run, root, signal } = await fixture(t);
  run.agentContexts!.push({
    id: 'review-fix',
    slotId: 'slot-1',
    role: 'review-fix',
    label: 'Fix',
    status: 'working',
    runId: run.id,
    startedAt: '2026-11-08T02:00:00.000Z',
  });
  assert.equal(
    (await captureOriginalProcessActivity(run, null, [])).activity.process.attempt.contextId,
    null,
  );
  run.agentContexts!.pop();
  await writeFile(
    path.join(root, 'SIGNAL.json.worker'),
    JSON.stringify({ ...signal, attemptId: 'other' }),
  );
  assert.equal(
    (await captureOriginalProcessActivity(run, null, [])).activity.process.attempt.contextId,
    null,
  );
  assert.equal(calls, 0);
});

test('foreign runtime facts, owner changes and runtime failure become explicit gaps', async (t) => {
  for (const failure of ['node', 'owner', 'exit'] as const) {
    const { run } = await fixture(t);
    if (failure === 'node') facts.sources[0].executionNodeId = 'other-node';
    if (failure === 'owner') owners[1] = 'another-run';
    if (failure === 'exit') exitCode = 1;
    const result = await captureOriginalProcessActivity(run, null, []);
    const coverage = result.activity.process.coverage.productEdits;
    assert.equal(coverage.status, 'unavailable');
    assert.equal(
      coverage.reason,
      failure === 'node'
        ? 'PROCESS_CAPTURE_BINDING_MISMATCH'
        : failure === 'owner'
          ? 'PROCESS_SLOT_OWNER_CHANGED'
          : 'PROCESS_RUNTIME_SOURCE_UNAVAILABLE',
    );
    assert.equal(result.activity.process.labels.fix_before_baseline.value, null);
  }
});

test('an earlier recovery attempt downgrades chronology instead of asserting a negative', async (t) => {
  const { run } = await fixture(t);
  run.recoveryAttempts = [
    {
      id: 'recovery',
      attempt: 1,
      stepName: 'monitor',
      startedAt: '2026-11-08T00:00:00.000Z',
      status: 'completed',
      triggeredBy: 'auto-recovery',
    },
  ];
  const result = await captureOriginalProcessActivity(run, null, []);
  assert.equal(
    result.activity.process.coverage.checklist.reason,
    'EARLIER_WORKER_ATTEMPTS_UNCAPTURED',
  );
  assert.equal(result.activity.process.labels.skipped_checklist.value, null);
});
