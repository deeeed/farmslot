import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { SourcePlanRestart } from '../sources/run-admission.js';
import { sourceTestLock, sourceTestPlan } from '../sources/source.test-support.js';

import type { executeFindSlotStep } from './find-slot-step.js';
import { makeRun } from './test-fixtures.js';

const store = await import('../runs/store.js');
let run: Run;
const selectedActions: string[] = [];
const attemptedSlots: Array<string | null> = [];
let afterReplan: (() => Promise<void>) | undefined;
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (run?.id === id ? run : undefined),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<Run['steps'][number]>) => {
      const step = run.steps.find((item) => item.name === name)!;
      Object.assign(step, patch);
      return step;
    },
  },
});
const runtime = await import('../sources/runtime.js');
mock.module('../sources/runtime.js', {
  namedExports: {
    ...runtime,
    withRunSources: async <T>(_run: Run, operation: () => Promise<T>) => operation(),
  },
});
mock.module('./find-slot-step.js', {
  namedExports: {
    executeFindSlotStep: async (
      runId: string,
      current: Run,
      _generation: number,
      deps: Parameters<typeof executeFindSlotStep>[3],
    ) => {
      attemptedSlots.push(current.slotId);
      if (current.slotId) {
        // Explicit placement skips the resolved decision, as the real step does.
        current.status = 'paused';
        return { outputs: { selectedSlot: current.slotId } };
      }
      const decision = current.decisions[0];
      const action = await deps.createEngineDecision(
        runId,
        decision.type.replace('engine_', ''),
        decision.description,
        decision.actions,
      );
      selectedActions.push(action);
      if (attemptedSlots.length === 1) {
        Object.assign(current, {
          slotId: 'selected-slot',
          sourcePlan: sourceTestPlan(sourceTestLock('node-1')),
        });
        await afterReplan?.();
        throw new SourcePlanRestart('Candidate inputs changed');
      }
      if (action === 'nudge') deps.setRunFlags(runId, { nudgeReuse: true, skipPrepare: true });
      current.slotId = 'selected-slot';
      current.status = 'paused';
      return { outputs: { selectedSlot: current.slotId, action } };
    },
  },
});
const { bumpRunGeneration, startRun } = await import('./orchestrator.js');

function setup(action: 'fresh' | 'resetBranch' | 'nudge') {
  selectedActions.length = 0;
  attemptedSlots.length = 0;
  afterReplan = undefined;
  const steps = FLOW_STEPS['fix-bug'];
  run = makeRun({
    id: 'source-restart-run',
    flowType: 'fix-bug',
    status: 'slot-finding',
    slotId: null,
    engineState: { generation: 0 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(PipelineSteps.FIND_SLOT) ? 'done' : 'pending',
    })),
    decisions: [
      {
        id: 'selected-decision',
        type: action === 'resetBranch' ? 'engine_no_suitable_slot' : 'engine_branch_affinity_nudge',
        title: 'Choose a slot',
        description: 'Retained operator choice',
        actions: [
          { id: action === 'resetBranch' ? 'pick' : action, label: action, style: 'primary' },
        ],
        createdAt: '2026-10-13T00:00:00Z',
        resolvedAt: '2026-10-13T00:00:01Z',
        resolvedAction: action === 'resetBranch' ? 'pick' : action,
        selectionData: { slotId: 'selected-slot', resetBranch: action === 'resetBranch' },
      },
    ],
  });
  run.sourcePlan = sourceTestPlan();
}

for (const action of ['fresh', 'resetBranch', 'nudge'] as const) {
  test(`source restart preserves resolved ${action} decision intent`, async () => {
    setup(action);
    const decision = structuredClone(run.decisions[0]);
    await startRun(run.id);
    assert.deepEqual(attemptedSlots, [null, null]);
    assert.deepEqual(selectedActions, [decision.resolvedAction, decision.resolvedAction]);
    assert.deepEqual(run.decisions, [decision]);
    assert.equal(run.sourcePlan?.lock.context.nodeId, 'node-1');
    assert.equal(run.slotId, 'selected-slot');
    if (action === 'nudge')
      assert.deepEqual(run.engineState?.flags, { nudgeReuse: true, skipPrepare: true });
  });
}

test('replay during source replanning prevents obsolete slot restoration and retry', async () => {
  setup('fresh');
  let entered!: () => void;
  let release!: () => void;
  const replanning = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  afterReplan = async () => {
    entered();
    await resumed;
  };
  const driving = startRun(run.id);
  await replanning;
  assert.equal(bumpRunGeneration(run.id), 1);
  run.slotId = 'replayed-slot';
  release();
  await driving;
  assert.deepEqual(attemptedSlots, [null]);
  assert.equal(run.slotId, 'replayed-slot');
  assert.equal(run.engineState?.generation, 1);
  assert.equal(run.status, 'slot-finding');
  assert.equal(run.steps.find((step) => step.name === PipelineSteps.FIND_SLOT)?.status, 'running');
});
