import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentContext, AgentRole, RunnerSessionUsage } from '@farmslot/protocol';
await import('./mock-pty.test-support.js');
const { createRun, updateRun, getRun, deleteRun } = await import('../runs/store.js');

test('shared registration retains every role and replaced conversation without inventing token zero', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'usage-fixture', ticketOrPr: 'USAGE-1' });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', slotId: null });
    await deleteRun(run.id);
  });
  const roles: AgentRole[] = ['dev', 'fix-bug', 'review', 'review-fix', 'ci-fix', 'primary'];
  const startedAt = '2026-11-05T00:00:00Z';
  const contexts: AgentContext[] = roles.map((role, index) => ({
    id: role,
    role,
    label: role,
    status: 'working',
    slotId: null,
    runId: run.id,
    runner: 'cursor',
    model: 'test-model',
    effort: 'high',
    startedAt,
    runnerSessionId: `conversation-${index}`,
    runnerSessionPath: null,
  }));
  updateRun(run.id, { agentContexts: contexts });
  updateRun(run.id, { agentContexts: [{ ...contexts[0], runnerSessionId: 'relaunched' }] });
  const rows = getRun(run.id)!.sessionUsage!;
  assert.equal(rows.length, roles.length + 1);
  for (const row of rows) {
    assert.equal(row.runner, 'cursor');
    assert.equal(row.model, 'test-model');
    assert.equal(row.effort, 'high');
    assert.equal(row.flowType, 'dev');
    assert.equal(row.runId, run.id);
    assert.equal(row.inputTokens, null);
    assert.equal(row.costStatus, 'unpriced');
    assert.ok(row.costReason);
  }
});

test('helper attribution survives provider failure without changing the original error', async (t) => {
  const { withRunSessionUsageContext } = await import('./run-session-usage-context.js');
  const { captureHelperAttempt, observeHelperUsage } = await import('./agent-usage-context.js');
  const run = createRun({ flowType: 'dev', project: 'usage-fixture', ticketOrPr: 'USAGE-2' });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', slotId: null });
    await deleteRun(run.id);
  });
  const failure = new Error('provider rejected after spending tokens');
  await assert.rejects(
    withRunSessionUsageContext(run.id, 'grade', () =>
      captureHelperAttempt(
        {
          runner: 'api:fixture',
          model: 'fixture',
          effort: 'low',
          source: 'provider-response',
        },
        async () => {
          observeHelperUsage({
            inputTokens: 10,
            outputTokens: 20,
            cacheRead: 30,
            cacheCreation: 40,
            totalTokens: 100,
          });
          throw failure;
        },
      ),
    ),
    (error) => error === failure,
  );
  const row = getRun(run.id)!.sessionUsage![0];
  assert.equal(row.runId, run.id);
  assert.equal(row.role, 'grade');
  assert.equal(row.effort, 'low');
  assert.equal(row.outcome, 'failed');
  assert.equal(row.totalTokens, 100);
  assert.equal(row.source, 'provider-response');
  assert.equal(row.costUsd, null);
  assert.equal(row.costStatus, 'unpriced');
  assert.ok(row.costReason);
});

test('helper reservations and live usage survive until a native conversation is returned', async (t) => {
  const { withRunSessionUsageContext } = await import('./run-session-usage-context.js');
  const { captureHelperAttempt, observeHelperUsage } = await import('./agent-usage-context.js');
  const run = createRun({ flowType: 'dev', project: 'usage-fixture', ticketOrPr: 'USAGE-3' });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', slotId: null });
    await deleteRun(run.id);
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = withRunSessionUsageContext(run.id, 'summary', () =>
    captureHelperAttempt(
      { runner: 'claude', model: 'fixture', source: 'provider-response' },
      async () => {
        observeHelperUsage(
          { turns: 3, inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          'native-helper-conversation',
        );
        await gate;
        return { usage: { provider: 'cli:claude', model: 'fixture', durationMs: 1 } };
      },
    ),
  );
  const active = getRun(run.id)!.sessionUsage!;
  assert.equal(active.length, 1, 'Reservation becomes the exact returned conversation');
  assert.equal(active[0].runnerSessionId, 'native-helper-conversation');
  assert.equal(active[0].totalTokens, 30);
  assert.equal(active[0].completedAt, null);
  release();
  await result;
  assert.equal(getRun(run.id)!.sessionUsage!.length, 1);
  assert.equal(getRun(run.id)!.sessionUsage![0].turns, 3);
  assert.ok(getRun(run.id)!.sessionUsage![0].completedAt);
});

test('warm receipts retain the whole observed conversation duration', async () => {
  const { upsertSessionUsage } = await import('./agent-session-rows.js');
  const base = {
    runner: 'claude',
    runnerSessionId: 'warm',
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-05T00:02:00Z',
    startedAt: '2026-11-05T00:00:00Z',
    completedAt: '2026-11-05T00:02:00Z',
    durationMs: 120000,
    totalTokens: 100,
    usageLeaseIds: ['first-lease'],
  };
  const later = {
    ...base,
    measuredAt: '2026-11-05T00:05:00Z',
    startedAt: '2026-11-05T00:04:00Z',
    completedAt: '2026-11-05T00:05:00Z',
    durationMs: 60000,
    totalTokens: 200,
    usageLeaseIds: ['retry-lease'],
  };
  const rows = upsertSessionUsage([base], later);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationMs, 300000);
  assert.equal(rows[0].totalTokens, 200);
  assert.deepEqual(rows[0].usageLeaseIds, ['first-lease', 'retry-lease']);
});

test('a native reservation remains unavailable until its exact conversation arrives', async () => {
  const { upsertSessionUsage } = await import('./agent-session-rows.js');
  const reservation = {
    runner: 'claude',
    runnerSessionId: null,
    source: 'unavailable' as const,
    measuredAt: '2026-11-05T00:00:00Z',
    nativeSession: {
      sessionId: 'host-reservation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'node',
    },
    costStatus: 'unpriced' as const,
    costReason: 'Conversation not returned',
  };
  const rows = upsertSessionUsage([], reservation);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runnerSessionId, null);
  const bound = upsertSessionUsage(rows, {
    ...reservation,
    runnerSessionId: 'native-conversation',
    source: 'runner-transcript',
    totalTokens: 30,
  });
  assert.equal(bound.length, 1);
  assert.equal(bound[0].runnerSessionId, 'native-conversation');
});

test('replay batches match ordered upserts, including promotion and a priced tie', async () => {
  const { mergeRunSessionReceipts, upsertSessionUsage } = await import('./agent-session-rows.js');
  const nativeSession = {
    sessionId: 'reservation',
    executionNodeId: 'node',
    ownerPrincipalId: 'owner',
  };
  const unavailable = {
    runner: 'pi',
    nativeSession,
    source: 'unavailable' as const,
    measuredAt: '2026-11-20T00:00:00Z',
  };
  const unpriced = {
    runner: 'pi',
    runnerSessionId: 'same',
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-20T00:03:00Z',
    totalTokens: 10,
    costStatus: 'unpriced' as const,
  };
  const priced = {
    runner: 'pi',
    runnerSessionId: 'same',
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-20T00:02:00Z',
    totalTokens: 10,
    costUsd: 4,
  };
  const original = [unavailable, unpriced];
  const incoming = [
    priced,
    { ...priced, runnerSessionId: 'confirmed', nativeSession },
    { ...priced, runnerSessionId: 'extra' },
    unpriced,
  ];
  const rows = mergeRunSessionReceipts(original, incoming);
  assert.deepEqual(
    rows,
    incoming.reduce<RunnerSessionUsage[]>((acc, next) => upsertSessionUsage(acc, next), original),
  );
  assert.deepEqual(
    rows.map((row) => row.runnerSessionId),
    ['same', 'confirmed', 'extra'],
  );
  assert.equal(rows[0]?.costUsd, 4);
  assert.equal(rows[0]?.costStatus, undefined);
  assert.equal(original.length, 2);
  let identityReads = 0;
  const ledger = Array.from({ length: 500 }, (_, index) => ({
    ...priced,
    get runner() {
      identityReads++;
      return 'pi';
    },
    runnerSessionId: 'old-' + index,
  }));
  const additions = Array.from({ length: 500 }, (_, index) => ({
    ...priced,
    runnerSessionId: 'new-' + index,
  }));
  assert.equal(mergeRunSessionReceipts(ledger, additions).length, 1000);
  assert.ok(
    identityReads <= ledger.length * 3,
    'unchanged identities are read once to index the ledger',
  );
});

test('same-scope cost-only receipts preserve measured tokens in either merge order', async () => {
  const { mergeRunSessionReceipts, upsertSessionUsage } = await import('./agent-session-rows.js');
  const cost = {
    runner: 'pi',
    runnerSessionId: 'same',
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-20T00:02:00Z',
    totalTokens: null,
    inputTokens: null,
    costUsd: 4,
  };
  const tokens = { ...cost, totalTokens: 100, inputTokens: 70, outputTokens: 30, costUsd: null };
  for (const [first, next] of [
    [tokens, cost],
    [cost, tokens],
  ] as const) {
    for (const [row] of [
      upsertSessionUsage([first], next),
      mergeRunSessionReceipts([first], [next]),
    ]) {
      assert.equal(row?.costUsd, 4);
      assert.equal(row?.totalTokens, 100);
      assert.equal(row?.inputTokens, 70);
      assert.equal(row?.outputTokens, 30);
    }
  }
  const [scoped] = mergeRunSessionReceipts([tokens], [{ ...cost, scope: 'run-delta' }]);
  assert.equal(scoped?.scope, 'run-delta');
  assert.equal(scoped?.totalTokens, null);
});

test('helper promotion and subsequent captures keep their prepared accounting key', async (t) => {
  const { recordRunSessionUsage } = await import('./agent-session-usage.js');
  const { readCostAccountingRevision } = await import('../runs/cost-accounting-revision.js');
  const run = createRun({ flowType: 'dev', project: 'usage-fixture', ticketOrPr: 'USAGE-4' });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled', slotId: null });
    await deleteRun(run.id);
  });
  const historical: RunnerSessionUsage = {
    runner: 'pi',
    runnerSessionId: 'historical',
    source: 'runner-transcript',
    measuredAt: '2026-11-20T00:00:00Z',
    totalTokens: 20,
  };
  const reservation: RunnerSessionUsage = {
    runner: 'claude',
    runnerSessionId: 'helper-pending',
    requestId: 'reservation',
    identityKind: 'request',
    kind: 'helper',
    source: 'unavailable',
    measuredAt: '2026-11-20T00:00:01Z',
  };
  updateRun(run.id, { sessionUsage: [historical, reservation] });
  const before = readCostAccountingRevision(run, run);
  assert.ok(before);
  let rebuilds = 0;
  const originalMap = Array.prototype.map;
  const confirmed: RunnerSessionUsage = {
    ...reservation,
    runnerSessionId: 'helper-confirmed',
    identityKind: 'conversation',
    source: 'runner-transcript',
    totalTokens: 30,
  };
  Array.prototype.map = function <T, U>(
    this: T[],
    callback: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown,
  ): U[] {
    if (this[0] === historical && this.length === 2 && callback.name === 'receiptKey') rebuilds++;
    return originalMap.call(this, callback, thisArg) as U[];
  };
  try {
    recordRunSessionUsage(run.id, confirmed);
    const promoted = readCostAccountingRevision(run, run);
    assert.notEqual(promoted, before);
    assert.equal(run.sessionUsage?.length, 2);
    assert.equal(run.sessionUsage?.[0], historical);
    assert.equal(run.sessionUsage?.[1]?.runnerSessionId, 'helper-confirmed');
    // A confirmed update does not remove any reservation.
    recordRunSessionUsage(run.id, { ...confirmed, totalTokens: 31 });
    assert.notEqual(readCostAccountingRevision(run, run), promoted);
    assert.equal(rebuilds, 0, 'the writer must not visit the whole ledger to rebuild its key');
  } finally {
    Array.prototype.map = originalMap;
  }
});

test('same-scope deltas never combine a verified price and another lease’s tokens', async () => {
  const { upsertSessionUsage } = await import('./agent-session-rows.js');
  const cost: RunnerSessionUsage = {
    runner: 'pi',
    runnerSessionId: 'reviewer',
    source: 'runner-transcript',
    scope: 'run-delta',
    measuredAt: '2026-11-20T00:03:00Z',
    costUsd: 2,
    usageLeaseIds: ['paid-window'],
  };
  const tokens: RunnerSessionUsage = {
    ...cost,
    usageLeaseIds: ['other-window'],
    costUsd: null,
    totalTokens: 800,
  };
  for (const [first, next] of [
    [tokens, cost],
    [cost, tokens],
  ] as const) {
    const [receipt] = upsertSessionUsage([first], next);
    assert.equal(receipt?.costUsd, 2);
    assert.equal(receipt?.totalTokens, undefined);
    assert.deepEqual(receipt?.usageLeaseIds, ['paid-window']);
  }
});
