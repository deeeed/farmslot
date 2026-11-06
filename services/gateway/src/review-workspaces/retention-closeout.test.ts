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
const { createRun, getRun, updateRun } = await import('../runs/store.js');
const { reconcileReviewWorkspaceCleanup } = await import('./pipeline.js');
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
