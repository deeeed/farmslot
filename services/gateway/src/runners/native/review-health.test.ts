import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import type { NativeSessionReadResult, Run } from '@farmslot/protocol';

import { makeRun } from '../../methods/run/test-fixtures.js';

let history: Run[] = [];
let reads: Record<string, unknown>[] = [];
let snapshot: NativeSessionReadResult;
mock.module('../../runs/store.js', {
  namedExports: { getAllRunsWithArchived: async () => history },
});
mock.module('./node.js', {
  namedExports: {
    routeNativeExecution: async (
      owner: string,
      method: string,
      params: Record<string, unknown>,
    ) => {
      assert.equal(owner, 'owner');
      assert.equal(method, NATIVE_WORKER_READ);
      reads.push(params);
      return snapshot;
    },
  },
});
const { assertReviewNativeRunnerHealthy } = await import('./review-health.js');
const input = { machine: 'node', runner: 'claude', model: 'opus', transport: 'native' as const };

function attempt(id = 'failed', launchRequestedAt = '2026-01-01T00:00:00.000Z'): Run {
  const run = makeRun({ id, flowType: 'review-pr', status: 'failed' });
  run.transport = 'native';
  run.nativeOwnerPrincipalId = 'owner';
  run.agentContexts = [
    {
      id: 'review',
      role: 'review',
      label: 'Review',
      status: 'failed',
      slotId: null,
      runId: run.id,
      updatedAt: launchRequestedAt,
      runner: 'claude',
      model: 'opus',
      nativeSession: {
        sessionId: id,
        leaseId: 'lease',
        commandId: 'command',
        ownerPrincipalId: 'owner',
        executionNodeId: 'node',
        launchRequestedAt,
      },
    },
  ];
  return run;
}

function reset() {
  history = [attempt()];
  reads = [];
  snapshot = {
    session: {
      id: 'failed',
      generation: 'generation',
      hostPid: 1,
      runner: 'claude',
      nativeSessionId: '',
      ownerPrincipalId: 'owner',
      executionNodeId: 'node',
      accountContextId: 'account',
      cwd: '/review',
      executable: '/runner',
      version: '1.0.0',
      mode: 'default',
      accountMode: 'native',
      state: 'failed',
      error: 'Claude stream-json initialization timed out',
      capabilities: {
        modes: ['default'],
        streaming: true,
        tools: true,
        approvals: true,
        questions: true,
        interrupt: true,
        resume: true,
      },
    },
    events: [],
    commands: [],
    cursor: 0,
    hasMore: false,
    pendingRequests: [],
  };
}

test('retained native startup failure refuses automatic placement with its real cause', async () => {
  reset();
  await assert.rejects(assertReviewNativeRunnerHealthy(input, 'owner', 'node'), {
    code: 'NATIVE_SESSION_ERROR',
    message: /node failed before accepting a review: Claude stream-json initialization timed out/,
  });
  assert.deepEqual(reads, [{ sessionId: 'failed', executionNodeId: 'node', leaseId: 'lease' }]);
  snapshot.session.state = 'closed';
  await assert.rejects(assertReviewNativeRunnerHealthy(input, 'owner', 'node'), /timed out/);
  await assert.rejects(
    assertReviewNativeRunnerHealthy({ ...input, model: 'sonnet' }, 'owner', 'node'),
    /timed out/,
  );
});

test('a later accepted review clears an older startup failure, independent of archive ordering', async () => {
  reset();
  const recovered = attempt('recovered', '2026-01-02T00:00:00.000Z');
  recovered.agentContexts![0].nativeSession!.acceptedAt = '2026-01-02T00:00:01.000Z';
  history.unshift(recovered);
  await assertReviewNativeRunnerHealthy(input, 'owner', 'node');
  assert.equal(reads.length, 0);
});

test('runner health does not cross owners, nodes, runners, accounts or transports', async () => {
  reset();
  for (const selected of [
    { ...input, runner: 'codex' },
    { ...input, transport: 'tmux' as const },
    {
      ...input,
      nativeProfile: {
        runner: 'claude',
        executionNodeId: 'node',
        profileId: 'isolated',
        accountContextId: 'other',
      },
    },
  ]) {
    await assertReviewNativeRunnerHealthy(selected, 'owner', 'node');
  }
  await assertReviewNativeRunnerHealthy(input, 'other-owner', 'node');
  await assertReviewNativeRunnerHealthy(input, 'owner', 'other-node');
  await assertReviewNativeRunnerHealthy(input, 'owner', 'node', history[0].id);
  assert.equal(reads.length, 0);
});

test('task failures after native acceptance and ordinary cancellation do not poison startup health', async () => {
  reset();
  snapshot.commands = [
    {
      commandId: 'command',
      generation: 'generation',
      state: 'failed',
      submitted: true,
      accepted: true,
      outcome: 'failed',
    },
  ];
  await assertReviewNativeRunnerHealthy(input, 'owner', 'node');
  snapshot.commands = [];
  snapshot.session.state = 'closed';
  delete snapshot.session.error;
  await assertReviewNativeRunnerHealthy(input, 'owner', 'node');
});
