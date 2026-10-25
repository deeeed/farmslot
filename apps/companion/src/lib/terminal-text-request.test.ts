import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';
import { operatorMessageInput } from '@farmslot/review-dispatch';

import { terminalTextRequest } from './terminal-text-request';

test('bare-session text retains its routing flag through semantic delivery', () => {
  const request = terminalTextRequest(
    { slotId: 'slot', bareSession: true },
    operatorMessageInput('status', 'message-1'),
  );
  assert.equal(request.method, Methods.TERMINAL_SEND);
  assert.equal(request.params.bareSession, true);
  assert.equal(request.params.operatorMessageId, 'message-1');
  assert.equal(request.params.text, 'status');
});

test('a run-bound retry keeps the exact actor and message identity', () => {
  const target = { slotId: 'slot', runId: 'run', contextId: 'worker', target: '%123' };
  const message = operatorMessageInput('Keep the invariant', 'retry-message');
  const first = terminalTextRequest(target, message);
  const retry = terminalTextRequest(target, message);
  assert.equal(first.method, Methods.TERMINAL_SEND);
  assert.deepEqual(retry, first);
  assert.equal(retry.params.runId, 'run');
  assert.equal(retry.params.contextId, 'worker');
  assert.equal(retry.params.target, '%123');
});
