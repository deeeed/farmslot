import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPendingDegradedAgreementEntry,
  buildRunnerObservabilityAgreementEntry,
  disagreementReason,
} from './observability-agreement.js';
import { aggregateAgreementEntries } from './observability-agreement-log.js';
import type { ObservabilityReading, RunnerActivity } from './observability-types.js';

const BASE = {
  slotId: 'slot-1',
  runner: 'claude',
  target: '%1',
  logPrefix: 'test',
  timestamp: 42,
} as const;

function reading(
  value: RunnerActivity,
  confidence: ObservabilityReading<RunnerActivity>['confidence'],
): ObservabilityReading<RunnerActivity> {
  return { value, source: 'hook', confidence, observedAt: 10 };
}

test('disagreementReason classifies hook-composing vs pane-idle mismatch', () => {
  assert.equal(
    disagreementReason({ paneBusy: false, hookBusy: true, hookActivity: 'composing' }),
    'hook-composing-pane-idle',
  );
});

test('disagreementReason returns undefined when pane and hook agree', () => {
  assert.equal(
    disagreementReason({ paneBusy: true, hookBusy: true, hookActivity: 'tool-running' }),
    undefined,
  );
});

test('disagreementReason marks unavailable hook signal', () => {
  assert.equal(
    disagreementReason({ paneBusy: false, hookBusy: null, hookActivity: null }),
    'hook-unavailable',
  );
});

test('paneRetired: unknown hook reading leaves hookBusy null and flags wouldConsultPane', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: true,
    reading: reading('unknown', 'high'),
    paneRetired: true,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.wouldConsultPane, true);
  assert.equal(entry.agreed, null);
  assert.equal(entry.paneRetired, true);
  assert.equal(entry.hookActivity, 'unknown');
  assert.equal(entry.hookConfidence, 'high');
  assert.equal(entry.hookObservedAt, 10);
});

test('paneRetired: low-confidence reading is non-authoritative and flags wouldConsultPane', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: false,
    reading: reading('composing', 'low'),
    paneRetired: true,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.wouldConsultPane, true);
  // Raw activity/confidence still recorded even though the reading is non-authoritative.
  assert.equal(entry.hookActivity, 'composing');
  assert.equal(entry.hookConfidence, 'low');
});

test('paneRetired: authoritative busy reading resolves hookBusy without consulting pane', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: false,
    reading: reading('tool-running', 'high'),
    paneRetired: true,
  });
  assert.equal(entry.hookBusy, true);
  assert.equal(entry.wouldConsultPane, undefined);
  assert.equal(entry.agreed, false);
});

test('absent reading flags wouldConsultPane under paneRetired', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: true,
    reading: null,
    paneRetired: true,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.wouldConsultPane, true);
  assert.equal(entry.hookActivity, null);
  assert.equal(entry.hookConfidence, null);
});

test('flag-off: unknown reading remains non-authoritative in telemetry', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: false,
    reading: reading('unknown', 'high'),
    paneRetired: false,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.agreed, null);
  assert.equal(entry.wouldConsultPane, undefined);
  assert.equal(entry.paneRetired, undefined);
});

test('flag-off: low-confidence reading remains non-authoritative in telemetry', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: true,
    reading: reading('composing', 'low'),
    paneRetired: false,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.agreed, null);
  assert.equal(entry.wouldConsultPane, undefined);
});

test('flag-off: absent reading keeps hookBusy null (unchanged)', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: true,
    reading: null,
    paneRetired: false,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.wouldConsultPane, undefined);
});

test('activity-degraded entry tags degradedSignal=activity', () => {
  const entry = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: true,
    reading: reading('unknown', 'high'),
    paneRetired: true,
  });
  assert.equal(entry.degradedSignal, 'activity');
  assert.equal(entry.wouldConsultPane, true);
});

test('pending-degraded entry records the prompt reading, not a healthy activity read', () => {
  // The scenario finding #2 fixed: activity read healthy-idle, but the PENDING (prompt digest)
  // read degraded. Logging the prompt reading keeps hookBusy null so the soak metric counts it.
  const entry = buildPendingDegradedAgreementEntry({
    ...BASE,
    paneBusy: true,
    promptReading: { value: false, source: 'hook', confidence: 'low', observedAt: 10 },
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.hookActivity, null);
  assert.equal(entry.wouldConsultPane, true);
  assert.equal(entry.degradedSignal, 'pending');
  assert.equal(entry.paneRetired, true);
  assert.equal(entry.hookConfidence, 'low');
  assert.equal(entry.hookObservedAt, 10);
  assert.equal(entry.paneBusy, true);
});

test('pending-degraded entry with an absent prompt reading still flags wouldConsultPane', () => {
  const entry = buildPendingDegradedAgreementEntry({
    ...BASE,
    paneBusy: false,
    promptReading: null,
  });
  assert.equal(entry.hookBusy, null);
  assert.equal(entry.wouldConsultPane, true);
  assert.equal(entry.hookConfidence, null);
  assert.equal(entry.degradedSignal, 'pending');
});

test('aggregate counts pending-degraded decisions in wouldConsultPane (no undercount)', () => {
  // Regression for finding #2: a pending-degraded decision logged with the healthy activity read
  // would resolve hookBusy=false and NOT count here — proving the fix, it counts as wouldConsultPane.
  const pendingDegraded = buildPendingDegradedAgreementEntry({
    ...BASE,
    paneBusy: true,
    promptReading: { value: false, source: 'hook', confidence: 'low', observedAt: 10 },
  });
  const authoritativeIdle = buildRunnerObservabilityAgreementEntry({
    ...BASE,
    paneBusy: false,
    reading: reading('idle', 'high'),
    paneRetired: true,
  });
  const aggregate = aggregateAgreementEntries([pendingDegraded, authoritativeIdle]);
  assert.equal(aggregate.wouldConsultPane, 1);
  assert.equal(aggregate.hookUnavailable, 1);
});
