import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { FamilyObservabilityRunSummary, RunDecision } from '@farmslot/protocol';

import { collectFamilyRetrospectives } from './family-retrospectives';

function decision(overrides: Partial<RunDecision>): RunDecision {
  return {
    id: overrides.id ?? 'decision',
    type: overrides.type ?? 'retrospective',
    title: overrides.title ?? 'Retro',
    description: overrides.description ?? 'Review the completed run.',
    actions: overrides.actions ?? [],
    createdAt: overrides.createdAt ?? '2026-05-20T10:00:00.000Z',
    ...overrides,
  };
}

function run(
  runId: string,
  decisions: RunDecision[],
  updatedAt = '2026-05-20T10:00:00.000Z',
): FamilyObservabilityRunSummary {
  return {
    runId,
    familyId: 'family-1',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'done',
    project: 'farmslot',
    ticketOrPr: `TASK-${runId}`,
    branch: null,
    prNumber: null,
    summary: null,
    createdAt: '2026-05-20T09:00:00.000Z',
    updatedAt,
    slotId: 'runner-local-fs-1',
    workerReport: null,
    workerLearnings: null,
    recipeJson: null,
    recipeQualityArtifact: null,
    recipeQuality: { semantic: 'unknown', source: 'missing', reasoning: '' },
    diffStat: { available: false, files: 0, additions: 0, deletions: 0 },
    artifacts: [],
    learnings: [],
    steps: [],
    acceptanceCriteria: [],
    ciChecks: [],
    selfReview: { verdict: null, summary: null, issues: [] },
    familyScope: null,
    decisions,
    missingData: [],
  };
}

test('collectFamilyRetrospectives returns pending retros before resolved retros', () => {
  const entries = collectFamilyRetrospectives([
    run('resolved', [
      decision({
        id: 'resolved-retro',
        resolvedAt: '2026-05-20T12:00:00.000Z',
      }),
    ]),
    run('pending-old', [decision({ id: 'pending-old', createdAt: '2026-05-20T10:00:00.000Z' })]),
    run('pending-new', [decision({ id: 'pending-new', createdAt: '2026-05-20T11:00:00.000Z' })]),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.decision.id),
    ['pending-new', 'pending-old', 'resolved-retro'],
  );
});

test('collectFamilyRetrospectives ignores non-retrospective decisions', () => {
  const entries = collectFamilyRetrospectives([
    run('mixed', [
      decision({ id: 'review-gate', type: 'review_comments' }),
      decision({ id: 'retro' }),
    ]),
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.decision.id),
    ['retro'],
  );
});
