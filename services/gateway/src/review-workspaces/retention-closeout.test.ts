import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retention-closeout-'));
Object.assign(process.env, {
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'closeout-owner',
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
let refuseStop = true;
let stops = 0;
mock.module('../runners/review-tmux.js', {
  namedExports: {
    REVIEW_STARTUP_TIMEOUT_MS: 300000,
    reviewTmuxSession: () => 'review-workspace',
    verifiedWarmReviewSessionId: () => undefined,
    launchReviewTmux: async () => ({}),
    recoverReviewTmuxSession: async () => {},
    reviewTmuxStartupState: () => 'acknowledged',
    reviewTmuxOperation: async () => {
      stops++;
      if (refuseStop) throw new Error('owned worker stop unavailable');
      return { stopped: true };
    },
  },
});
const workspace = await import('./workspace.js');
const cleanup = mock.fn(async (_runId: string) => {});
mock.module('./workspace.js', { namedExports: { ...workspace, cleanupReviewWorkspace: cleanup } });
const { createRun, getRun, updateRun, archiveRun } = await import('../runs/store.js');
const { reconcileReviewWorkspaceCleanup, teardownReviewWorkspace } = await import('./pipeline.js');
const { retainedWorkspaceIsIdle } = await import('./retention-policy.js');

test('a retained result keeps capacity until terminal reconciliation confirms the worker stop', async () => {
  const created = createRun(
    {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: 'example/app#42',
      mode: 'autonomous',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      transport: 'tmux',
      reviewWorkspaceTarget: { machine: 'local' },
    },
    { nativeOwnerPrincipalId: 'closeout-owner' },
  );
  updateRun(created.id, {
    status: 'done',
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
      retainedAt: '2026-11-06T00:00:00Z',
      retainedUntil: '2026-11-13T00:00:00Z',
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        runId: created.id,
        slotId: null,
        status: 'complete',
        target: { session: 'review-workspace', target: 'review-workspace' },
      },
    ],
  });
  assert.equal(retainedWorkspaceIsIdle(getRun(created.id)!), false);
  await reconcileReviewWorkspaceCleanup(() => {});
  assert.equal(stops, 1);
  assert.match(getRun(created.id)!.reviewWorkspaceCleanupError ?? '', /stop unavailable/);
  assert.equal(retainedWorkspaceIsIdle(getRun(created.id)!), false);
  refuseStop = false;
  await reconcileReviewWorkspaceCleanup(() => {});
  assert.equal(stops, 2);
  assert(getRun(created.id)!.reviewWorkspace!.executionStoppedAt);
  assert.equal(retainedWorkspaceIsIdle(getRun(created.id)!), true);
  assert.equal(getRun(created.id)!.reviewWorkspaceCleanupError, undefined);
});

for (const alreadyStopped of [false, true]) {
  test(`an unstarted setup failure releases checkout and allows archive, stopped=${alreadyStopped}`, async () => {
    const created = createRun(
      {
        flowType: 'review-pr',
        project: 'fixture',
        ticketOrPr: `example/app#${alreadyStopped ? 44 : 43}`,
        mode: 'autonomous',
        runner: 'pi',
        model: 'litellm/glm-5p3-flash',
        transport: 'native',
        reviewWorkspaceTarget: { machine: 'local' },
      },
      { nativeOwnerPrincipalId: 'closeout-owner' },
    );
    updateRun(created.id, {
      status: 'failed',
      error: 'Review support source is unavailable',
      steps: [
        { name: 'write-task', status: 'failed' },
        { name: 'dispatch', status: 'skipped' },
      ],
      agentContexts: [],
      reviewWorkspace: {
        workspaceId: created.id,
        machine: 'local',
        executionNodeId: 'local',
        checkoutPath: '/owned/source',
        taskPath: '/owned/task',
        artifactPath: '/owned/task/artifacts',
        retainedAt: '2026-11-11T00:00:00Z',
        ...(alreadyStopped ? { executionStoppedAt: '2026-11-11T00:00:01Z' } : {}),
      },
    });
    const before = cleanup.mock.callCount();
    const previousStops = stops;
    if (alreadyStopped) await reconcileReviewWorkspaceCleanup(() => {});
    else await teardownReviewWorkspace(created.id);
    assert.equal(cleanup.mock.callCount(), before + 1);
    assert.equal(stops, previousStops, 'No reviewer process was launched');
    assert(getRun(created.id)!.reviewWorkspace?.cleanedAt);
    assert.equal(await archiveRun(created.id), true);
  });
}
