import assert from 'node:assert/strict';
import test from 'node:test';

import { pickStreamOutput } from './slot.js';

const frame = (event: string, payload?: unknown) => ({
  type: 'event' as const,
  event,
  payload,
});

test('pickStreamOutput returns data for script.output events', () => {
  const result = pickStreamOutput(
    frame('script.output', { stream: 'stdout', data: '[ssh] Connected\n', timestamp: 0 }),
  );
  assert.equal(result, '[ssh] Connected\n');
});

test('pickStreamOutput ignores slot.prepare.output so each line prints once', () => {
  const result = pickStreamOutput(
    frame('slot.prepare.output', { stream: 'stdout', data: '[ssh] Connected\n' }),
  );
  assert.equal(result, null);
});

test('pickStreamOutput ignores slot.prepare.step (no data field)', () => {
  const result = pickStreamOutput(frame('slot.prepare.step', { name: 'ssh', detail: 'ok' }));
  assert.equal(result, null);
});

test('pickStreamOutput returns null when script.output payload has no data field', () => {
  const result = pickStreamOutput(frame('script.output', { stream: 'stdout' }));
  assert.equal(result, null);
});

test('pickStreamOutput returns null for events with no payload', () => {
  const result = pickStreamOutput(frame('script.output'));
  assert.equal(result, null);
});
