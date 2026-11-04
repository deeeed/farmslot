import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { pipelineStepsForRun, type Run, type RunCreateParams } from '@farmslot/protocol';

import '../../runtime/mock-pty.test-support.js';

const core = await import('../../core/index.js');
const orchestrator = await import('../../run-engine/orchestrator.js');
const capabilities = await import('../../run-engine/slot-capability-requirements.js');
const store = await import('../../runs/store.js');
const { makeRun } = await import('../../run-engine/test-fixtures.js');

let run: Run;
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    getRun: () => run,
    getAllRuns: () => [run],
    persistRunNow: async () => {},
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<Run['steps'][number]>) => {
      const step = run.steps.find((item) => item.name === name)!;
      return Object.assign(step, patch);
    },
  },
});
mock.module('../../core/index.js', {
  namedExports: { ...core, readSlotRow: async () => null },
});
mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...orchestrator,
    cancelRunEngine: () => {},
    isRunEngineDriven: () => false,
    bumpRunGeneration: () => {
      run.engineState = { ...run.engineState, generation: 1 };
      return 1;
    },
  },
});
mock.module('../../run-engine/slot-capability-requirements.js', {
  namedExports: { ...capabilities, replaySlotCapabilityRequirements: async () => undefined },
});
const { runReplayStep } = await import('./replay-step.js');
const { reconcileOrphanedSlots, STALE_RELEASE_RECLAIM_MS } =
  await import('../../run-engine/recovery.js');

test('creation records the caller pin separately from later placement', () => {
  for (const slotId of [undefined, 'mini-example-3']) {
    const request: RunCreateParams = {
      flowType: 'dev',
      project: 'example-terminal',
      ticketOrPr: 'PROJ-383',
      slotId,
    };
    const created = store.buildRunRecord(request);
    assert.equal(created.requestedSlotId, null, 'a chained run has no caller request');
    const placed = store.buildRunRecord(
      { ...request, slotId: 'engine-placement' },
      { dispatchRequest: request },
    );
    assert.equal(placed.requestedSlotId, slotId ?? null);
  }
});

for (const flowType of ['dev', 'fix-bug'] as const) {
  for (const placement of ['explicit', 'scored'] as const) {
    test(
      `${placement === 'scored' ? 'control: ' : ''}${flowType} replay preserves ${placement} placement intent`,
      { timeout: 2000 },
      async () => {
        run = makeRun({
          id: 'replay-pin',
          project: 'example-terminal',
          flowType,
          ticketOrPr: 'PROJ-383',
          prNumber: undefined,
          status: 'failed',
          slotId: 'mini-example-3',
          branch: '',
        });
        run.steps = pipelineStepsForRun(run)!.map((name) => ({
          name,
          status: name === 'find-slot' ? 'failed' : 'pending',
          ...(name === 'find-slot' && placement === 'scored'
            ? { inputs: {}, outputs: { selectedSlot: run.slotId, selectionMethod: 'scored' } }
            : {}),
        }));
        const expected = placement === 'explicit' ? 'mini-example-3' : null;
        if (placement === 'explicit') run.requestedSlotId = expected;
        for (let attempt = 0; attempt < 2; attempt++) {
          let started = false;
          await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {}, {
            startEngine: async () => {
              started = true;
            },
          });
          assert.equal(started, true);
          assert.equal(run.slotId, expected);
          assert.equal(run.taskFile, null);
        }
        // Persisted intent survives a lost binding or a failed provisional selection.
        run.requestedSlotId = expected;
        run.slotId = placement === 'explicit' ? null : 'engine-provisional';
        run.steps.find((step) => step.name === 'find-slot')!.outputs = undefined;
        await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {}, {
          startEngine: async () => {},
        });
        assert.equal(run.slotId, expected);
      },
    );
  }
}

test('restart cleanup retains a detached stored pin for replay', { timeout: 2000 }, async () => {
  run = makeRun({
    id: 'replay-pin',
    project: 'example-terminal',
    flowType: 'dev',
    ticketOrPr: 'PROJ-383',
    prNumber: undefined,
    status: 'blocked',
    slotId: 'mini-example-3',
    branch: '',
    steps: [
      { name: 'find-slot', status: 'done', inputs: { requestedSlotId: 'mini-example-3' } },
      { name: 'monitor', status: 'done' },
    ],
  });
  run.requestedSlotId = 'mini-example-3';
  const stale = new Date(Date.now() - STALE_RELEASE_RECLAIM_MS - 1).toISOString();
  const unexpected = (): never => {
    throw new Error('Unexpected recovery action');
  };
  await reconcileOrphanedSlots({
    listRuns: () => ({ runs: [run] }),
    loadFleetStatus: async () => ({
      slots: [{ slot: 'mini-example-3', lifecycle: 'busy', phase: 'releasing' }],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async (_slot, field) => (field === 'current_run_id' ? run.id : stale),
    getRun: () => run,
    updateRun: (_id, patch) => {
      Object.assign(run, patch);
    },
    stopRunOwnedWorkers: async () => null,
    resetSlot: unexpected,
    resetSlotIf: async (_slot, predicate) => {
      assert.equal(
        predicate({ phase: 'releasing', releasing_since: stale, current_run_id: run.id }),
        true,
      );
      return true;
    },
    updateSlotStatusIf: unexpected,
    broadcast: () => {},
    retryOccupiedRunSlot: unexpected,
    resumeInterruptedRecovery: unexpected,
  });
  assert.equal(run.slotId, null);
  assert.equal(run.requestedSlotId, 'mini-example-3');
  await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {}, {
    startEngine: async () => {},
  });
  assert.equal(run.slotId, 'mini-example-3');
});

for (const legacyField of ['find-slot input', 'dispatch request'] as const) {
  test(`legacy ${legacyField} placement does not become a replay pin`, async () => {
    run = makeRun({
      id: 'legacy-queue-placement',
      flowType: 'dev',
      status: 'failed',
      slotId: 'scheduler-placement',
      prNumber: undefined,
      branch: '',
    });
    if (legacyField === 'dispatch request')
      run.dispatchRequest = {
        flowType: run.flowType,
        project: run.project,
        ticketOrPr: run.ticketOrPr,
        slotId: 'scheduler-placement',
      };
    run.steps = pipelineStepsForRun(run)!.map((name) => ({
      name,
      status: name === 'find-slot' ? 'failed' : 'pending',
      ...(name === 'find-slot' ? { inputs: { requestedSlotId: run.slotId } } : {}),
    }));
    await runReplayStep({ runId: run.id, stepName: 'find-slot' }, () => {}, {
      startEngine: async () => {},
    });
    assert.equal(run.slotId, null);
    assert.equal(run.requestedSlotId, null);
  });
}
