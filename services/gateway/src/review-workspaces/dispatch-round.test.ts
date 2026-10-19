import assert from 'node:assert/strict';
import { after, mock, test, type TestContext } from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

await import('../runtime/mock-pty.test-support.js');
const priorOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'review-owner';
after(() => {
  if (priorOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = priorOwner;
});
// The workspace host, task files and reviewer launch are scripted; the run store
// and the review round budget are real. The task module is replaced before anything
// can load the pipeline through it.
mock.module('./task.js', {
  namedExports: {
    materializeReviewWorkspaceTask: async () => ({
      prompt: 'Review the frozen head.',
      taskFile: '/owned/task/TASK.md',
    }),
    readReviewWorkspaceSignal: async () => null,
    readReviewWorkspaceProgress: async () => null,
    refreshReviewWorkspaceView: async () => 0,
    readReviewWorkspaceCompletion: async () => null,
    collectReviewWorkspaceSubtaskMetrics: async () => null,
  },
});
const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadProjectVars: async () => ({ projectJson: {} }) },
});
const support = await import('./support.js');
mock.module('./support.js', {
  namedExports: { ...support, ensureReviewWorkspaceSupport: async () => {} },
});
const nativeWorkspace = await import('../runners/native/review-workspace.js');
let launches = 0;
let launchFailure: Error | undefined;
mock.module('../runners/native/review-workspace.js', {
  namedExports: {
    ...nativeWorkspace,
    launchReviewWorkspaceWorker: async () => {
      launches++;
      if (launchFailure) throw launchFailure;
      return { session: { id: 'reviewer-session', generation: 'reviewer-generation' } };
    },
  },
});
const { executeReviewWorkspaceStep } = await import('./pipeline.js');
const { createRun, getRun, updateRun, updateRunStep } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const { reviewRoundAdmissionId, runReviewRoundBudget } =
  await import('../review/review-round-budget.js');

function workspaceRun(t: TestContext) {
  const created = createRun(
    {
      flowType: 'review-pr',
      project: 'demo',
      ticketOrPr: 'REVIEW-DISPATCH',
      runner: 'grok',
      model: 'grok-4.7',
      transport: 'native',
      reviewWorkspaceTarget: { machine: 'review-node' },
    },
    { nativeOwnerPrincipalId: 'review-owner' },
  );
  const run = updateRun(created.id, {
    status: 'dispatching',
    slotId: null,
    engineState: { generation: 0 },
    steps: [
      { name: PipelineSteps.DISPATCH, status: 'running', startedAt: '2026-10-19T10:00:00.000Z' },
    ],
    reviewWorkspace: {
      workspaceId: 'owned',
      machine: 'review-node',
      executionNodeId: 'review-node',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
    },
    reviewWorkspaceSubject: {
      repository: 'owner/repo',
      repositoryUrl: 'https://github.com/owner/repo',
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      branch: 'feature',
      title: 'Review',
      body: '',
      url: 'https://github.com/owner/repo/pull/1',
      capturedAt: created.createdAt,
    },
  });
  t.after(async () => {
    launchFailure = undefined;
    updateRun(run.id, {
      reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: new Date().toISOString() },
    });
    await deleteTestRunIfPresent(run.id);
  });
  return {
    run,
    dispatch: (generation: number) =>
      executeReviewWorkspaceStep(run.id, PipelineSteps.DISPATCH, generation, () => {}),
    // The engine stamps a step again each time it enters it (run-engine/orchestrator.ts).
    enterDispatch: (startedAt: string) =>
      updateRunStep(run.id, PipelineSteps.DISPATCH, { status: 'running', startedAt }),
    round: (generation: number) =>
      reviewRoundAdmissionId(`workspace-review-${run.id}`, generation + 1, run.createdAt),
  };
}

test('a restart that re-enters DISPATCH reattaches to its round; a later no-verdict end settles it', async (t) => {
  const f = workspaceRun(t);
  await f.dispatch(0);
  // The gateway restarts during DISPATCH; recovery re-enters the step at the same generation.
  f.enterDispatch('2026-10-19T10:30:00.000Z');
  launchFailure = new Error('reviewer launch refused');
  await assert.rejects(f.dispatch(0), /reviewer launch refused/);

  const run = getRun(f.run.id)!;
  assert.deepEqual(run.reviewRoundAdmissions, [f.round(0)], 'one reviewer is charged once');
  assert.equal(run.reviewRoundSettlements?.[f.round(0)]?.reason, 'reviewer launch refused');
  const budget = await runReviewRoundBudget(run);
  assert.deepEqual([budget.used, budget.noVerdict], [0, 1]);
});

test('a replay at a new generation dispatches a new round and records which generation it is', async (t) => {
  const f = workspaceRun(t);
  const before = launches;
  await f.dispatch(0);
  assert.equal(getRun(f.run.id)!.engineState?.workspaceReviewDispatchGeneration, 0);

  // An operator replay owns a new generation and dispatches its own attempt.
  updateRun(f.run.id, { engineState: { ...getRun(f.run.id)!.engineState, generation: 1 } });
  f.enterDispatch('2026-10-19T11:00:00.000Z');
  await f.dispatch(1);

  const run = getRun(f.run.id)!;
  assert.deepEqual(run.reviewRoundAdmissions, [f.round(0), f.round(1)]);
  assert.equal(run.engineState?.workspaceReviewDispatchGeneration, 1);
  assert.equal(launches - before, 2);
});
