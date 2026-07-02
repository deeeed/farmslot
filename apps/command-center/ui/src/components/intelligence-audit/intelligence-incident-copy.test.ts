import assert from 'node:assert/strict';
import test from 'node:test';

import type { IntelligenceAction } from '@farmslot/protocol';

import { actionToHuman, categoryToTrigger } from './intelligence-incident-copy.js';

function record(overrides: Partial<IntelligenceAction>): IntelligenceAction {
  return {
    id: 'audit-1',
    timestamp: '2026-07-02T12:34:34.002Z',
    decidedAt: '2026-07-02T12:34:34.003Z',
    runId: 'run-1',
    familyId: 'run-1',
    project: 'metamask-core-farm',
    stepName: 'grade',
    actor: 'auto-nudge',
    verdict: { confidence: 'medium', category: 'timeout', patternId: 'worker-idle' },
    guards: [],
    outcome: 'skipped',
    outcomeReason: 'non_recoverable_category',
    tier: 'deterministic',
    costUsd: 0,
    appliedAction: { type: 'tmux.send' },
    ...overrides,
  };
}

test('categoryToTrigger describes worker-idle monitor signals without step timeout wording', () => {
  assert.match(categoryToTrigger(record({})), /idle worker/i);
  assert.doesNotMatch(categoryToTrigger(record({})), /step timed out/i);
});

test('actionToHuman does not claim tmux keys were sent when outcome is skipped', () => {
  assert.match(actionToHuman(record({})), /not applied/i);
  assert.doesNotMatch(actionToHuman(record({})), /^Sent /);
});

test('actionToHuman uses Sent wording only for applied tmux nudges', () => {
  assert.match(actionToHuman(record({ outcome: 'applied' })), /^Sent keys to tmux pane$/);
});
