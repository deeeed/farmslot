import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import {
  activeWorkspaceReviews,
  assertReviewWorkspaceAdmitted,
  assertReviewWorkspacePlacement,
  type ReviewWorkspaceAdmission,
} from './admission.js';

test('workspace placement never treats slot pins as permission to use their host', () => {
  assert.throws(
    () => assertReviewWorkspacePlacement({ flowType: 'review-pr', slotId: 'busy' }),
    /Select an authorized review machine/,
  );
  assert.throws(
    () =>
      assertReviewWorkspacePlacement({
        flowType: 'review-pr',
        reviewWorkspaceTarget: { machine: 'node' },
        allowedSlots: ['busy'],
      }),
    /without slot placement/,
  );
  assert.throws(
    () =>
      assertReviewWorkspacePlacement({
        flowType: 'fix-bug',
        reviewWorkspaceTarget: { machine: 'node' },
      }),
    /without slot placement/,
  );
  assert.doesNotThrow(() =>
    assertReviewWorkspacePlacement({
      flowType: 'review-pr',
      reviewWorkspaceTarget: { machine: 'node' },
    }),
  );
  for (const machine of ['', ' node', 'node ', '\n']) {
    assert.throws(
      () =>
        assertReviewWorkspacePlacement({
          flowType: 'review-pr',
          reviewWorkspaceTarget: { machine },
        }),
      /Invalid review workspace target/,
    );
  }
  assert.throws(
    () =>
      assertReviewWorkspacePlacement({
        flowType: 'review-pr',
        reviewWorkspaceTarget: { machine: 'node' },
        slotId: 'busy',
      }),
    /without slot placement/,
  );
});

test('workspace capacity counts host workers independently of device slots', () => {
  const base = {
    ...makeRun({ flowType: 'review-pr', slotId: null }),
    reviewWorkspaceTarget: { machine: 'node' },
  };
  const runs: Run[] = [
    { ...base, id: 'one', status: 'created' },
    { ...base, id: 'two', status: 'monitoring' },
    { ...base, id: 'old', status: 'done' },
    { ...base, id: 'other', reviewWorkspaceTarget: { machine: 'other' }, status: 'monitoring' },
    {
      ...base,
      id: 'device',
      reviewWorkspaceTarget: undefined,
      slotId: 'busy-device',
      status: 'monitoring',
    },
  ];
  assert.equal(activeWorkspaceReviews('node', runs), 2);
  assert.equal(activeWorkspaceReviews('node', runs, 'one'), 1);
});

test('a terminal run retains capacity until its native process close is confirmed', () => {
  const run = {
    ...makeRun({ slotId: null, status: 'cancelled' }),
    reviewWorkspaceTarget: { machine: 'node' },
  };
  run.agentContexts = [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'failed',
      slotId: null,
      runId: run.id,
      taskFile: null,
      signalFile: null,
      runner: 'codex',
      model: 'gpt-6-astra',
      target: null,
      updatedAt: new Date().toISOString(),
      nativeSession: {
        sessionId: 'session',
        executionNodeId: 'local',
        ownerPrincipalId: 'owner',
        leaseId: 'lease',
        commandId: 'command',
      },
    },
  ];
  assert.equal(activeWorkspaceReviews('node', [run]), 1);
  run.agentContexts[0].nativeSession!.closedAt = new Date().toISOString();
  assert.equal(activeWorkspaceReviews('node', [run]), 0);
  delete run.agentContexts[0].nativeSession!.closedAt;
  run.agentContexts[0].nativeSession!.releasedAt = new Date().toISOString();
  assert.equal(activeWorkspaceReviews('node', [run]), 0);
});

test('cancelled allocation keeps capacity until its source checkout cleanup is confirmed', () => {
  const run = {
    ...makeRun({ slotId: null, status: 'cancelled' }),
    reviewWorkspaceTarget: { machine: 'node' },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'node',
      executionNodeId: 'local',
      checkoutPath: '/owned/source',
      taskPath: '/owned/task',
      artifactPath: '/owned/task/artifacts',
      cleanedAt: undefined as string | undefined,
    },
  };
  assert.equal(activeWorkspaceReviews('node', [run]), 1);
  run.reviewWorkspace.cleanedAt = new Date().toISOString();
  assert.equal(activeWorkspaceReviews('node', [run]), 0);
});

test('workspace admission rejects shared pressure before consuming host capacity', () => {
  const admission = {
    pool: { machine: 'node' },
    limit: 3,
    pressure: { outcome: 'rejected' },
  } as ReviewWorkspaceAdmission;
  assert.throws(() => assertReviewWorkspaceAdmitted(admission), {
    code: 'REVIEW_WORKSPACE_PRESSURE',
  });
});

test('full-live keeps slot placement and cannot request static workspace execution', () => {
  assert.doesNotThrow(() =>
    assertReviewWorkspacePlacement({
      flowType: 'review-pr',
      reviewValidationDepth: 'full-live',
      slotId: 'runtime',
    }),
  );
  assert.doesNotThrow(() =>
    assertReviewWorkspacePlacement({ flowType: 'review-pr', reviewValidationDepth: 'full-live' }),
  );
  assert.throws(
    () =>
      assertReviewWorkspacePlacement({
        flowType: 'review-pr',
        reviewValidationDepth: 'full-live',
        reviewWorkspaceTarget: { machine: 'node' },
      }),
    /without slot placement/,
  );
});
