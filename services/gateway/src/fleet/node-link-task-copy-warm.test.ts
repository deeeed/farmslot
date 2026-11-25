import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

let row: Record<string, unknown> | null = null;
const runs = new Map<string, Run>();
const state = await import('../core/state.js');
mock.module('../core/state.js', { namedExports: { ...state, readSlotRow: async () => row } });
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: (id: string) => runs.get(id) },
});
const registry = await import('./machine-registry.js');
// No node identity: staging stops right after its ownership check.
mock.module('./machine-registry.js', { namedExports: { ...registry, getNode: () => undefined } });
const { makeRun } = await import('../run-engine/test-fixtures.js');
const { makeVars } = await import('../runners/test-fixtures.js');
const { activeRunOnSlotReason } = await import('../methods/dispatch/slot-scoring.js');
const { createNodeLinkTaskStager } = await import('./node-link-task-copy.js');

test('a warm child stages its task under the hold its parent left for it; others may not', async () => {
  const vars = makeVars({ slotId: 'mini-mm-1' });
  const taskFile = '/tasks/update-branch/c616be16/TASK.md';
  const child = makeRun({
    id: 'warm-child',
    slotId: vars.slotId,
    status: 'dispatching',
    parentRunId: 'parent-run',
    taskFile,
    engineState: { generation: 0, flags: { warmSessionReuse: true } },
  });
  runs.set(child.id, child);
  runs.set('other-run', makeRun({ id: 'other-run', slotId: vars.slotId, taskFile }));
  row = {
    slot: vars.slotId,
    slot_epoch: 5,
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: null,
    cleanup_run_id: 'parent-run',
    handoff_run_id: null,
    held_reason: activeRunOnSlotReason(child.id),
  };
  const stage = (runId: string) =>
    createNodeLinkTaskStager(
      { runId, taskFile },
      vars,
      '/tasks/update-branch/c616be16',
      `${vars.remoteRepo}/.agent/tasks/c616be16`,
    );
  await assert.rejects(stage(child.id), /Node identity is unavailable/);
  await assert.rejects(stage('other-run'), /cannot replace another run owner/);
});
