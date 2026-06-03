import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyObservabilityRunSummary,
  RetrospectivePayload,
  RunDecision,
} from '@farmslot/protocol';

import {
  pendingRetrospectiveDecision,
  retrospectiveCiWatchLabel,
  retrospectiveCommentsSummary,
  retrospectivePayload,
} from './family-observability-retrospective-model.js';

function decision(overrides: Partial<RunDecision> = {}): RunDecision {
  return {
    id: 'decision-1',
    type: 'retrospective',
    title: 'Review run',
    description: 'Review run output',
    createdAt: '2026-05-01T00:00:00.000Z',
    actions: [{ id: 'accept', label: 'Accept' }],
    ...overrides,
  } as RunDecision;
}

function run(decisions: RunDecision[] = []): Pick<FamilyObservabilityRunSummary, 'decisions'> {
  return { decisions } as Pick<FamilyObservabilityRunSummary, 'decisions'>;
}

test('pendingRetrospectiveDecision returns the first unresolved retrospective decision', () => {
  const resolved = decision({ id: 'resolved', resolvedAt: '2026-05-01T01:00:00.000Z' });
  const other = decision({ id: 'other', type: 'engine_other' });
  const pending = decision({ id: 'pending' });

  assert.equal(pendingRetrospectiveDecision(run([resolved, other, pending]))?.id, 'pending');
  assert.equal(pendingRetrospectiveDecision(run([resolved, other])), null);
});

test('retrospectivePayload only accepts canonical retrospective payloads', () => {
  const payload: RetrospectivePayload = {
    kind: 'retrospective',
    outcome: 'success',
    whatThisIs: 'Review this run',
    actionEffects: [],
  };

  assert.equal(retrospectivePayload(decision({ payload })), payload);
  assert.equal(
    retrospectivePayload(
      decision({
        payload: { kind: 'collision', ticketSlug: 'ticket', existingDirs: [], priorRunIds: [] },
      }),
    ),
    undefined,
  );
  assert.equal(retrospectivePayload(null), undefined);
});

test('retrospective labels preserve existing fallback text', () => {
  const payload: RetrospectivePayload = {
    kind: 'retrospective',
    outcome: 'success',
    whatThisIs: 'Review this run',
    actionEffects: [],
    ciWatch: { result: 'passed', passed: 3, total: 4 },
    commentsTriageSummary: {
      total: 5,
      real: 2,
      falsePositive: 1,
      outOfScope: 1,
      fixed: 1,
      actionablePaths: ['a.ts', 'b.ts'],
    },
  };

  assert.equal(retrospectiveCiWatchLabel(payload), 'passed · 3/4');
  assert.equal(
    retrospectiveCommentsSummary(payload),
    '5 total · 2 REAL · 1 fixed · paths: a.ts, b.ts',
  );
  assert.equal(
    retrospectiveCiWatchLabel({
      kind: 'retrospective',
      outcome: 'success',
      whatThisIs: 'Review this run',
      actionEffects: [],
    }),
    null,
  );
});
