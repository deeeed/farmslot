import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  routeTerminalRunTransition,
  type TerminalTransitionCollaborators,
  terminalTransitionDeps,
  type TerminalTransitionKind,
  type TerminalTransitionRequest,
} from './terminal-transition.js';
import { routeRunTransition, type RunTransitionResult } from './transition-router.js';

const NOW = '2026-09-05T10:00:00.000Z';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    familyId: 'fam_1',
    lane: 'production',
    flowType: 'dev',
    status: 'monitoring',
    project: 'farmslot-farm',
    ticketOrPr: 'MANUAL-000117',
    slotId: 'macwork-ff-3',
    branch: null,
    taskFile: null,
    steps: [] as Run['steps'],
    decisions: [],
    metrics: {} as Run['metrics'],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Run;
}

interface Harness {
  result: Promise<RunTransitionResult>;
  /** Ordered log: what happened, and the run status visible at that moment. */
  log: string[];
  stored: () => Run;
}

function drive(
  seed: Run,
  request: Omit<TerminalTransitionRequest, 'collaborators'>,
  overrides: Partial<TerminalTransitionCollaborators> = {},
): Harness {
  const log: string[] = [];
  let stored = seed;
  const collaborators: TerminalTransitionCollaborators = {
    settleBacklog: async () => void log.push('settleBacklog'),
    tickWorkGraph: async () => void log.push('tickWorkGraph'),
    cleanupEvalHarness: async () => void log.push('cleanupEvalHarness'),
    cleanupSlot: async (current) => void log.push(`cleanupSlot:${current.status}`),
    emit: (current) => void log.push(`publish:${current.status}`),
    ...overrides,
  };
  const full: TerminalTransitionRequest = { ...request, collaborators };
  const deps = {
    ...terminalTransitionDeps(full),
    getRun: () => stored,
    updateRun: (_id: string, patch: Partial<Run>) => {
      stored = { ...stored, ...patch };
      return stored;
    },
  };
  return {
    log,
    stored: () => stored,
    result: routeRunTransition({ kind: full.kind, runId: full.runId, actor: full.actor }, deps),
  };
}

const TERMINAL_PATCHES: Record<TerminalTransitionKind, Partial<Run>> = {
  complete: { status: 'done', completedAt: NOW },
  fail: { status: 'failed', completedAt: NOW, error: 'step blew up' },
  block: { status: 'blocked', completedAt: NOW, error: 'worker asked for help' },
};

for (const kind of ['complete', 'fail', 'block'] as const) {
  test(`${kind} publishes the terminal status before any slot teardown starts`, async () => {
    const harness = drive(run({ workGraphId: 'graph-1' }), {
      runId: 'run_1',
      kind,
      actor: 'engine',
      patch: TERMINAL_PATCHES[kind],
    });
    const result = await harness.result;

    const publishIndex = harness.log.findIndex((entry) => entry.startsWith('publish:'));
    const cleanupIndex = harness.log.findIndex((entry) => entry.startsWith('cleanupSlot:'));
    assert.ok(publishIndex >= 0 && cleanupIndex >= 0, harness.log.join(' -> '));
    // The ordering this module exists for: under the old engine the release ran
    // inside the step (or before the broadcast), so clients only saw the
    // terminal status after tmux teardown finished.
    assert.ok(
      publishIndex < cleanupIndex,
      `terminal status must publish first, got ${harness.log.join(' -> ')}`,
    );
    // And it publishes the settled status, not the pre-terminal one.
    assert.equal(harness.log[publishIndex], `publish:${TERMINAL_PATCHES[kind].status}`);
    assert.deepEqual(harness.log, [
      `publish:${TERMINAL_PATCHES[kind].status}`,
      'settleBacklog',
      'tickWorkGraph',
      'cleanupEvalHarness',
      `cleanupSlot:${TERMINAL_PATCHES[kind].status}`,
    ]);
    assert.equal(result.run.status, TERMINAL_PATCHES[kind].status);
  });
}

test('a failing slot teardown leaves the run terminal and records an advisory failure', async () => {
  const harness = drive(
    run(),
    { runId: 'run_1', kind: 'fail', actor: 'engine', patch: TERMINAL_PATCHES.fail },
    {
      cleanupSlot: async () => {
        throw new Error('tmux kill refused');
      },
    },
  );
  const result = await harness.result;

  assert.equal(result.run.status, 'failed');
  const outcome = result.effects.find((effect) => effect.name === 'slot-cleanup');
  assert.equal(outcome?.status, 'failed');
  assert.equal(outcome?.detail, 'tmux kill refused');
});

test('a gate park that already freed the slot keeps the teardown off it', async () => {
  const harness = drive(
    run({
      park: {
        machine: 'macwork',
        mode: 'release',
        phase: 'parked',
        slotDisposition: 'freed',
        slotFreedAt: NOW,
      } as Run['park'],
    }),
    { runId: 'run_1', kind: 'complete', actor: 'engine', patch: TERMINAL_PATCHES.complete },
  );
  const result = await harness.result;

  assert.equal(
    harness.log.some((entry) => entry.startsWith('cleanupSlot:')),
    false,
    'the park published this slot for dispatch; teardown would hit its new occupant',
  );
  const outcome = result.effects.find((effect) => effect.name === 'slot-cleanup');
  assert.equal(outcome?.status, 'skipped');
  assert.match(outcome?.detail ?? '', /park already released slot ownership/);
});

test('a transition that owes no teardown records why, instead of releasing anyway', async () => {
  const harness = drive(
    run(),
    { runId: 'run_1', kind: 'complete', actor: 'engine', patch: TERMINAL_PATCHES.complete },
    { cleanupSlot: null },
  );
  const result = await harness.result;

  const outcome = result.effects.find((effect) => effect.name === 'slot-cleanup');
  assert.equal(outcome?.status, 'skipped');
  assert.match(outcome?.detail ?? '', /owes no slot teardown/);
});

test('the work-graph tick refuses to run against a backlog that failed to settle', async () => {
  const harness = drive(
    run({ workGraphId: 'graph-1' }),
    { runId: 'run_1', kind: 'fail', actor: 'engine', patch: TERMINAL_PATCHES.fail },
    {
      settleBacklog: async () => {
        throw new Error('backlog write failed');
      },
    },
  );
  const result = await harness.result;

  assert.equal(
    harness.log.includes('tickWorkGraph'),
    false,
    'scheduling against a backlog we know is stale is the redispatch bug this guards',
  );
  assert.equal(
    result.effects.find((effect) => effect.name === 'work-graph-tick')?.status,
    'skipped',
  );
  // The teardown still runs: a failed settle must not strand the slot.
  assert.ok(harness.log.some((entry) => entry.startsWith('cleanupSlot:')));
});

test('settling an already-terminal status is allowed only for that same status', async () => {
  const seed = run({ status: 'blocked' });
  const settled = drive(seed, {
    runId: 'run_1',
    kind: 'block',
    actor: 'engine',
    settlingStatus: 'blocked',
    patch: { completedAt: NOW },
  });
  const result = await settled.result;
  assert.equal(result.run.status, 'blocked');
  assert.ok(settled.log.some((entry) => entry.startsWith('cleanupSlot:')));

  // A cancel that won the race owns the run; the engine's late settle yields.
  const raced = drive(run({ status: 'cancelled' }), {
    runId: 'run_1',
    kind: 'block',
    actor: 'engine',
    settlingStatus: 'blocked',
    patch: { completedAt: NOW },
  });
  await assert.rejects(raced.result, /is 'cancelled', not the 'blocked'/);
  assert.deepEqual(raced.log, [], 'a refused transition must not tear anything down');
});

test('a refused transition is reported as null rather than thrown at the engine', async () => {
  // The production entry point: `startRun` calls this from inside its own catch,
  // so a guard refusal must not reject and take the engine down with it.
  const refused = await routeTerminalRunTransition({
    runId: 'run-that-does-not-exist-117',
    kind: 'fail',
    actor: 'engine',
    settlingStatus: 'failed',
    patch: {},
    collaborators: {
      settleBacklog: async () => {},
      tickWorkGraph: async () => {},
      cleanupEvalHarness: async () => {},
      cleanupSlot: null,
      emit: () => {},
    },
  }).catch((error: unknown) => error);
  // A missing run is a hard error, not a guard refusal — it must still throw.
  assert.ok(refused instanceof Error);
  assert.match((refused as Error).message, /Run not found/);
});
