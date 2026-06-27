import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

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
    project: 'farmslot',
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
