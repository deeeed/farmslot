import assert from 'node:assert/strict';
import test from 'node:test';

import type { MonitorViolation } from '@farmslot/protocol';

import {
  monitorViolationBody,
  monitorViolationDedupeKey,
  monitorViolationTitle,
  normalizeMonitorViolation,
} from './notification-format';

const baseViolation: MonitorViolation = {
  slotId: ' runner-mobile-2 ',
  type: 'idle',
  message: ' agent is idle ',
  nudgeSent: null,
  timestamp: '2026-05-21T00:00:00.000Z',
};

test('normalizes wrapped monitor violations into actionable notification data', () => {
  const normalized = normalizeMonitorViolation({ violation: baseViolation });

  assert.ok(normalized);
  assert.equal(normalized.slotId, 'runner-mobile-2');
  assert.equal(normalized.message, 'agent is idle');
  assert.equal(monitorViolationTitle(normalized), 'Worker idle · runner-mobile-2');
  assert.equal(monitorViolationBody(normalized), 'agent is idle');
});

test('rejects unknown slot monitor violations instead of notifying useless alerts', () => {
  assert.equal(normalizeMonitorViolation({ ...baseViolation, slotId: 'unknown' }), null);
  assert.equal(normalizeMonitorViolation({ ...baseViolation, slotId: 'slot unknown' }), null);
  assert.equal(normalizeMonitorViolation({ ...baseViolation, slotId: 'unknown slot' }), null);
  assert.equal(normalizeMonitorViolation({ ...baseViolation, slotId: 'undefined' }), null);
});

test('rejects monitor event types that are not useful as mobile notifications', () => {
  assert.equal(normalizeMonitorViolation({ ...baseViolation, type: 'skipped' }), null);
});

test('accepts budget monitor violations as actionable mobile notifications', () => {
  const normalized = normalizeMonitorViolation({ ...baseViolation, type: 'budget' });
  assert.ok(normalized);
  assert.equal(normalized.type, 'budget');
  assert.equal(monitorViolationTitle(normalized), 'Usage budget · runner-mobile-2');
});

test('monitor violation dedupe is scoped by slot, type, role, and context', () => {
  const one = monitorViolationDedupeKey({
    ...baseViolation,
    slotId: 'runner-mobile-2',
    role: 'dev',
    contextId: 'run-a',
  });
  const two = monitorViolationDedupeKey({
    ...baseViolation,
    slotId: 'runner-mobile-2',
    role: 'review',
    contextId: 'run-a',
  });

  assert.notEqual(one, two);
});
