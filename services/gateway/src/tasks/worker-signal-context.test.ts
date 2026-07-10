import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { applyRunningWorkerSignalToContext } from './worker-signal-context.js';

async function cleanupRun(runId: string): Promise<void> {
  try {
    updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  } catch {
    return;
  }
  await deleteRun(runId);
}

test('applyRunningWorkerSignalToContext updates the matched reviewer context id', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-reviewer-signal`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  updateRun(run.id, {
    agentContexts: [
      {
        id: 'rev-codex',
        slotId: 'runner-browser-1',
        runId: run.id,
        role: 'self-review',
        label: 'rev-codex',
        status: 'working',
        target: { session: 'mme-1', window: 'rev-codex', target: 'mme-1:rev-codex' },
        updatedAt: '2026-07-10T08:00:00.000Z',
      },
    ],
  });

  await applyRunningWorkerSignalToContext(
    'runner-browser-1',
    run.id,
    {
      status: 'running',
      timestamp: '2026-07-10T08:10:00.000Z',
      role: 'self-review',
      contextId: 'rev-codex',
    },
    'self-review',
    'rev-codex',
  );

  const updated = getRun(run.id);
  const contexts = updated?.agentContexts ?? [];
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.id, 'rev-codex');
  assert.equal(contexts[0]?.lastSignalAt, '2026-07-10T08:10:00.000Z');
  assert.equal(
    contexts.some((ctx) => ctx.id === 'self-review'),
    false,
  );
});

test('applyRunningWorkerSignalToContext prefers signal context id before role fallback', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-reviewer-signal-role`,
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  updateRun(run.id, {
    agentContexts: [
      {
        id: 'rev-claude',
        slotId: 'runner-browser-1',
        runId: run.id,
        role: 'self-review',
        label: 'rev-claude',
        status: 'working',
        target: { session: 'mme-1', window: 'rev-claude', target: 'mme-1:rev-claude' },
        updatedAt: '2026-07-10T08:00:00.000Z',
      },
      {
        id: 'rev-codex',
        slotId: 'runner-browser-1',
        runId: run.id,
        role: 'self-review',
        label: 'rev-codex',
        status: 'working',
        target: { session: 'mme-1', window: 'rev-codex', target: 'mme-1:rev-codex' },
        updatedAt: '2026-07-10T08:00:00.000Z',
      },
    ],
  });

  await applyRunningWorkerSignalToContext(
    'runner-browser-1',
    run.id,
    {
      status: 'running',
      timestamp: '2026-07-10T08:20:00.000Z',
      contextId: 'rev-codex',
    },
    'self-review',
  );

  const contexts = getRun(run.id)?.agentContexts ?? [];
  assert.equal(
    contexts.find((ctx) => ctx.id === 'rev-codex')?.lastSignalAt,
    '2026-07-10T08:20:00.000Z',
  );
  assert.equal(contexts.find((ctx) => ctx.id === 'rev-claude')?.lastSignalAt, undefined);
});
