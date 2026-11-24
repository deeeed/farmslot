// 6582e7a5 (preflight) and b5da0c86 (deps), 2026-11-24: the run error named the slot's
// prepare log, and the slot's next prepare overwrote it before anyone read it.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

// Run state under a temporary home, never the operator's.
const home = mkdtempSync(path.join(os.tmpdir(), 'failed-prepare-log-home-'));
process.env.FARMSLOT_HOME = home;
test.after(() => rm(home, { recursive: true, force: true }));

import type { PrepareCommandError } from '../methods/slot/shared.js';

import { makeRun } from './test-fixtures.js';

let run: Run;
let prepareError: PrepareCommandError = new Error('unset');
// The orchestrator is this module's only importer, and these are the names it takes.
mock.module('./dispatch-lifecycle-steps.js', {
  namedExports: {
    executePrepareStep: async () => {
      throw prepareError;
    },
    executeDispatchStep: async () => {
      throw new Error('Unexpected dispatch');
    },
  },
});
const realRetain = await import('../run-lifecycle/failed-step-log.js');
let retain = realRetain.retainFailedStepLogs;
mock.module('../run-lifecycle/failed-step-log.js', {
  namedExports: { retainFailedStepLogs: (...args: Parameters<typeof retain>) => retain(...args) },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (run?.id === id ? run : undefined),
    getAllRuns: () => (run ? [run] : []),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<RunStep>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
    persistRunNow: async () => {},
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
const backlog = await import('../backlog/store.js');
mock.module('../backlog/store.js', {
  namedExports: { ...backlog, markBacklogRunObserved: async () => undefined },
});
const posture = await import('./resource-posture.js');
mock.module('./resource-posture.js', {
  namedExports: { ...posture, reconcileRunPosture: async () => ({ result: undefined }) },
});
const lifecycle = await import('../methods/run/lifecycle-control.js');
mock.module('../methods/run/lifecycle-control.js', {
  namedExports: { ...lifecycle, releaseCompletedRunSlot: async () => {} },
});
const { bumpRunGeneration, startRun } = await import('./orchestrator.js');

async function failingPrepare(t: import('node:test').TestContext, id: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prepare-mini-mm-3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(() => rm(store.runSessionArchiveDir(id), { recursive: true, force: true }));
  const log = path.join(dir, 'deps.log');
  await writeFile(log, 'YN0028: The lockfile would have been modified by this install\n');
  prepareError = Object.assign(new Error(`yarn install failed (exit 1) — log: ${log}`), {
    failedCommand: 'yarn install',
    failedLogPath: log,
  });
  const flow = FLOW_STEPS['fix-bug'];
  run = makeRun({
    id,
    flowType: 'fix-bug',
    status: 'preparing',
    engineState: { generation: 1 },
    steps: flow.map((name, index) => ({
      name,
      status: index < flow.indexOf(S.PREPARE) ? 'done' : 'pending',
    })),
  });
  return log;
}

test('a failed prepare names a per-run copy of its log, which the next prepare cannot overwrite', async (t) => {
  const log = await failingPrepare(t, 'b5da0c86-0000-4000-8000-000000000001');

  await startRun(run.id);

  const step = run.steps.find((candidate) => candidate.name === S.PREPARE)!;
  const copy = step.outputs?.failedLogPath;
  assert.equal(typeof copy, 'string');
  assert.equal(
    path.dirname(copy as string),
    path.join(store.runSessionArchiveDir(run.id), 'prepare-logs'),
  );
  assert.equal(run.status, 'failed');
  assert.equal(run.error, `yarn install failed (exit 1) — log: ${copy}`);
  assert.equal(step.detail, run.error);
  await writeFile(log, 'the next run on this slot\n');
  assert.match(await readFile(copy as string, 'utf8'), /YN0028/);
});

test('a replay that starts while the log is copied is not overwritten by the old loop', async (t) => {
  await failingPrepare(t, '6582e7a5-0000-4000-8000-000000000002');
  retain = async (...args) => {
    bumpRunGeneration(run.id);
    return realRetain.retainFailedStepLogs(...args);
  };
  t.after(() => {
    retain = realRetain.retainFailedStepLogs;
  });

  await startRun(run.id);

  assert.notEqual(run.status, 'failed', 'the replay owns the run now');
  assert.notEqual(run.steps.find((step) => step.name === S.PREPARE)?.status, 'failed');
});
