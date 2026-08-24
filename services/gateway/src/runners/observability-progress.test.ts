import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyMonitorProgress,
  resolveMonitorStuckState,
  shouldDeliverStuckNudge,
} from './observability-progress.js';
import type {
  ObservabilityReading,
  RunnerActivity,
  RunnerSessionDeliveryState,
} from './observability-types.js';

function activity(
  value: RunnerActivity,
  confidence: ObservabilityReading<RunnerActivity>['confidence'] = 'high',
): ObservabilityReading<RunnerActivity> {
  return { value, source: 'hook', confidence, observedAt: 1 };
}

function turn(
  value: RunnerSessionDeliveryState,
  confidence: ObservabilityReading<RunnerSessionDeliveryState>['confidence'] = 'high',
): ObservabilityReading<RunnerSessionDeliveryState> {
  return { value, source: 'hook', confidence, observedAt: 1 };
}

const twentyMin = 20 * 60_000;
const start = 1_000_000;

test('classifyMonitorProgress treats tool-running and composing as progress', () => {
  assert.equal(classifyMonitorProgress({ activity: activity('tool-running') }), 'making-progress');
  assert.equal(classifyMonitorProgress({ activity: activity('composing') }), 'making-progress');
});

test('classifyMonitorProgress treats an active turn as progress even if activity is idle', () => {
  assert.equal(
    classifyMonitorProgress({ activity: activity('idle'), turnState: turn('active') }),
    'making-progress',
  );
  assert.equal(
    classifyMonitorProgress({ activity: null, turnState: turn('active') }),
    'making-progress',
  );
});

test('classifyMonitorProgress fails closed without structured activity (Cursor pane-only)', () => {
  assert.equal(classifyMonitorProgress({ activity: null }), 'unproven');
  assert.equal(classifyMonitorProgress({ activity: activity('unknown') }), 'unproven');
  assert.equal(classifyMonitorProgress({ activity: activity('idle', 'low') }), 'unproven');
});

test('classifyMonitorProgress distinguishes idle from awaiting-input', () => {
  assert.equal(classifyMonitorProgress({ activity: activity('idle') }), 'idle');
  assert.equal(classifyMonitorProgress({ activity: activity('awaiting-input') }), 'awaiting-input');
});

test('resolveMonitorStuckState does not flag a live tool call after the stuck timeout', () => {
  const state = resolveMonitorStuckState({
    now: start + twentyMin + 1,
    lastProgressAt: start,
    stuckTimeoutMs: twentyMin,
    activity: activity('tool-running'),
  });
  assert.equal(state.stuck, false);
  assert.equal(state.kind, 'making-progress');
  assert.equal(state.lastProgressAt, start + twentyMin + 1);
});

test('resolveMonitorStuckState does not flag Cursor-style unknown activity as stuck', () => {
  const state = resolveMonitorStuckState({
    now: start + twentyMin + 1,
    lastProgressAt: start,
    stuckTimeoutMs: twentyMin,
    activity: null,
    turnState: null,
  });
  assert.equal(state.stuck, false);
  assert.equal(state.kind, 'unproven');
  assert.equal(state.lastProgressAt, start);
  assert.equal(shouldDeliverStuckNudge(state.kind), false);
});

test('resolveMonitorStuckState flags structured idle after the stuck timeout', () => {
  const before = resolveMonitorStuckState({
    now: start + twentyMin,
    lastProgressAt: start,
    stuckTimeoutMs: twentyMin,
    activity: activity('idle'),
  });
  assert.equal(before.stuck, false);

  const after = resolveMonitorStuckState({
    now: start + twentyMin + 1,
    lastProgressAt: start,
    stuckTimeoutMs: twentyMin,
    activity: activity('idle'),
  });
  assert.equal(after.stuck, true);
  assert.equal(shouldDeliverStuckNudge(after.kind), true);
});

test('resolveMonitorStuckState keeps the last progress timestamp while idle', () => {
  const state = resolveMonitorStuckState({
    now: start + 5_000,
    lastProgressAt: start,
    stuckTimeoutMs: twentyMin,
    activity: activity('idle'),
  });
  assert.equal(state.lastProgressAt, start);
  assert.equal(state.stuck, false);
});
