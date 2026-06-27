import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isObservabilityReadingAuthoritative,
  selectBusyFromObservabilityAndPane,
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

test('selectBusyFromObservabilityAndPane falls back to pane on low confidence', () => {
  assert.deepEqual(selectBusyFromObservabilityAndPane(activityReading('idle', 'low'), true), {
    busy: true,
    source: 'pane',
    confidence: null,
  });
});