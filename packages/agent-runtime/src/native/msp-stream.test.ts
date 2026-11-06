import assert from 'node:assert/strict';
import test from 'node:test';

import { MspTextStream } from './msp-stream.js';
import type { NativeEventInput } from './types.js';

test('uninstalled Muse/MSP contract streams item deltas before completion without repeating completed text', () => {
  const events: NativeEventInput[] = [];
  const stream = new MspTextStream('session', 'turn', 'command', (event) => events.push(event));
  const item = {
    itemId: 'answer',
    kind: 'agentMessage',
    turnId: 'turn',
    revision: 1,
    status: 'inProgress',
    text: '',
  };
  stream.accept('foreign', 'item/started', { item });
  stream.accept('session', 'item/delta', { itemId: 'answer', delta: 'foreign' });
  assert.deepEqual(events, []);
  stream.accept('session', 'item/started', { item });
  stream.accept('session', 'item/delta', { itemId: 'answer', delta: 'hello' });
  assert.deepEqual(
    events.map((event) => event.text),
    ['hello'],
  );
  stream.accept('session', 'item/delta', { itemId: 'answer', delta: ' world', field: 'text' });
  stream.accept('session', 'item/completed', {
    item: { ...item, revision: 2, status: 'completed', text: 'hello world' },
  });
  stream.accept('session', 'item/completed', {
    item: { ...item, revision: 2, status: 'completed', text: 'hello world' },
  });
  stream.accept('session', 'item/delta', { itemId: 'answer', delta: 'after completion' });
  assert.equal(events.map((event) => event.text).join(''), 'hello world');
  assert.ok(events.every((event) => event.commandId === 'command' && event.type === 'text.delta'));
});
