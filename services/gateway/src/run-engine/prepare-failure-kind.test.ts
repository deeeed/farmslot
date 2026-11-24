// MetaMask/metamask-mobile#39654 run 2870e73a: a lockfile drift failure reaches the failed
// prepare step's outputs as failureKind, through the real engine's failure handler.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from './test-fixtures.js';

let run: Run;
// The orchestrator is this module's only importer, and these are the names it takes.
mock.module('./dispatch-lifecycle-steps.js', {
  namedExports: {
    executePrepareStep: async () => {
      throw Object.assign(new Error('lockfile drift on PR branch: @metamask/perps-controller …'), {
        failureKind: 'lockfile-drift',
      });
    },
    executeDispatchStep: async () => {
      throw new Error('Unexpected dispatch');
    },
  },
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
const { startRun } = await import('./orchestrator.js');

test('a lockfile drift prepare failure records its kind on the failed step', async () => {
  const flow = FLOW_STEPS['pr-complete'];
  run = makeRun({
    id: '2870e73a-0000-4000-8000-000000000001',
    flowType: 'pr-complete',
    status: 'preparing',
    engineState: { generation: 1 },
    steps: flow.map((name, index) => ({
      name,
      status: index < flow.indexOf(S.PREPARE) ? 'done' : 'pending',
    })),
  });

  await startRun(run.id);

  const prepare = run.steps.find((step) => step.name === S.PREPARE)!;
  assert.equal(run.status, 'failed');
  assert.equal(prepare.outputs?.failureKind, 'lockfile-drift');
});
