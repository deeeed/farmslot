import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

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
mock.module('../runners/native/review-workspace.js', {
  namedExports: {
    ...nativeWorkspace,
    launchReviewWorkspaceWorker: async () => {
      launches++;
      return { session: { id: 'reviewer-session', generation: 'reviewer-generation' } };
    },
  },
});
const { executeReviewWorkspaceStep } = await import('./pipeline.js');
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { deleteTestRunIfPresent } = await import('../run-engine/test-fixtures.js');
const { reviewRoundAdmissionId } = await import('../review/review-round-budget.js');

test('a workspace replay that dispatches again admits a new round; a reattach does not', async (t) => {
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
  const launchedAt = (at: string) => [
    { name: PipelineSteps.DISPATCH, status: 'running' as const, startedAt: at },
  ];
  const first = '2026-10-19T10:00:00.000Z';
  const replayed = '2026-10-19T11:00:00.000Z';
  const run = updateRun(created.id, {
    status: 'dispatching',
    slotId: null,
    steps: launchedAt(first),
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
    updateRun(run.id, {
      reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: new Date().toISOString() },
    });
    await deleteTestRunIfPresent(run.id);
  });
  const dispatch = () => executeReviewWorkspaceStep(run.id, PipelineSteps.DISPATCH, 0, () => {});
  const round = (at: string) => reviewRoundAdmissionId(`workspace-review-${run.id}`, 1, at);

  await dispatch();
  // A restart re-enters the same DISPATCH launch: the same attempt and receipt.
  await dispatch();
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, [round(first)]);

  updateRun(run.id, { steps: launchedAt(replayed) });
  await dispatch();
  assert.deepEqual(getRun(run.id)!.reviewRoundAdmissions, [round(first), round(replayed)]);
  assert.equal(launches, 3);
});
