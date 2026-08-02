import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { type CancelCollaborators, cancelPlan } from './cancel-transition.js';
import {
  type RunTransitionDeps,
  type RunTransitionRequest,
  routeRunTransition,
} from './transition-router.js';

const NOW = '2026-08-02T10:00:00.000Z';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    familyId: 'fam_1',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000001',
    slotId: 'mini-ff-1',
    branch: null,
    taskFile: null,
    steps: [
      { name: 'DISPATCH', status: 'done' },
      { name: 'MONITOR', status: 'running' },
      { name: 'FINALIZE', status: 'pending' },
    ] as Run['steps'],
    decisions: [],
    metrics: {} as Run['metrics'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface Harness {
  deps: RunTransitionDeps;
  collaborators: CancelCollaborators;
  calls: string[];
  emitted: Array<{ event: string; payload: unknown }>;
  stored: Run;
}

function harness(seed: Run, overrides: Partial<CancelCollaborators> = {}): Harness {
  const calls: string[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  let stored = seed;

  const collaborators: CancelCollaborators = {
    cancelEngine: () => void calls.push('cancelEngine'),
    invalidateWarmSessions: () => void calls.push('invalidateWarmSessions'),
    settleBacklog: async () => void calls.push('settleBacklog'),
    tickWorkGraph: async () => void calls.push('tickWorkGraph'),
    releaseSlot: async () => void calls.push('releaseSlot'),
    emit: (event, payload) => {
      calls.push(`emit:${event}`);
      emitted.push({ event, payload });
    },
    ...overrides,
  };

  const deps: RunTransitionDeps = {
    getRun: () => stored,
    updateRun: (_id, partial) => {
      stored = { ...stored, ...partial } as Run;
      return stored;
    },
    planFor: (request) => cancelPlan(request, collaborators),
    onMutated: (mutated) => collaborators.emit('run.updated', { run: mutated }),
  };

  return {
    deps,
    collaborators,
    calls,
    emitted,
    get stored() {
      return stored;
    },
  } as Harness;
}

const cancelRequest: RunTransitionRequest = {
  kind: 'cancel',
  runId: 'run_1',
  actor: 'operator',
  reason: 'Cancelled by user',
};

test('operator cancel settles the backlog and ticks the work graph', async () => {
  // Regression for the gap ADR-052 documents: run.cancel holds the per-request
  // emit, so the index.ts event interceptor never saw it and neither store moved.
  const h = harness(run({ workGraphId: 'wg_1', workNodeId: 'node_1' }));

  const result = await routeRunTransition(cancelRequest, h.deps);

  assert.equal(result.run.status, 'cancelled');
  assert.deepEqual(
    result.effects.map((effect) => `${effect.name}:${effect.status}`),
    [
      'engine-cancel:ok',
      'warm-sessions:ok',
      'backlog-settle:ok',
      'work-graph-tick:ok',
      'slot-release:ok',
    ],
  );
  assert.ok(h.calls.includes('settleBacklog'), 'backlog must be settled by the transition itself');
  assert.ok(h.calls.includes('tickWorkGraph'), 'work graph must be told, not left to poll');
});

test('backlog settles before the scheduler tick reads it', async () => {
  const h = harness(run({ workGraphId: 'wg_1' }));
  await routeRunTransition(cancelRequest, h.deps);
  assert.ok(
    h.calls.indexOf('settleBacklog') < h.calls.indexOf('tickWorkGraph'),
    'the scheduler reads backlog state; ticking first would act on a pre-cancel item',
  );
});

test('slow effects are awaited in order rather than raced', async () => {
  const order: string[] = [];
  const h = harness(run({ workGraphId: 'wg_1' }), {
    settleBacklog: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('settleBacklog');
    },
    tickWorkGraph: async () => {
      order.push('tickWorkGraph');
    },
  });

  await routeRunTransition(cancelRequest, h.deps);

  // The pre-router path called markBacklogRunObserved without awaiting it and then
  // invoked schedulerTick on the next line, so this order was not guaranteed.
  assert.deepEqual(order, ['settleBacklog', 'tickWorkGraph']);
});

test('terminal state is published before slow slot teardown', async () => {
  const h = harness(run());
  await routeRunTransition(cancelRequest, h.deps);
  assert.ok(
    h.calls.indexOf('emit:run.updated') < h.calls.indexOf('releaseSlot'),
    'Command Center must reflect the cancel without waiting on tmux cleanup',
  );
});

test('a run with no work graph skips the tick instead of failing', async () => {
  const h = harness(run({ workGraphId: undefined }));
  const result = await routeRunTransition(cancelRequest, h.deps);
  assert.equal(
    result.effects.find((effect) => effect.name === 'work-graph-tick')?.status,
    'skipped',
  );
  assert.equal(h.calls.includes('tickWorkGraph'), false);
});

test('a run with no slot skips slot release', async () => {
  const h = harness(run({ slotId: null }));
  const result = await routeRunTransition(cancelRequest, h.deps);
  assert.equal(result.effects.find((effect) => effect.name === 'slot-release')?.status, 'skipped');
});

test('an advisory failure is reported, never swallowed', async () => {
  const h = harness(run({ workGraphId: 'wg_1' }), {
    releaseSlot: async () => {
      throw new Error('tmux session gone');
    },
  });

  const result = await routeRunTransition(cancelRequest, h.deps);

  // The run still reaches its terminal state — teardown failure must not strand it.
  assert.equal(result.run.status, 'cancelled');
  const outcome = result.effects.find((effect) => effect.name === 'slot-release')!;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail!, /tmux session gone/);
  // The stores still agree; only the advisory effect failed.
  assert.ok(h.calls.includes('settleBacklog'));
  assert.ok(h.calls.includes('tickWorkGraph'));
});

test('a required failure aborts before the run is mutated', async () => {
  const h = harness(run(), {
    cancelEngine: () => {
      throw new Error('engine unreachable');
    },
  });

  await assert.rejects(
    () => routeRunTransition(cancelRequest, h.deps),
    /Run transition effect 'engine-cancel' failed: engine unreachable/,
  );
  assert.equal(h.stored.status, 'monitoring', 'no half-transitioned run');
  assert.equal(h.calls.includes('settleBacklog'), false);
});

test('cancel marks in-flight steps skipped and records the operator reason', async () => {
  const h = harness(run());
  const result = await routeRunTransition(
    { ...cancelRequest, reason: 'superseded by MANUAL-000072' },
    h.deps,
  );
  assert.equal(result.run.error, 'superseded by MANUAL-000072');
  assert.deepEqual(
    result.run.steps.map((step) => step.status),
    ['done', 'skipped', 'skipped'],
  );
  assert.equal(result.run.metrics.outcome, 'cancelled');
  assert.deepEqual(result.run.agentContexts, []);
});

test('an already-terminal run is rejected without re-running effects', async () => {
  const h = harness(run({ status: 'done' }));
  await assert.rejects(
    () => routeRunTransition(cancelRequest, h.deps),
    /already in terminal state: done/,
  );
  assert.deepEqual(h.calls, []);
});

test('a missing run is rejected', async () => {
  const h = harness(run());
  const deps: RunTransitionDeps = { ...h.deps, getRun: () => undefined };
  await assert.rejects(() => routeRunTransition(cancelRequest, deps), /Run not found: run_1/);
});
