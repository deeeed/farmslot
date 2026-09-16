import assert from 'node:assert/strict';
import test from 'node:test';

import { hostReviewSandboxAvailable } from '@farmslot/agent-runtime/native/review-sandbox';
import type { NativeSessionInfo, NativeWorkerSessionBinding, Run } from '@farmslot/protocol';

import {
  assertReviewWorkspaceCancellation,
  assertReviewWorkspaceRun,
  runnerSupportsReadonlyReviewWorkspace,
} from './review-workspace.js';

const binding: NativeWorkerSessionBinding = {
  sessionId: 'session',
  leaseId: 'lease',
  generation: 'generation',
  commandId: 'command',
  ownerPrincipalId: 'owner',
  executionNodeId: 'node',
};
const session = {
  id: 'session',
  workerLeaseId: 'lease',
  generation: 'generation',
  ownerPrincipalId: 'owner',
  executionNodeId: 'node',
  state: 'closed',
  processPid: 123,
  processStopped: true,
} as NativeSessionInfo;
function run(): Run {
  return {
    flowType: 'review-pr',
    slotId: null,
    transport: 'native',
    nativeOwnerPrincipalId: 'owner',
    metrics: { runner: 'codex', model: 'gpt-5.4' },
    reviewWorkspaceTarget: { machine: 'host' },
    reviewWorkspace: {
      workspaceId: 'workspace',
      machine: 'host',
      executionNodeId: 'node',
      checkoutPath: '/reviews/source',
      taskPath: '/reviews/task',
      artifactPath: '/reviews/output',
    },
  } as Run;
}

test('workspace launch rejects slot substitution, placement/profile changes and overlapping writable roots', () => {
  assert.doesNotThrow(() => assertReviewWorkspaceRun(run()));
  for (const patch of [
    { slotId: 'real-slot' },
    { nativeOwnerPrincipalId: undefined },
    { transport: 'tmux' },
    { flowType: 'qa' },
    { reviewWorkspaceTarget: { machine: 'elsewhere' } },
  ])
    assert.throws(() => assertReviewWorkspaceRun({ ...run(), ...patch } as Run));
  for (const taskPath of ['/reviews', '/reviews/source/results', 'relative']) {
    const current = run();
    current.reviewWorkspace!.taskPath = taskPath;
    assert.throws(() => assertReviewWorkspaceRun(current), /roots|paths/);
  }
  const current = run();
  current.reviewWorkspace!.support = {
    path: '/reviews/task/support',
    sha256: 'a'.repeat(64),
    sources: [],
    skills: [],
    environment: {},
  };
  assert.throws(() => assertReviewWorkspaceRun(current), /root|overlap/);
  delete current.reviewWorkspace!.support;
  current.nativeProfile = {
    runner: 'codex',
    executionNodeId: 'different-node',
    profileId: 'profile',
    accountContextId: 'account',
  };
  assert.throws(() => assertReviewWorkspaceRun(current), /another runner or node/);
});

test('cancellation requires exact owner/node/lease/generation and actual process cleanup', () => {
  const result = {
    cancelled: true as const,
    sessionId: 'session',
    leaseId: 'lease',
    generation: 'generation',
    session,
  };
  assert.doesNotThrow(() => assertReviewWorkspaceCancellation(binding, result));
  for (const key of ['id', 'workerLeaseId', 'generation', 'ownerPrincipalId', 'executionNodeId']) {
    assert.throws(() =>
      assertReviewWorkspaceCancellation(binding, {
        ...result,
        session: { ...session, [key]: 'other' },
      }),
    );
  }
  assert.throws(
    () => assertReviewWorkspaceCancellation(binding, { ...result, session: undefined }),
    /current session/,
  );
  assert.throws(
    () =>
      assertReviewWorkspaceCancellation(binding, {
        ...result,
        session: { ...session, processStopped: false },
      }),
    /cleanup/,
  );
  assert.throws(
    () =>
      assertReviewWorkspaceCancellation(binding, {
        ...result,
        cancelled: false,
        reason: 'generation-changed',
        session: undefined,
      }),
    /unconfirmed/,
  );
  assert.doesNotThrow(() =>
    assertReviewWorkspaceCancellation(
      { ...binding, generation: undefined },
      {
        cancelled: true,
        sessionId: 'session',
        leaseId: 'lease',
      },
    ),
  );
});

test('only explicitly supported native runners admit read-only workspace review', () => {
  assert.equal(runnerSupportsReadonlyReviewWorkspace('codex'), true);
  for (const runner of ['claude', 'cursor', 'grok'])
    assert.equal(runnerSupportsReadonlyReviewWorkspace(runner), hostReviewSandboxAvailable());
  for (const runner of ['scripted', 'unknown'])
    assert.equal(runnerSupportsReadonlyReviewWorkspace(runner), false);
});
