import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import '../../runtime/mock-pty.test-support.js';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

const core = await import('../../core/index.js');
const fleet = await import('../../fleet/state.js');
const replayStep = await import('./replay-step.js');
let replay: typeof replayStep.runReplayStep;
const rollbacks: Array<Record<string, unknown>> = [];
mock.module('../../core/index.js', {
  namedExports: {
    ...core,
    claimSlotStatusIf: async () => ({ claimed: true, epoch: 1 }),
    updateSlotStatusIf: async (
      _id: string,
      _predicate: unknown,
      fields: Parameters<typeof core.updateSlotStatusIf>[2],
    ) => {
      rollbacks.push(fields);
      return true;
    },
  },
});
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadFleetStatus: async () => ({
      slots: [{ slot: 'move-b', machine: 'move-node', agent: 'idle', currentRunId: null }],
    }),
  },
});
mock.module('./replay-step.js', {
  namedExports: {
    ...replayStep,
    runReplayStep: (...args: Parameters<typeof replayStep.runReplayStep>) => replay(...args),
  },
});
const { runActivateOnSlot, runAutoRecoveryStop, runCIWatchPoke } = await import('./engine-ops.js');

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('runAutoRecoveryStop disables auto recovery and emits run update', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-auto-stop`,
  });
  t.after(() => cleanupRun(run.id));

  const events: string[] = [];
  const result = runAutoRecoveryStop({ runId: run.id }, (event) => {
    events.push(event);
  });

  assert.equal(result.run.autoRecoveryDisabled, true);
  assert.equal(result.run.recoveryProposal?.status, 'disabled');
  assert.deepEqual(events, ['run.updated']);
});

test('runCIWatchPoke surfaces missing runs before poking monitor state', () => {
  assert.throws(() => runCIWatchPoke({ runId: 'missing-ci-watch' }), /Run not found/);
});

for (const fails of [false, true]) {
  test(`activate-on-slot ${fails ? 'rolls back' : 'moves'} the stored pin with the binding`, async (t) => {
    const previousPressure = process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
    process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = 'off';
    t.after(() => {
      if (previousPressure === undefined) delete process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION;
      else process.env.FARMSLOT_DISPATCH_PRESSURE_ADMISSION = previousPressure;
    });
    const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'PROJ-383-move' });
    t.after(() => cleanupRun(run.id));
    updateRun(run.id, { status: 'failed', slotId: 'move-a', requestedSlotId: 'move-a' });
    rollbacks.length = 0;
    replay = async () => {
      assert.equal(getRun(run.id)?.slotId, 'move-b');
      assert.equal(getRun(run.id)?.requestedSlotId, 'move-b');
      if (fails) throw new Error('replay refused');
      return { run: getRun(run.id)! };
    };
    const activate = () => runActivateOnSlot({ runId: run.id, slotId: 'move-b' }, () => {});
    if (fails) await assert.rejects(activate, /replay refused/);
    else await activate();
    assert.equal(getRun(run.id)?.slotId, fails ? 'move-a' : 'move-b');
    assert.equal(getRun(run.id)?.requestedSlotId, fails ? 'move-a' : 'move-b');
    assert.deepEqual(rollbacks, fails ? [{ current_run_id: null }] : []);
  });
}
