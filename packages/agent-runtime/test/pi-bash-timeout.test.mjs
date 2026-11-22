import assert from 'node:assert/strict';
import test from 'node:test';

import piBashTimeout, { PI_BASH_TIMEOUT_SECONDS } from '../scripts/pi-bash-timeout.mjs';

function toolCall(toolName, input) {
  const handlers = [];
  piBashTimeout({ on: (type, handler) => type === 'tool_call' && handlers.push(handler) });
  const event = { type: 'tool_call', toolCallId: 't1', toolName, input };
  for (const handler of handlers) handler(event);
  return event.input;
}

test('a Pi bash call without a timeout gets the 600-second default', () => {
  assert.equal(PI_BASH_TIMEOUT_SECONDS, 600);
  assert.deepEqual(toolCall('bash', { command: 'find / -name x' }), {
    command: 'find / -name x',
    timeout: 600,
  });
});

test('an explicit Pi bash timeout, longer or shorter, is kept', () => {
  assert.equal(toolCall('bash', { command: 'yarn test', timeout: 900 }).timeout, 900);
  assert.equal(toolCall('bash', { command: 'true', timeout: 5 }).timeout, 5);
});

test('other Pi tools are left alone', () => {
  assert.deepEqual(toolCall('grep', { pattern: 'x' }), { pattern: 'x' });
});
