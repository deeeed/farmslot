import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import {
  assertReviewWorkspaceAdmissionOpen,
  noteReviewWorkspaceRetirement,
} from './storage-use.js';

const run: Run = {
  ...makeRun({ id: 'checkpoint-review', status: 'done', ticketOrPr: 'example/app#42' }),
  transport: 'tmux',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/owned/runs/workspace/source',
    taskPath: '/owned/runs/workspace/task',
    artifactPath: '/owned/runs/workspace/task/artifacts',
    retainedAt: '2026-11-01T00:00:00Z',
    retainedUntil: '2026-11-03T00:00:00Z',
  },
};
let writable = false;
let purges = 0;
let finalWriteFailures = 0;
mock.module('../runs/store.js', {
  namedExports: {
    getAllRuns: () => [run],
    getAllRunsWithArchived: async () => [run],
    getRun: () => run,
    updateRun: (_id: string, patch: Partial<Run>) => {
      Object.assign(run, patch);
      noteReviewWorkspaceRetirement(run);
      return run;
    },
    persistRunNow: async () => {
      if (!writable) throw new Error('checkpoint write failed');
      if (run.reviewWorkspace?.cleanedAt && finalWriteFailures-- > 0)
        throw new Error('final closeout write failed');
    },
  },
});
mock.module('../backlog/dispatch-queue.js', { namedExports: { getQueueSnapshot: () => [] } });
mock.module('../fleet/machine-registry.js', { namedExports: { getNode: () => undefined } });
mock.module('../methods/pr-rules.js', { namedExports: { reviewWorkspacePendingPRs: () => [] } });
mock.module('../runners/native/review-workspace.js', {
  namedExports: { cancelReviewWorkspaceWorker: async () => {} },
});
mock.module('../runners/review-tmux.js', {
  namedExports: {
    reviewTmuxOperation: async () => {
      throw new Error('A never-started allocation has no reviewer terminal');
    },
  },
});
mock.module('../runners/registry.js', { namedExports: { getRunnerDefinition: () => ({}) } });
mock.module('./workspace.js', {
  namedExports: {
    purgeReviewWorkspace: async () => {
      purges++;
    },
  },
});
const { cleanupExpiredReviewWorkspaces } = await import('./retention.js');

test('every purge attempt requires a durable retirement checkpoint, including retries after write failure', async () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  try {
    await assert.rejects(cleanupExpiredReviewWorkspaces(now), /checkpoint write failed/);
    assert.equal(purges, 0);
    assert.deepEqual(await cleanupExpiredReviewWorkspaces(now), []);
    assert.equal(purges, 0, 'an in-memory retirement is not proof the fence reached disk');
    writable = true;
    assert.deepEqual(await cleanupExpiredReviewWorkspaces(now), ['/owned/runs/workspace/source']);
    assert.equal(purges, 1);
  } finally {
    run.reviewWorkspace = { ...run.reviewWorkspace!, cleanedAt: new Date(now).toISOString() };
    noteReviewWorkspaceRetirement(run, true);
  }
});

test('failed final closeout writes keep admission fenced and retry metadata without deleting twice', async () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  writable = true;
  purges = 0;
  finalWriteFailures = 2;
  run.reviewWorkspace = {
    workspaceId: 'workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/owned/runs/workspace/source',
    taskPath: '/owned/runs/workspace/task',
    artifactPath: '/owned/runs/workspace/task/artifacts',
    retainedAt: '2026-11-01T00:00:00Z',
    retainedUntil: '2026-11-03T00:00:00Z',
  };
  run.reviewWorkspaceCleanupError = undefined;
  try {
    await assert.rejects(cleanupExpiredReviewWorkspaces(now), /final closeout write failed/);
    assert.equal(purges, 1);
    assert.throws(
      () => assertReviewWorkspaceAdmissionOpen({ ticketOrPr: run.ticketOrPr }),
      /cleanup is running/,
    );
    assert.deepEqual(await cleanupExpiredReviewWorkspaces(now + 1), [
      '/owned/runs/workspace/source',
    ]);
    assert.equal(purges, 1, 'confirmed node deletion is not repeated for a metadata-only retry');
    assert.doesNotThrow(() => assertReviewWorkspaceAdmissionOpen({ ticketOrPr: run.ticketOrPr }));
  } finally {
    noteReviewWorkspaceRetirement(
      {
        ...run,
        reviewWorkspace: { ...run.reviewWorkspace!, cleanedAt: new Date(now).toISOString() },
      },
      true,
    );
  }
});
