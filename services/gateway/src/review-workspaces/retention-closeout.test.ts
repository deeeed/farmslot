import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { RunStatus } from '@farmslot/protocol';

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
const { createRun, getRun, updateRun, archiveRun, getAllRunsWithArchived } =
  await import('../runs/store.js');
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

const { runArchive } = await import('../methods/run/admin.js');
const { isRunArchiving } = await import('../run-lifecycle/archive-fence.js');
let archivePr = 50;
function retainedArchiveRun(
  status: RunStatus,
  stopped = true,
  transport: 'tmux' | 'native' = 'tmux',
) {
  const run = createRun(
    {
      flowType: 'review-pr',
      project: 'fixture',
      ticketOrPr: `example/app#${++archivePr}`,
      mode: 'autonomous',
      runner: 'codex',
      model: 'gpt-6.1-sol',
      transport,
      reviewWorkspaceTarget: { machine: 'local' },
    },
    { nativeOwnerPrincipalId: 'closeout-owner' },
  );
  return updateRun(run.id, {
    status,
    error: 'Original reviewer failure',
    engineState: { workspaceReviewDispatchGeneration: 0 },
    reviewWorkspace: {
      workspaceId: run.id,
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
      retainedAt: '2026-11-11T00:00:00Z',
      retainedUntil: '2026-11-18T00:00:00Z',
      ...(stopped ? { executionStoppedAt: '2026-11-11T00:00:01Z' } : {}),
    },
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Review',
        status: 'failed',
        runId: run.id,
        slotId: null,
        runner: 'codex',
        runnerSessionId: 'retained-conversation',
        target: { session: 'review-workspace', target: 'review-workspace' },
      },
    ],
  });
}

for (const status of ['failed', 'cancelled', 'done'] as const) {
  test(`explicit archive cleans a retained ${status} review without waiting for expiry`, async () => {
    const run = retainedArchiveRun(status);
    const before = cleanup.mock.callCount();
    cleanup.mock.mockImplementationOnce(async (id) => {
      assert.equal(id, run.id);
      assert.equal(isRunArchiving(id), true, 'replay remains fenced during node cleanup');
    });
    assert.deepEqual(await runArchive({ runId: run.id }, () => {}), { ok: true });
    assert.equal(cleanup.mock.callCount(), before + 1);
    assert.equal(getRun(run.id), undefined);
    const saved = (await getAllRunsWithArchived()).find((r) => r.id === run.id);
    assert(saved?.reviewWorkspace?.cleanedAt);
    assert.equal(saved.status, status);
    assert.equal(saved.error, 'Original reviewer failure');
    assert.equal(saved.agentContexts?.[0].runnerSessionId, 'retained-conversation');
    assert.equal(saved.reviewWorkspace.retainedUntil, '2026-11-18T00:00:00Z');
  });
}

test('archive retains the run when reviewer stop or checkout cleanup cannot be confirmed', async () => {
  const run = retainedArchiveRun('failed', false);
  const before = cleanup.mock.callCount();
  refuseStop = true;
  await assert.rejects(
    runArchive({ runId: run.id }, () => {}),
    /stop unavailable/,
  );
  assert.equal(cleanup.mock.callCount(), before);
  assert.equal(getRun(run.id)?.status, 'failed');
  assert.equal(isRunArchiving(run.id), false);
  refuseStop = false;
  cleanup.mock.mockImplementationOnce(async () => {
    throw new Error('owned checkout unavailable');
  });
  await assert.rejects(
    runArchive({ runId: run.id }, () => {}),
    /checkout unavailable/,
  );
  assert.equal(getRun(run.id)?.reviewWorkspace?.cleanedAt, undefined);
  assert.equal(isRunArchiving(run.id), false);
  assert.deepEqual(await runArchive({ runId: run.id }, () => {}), { ok: true });
});

test('archive refuses active review execution before stopping or cleaning it', async () => {
  const run = retainedArchiveRun('reviewing', false);
  const before = cleanup.mock.callCount(),
    stopped = stops;
  await assert.rejects(
    runArchive({ runId: run.id }, () => {}),
    /active run/,
  );
  assert.equal(cleanup.mock.callCount(), before);
  assert.equal(stops, stopped);
});

test('archive of a closed native review keeps the exact conversation and result', async () => {
  const run = retainedArchiveRun('failed', true, 'native');
  const context = run.agentContexts![0];
  updateRun(run.id, {
    agentContexts: [
      {
        ...context,
        nativeSession: {
          sessionId: 'closed-session',
          leaseId: 'original-lease',
          generation: 'original-generation',
          commandId: 'original-command',
          ownerPrincipalId: 'closeout-owner',
          executionNodeId: 'local',
          closedAt: '2026-11-11T00:00:01Z',
        },
      },
    ],
  });
  const binding = getRun(run.id)!.agentContexts![0].nativeSession;
  assert.deepEqual(await runArchive({ runId: run.id }, () => {}), { ok: true });
  const archived = (await getAllRunsWithArchived()).find((r) => r.id === run.id);
  assert(archived?.reviewWorkspace?.cleanedAt);
  assert.deepEqual(archived.agentContexts?.[0].nativeSession, binding);
  assert.equal(archived.agentContexts?.[0].runnerSessionId, 'retained-conversation');
});
