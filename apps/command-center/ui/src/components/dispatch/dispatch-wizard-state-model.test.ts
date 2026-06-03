import assert from 'node:assert/strict';
import test from 'node:test';

import type { DispatchCandidatesResult, Run, SlotStatus } from '@farmslot/protocol';

import {
  deriveCandidateResultState,
  deriveDispatchFleetViewState,
  deriveIssueTypeFlowState,
  dispatchScoringKey,
  findActiveRunConflict,
} from './dispatch-wizard-state-model.js';

const candidates: DispatchCandidatesResult['candidates'] = [
  {
    slotId: 'busy-nudge',
    score: 90,
    cdpLive: true,
    branch: 'fix/pr-1',
    lifecycle: 'busy',
    onMain: false,
    free: false,
    nudgeEligible: true,
    nudgeMeta: {
      uncommittedCount: 0,
      uncommittedFiles: [],
      nudgeCount: 0,
      ctxPct: null,
      prMatchKind: 'pr-number',
      riskFlags: [],
      canNudge: true,
    },
  },
  {
    slotId: 'free-slot',
    score: 40,
    cdpLive: true,
    branch: 'main',
    lifecycle: 'idle',
    onMain: true,
    free: true,
  },
];

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'autonomous',
    status: overrides.status ?? 'running',
    project: overrides.project ?? 'example-mobile',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt: overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-04T10:00:00.000Z',
    ...overrides,
  } as Run;
}

function makeSlot(slot: string, overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot,
    machine: 'mini',
    platform: 'darwin',
    project: 'mobile',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: 'OK' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: true,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

test('deriveCandidateResultState prunes stale nudge intents and keeps valid override when scoring key is stable', () => {
  const lastFetchScoringKey = dispatchScoringKey({
    flowType: 'review-pr',
    normalizedTicket: 'example-org/example-mobile#1',
    ticketId: '1',
    comparisonLane: false,
    comparisonFamilyId: '',
  });
  const result = deriveCandidateResultState({
    candidates,
    previousOverride: 'free-slot',
    nudgeIntents: new Map([
      ['busy-nudge', 'nudge'],
      ['stale-slot', 'fresh'],
    ]),
    flowType: 'review-pr',
    normalizedTicket: 'example-org/example-mobile#1',
    ticketId: '1',
    comparisonLane: false,
    comparisonFamilyId: '',
    lastFetchScoringKey,
  });

  assert.equal(result.slotOverride, 'free-slot');
  assert.equal(result.nudgeIntents.get('busy-nudge'), 'nudge');
  assert.equal(result.nudgeIntents.has('stale-slot'), false);
  assert.equal(result.nudgeIntentsChanged, true);
  assert.equal(result.scoringKey, lastFetchScoringKey);
});

test('deriveCandidateResultState resets selected slot when scoring context changes', () => {
  const result = deriveCandidateResultState({
    candidates,
    previousOverride: 'free-slot',
    nudgeIntents: new Map(),
    flowType: 'pr-complete',
    normalizedTicket: 'example-org/example-mobile#1',
    ticketId: '1',
    comparisonLane: true,
    comparisonFamilyId: 'family-1',
    lastFetchScoringKey: 'review-pr|example-org/example-mobile#1|',
  });

  assert.equal(result.slotOverride, 'busy-nudge');
  assert.equal(result.scoringKey, 'pr-complete|example-org/example-mobile#1|lane:family-1');
});

test('findActiveRunConflict matches raw or normalized ticket and ignores terminal runs', () => {
  const runs = [
    makeRun({ id: 'done', status: 'done', ticketOrPr: 'PROJ-1' }),
    makeRun({ id: 'active', status: 'monitoring', ticketOrPr: 'example-org/example-mobile#1' }),
  ];

  assert.deepEqual(
    findActiveRunConflict(runs, {
      ticket: '1',
      normalizedTicket: 'example-org/example-mobile#1',
      project: 'example-mobile',
    }),
    { id: 'active', status: 'monitoring' },
  );
  assert.equal(
    findActiveRunConflict(runs, {
      ticket: '1',
      normalizedTicket: 'example-org/example-mobile#1',
      project: 'other-project',
    }),
    null,
  );
});

test('deriveDispatchFleetViewState filters fleet and preserves project selection rules', () => {
  const slots = [
    makeSlot('mobile-mini', { machine: 'mini', project: 'mobile' }),
    makeSlot('extension-mini', { machine: 'mini', project: 'extension' }),
    makeSlot('mobile-mac', { machine: 'macwork', project: 'mobile' }),
  ];

  const filtered = deriveDispatchFleetViewState({
    slots,
    currentProject: '',
    globalProjectFilters: ['mobile'],
    globalMachineFilters: ['mini'],
  });
  assert.deepEqual(
    filtered.slots.map((slot) => slot.slot),
    ['mobile-mini'],
  );
  assert.deepEqual(filtered.availableProjects, ['mobile']);
  assert.equal(filtered.project, 'mobile');
  assert.equal(filtered.projectAutoSelected, true);
  assert.equal(filtered.projectCleared, false);
  assert.deepEqual(
    filtered.allProjectSlots.map((slot) => slot.slot),
    ['mobile-mini'],
  );
  assert.equal(filtered.machineFilterSignature, 'mini');

  const cleared = deriveDispatchFleetViewState({
    slots,
    currentProject: 'missing-project',
    globalProjectFilters: [],
    globalMachineFilters: [],
  });
  assert.equal(cleared.project, '');
  assert.equal(cleared.projectCleared, true);
  assert.deepEqual(cleared.availableProjects, ['extension', 'mobile']);
  assert.deepEqual(
    cleared.allProjectSlots.map((slot) => slot.slot),
    ['mobile-mini', 'extension-mini', 'mobile-mac'],
  );

  const preserved = deriveDispatchFleetViewState({
    slots,
    currentProject: 'mobile',
    globalProjectFilters: [],
    globalMachineFilters: ['macwork', 'mini'],
  });
  assert.equal(preserved.project, 'mobile');
  assert.equal(preserved.projectAutoSelected, false);
  assert.deepEqual(
    preserved.allProjectSlots.map((slot) => slot.slot),
    ['mobile-mini', 'mobile-mac'],
  );
  assert.equal(preserved.machineFilterSignature, 'macwork,mini');
});

test('deriveIssueTypeFlowState only auto-selects flow while auto mode is allowed', () => {
  assert.deepEqual(deriveIssueTypeFlowState('Bug', null, false), {
    flowType: 'fix-bug',
    autoFlowType: true,
    mode: 'autonomous',
  });
  assert.deepEqual(deriveIssueTypeFlowState('Story', 'fix-bug', true), {
    flowType: 'dev',
    autoFlowType: true,
    mode: 'interactive',
  });
  assert.equal(deriveIssueTypeFlowState('Task', 'review-pr', false), null);
  assert.equal(deriveIssueTypeFlowState('Epic', null, false), null);
});
