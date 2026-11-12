import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '../../src/contracts/slots.js';
import { computeSummary } from '../../src/fleet/summary.js';

// ---------------------------------------------------------------------------
// Test #12: computeSummary parity
// Gateway no longer carries a local copy; both gateway and client import this.
// ---------------------------------------------------------------------------

function makeSlot(overrides: Partial<SlotStatus>): SlotStatus {
  return {
    slot: 'test-01',
    machine: 'macwork',
    platform: 'macos',
    project: 'p',
    health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    ...overrides,
  };
}

test('computeSummary counts all lifecycle buckets correctly', () => {
  const slots: SlotStatus[] = [
    makeSlot({
      slot: 's1',
      lifecycle: 'ready',
      health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      warm: false,
    }),
    makeSlot({
      slot: 's2',
      lifecycle: 'ready',
      health: { ssh: 'OK', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
      warm: true,
    }),
    makeSlot({
      slot: 's3',
      lifecycle: 'ready',
      health: { ssh: 'FAIL', device: '-', devserver: 'OK', cdp: '-', fixtures: '-' },
    }),
    makeSlot({ slot: 's4', lifecycle: 'busy' }),
    makeSlot({ slot: 's5', lifecycle: 'held' }),
    makeSlot({ slot: 's6', lifecycle: 'manual' }),
    makeSlot({ slot: 's7', lifecycle: 'disabled' }),
  ];
  const summary = computeSummary(slots);
  assert.equal(summary.total, 7);
  assert.equal(summary.ready, 2, 'healthy ready slots');
  assert.equal(summary.blocked, 1, 'unhealthy ready slot = blocked');
  assert.equal(summary.warmCount, 1, 'warm slot');
  assert.equal(summary.busy, 1);
  assert.equal(summary.held, 1);
  assert.equal(summary.manual, 1);
  assert.equal(summary.disabled, 1);
});

test('computeSummary returns zero counts for empty fleet', () => {
  const summary = computeSummary([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.ready, 0);
  assert.equal(summary.busy, 0);
});
