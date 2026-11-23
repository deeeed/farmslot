import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

const published: string[] = [];
const rules = await import('../methods/pr-rules.js');
mock.module('../methods/pr-rules.js', {
  namedExports: { ...rules, publishCompletedReview: (runId: string) => void published.push(runId) },
});
const { terminalTransitionDeps } = await import('./terminal-transition.js');
const { routeRunTransition } = await import('./transition-router.js');

const NOW = '2026-11-23T11:27:43.000Z';

async function complete(flowType: Run['flowType']): Promise<void> {
  let stored: Run = {
    id: `run-${flowType}`,
    familyId: 'family',
    lane: 'production',
    flowType,
    status: 'human-gating',
    project: 'farmslot-farm',
    ticketOrPr: 'owner/repo#7',
    slotId: null,
    branch: null,
    taskFile: null,
    steps: [] as Run['steps'],
    decisions: [],
    metrics: {} as Run['metrics'],
    createdAt: NOW,
    updatedAt: NOW,
  } as Run;
  const deps = {
    ...terminalTransitionDeps({
      kind: 'complete',
      runId: stored.id,
      actor: 'engine',
      patch: { status: 'done', completedAt: NOW },
      collaborators: {
        settleBacklog: async () => {},
        tickWorkGraph: async () => {},
        cleanupEvalHarness: null,
        cleanupWorkspace: null,
        cleanupSlot: null,
        emit: () => {},
      },
    }),
    getRun: () => stored,
    updateRun: (_id: string, patch: Partial<Run>) => {
      stored = { ...stored, ...patch };
      return stored;
    },
  };
  await routeRunTransition({ kind: 'complete', runId: stored.id, actor: 'engine' }, deps);
}

test('a completed review starts its PR publication as part of completing', async () => {
  published.length = 0;
  await complete('review-pr');
  assert.deepEqual(published, ['run-review-pr']);
});

test('other completed flows publish no review', async () => {
  published.length = 0;
  await complete('dev');
  assert.deepEqual(published, []);
});
