import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentContext, AgentRole } from '@farmslot/protocol';
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
  };
  const later = {
    ...base,
    measuredAt: '2026-11-05T00:05:00Z',
    startedAt: '2026-11-05T00:04:00Z',
    completedAt: '2026-11-05T00:05:00Z',
    durationMs: 60000,
    totalTokens: 200,
  };
  const rows = upsertSessionUsage([base], later);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationMs, 300000);
  assert.equal(rows[0].totalTokens, 200);
});
