import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  buildComparisonRunParams,
  comparisonBranchHint,
  comparisonVariantInputBlocked,
  resolveComparisonDispatchBranch,
  deriveComparisonVariantState,
  exitedComparisonModeState,
  forkComparisonStateFromRun,
  resolveComparisonVariant,
} from './dispatch-wizard-comparison-state.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? 'claude-opus',
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'autonomous',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'mobile',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      runner: 'claude',
      model: 'opus',
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt: overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-04T10:00:00.000Z',
    ...overrides,
  } as Run;
}

test('comparison helpers exit and fork same-family state', () => {
  assert.deepEqual(exitedComparisonModeState(), {
    comparisonLane: false,
    comparisonFamilyId: '',
    comparisonParentRunId: '',
    comparisonVariant: '',
    variantCollision: false,
    variantInput: '',
  });
  assert.deepEqual(
    forkComparisonStateFromRun(
      makeRun({ id: 'parent', familyId: 'family-a' }),
      { runner: 'codex', model: 'gpt-5' },
      new Set(['claude']),
    ),
    {
      comparisonLane: true,
      comparisonFamilyId: 'family-a',
      comparisonParentRunId: 'parent',
      comparisonVariant: '',
      runner: 'claude',
      model: 'opus',
    },
  );
});

test('comparison variant helpers suggest collision suffixes and preserve custom tags', () => {
  const runs = [
    makeRun({ variant: 'claude-opus' }),
    makeRun({ id: 'run-2', variant: 'candidate' }),
  ];
  assert.deepEqual(
    deriveComparisonVariantState({
      comparisonLane: true,
      comparisonFamilyId: 'family-1',
      runs,
      runner: 'claude',
      model: 'opus',
      variantInput: '',
    }),
    { variantCollision: true, variantInput: 'claude-opus-v2' },
  );
  assert.equal(
    comparisonVariantInputBlocked({
      comparisonLane: true,
      comparisonFamilyId: 'family-1',
      runs,
      variantInput: 'candidate',
      variantCollision: true,
    }),
    true,
  );
  assert.equal(resolveComparisonVariant(' custom ', 'claude', 'opus'), 'custom');
});

test('comparison dispatch branch is omitted so gateway can auto-derive per variant', () => {
  assert.equal(
    resolveComparisonDispatchBranch({
      comparisonLane: true,
      variant: 'codex',
      branch: 'feat/shared-production-branch',
    }),
    undefined,
  );
  assert.equal(
    resolveComparisonDispatchBranch({
      comparisonLane: false,
      variant: 'codex',
      branch: 'feat/shared-production-branch',
    }),
    'feat/shared-production-branch',
  );
  assert.equal(
    comparisonBranchHint({
      comparisonLane: true,
      variant: 'codex',
      flowType: 'dev',
      ticketOrPr: 'PROJ-1',
      derivedBranch: 'feat/proj-1-codex',
    }),
    'Branch auto-derived: feat/proj-1-codex',
  );
});

test('comparison run params omit lane when inactive', () => {
  assert.deepEqual(
    buildComparisonRunParams({
      comparisonLane: false,
      comparisonFamilyId: 'family',
      comparisonParentRunId: 'parent',
      variant: 'candidate',
    }),
    {},
  );
  assert.deepEqual(
    buildComparisonRunParams({
      comparisonLane: true,
      comparisonFamilyId: 'family',
      comparisonParentRunId: 'parent',
      variant: 'candidate',
    }),
    { lane: 'comparison', familyId: 'family', variant: 'candidate', parentRunId: 'parent' },
  );
});
