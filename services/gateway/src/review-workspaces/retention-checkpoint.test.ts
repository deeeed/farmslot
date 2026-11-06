import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import { noteReviewWorkspaceRetirement } from './storage-use.js';

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
  namedExports: { reviewTmuxOperation: async () => ({ stopped: true }) },
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
    noteReviewWorkspaceRetirement(run);
  }
});
