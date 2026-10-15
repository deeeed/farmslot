import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { NATIVE_WORKER_READ } from '@farmslot/agent-runtime/native';
import { NativeSessionMethodError } from '@farmslot/agent-runtime/native/service';
import { Methods, type NativeSessionReadResult, type Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { makeRun } from '../../methods/run/test-fixtures.js';

let history: Run[] = [];
let reads: Record<string, unknown>[] = [];
let snapshot: NativeSessionReadResult;
let readFailure: Error | undefined;
let hostFailure: Error | undefined;
let probes: { owner: string; params: Record<string, unknown> }[] = [];
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
      if (method === Methods.NATIVE_SESSION_LIST) {
        probes.push({ owner, params });
        if (hostFailure) throw hostFailure;
        return { sessions: [] };
      }
      assert.equal(owner, 'owner');
      assert.equal(method, NATIVE_WORKER_READ);
      reads.push(params);
      if (readFailure) throw readFailure;
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
  readFailure = undefined;
  hostFailure = undefined;
  probes = [];
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

for (const local of [true, false]) {
  test(`missing ${local ? 'local' : 'remote'} startup session stays a candidate refusal`, async () => {
    reset();
    readFailure = local
      ? new NativeSessionMethodError(
          'NATIVE_SESSION_ERROR',
          'Native session not found for this principal',
        )
      : new Error('Native session not found for this principal');
    await assert.rejects(
      assertReviewNativeRunnerHealthy(input, 'owner', 'node'),
      (error: unknown) => {
        assert(error instanceof GatewayMethodError);
        assert.equal(error.code, 'NATIVE_SESSION_ERROR');
        assert.match(error.message, /startup.*could not be verified.*Native session not found/);
        return true;
      },
    );
  });
}

test('confirmed cancellation before creation adds no health verdict and preserves earlier failure', async () => {
  reset();
  const cancelled = attempt('cancelled', '2026-01-02T00:00:00.000Z');
  cancelled.status = 'cancelled';
  cancelled.agentContexts![0].nativeSession!.closedAt = '2026-01-02T00:00:01.000Z';
  history = [cancelled];
  readFailure = new NativeSessionMethodError(
    'NATIVE_SESSION_ERROR',
    'Native session not found for this principal',
  );
  await assertReviewNativeRunnerHealthy(input, 'owner', 'node');
  assert.equal(reads.length, 0);
  history.push(attempt());
  readFailure = undefined;
  await assert.rejects(assertReviewNativeRunnerHealthy(input, 'owner', 'node'), /timed out/);
  assert.equal(reads[0].sessionId, 'failed');
});

for (const previousAcceptance of [false, true]) {
  test(`unavailable current host refuses placement with ${previousAcceptance ? 'prior acceptance' : 'no history'}`, async () => {
    reset();
    if (previousAcceptance)
      history[0].agentContexts![0].nativeSession!.acceptedAt = '2026-01-01T00:00:01.000Z';
    else history = [];
    hostFailure = new Error('Native host unavailable; inspect host.log. No command was retried.');
    await assert.rejects(assertReviewNativeRunnerHealthy(input, 'owner', 'node'), {
      code: 'NATIVE_SESSION_ERROR',
      message: /Native host on node is unavailable: Native host unavailable/,
    });
    assert.deepEqual(probes, [{ owner: 'owner', params: { executionNodeId: 'node' } }]);
    assert.deepEqual(reads, []);
  });
}

test('current host probe preserves structured candidate refusals and skips tmux', async () => {
  reset();
  const failure = new GatewayMethodError('NATIVE_SESSION_ERROR', 'Host cleanup is unconfirmed');
  hostFailure = failure;
  await assert.rejects(
    assertReviewNativeRunnerHealthy(input, 'owner', 'node'),
    (error) => error === failure,
  );
  await assertReviewNativeRunnerHealthy({ ...input, transport: 'tmux' }, 'owner', 'node');
  assert.equal(probes.length, 1);
});
