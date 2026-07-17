import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildObservabilityDegradedIntelligenceAction,
  buildObservabilityDegradedRecovery,
  isObservabilityDegraded,
  OBSERVABILITY_DEGRADED_ATTENTION_REASON,
} from './observability-degraded.js';
import type { ObservabilityReading, RunnerActivity } from './observability-types.js';

function activityReading(
  value: RunnerActivity,
  confidence: ObservabilityReading<RunnerActivity>['confidence'] = 'high',
): ObservabilityReading<RunnerActivity> {
  return { value, source: 'hook', confidence, observedAt: 1_000 };
}

test('isObservabilityDegraded flags null, low confidence, and unknown', () => {
  assert.equal(isObservabilityDegraded(null), true);
  assert.equal(isObservabilityDegraded(undefined), true);
  assert.equal(isObservabilityDegraded(activityReading('idle', 'low')), true);
  assert.equal(isObservabilityDegraded(activityReading('unknown')), true);
});

test('isObservabilityDegraded accepts authoritative non-unknown readings', () => {
  assert.equal(isObservabilityDegraded(activityReading('idle')), false);
  assert.equal(isObservabilityDegraded(activityReading('composing')), false);
  assert.equal(isObservabilityDegraded(activityReading('tool-running', 'medium')), false);
});

test('buildObservabilityDegradedRecovery emits a deterministic hold-send action', () => {
  const recovery = buildObservabilityDegradedRecovery({
    slotId: 'macwork-ff-3',
    runner: 'claude',
    target: 'ff-3:dev',
    now: 42,
  });
  assert.equal(recovery.kind, 'observability-degraded');
  assert.equal(recovery.tier, 'deterministic');
  assert.equal(recovery.action, 'hold-send');
  assert.equal(recovery.slotId, 'macwork-ff-3');
  assert.equal(recovery.runner, 'claude');
  assert.equal(recovery.target, 'ff-3:dev');
  assert.equal(recovery.attentionReason, OBSERVABILITY_DEGRADED_ATTENTION_REASON);
  assert.equal(recovery.attentionReason, 'observability-degraded');
  assert.equal(recovery.timestamp, 42);
  assert.match(recovery.reason, /hold/i);
});

test('buildObservabilityDegradedIntelligenceAction is a deterministic-tier ADR-031 record', () => {
  const action = buildObservabilityDegradedIntelligenceAction({
    runId: 'run-abc',
    now: 1_000,
    runner: 'claude',
    target: 'ff-3:dev',
    reason: 'hooks lapsed under pane-retired flag',
  });
  assert.equal(action.runId, 'run-abc');
  assert.equal(action.tier, 'deterministic');
  assert.equal(action.outcome, 'applied');
  assert.equal(action.actor, 'auto-nudge');
  assert.equal(action.verdict.patternId, 'observability-degraded-hold');
  assert.equal(action.costUsd, 0);
  assert.match(action.id, /^obs-degraded-run-abc-1000$/);
});
