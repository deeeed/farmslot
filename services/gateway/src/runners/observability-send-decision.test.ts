import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computePromptAcceptedSinceMs,
  isObservabilityReadingAuthoritative,
  OBS_PANE_RETIRED_ENV,
  paneRetiredFromEnv,
  selectBusyFromObservabilityAndPane,
  selectIdleFromObservabilityAndPane,
  selectPendingFromObservabilityAndPane,
} from './observability-send-decision.js';
import type { ObservabilityReading, RunnerActivity } from './observability-types.js';

function activityReading(
  value: RunnerActivity,
  confidence: ObservabilityReading<RunnerActivity>['confidence'] = 'high',
): ObservabilityReading<RunnerActivity> {
  return { value, source: 'hook', confidence, observedAt: Date.now() };
}

function promptReading(
  value: boolean,
  confidence: ObservabilityReading<boolean>['confidence'] = 'high',
): ObservabilityReading<boolean> {
  return { value, source: 'hook', confidence, observedAt: Date.now() };
}

test('computePromptAcceptedSinceMs aligns lookback with safe-send timeout window', () => {
  assert.equal(computePromptAcceptedSinceMs(20_000, 10_000), 10_000);
  assert.equal(computePromptAcceptedSinceMs(40_000, 30_000), 10_000);
});

test('isObservabilityReadingAuthoritative rejects null and low confidence', () => {
  assert.equal(isObservabilityReadingAuthoritative(null), false);
  assert.equal(isObservabilityReadingAuthoritative(activityReading('idle', 'low')), false);
  assert.equal(isObservabilityReadingAuthoritative(activityReading('idle', 'high')), true);
});

test('selectBusyFromObservabilityAndPane prefers hook when authoritative', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('composing'), false), {
    busy: true,
    source: 'hook',
    confidence: 'high',
  });
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('idle'), true), {
    busy: false,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectBusyFromObservabilityAndPane falls back to pane on unknown or missing hook', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(null, true), {
    busy: true,
    source: 'pane',
    confidence: null,
  });
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('unknown'), true), {
    busy: true,
    source: 'pane',
    confidence: null,
  });
});

test('selectPendingFromObservabilityAndPane treats accepted hook as not pending when pane is clear', () => {
  assert.deepEqual(selectPendingFromObservabilityAndPane(promptReading(true), false), {
    pending: false,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectPendingFromObservabilityAndPane prefers live pane when hook reports stale acceptance', () => {
  assert.deepEqual(selectPendingFromObservabilityAndPane(promptReading(true), true), {
    pending: true,
    source: 'pane',
    confidence: null,
  });
});

test('selectPendingFromObservabilityAndPane keeps buffered composer pending when hook says not accepted', () => {
  assert.deepEqual(selectPendingFromObservabilityAndPane(promptReading(false), true), {
    pending: true,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectPendingFromObservabilityAndPane falls back to pane when hook is absent', () => {
  assert.deepEqual(selectPendingFromObservabilityAndPane(null, true), {
    pending: true,
    source: 'pane',
    confidence: null,
  });
  assert.deepEqual(selectPendingFromObservabilityAndPane(null, false), {
    pending: false,
    source: 'pane',
    confidence: null,
  });
});

test('selectIdleFromObservabilityAndPane prefers hook idle when authoritative', () => {
  assert.deepEqual(selectIdleFromObservabilityAndPane(activityReading('idle'), false), {
    idle: true,
    source: 'hook',
    confidence: 'high',
  });
  assert.deepEqual(selectIdleFromObservabilityAndPane(activityReading('composing'), true), {
    idle: false,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectIdleFromObservabilityAndPane falls back to pane on unknown or missing hook', () => {
  assert.deepEqual(selectIdleFromObservabilityAndPane(null, true), {
    idle: true,
    source: 'pane',
    confidence: null,
  });
  assert.deepEqual(selectIdleFromObservabilityAndPane(activityReading('unknown'), false), {
    idle: false,
    source: 'pane',
    confidence: null,
  });
});

test('selectBusyFromObservabilityAndPane falls back to pane on low confidence', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('idle', 'low'), true), {
    busy: true,
    source: 'pane',
    confidence: null,
  });
});

// --- ADR-032 Phase 3A pane-retirement flag ---

test('paneRetiredFromEnv reads the flag from env truthy values only', () => {
  assert.equal(paneRetiredFromEnv({ [OBS_PANE_RETIRED_ENV]: '1' }), true);
  assert.equal(paneRetiredFromEnv({ [OBS_PANE_RETIRED_ENV]: 'true' }), true);
  assert.equal(paneRetiredFromEnv({ [OBS_PANE_RETIRED_ENV]: 'TRUE' }), true);
  assert.equal(paneRetiredFromEnv({ [OBS_PANE_RETIRED_ENV]: '0' }), false);
  assert.equal(paneRetiredFromEnv({ [OBS_PANE_RETIRED_ENV]: '' }), false);
  assert.equal(paneRetiredFromEnv({}), false);
});

test('selectBusy pane-retired: authoritative hook still wins, pane never consulted', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('composing'), false, true), {
    busy: true,
    source: 'hook',
    confidence: 'high',
  });
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('idle'), true, true), {
    busy: false,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectBusy pane-retired: degraded (unknown/null/low) resolves to busy without pane', () => {
  const degraded = { busy: true, source: 'degraded', confidence: null, degraded: true };
  // pane says NOT busy (false), but the flag must ignore it and hold busy.
  assert.deepEqual(selectBusyFromObservabilityAndPane(null, false, true), degraded);
  assert.deepEqual(
    selectBusyFromObservabilityAndPane(activityReading('unknown'), false, true),
    degraded,
  );
  assert.deepEqual(
    selectBusyFromObservabilityAndPane(activityReading('idle', 'low'), false, true),
    degraded,
  );
});

test('selectIdle pane-retired: degraded resolves to not-idle (busy) without pane', () => {
  const degraded = { idle: false, source: 'degraded', confidence: null, degraded: true };
  assert.deepEqual(selectIdleFromObservabilityAndPane(null, true, true), degraded);
  assert.deepEqual(
    selectIdleFromObservabilityAndPane(activityReading('unknown'), true, true),
    degraded,
  );
  // authoritative hook still decides.
  assert.deepEqual(selectIdleFromObservabilityAndPane(activityReading('idle'), false, true), {
    idle: true,
    source: 'hook',
    confidence: 'high',
  });
});

test('selectPending pane-retired: authoritative hook decides, degraded holds (not pending) without pane', () => {
  assert.deepEqual(selectPendingFromObservabilityAndPane(promptReading(true), true, true), {
    pending: false,
    source: 'hook',
    confidence: 'high',
  });
  assert.deepEqual(selectPendingFromObservabilityAndPane(promptReading(false), true, true), {
    pending: true,
    source: 'hook',
    confidence: 'high',
  });
  assert.deepEqual(selectPendingFromObservabilityAndPane(null, true, true), {
    pending: false,
    source: 'degraded',
    confidence: null,
    degraded: true,
  });
});

test('selectors flag-off (paneRetired=false) stay byte-identical to Phase 2 pane fallback', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(null, true, false), {
    busy: true,
    source: 'pane',
    confidence: null,
  });
  assert.deepEqual(selectIdleFromObservabilityAndPane(activityReading('unknown'), true, false), {
    idle: true,
    source: 'pane',
    confidence: null,
  });
  assert.deepEqual(selectPendingFromObservabilityAndPane(null, true, false), {
    pending: true,
    source: 'pane',
    confidence: null,
  });
});
