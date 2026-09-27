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
const userTurn = (content, sessionId = 'session') =>
  JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content } });

test('verifies whole messages in separate user turns', () => {
  assert.equal(
    verifyReceipts(proof, `${userTurn('first complete')}\n${userTurn('second complete')}`).length,
    2,
  );
});

test('rejects enqueue-only receipts and duplicate or combined user turns', () => {
  const enqueue = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: 'session',
    content: 'first complete',
  });
  const consumed = `${userTurn('first complete')}\n${userTurn('second complete')}`;
  assert.throws(() => verifyReceipts(proof, `${enqueue}\n${userTurn('second complete')}`));
  assert.equal(verifyReceipts(proof, `${enqueue}\n${consumed}`).length, 2);
  assert.throws(() => verifyReceipts(proof, `${consumed}\n${userTurn('first complete')}`));
  assert.throws(() =>
    verifyReceipts(proof, userTurn(proof.messages.map(({ text }) => ({ type: 'text', text })))),
  );
});

test('rejects empty and duplicate expected messages', () => {
  assert.throws(() => verifyReceipts({ ...proof, messages: [] }, ''));
  assert.throws(() =>
    verifyReceipts(
      { ...proof, messages: [proof.messages[0], proof.messages[0]] },
      userTurn('first complete'),
    ),
  );
});

test('rejects tail-only and merged receipts', () => {
  assert.throws(() =>
    verifyReceipts(proof, `${userTurn('complete')}\n${userTurn('second complete')}`),
  );
  assert.throws(() => verifyReceipts(proof, userTurn('first completesecond complete')));
});

test('decodes one native paste envelope without changing payload bytes', () => {
  const wrapped = (text) =>
    `\n\n<pasted_content id="3fad">\n${text}\n</pasted_content id="3fad">\n`;
  const receipts = verifyReceipts(
    proof,
    `${userTurn(wrapped('first complete'))}\n${userTurn(wrapped('second complete'))}`,
  );
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].bytes, Buffer.byteLength('first complete'));
  assert.equal(receipts[0].nativePasteEnvelope, true);
  assert.ok(receipts[0].nativeEventBytes > receipts[0].bytes);
  assert.throws(() =>
    verifyReceipts(
      proof,
      `${userTurn(wrapped(' first complete'))}\n${userTurn(wrapped('second complete'))}`,
    ),
  );
  assert.throws(() =>
    verifyReceipts(
      proof,
      `${userTurn(wrapped('first complete').replace('</pasted_content id="3fad">', '</pasted_content id="other">'))}\n${userTurn(wrapped('second complete'))}`,
    ),
  );
  assert.throws(() =>
    verifyReceipts(proof, userTurn(wrapped('first complete') + wrapped('second complete'))),
  );
});

test('rejects another session and assistant echoes', () => {
  assert.throws(() =>
    verifyReceipts(proof, `${userTurn('first complete', 'other')}\n${userTurn('second complete')}`),
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
      content: [{ type: 'text', text: 'first complete' }],
    },
  };
  const second = userTurn([{ type: 'text', text: 'second complete' }]);
  assert.equal(verifyReceipts(proof, `${JSON.stringify(event)}\n${second}`).length, 2);
  event.message.content[0].type = 'tool_result';
  assert.throws(() => verifyReceipts(proof, `${JSON.stringify(event)}\n${second}`));
});
