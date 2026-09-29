import assert from 'node:assert/strict';
import test from 'node:test';

import { staticReviewReplayBlock } from './review-workspace.js';

const active = {
  reviewWorkspaceTarget: { machine: 'local' },
  reviewWorkspace: {
    workspaceId: 'workspace',
    machine: 'local',
    executionNodeId: 'local',
    checkoutPath: '/source',
    taskPath: '/task',
    artifactPath: '/task/artifacts',
  },
};

test('workspace setup and runner changes cannot mutate an existing review attempt', () => {
  for (const stepName of ['find-slot', 'write-task', 'prepare', 'dispatch']) {
    assert.ok(staticReviewReplayBlock(active, { stepName }));
    assert.ok(
      staticReviewReplayBlock(
        {
          ...active,
          reviewWorkspace: { ...active.reviewWorkspace, cleanedAt: new Date().toISOString() },
        },
        { stepName },
      ),
    );
  }
  assert.ok(
    staticReviewReplayBlock(active, {
      stepName: 'monitor',
      runner: 'cursor',
      model: 'claude-opus-5-5-high',
    }),
  );
  assert.ok(staticReviewReplayBlock(active, { stepName: 'dispatch', freshDispatch: true }));
  assert.equal(staticReviewReplayBlock(active, { stepName: 'monitor' }), null);
  assert.equal(staticReviewReplayBlock(active, { stepName: 'human-gate' }), null);
});

test('unallocated attempts and non-workspace runs retain their replay contract', () => {
  assert.equal(
    staticReviewReplayBlock(
      { reviewWorkspaceTarget: active.reviewWorkspaceTarget },
      { stepName: 'find-slot' },
    ),
    null,
  );
  assert.equal(staticReviewReplayBlock({}, { stepName: 'dispatch', runner: 'cursor' }), null);
  assert.ok(
    staticReviewReplayBlock(
      { reviewWorkspaceTarget: active.reviewWorkspaceTarget },
      { stepName: 'monitor' },
    ),
  );
});

test('cleaned workspaces can recover reports from disk even before reviewResult was persisted', () => {
  const cleaned = {
    ...active,
    reviewWorkspace: { ...active.reviewWorkspace, cleanedAt: new Date().toISOString() },
  };
  assert.equal(staticReviewReplayBlock(cleaned, { stepName: 'monitor' }), null);
  assert.equal(staticReviewReplayBlock(cleaned, { stepName: 'human-gate' }), null);
});
