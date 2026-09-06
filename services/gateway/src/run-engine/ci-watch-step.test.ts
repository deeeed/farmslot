import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, SlotReleaseParams } from '@farmslot/protocol';

import { createRun, deleteRun, updateRun } from '../runs/store.js';

import { type CIWatchStepContext, executeCIWatchStep } from './ci-watch-step.js';
import {
  ciRequiresPublishedPr,
  requiresPublicationApproval,
  shouldPrepareLocalFirstPackage,
} from './publication-policy.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    parentRunId: null,
    familyRootTicketOrPr: 'PROJ-1',
    lane: 'production',
    variant: null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: 'ci-watching',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-1',
    slotId: 'slot-1',
    branch: 'fix/proj-1',
    completionPolicy: overrides.completionPolicy,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
      ...overrides.metrics,
    },
    createdAt: '2026-05-15T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z',
    ...overrides,
  };
}

test('local-first publication adapters share one eligibility contract', () => {
  const representativeRuns = [
    makeRun({ flowType: 'dev', mode: 'autonomous' }),
    makeRun({ flowType: 'fix-bug' }),
    makeRun({ flowType: 'dev', mode: 'interactive' }),
    makeRun({ flowType: 'dev', mode: 'autonomous', completionPolicy: 'artifact-only' }),
    makeRun({
      flowType: 'fix-bug',
      metrics: {
        nudgeCount: 0,
        model: null,
        runner: null,
        runnerSessionId: null,
        runnerSessionPath: null,
        disposition: 'already_fixed',
      },
    }),
  ];
  for (const run of representativeRuns) {
    assert.equal(requiresPublicationApproval(run), shouldPrepareLocalFirstPackage(run));
    assert.equal(ciRequiresPublishedPr(run), shouldPrepareLocalFirstPackage(run));
  }
});

test('ciRequiresPublishedPr gates unpublished local-first dev and fix-bug runs', () => {
  assert.equal(ciRequiresPublishedPr(makeRun({ flowType: 'dev', mode: 'autonomous' })), true);
  assert.equal(ciRequiresPublishedPr(makeRun({ flowType: 'fix-bug' })), true);
  assert.equal(ciRequiresPublishedPr(makeRun({ flowType: 'dev', mode: 'interactive' })), false);
  assert.equal(
    ciRequiresPublishedPr(
      makeRun({ flowType: 'dev', mode: 'autonomous', completionPolicy: 'artifact-only' }),
    ),
    false,
  );
});

function ciWatchContext(
  overrides: Partial<CIWatchStepContext> = {},
): CIWatchStepContext & { deferred: SlotReleaseParams[] } {
  const deferred: SlotReleaseParams[] = [];
  return {
    deferred,
    activeMonitors: new Map(),
    applyChainedRunEngineFlags: () => {},
    broadcastFn: () => {},
    buildCIWatchChainedRunParams: () => null,
    hasValidPrNumber: () => false,
    loadProjectVarsOrNull: async () => null,
    resolveCIWatchTerminalPatch: () => null,
    startRun: async () => {},
    deferTerminalSlotRelease: (params) => void deferred.push(params),
    ...overrides,
  };
}

test('ci-watch hands its slot release to the engine instead of running it', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    mode: 'interactive',
    project: 'example-mobile-farm',
    ticketOrPr: 'MANUAL-000117',
    runner: 'claude',
    slotId: 'slot-defer-1',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'cancelled' });
    await deleteRun(run.id);
  });
  // A no-code disposition takes the first skip path, which used to run
  // `slotRelease` inline — gating the run's own `done` status on tmux teardown.
  updateRun(run.id, {
    status: 'ci-watching',
    metrics: { ...run.metrics, disposition: 'already_fixed' },
  });

  const context = ciWatchContext();
  const io = await executeCIWatchStep(run.id, context);

  assert.equal(io.outputs?.skipped, true);
  assert.equal(io.outputs?.reason, 'no-code-terminal-disposition');
  assert.deepEqual(context.deferred, [
    {
      slotId: 'slot-defer-1',
      keepWork: true,
      keepWarm: true,
      detachRuns: false,
      expectedRunId: run.id,
    },
  ]);
});
