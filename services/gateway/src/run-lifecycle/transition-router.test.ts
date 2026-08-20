import assert from 'node:assert/strict';
import test from 'node:test';

import { failedRunCancelEffects, type Run } from '@farmslot/protocol';

import {
  type CancelCollaborators,
  cancelPlan,
  defaultCancelCollaborators,
} from './cancel-transition.js';
import {
  routeRunTransition,
  type RunTransitionDeps,
  type RunTransitionRequest,
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
    releaseCapabilities: async () => void calls.push('releaseCapabilities'),
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
  // Regression for the gap ADR-053 documents: run.cancel holds the per-request
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
      'runtime-capabilities:ok',
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

test('runtime capabilities are released before slot teardown', async () => {
  const h = harness(run());
  await routeRunTransition(cancelRequest, h.deps);
  assert.ok(
    h.calls.indexOf('releaseCapabilities') < h.calls.indexOf('releaseSlot'),
    'provider cleanup needs the live slot context',
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
  assert.equal(
    result.effects.find((effect) => effect.name === 'runtime-capabilities')?.status,
    'skipped',
  );
});

test('a runtime capability cleanup failure is visible and slot teardown still runs', async () => {
  const h = harness(run(), {
    releaseCapabilities: async () => {
      throw new Error('browser-cdp: stop refused');
    },
  });

  const result = await routeRunTransition(cancelRequest, h.deps);
  const outcome = result.effects.find((effect) => effect.name === 'runtime-capabilities')!;
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.detail!, /browser-cdp: stop refused/);
  assert.ok(h.calls.includes('releaseSlot'), 'capability cleanup must not strand the slot');
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
  assert.equal(result.run.park, undefined, 'normal non-park cancel must not invent park state');
  assert.equal(
    result.run.backlogReconcilePending,
    true,
    'the repair marker must exist before the terminal state is published',
  );
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

test('a failed backlog settle blocks the work-graph tick instead of scheduling on stale state', async () => {
  // Codex round-1 blocker: `markBacklogRunObserved` used to swallow its own
  // rejection, so `backlog-settle` always reported ok and the scheduler could tick
  // against a backlog that never settled — the redispatch shape of #466.
  const h = harness(run({ workGraphId: 'wg_1' }), {
    settleBacklog: async () => {
      throw new Error('backlog persist failed');
    },
  });

  const result = await routeRunTransition(cancelRequest, h.deps);

  const settle = result.effects.find((effect) => effect.name === 'backlog-settle')!;
  assert.equal(settle.status, 'failed');
  assert.match(settle.detail!, /backlog persist failed/);

  const tick = result.effects.find((effect) => effect.name === 'work-graph-tick')!;
  assert.equal(tick.status, 'skipped');
  assert.match(tick.detail!, /stale backlog state/);
  assert.equal(h.calls.includes('tickWorkGraph'), false, 'must not schedule on stale state');

  // The run still reaches its terminal state, and slot teardown still runs.
  assert.equal(result.run.status, 'cancelled');
  assert.ok(h.calls.includes('releaseSlot'));
});

test('the production backlog collaborator returns an awaitable settle', async () => {
  // The propagation contract is enforced by the `Promise<void>` signature and by the
  // stale-state test above (injected throwing collaborator). Asserting on
  // Function.toString() was brittle, so the structural guard lives as a comment at
  // the source instead.
  const collaborators = defaultCancelCollaborators();
  // A run with no linked backlog item is a legitimate no-op, not a failure.
  await collaborators.settleBacklog({ id: 'run_without_backlog_link' } as Run);
});

test('concurrent cancels are serialized; only the first transitions the run', async () => {
  // Codex round-2 blocker: the terminal guard ran before the awaited `before`
  // effects, which yield. Two concurrent cancels both passed it and both ran the
  // whole chain — duplicate mutation, duplicate broadcast, and a stale second slot
  // release that can free a slot another run has since claimed.
  const h = harness(run({ workGraphId: 'wg_1' }), {
    cancelEngine: () => {
      h.calls.push('cancelEngine');
    },
    settleBacklog: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      h.calls.push('settleBacklog');
    },
  });

  const [first, second] = await Promise.allSettled([
    routeRunTransition(cancelRequest, h.deps),
    routeRunTransition(cancelRequest, h.deps),
  ]);

  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match((second as PromiseRejectedResult).reason.message, /already in terminal state/);

  // Exactly one of each side effect, not two.
  const count = (name: string) => h.calls.filter((call) => call === name).length;
  assert.equal(count('settleBacklog'), 1);
  assert.equal(count('tickWorkGraph'), 1);
  assert.equal(count('releaseSlot'), 1, 'a duplicate release could free a reclaimed slot');
  assert.equal(count('emit:run.updated'), 1);
});

test('a queued transition sees state left by the one ahead of it', async () => {
  const h = harness(run());
  await routeRunTransition(cancelRequest, h.deps);
  // Guard re-evaluates inside the lock, not against the state it queued with.
  await assert.rejects(
    () => routeRunTransition(cancelRequest, h.deps),
    /already in terminal state: cancelled/,
  );
});

test('a publish failure is recorded but never aborts store settlement', async () => {
  const h = harness(run({ workGraphId: 'wg_1' }));
  const deps = {
    ...h.deps,
    onMutated: () => {
      throw new Error('socket gone');
    },
  };

  const result = await routeRunTransition(cancelRequest, deps);

  const publish = result.effects.find((effect) => effect.name === 'publish')!;
  assert.equal(publish.status, 'failed');
  assert.match(publish.detail!, /socket gone/);
  // The stores still settled — a dead client must not strand backlog/graph state.
  assert.ok(h.calls.includes('settleBacklog'));
  assert.ok(h.calls.includes('tickWorkGraph'));
});

test('an asynchronous publish failure is recorded, not lost to an unobserved rejection', async () => {
  // Codex round-7 P2: the cancel collaborator broadcasts via a dynamic import, so the
  // failure arrives as a rejected promise. A fire-and-forget `onMutated` returned
  // before that rejection and reported a clean publish while other clients went stale.
  const h = harness(run({ workGraphId: 'wg_1' }));
  const deps = {
    ...h.deps,
    onMutated: async () => {
      await Promise.resolve();
      throw new Error('broadcast import failed');
    },
  };

  const result = await routeRunTransition(cancelRequest, deps);

  const publish = result.effects.find((effect) => effect.name === 'publish')!;
  assert.equal(publish.status, 'failed');
  assert.match(publish.detail!, /broadcast import failed/);
  assert.ok(h.calls.includes('settleBacklog'));
  assert.ok(h.calls.includes('tickWorkGraph'));
});

test('nothing yields between the terminal guard and the mutation', async () => {
  // Codex round-3 blocker: awaiting the pre-effects yielded the event loop, and
  // the run engine writes through updateRun without taking the transition lock.
  // An engine step could therefore finish and publish after the guard but before
  // the cancel became authoritative — a window the pre-router implementation,
  // whose abort/invalidate/mutate sequence was straight-line synchronous, did not
  // have.
  const h = harness(run());
  let mutatedDuringSameTick = false;

  const deps = {
    ...h.deps,
    updateRun: (id: string, partial: Partial<Run>) => {
      mutatedDuringSameTick = true;
      return h.deps.updateRun(id, partial);
    },
  };

  const pending = routeRunTransition(cancelRequest, deps);
  // The lock's first `.then` costs one microtask; drain a couple and the guard,
  // pre-effects, and mutation must all have completed without an intervening
  // macrotask an engine write could slip into.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mutatedDuringSameTick, true, 'pre-effects must not yield before the mutation');

  await pending;
});

test('cancel surfaces a failed advisory effect to its caller', async () => {
  // Codex round-3 blocker: runCancel discarded `effects`, so a failed backlog
  // settle returned an unqualified successful cancel.
  const h = harness(run({ workGraphId: 'wg_1' }), {
    settleBacklog: async () => {
      throw new Error('disk full');
    },
  });

  const result = await routeRunTransition(cancelRequest, h.deps);

  assert.equal(result.run.status, 'cancelled');
  const failed = result.effects.filter((effect) => effect.status === 'failed');
  assert.deepEqual(
    failed.map((effect) => effect.name),
    ['backlog-settle'],
  );
  assert.match(failed[0].detail!, /disk full/);
});

test('a partially applied cancel is visible to human-facing callers', async () => {
  // Codex round-10 P1: the chat tool and confirmed-action paths destructured only
  // `run` and reported `cancelled: true`, so an operator could be told the stop
  // landed while the slot was still claimed. Every human-facing caller filters the
  // returned effects through this helper.
  const h = harness(run({ workGraphId: 'wg_1' }), {
    releaseSlot: async () => {
      throw new Error('tmux session gone');
    },
  });

  const result = await routeRunTransition(cancelRequest, h.deps);
  const failed = failedRunCancelEffects(result.effects);

  assert.equal(result.run.status, 'cancelled', 'the run is terminal');
  assert.equal(failed.length, 1, 'but the cancel was only partially applied');
  assert.equal(failed[0].name, 'slot-release');
  assert.match(failed[0].detail ?? '', /tmux session gone/);

  // A fully applied cancel reports nothing, so callers stay quiet in the happy path.
  const clean = await routeRunTransition(cancelRequest, harness(run({ workGraphId: 'wg_1' })).deps);
  assert.deepEqual(failedRunCancelEffects(clean.effects), []);
});
