import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-retirement-eviction-'));
Object.assign(process.env, {
  FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
  FARMSLOT_POOL_DIR: path.join(root, 'pool'),
  FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
  FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID: 'eviction-owner',
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { createRun, getRun, updateRun, persistRunNow, archiveRun, deleteRun } =
  await import('./store.js');
const { noteReviewWorkspaceRetirement, assertReviewWorkspaceAdmissionOpen } =
  await import('../review-workspaces/storage-use.js');
for (const operation of [archiveRun, deleteRun])
  test(`${operation.name} cannot evict a memory-cleaned workspace before durable retirement closeout`, async () => {
    const run = createRun(
      {
        flowType: 'review-pr',
        project: 'fixture',
        ticketOrPr: 'example/app#94',
        mode: 'autonomous',
        runner: 'codex',
        model: 'gpt-6.1-sol',
        transport: 'tmux',
        reviewWorkspaceTarget: { machine: 'local' },
      },
      { nativeOwnerPrincipalId: 'eviction-owner' },
    );
    const workspace = {
      workspaceId: run.id,
      machine: 'local',
      executionNodeId: 'local',
      checkoutPath: path.join(root, run.id, 'source'),
      taskPath: path.join(root, run.id, 'task'),
      artifactPath: path.join(root, run.id, 'task/artifacts'),
      retirement: {
        id: run.id,
        startedAt: new Date().toISOString(),
        pr: { host: 'github.com', repo: 'example/app', number: 94 },
      },
    };
    updateRun(run.id, { status: 'done', reviewWorkspace: workspace });
    updateRun(run.id, { reviewWorkspace: { ...workspace, cleanedAt: new Date().toISOString() } });
    try {
      await assert.rejects(operation(run.id), /durable.*closeout/);
      assert.equal(getRun(run.id), run);
      assert.throws(
        () => assertReviewWorkspaceAdmissionOpen({ ticketOrPr: run.ticketOrPr }),
        /cleanup is running/,
      );
      await persistRunNow(run, 'confirmed closeout test receipt');
      noteReviewWorkspaceRetirement(run, true);
      assert.equal(await operation(run.id), true);
    } finally {
      noteReviewWorkspaceRetirement(
        {
          ...run,
          reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: new Date().toISOString() },
        },
        true,
      );
      if (getRun(run.id)) await deleteRun(run.id);
    }
  });
