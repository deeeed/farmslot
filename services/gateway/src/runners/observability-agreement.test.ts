import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRunnerObservabilityAgreementEntry,
  disagreementReason,
} from './observability-agreement.js';
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
