import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftWithContext,
  queueNativeChatContext,
  takeNativeChatContext,
  TERMINAL_CHAT_CONTEXT_LINES,
  terminalChatContext,
} from './native-chat-context.js';

test('a terminal selection becomes a fenced block without the terminal padding', () => {
  assert.equal(
    terminalChatContext('\n   \nerror: a.rs:3   \r\n  note: see docs  \n\n'),
    '```\nerror: a.rs:3\n  note: see docs\n```',
  );
  // A fence longer than any backtick run inside, so the block cannot close early.
  assert.equal(terminalChatContext('run ```npm test```'), '````\nrun ```npm test```\n````');
  assert.equal(terminalChatContext(' \n\t\n'), '');
  // A whole scrollback keeps its last lines and says how many it left out.
  const long = Array.from({ length: TERMINAL_CHAT_CONTEXT_LINES + 50 }, (_, i) => `line ${i + 1}`);
  const block = terminalChatContext(long.join('\n')).split('\n');
  assert.deepEqual(block.slice(0, 3), ['```', '… 50 earlier lines', 'line 51']);
  assert.equal(block.at(-2), `line ${TERMINAL_CHAT_CONTEXT_LINES + 50}`);
});

test('context waits for its conversation, is taken once, and follows the typed draft', () => {
  queueNativeChatContext('attempt-a', '```\none\n```');
  queueNativeChatContext('attempt-a', '```\ntwo\n```');
  assert.equal(takeNativeChatContext('attempt-b'), undefined);
  assert.equal(takeNativeChatContext('attempt-a'), '```\none\n```\n\n```\ntwo\n```');
  assert.equal(takeNativeChatContext('attempt-a'), undefined);
  assert.equal(
    draftWithContext('look at this:  \n', '```\nx\n```'),
    'look at this:\n\n```\nx\n```',
  );
  assert.equal(draftWithContext('', '```\nx\n```'), '```\nx\n```');
});
