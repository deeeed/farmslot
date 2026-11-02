import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setImmediate as flushed } from 'node:timers/promises';

const replayStep = await import('../methods/run/replay-step.js');
const replays: string[] = [];
mock.module('../methods/run/replay-step.js', {
  namedExports: {
    ...replayStep,
    runReplayStep: async (params: { runId: string }) => {
      replays.push(params.runId);
    },
  },
});
const { rearmPublicationReviewRecoveryForRun, suspendPublicationReviewRecoveryForRun } =
  await import('./orchestrator.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');

/** A run whose HUMAN_GATE is still preparing its decision on a slot. */
function preparingGate(): string {
  const created = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}${replays.length}`,
    slotId: 'watcher-slot',
  });
  updateRun(created.id, {
    status: 'human-gating',
    steps: created.steps.map((step) =>
      step.name === 'human-gate'
        ? { ...step, status: 'running', detail: 'Preparing operator decision' }
        : step.name === 'finalize' || step.name === 'ci-watch'
          ? step
          : { ...step, status: 'done' },
    ),
    engineState: { ...created.engineState, generation: 3 },
  });
  return created.id;
}

// F311: recovery's replay was refused (the node was still away) and re-armed this retry. An
// operator then replayed the gate and its card came up before the retry fired; the retry must not
// replay again and supersede that card.
test('a pending gate retry stands down once another replay owns the gate (F311)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const untouched = preparingGate();
  const replayedByOperator = preparingGate();
  t.after(async () => {
    for (const id of [untouched, replayedByOperator]) {
      suspendPublicationReviewRecoveryForRun(id);
      updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(id);
    }
  });
  assert.ok(rearmPublicationReviewRecoveryForRun(untouched, { replayPending: true }));
  assert.ok(rearmPublicationReviewRecoveryForRun(replayedByOperator, { replayPending: true }));
  updateRun(replayedByOperator, {
    engineState: { ...getRun(replayedByOperator)?.engineState, generation: 4 },
  });

  t.mock.timers.tick(60_000);
  for (let i = 0; i < 5; i++) await flushed();

  assert.deepEqual(replays, [untouched], 'only the gate nobody else replayed is retried');
  assert.equal(getRun(replayedByOperator)?.engineState?.publishGate?.reviewRecovery, undefined);
});
