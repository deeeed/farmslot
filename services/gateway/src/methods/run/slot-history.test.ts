import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  createRun,
  deleteRun,
  listRunsForSlotHistory,
  runRecordPath,
  updateRun,
} from '../../runs/store.js';

import { buildSlotRunHistoryEntry } from './slot-history.js';
import { makeRun } from './test-fixtures.js';

test('listRunsForSlotHistory filters by slot, sorts newest first, and reports pre-limit total', async (t) => {
  const created: string[] = [];
  const addRun = (slotId: string, createdAt: string, ticketOrPr: string): Run => {
    const run = createRun({
      flowType: 'fix-bug',
      project: 'example-mobile-farm',
      ticketOrPr,
      runner: 'claude',
      model: 'sonnet',
    });
    created.push(run.id);
    return updateRun(run.id, {
      slotId,
      status: 'done',
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    });
  };

  const older = addRun('slot-history-a', '2026-04-14T00:00:00.000Z', 'PROJ-history-old');
  const newer = addRun('slot-history-a', '2026-04-16T00:00:00.000Z', 'PROJ-history-new');
  addRun('slot-history-b', '2026-04-17T00:00:00.000Z', 'PROJ-other-slot');

  t.after(async () => {
    for (const id of created) {
      await deleteRun(id);
    }
  });

  const result = listRunsForSlotHistory('slot-history-a', { limit: 1 });
  assert.equal(result.totalCount, 2);
  assert.deepEqual(
    result.runs.map((run) => run.id),
    [newer.id],
  );

  const unbounded = listRunsForSlotHistory('slot-history-a');
  assert.deepEqual(
    unbounded.runs.map((run) => run.id),
    [newer.id, older.id],
  );
});

test('listRunsForSlotHistory rejects invalid limits and caps excessive limits', () => {
  assert.throws(() => listRunsForSlotHistory('slot-history-a', { limit: 0 }), /positive finite/);
  assert.throws(() => listRunsForSlotHistory('slot-history-a', { limit: -5 }), /positive finite/);
  assert.throws(
    () => listRunsForSlotHistory('slot-history-a', { limit: Number.NaN }),
    /positive finite/,
  );
  assert.doesNotThrow(() => listRunsForSlotHistory('slot-history-a', { limit: 101 }));
});

test('buildSlotRunHistoryEntry derives recovery paths and current marker', () => {
  const run = makeRun({
    id: 'run-history-entry',
    familyId: 'family-history-entry',
    slotId: 'slot-history-a',
    branch: 'fix/history',
    taskFile: '/tmp/farmslot/task/TASK.md',
    metrics: {
      nudgeCount: 1,
      runner: 'claude',
      model: 'sonnet',
      actualModel: 'claude-sonnet-4-6',
      runnerSessionId: 'sess-123',
      runnerSessionPath: '/tmp/session.jsonl',
      durationMs: 1234,
    },
  });

  assert.deepEqual(buildSlotRunHistoryEntry(run, run.id), {
    runId: 'run-history-entry',
    familyId: 'family-history-entry',
    status: 'monitoring',
    flowType: 'fix-bug',
    ticketOrPr: 'PROJ-1',
    summary: undefined,
    project: 'example-mobile-farm',
    branch: 'fix/history',
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
    completedAt: undefined,
    durationMs: 1234,
    runner: 'claude',
    model: 'sonnet',
    actualModel: 'claude-sonnet-4-6',
    runnerSessionId: 'sess-123',
    runnerSessionPath: '/tmp/session.jsonl',
    taskFile: '/tmp/farmslot/task/TASK.md',
    taskDir: '/tmp/farmslot/task',
    artifactDir: '/tmp/farmslot/task/artifacts',
    prNumber: null,
    diffStat: { files: 0, additions: 0, deletions: 0, available: false },
    visualPairCount: 0,
    runRecordPath: runRecordPath('run-history-entry'),
    currentForSlot: true,
  });
});

test('buildSlotRunHistoryEntry includes compact diff summary for workspace shortcuts', () => {
  const run = makeRun({
    id: 'run-history-diff',
    steps: [
      {
        name: 'complete',
        status: 'done',
        outputs: { diffStat: { files: 2, additions: 10, deletions: 3 } },
      },
    ],
  });

  assert.deepEqual(buildSlotRunHistoryEntry(run).diffStat, {
    files: 2,
    additions: 10,
    deletions: 3,
    available: true,
  });
});

test('buildSlotRunHistoryEntry includes compact before-after count for workspace shortcuts', () => {
  const run = makeRun({
    id: 'run-history-visual-pairs',
    decisions: [
      {
        id: 'ready-visuals',
        type: 'monitor_ready_gate',
        title: 'Ready',
        description: 'Ready',
        actions: [],
        createdAt: '2026-04-15T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: 12,
          repo: 'owner/repo',
          diffStat: { files: 1, additions: 2, deletions: 1 },
          workerReport: 'done',
          branch: 'fix/history',
          artifactManifest: [
            { path: 'evidence/before-login.png', purpose: 'screenshot' },
            { path: 'evidence/after-login.png', purpose: 'screenshot' },
          ],
          publicationStatus: 'published_draft',
        },
      },
    ],
  });

  assert.equal(buildSlotRunHistoryEntry(run).visualPairCount, 1);
});
