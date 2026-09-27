import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyReceipts } from './terminal-paste-receipt.mjs';

const proof = {
  sessionId: 'session',
  messages: [
    { id: 'first', text: 'first complete' },
    { id: 'second', text: 'second complete' },
  ],
};
const queued = (content, sessionId = 'session') =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId, content });

test('verifies whole separately queued messages', () => {
  assert.equal(
    verifyReceipts(proof, `${queued('first complete')}\n${queued('second complete')}`).length,
    2,
  );
});

test('rejects tail-only and merged receipts', () => {
  assert.throws(() => verifyReceipts(proof, `${queued('complete')}\n${queued('second complete')}`));
  assert.throws(() => verifyReceipts(proof, queued('first completesecond complete')));
});

test('rejects another session and assistant echoes', () => {
  assert.throws(() =>
    verifyReceipts(proof, `${queued('first complete', 'other')}\n${queued('second complete')}`),
  );
  assert.throws(() =>
    verifyReceipts(
      proof,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first complete' },
            { type: 'text', text: 'second complete' },
          ],
        },
      }),
    ),
  );
});

test('accepts native user text blocks without counting tool results', () => {
  const event = {
    type: 'user',
    sessionId: 'session',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'first complete' },
        { type: 'text', text: 'second complete' },
      ],
    },
  };
  assert.equal(verifyReceipts(proof, JSON.stringify(event)).length, 2);
  event.message.content[0].type = 'tool_result';
  assert.throws(() => verifyReceipts(proof, JSON.stringify(event)));
});
