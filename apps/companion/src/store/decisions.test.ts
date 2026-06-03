import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

import { useDecisionStore } from './decisions';

function decision(overrides: Partial<PendingDecision>): PendingDecision {
  return {
    id: 'decision-1',
    type: 'review_posting',
    slotId: 'runner-mobile-1',
    title: 'Needs review',
    description: 'Review the workspace.',
    context: {},
    actions: [{ id: 'approve', label: 'Approve' }],
    createdAt: '2026-05-21T00:00:00.000Z',
    ...overrides,
  } as PendingDecision;
}

test('decision store upserts existing decision updates', () => {
  useDecisionStore.setState({ decisions: [] });
  useDecisionStore.getState().setDecisions([decision({ title: 'Old title' })]);

  useDecisionStore.getState().upsertDecision(decision({ title: 'Updated title' }));

  assert.deepEqual(
    useDecisionStore.getState().decisions.map((item) => item.title),
    ['Updated title'],
  );
});

test('decision store upsert appends missing decision updates', () => {
  useDecisionStore.setState({ decisions: [] });

  useDecisionStore.getState().upsertDecision(decision({ id: 'decision-2' }));

  assert.deepEqual(
    useDecisionStore.getState().decisions.map((item) => item.id),
    ['decision-2'],
  );
});
