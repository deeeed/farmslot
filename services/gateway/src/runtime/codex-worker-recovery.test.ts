import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

const config = await import('../core/config.js');
mock.module('../core/config.js', {
  namedExports: { ...config, loadSlotVars: async () => makeVars() },
});
const { extractRunWorkerSessionUsage, projectArchivedRunnerUsage } =
  await import('./session-usage.js');

test('recorded Codex worker/fix paths recover once without an archive and retain unpriced receipts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-worker-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = path.join(root, 'recorded.jsonl');
  const sessionId = 'recorded-codex-worker';
  await writeFile(
    transcript,
    [
      { type: 'session_meta', payload: { id: sessionId } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 39986442,
              cached_input_tokens: 39031040,
              output_tokens: 115009,
              reasoning_output_tokens: 30579,
              total_tokens: 40101451,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  const run = makeRun({
    flowType: 'dev',
    slotId: 'unregistered-slot',
    metrics: {
      nudgeCount: 0,
      runner: 'codex',
      model: 'gpt-6.1-sol',
      runnerSessionId: sessionId,
      runnerSessionPath: transcript,
    },
  });
  const context = (id: string, role: AgentContext['role']): AgentContext => ({
    id,
    role,
    label: id,
    status: 'complete',
    slotId: run.slotId,
    runId: run.id,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    runnerSessionId: sessionId,
    runnerSessionPath: transcript,
    startedAt: '2026-11-04T15:03:37.307Z',
    completedAt: '2026-11-04T23:09:24Z',
  });
  run.agentContexts = [
    context('dev', 'dev'),
    context('review-fix', 'review-fix'),
    {
      ...context('reviewer', 'review'),
      reviewId: 'independent-review',
      runnerSessionId: 'reviewer-session',
      runnerSessionPath: '/not-a-worker.jsonl',
    },
  ];
  run.sessionUsage = [
    {
      runner: 'codex',
      runnerSessionId: sessionId,
      runnerSessionPath: '/old-retained-path.jsonl',
      role: 'dev',
      kind: 'agent',
      source: 'runner-transcript',
      totalTokens: 1,
      measuredAt: '2026-11-04T15:03:37Z',
    },
  ];
  const before = JSON.stringify(run);
  const usage = await extractRunWorkerSessionUsage(run, makeVars());
  assert.equal(usage?.totalTokens, 40101451);
  assert.equal(usage?.cacheRead, 39031040);
  assert.equal(usage?.costUsd, null);
  const projected = await projectArchivedRunnerUsage(run);
  assert.equal(projected.metrics.sessionTotalTokens, 40101451);
  assert.equal(projected.metrics.actualModel, 'gpt-6.1-sol');
  const row = projected.sessionUsage?.find((entry) => entry.runnerSessionId === sessionId);
  assert.ok(row);
  assert.equal(row.totalTokens, 40101451);
  assert.equal(row.costStatus, 'unpriced');
  assert.ok(row.costReason);
  assert.ok(row.roles?.includes('dev') && row.roles.includes('review-fix'));
  assert.notEqual(
    row.measuredAt,
    run.updatedAt,
    'Read capture time is not fabricated from run completion',
  );
  assert.equal(JSON.stringify(run), before, 'Read projection never writes stored run data');
});

test('family receipt source metadata excludes native lifecycle and recovery prompt content', async () => {
  const { contextSessionReceipt } = await import('./agent-session-rows.js');
  const run = makeRun({ flowType: 'dev' });
  const row = contextSessionReceipt(
    run,
    {
      id: 'dev',
      role: 'dev',
      label: 'worker',
      status: 'working',
      slotId: run.slotId,
      runId: run.id,
      runner: 'codex',
      runnerSessionId: 'conversation',
      nativeSession: {
        sessionId: 'host',
        executionNodeId: 'node',
        ownerPrincipalId: 'owner',
        stateDirectory: '/owned/native/state',
        leaseId: 'lease',
        commandId: 'command',
        recovery: {
          fromGeneration: 'before',
          commandId: 'recover',
          text: 'PRIVATE_RECOVERY_PROMPT',
        },
      },
    },
    '2026-11-05T00:00:00Z',
  );
  assert.ok(row?.nativeSession);
  assert.equal(JSON.stringify(row.nativeSession).includes('PRIVATE_RECOVERY_PROMPT'), false);
  assert.equal(row.nativeSession.sessionId, 'host');
});
