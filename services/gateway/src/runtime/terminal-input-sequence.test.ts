import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inputAlreadyApplied,
  inputSequenceSizeForTests,
  rememberInputApplied,
  resetInputSequencesForTests,
  runInputInOrder,
} from './terminal-input-sequence.js';

/** What terminal.worker.input does for one batch: in order, written at most once. */
function writer(pane: string, typed: string[]) {
  return (data: string, seq?: { stream: string; n: number }, fail = false) =>
    runInputInOrder(pane, async () => {
      if (inputAlreadyApplied(pane, seq)) return;
      if (fail) throw new Error('tmux send-keys failed');
      typed.push(data);
      rememberInputApplied(pane, seq);
    });
}

test('a batch resent after a lost reply is acknowledged without being typed again', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%19', typed);
  await write('echo ONCE\r', { stream: 'a', n: 1 });
  await write('echo ONCE\r', { stream: 'a', n: 1 });
  await write('pwd\r', { stream: 'a', n: 2 });
  // A new queue (new screen or sign-in) starts its own stream at 1.
  await write('ls\r', { stream: 'b', n: 1 });
  // Input without a sequence (an older client) is written as before.
  await write('x', undefined);
  await write('x', undefined);
  assert.deepEqual(typed, ['echo ONCE\r', 'pwd\r', 'ls\r', 'x', 'x']);
});

test('a batch whose write failed is written by its resend', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('slot:mmt-3', typed);
  await assert.rejects(write('make\r', { stream: 'a', n: 1 }, true), /send-keys failed/);
  await write('make\r', { stream: 'a', n: 1 });
  assert.deepEqual(typed, ['make\r']);
});

test('a resend that arrives while the original is still being written waits for it', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const pane = 'mini:%4';
  const original = runInputInOrder(pane, async () => {
    if (inputAlreadyApplied(pane, { stream: 'a', n: 1 })) return;
    await slow;
    typed.push('echo once\r');
    rememberInputApplied(pane, { stream: 'a', n: 1 });
  });
  const resend = writer(pane, typed)('echo once\r', { stream: 'a', n: 1 });
  release();
  await Promise.all([original, resend]);
  assert.deepEqual(typed, ['echo once\r']);
});

test('remembered streams and panes stay bounded', () => {
  resetInputSequencesForTests();
  for (let stream = 0; stream < 40; stream++)
    rememberInputApplied('pane', { stream: `s${stream}`, n: 1 });
  for (let pane = 0; pane < 600; pane++) rememberInputApplied(`p${pane}`, { stream: 'a', n: 1 });
  const size = inputSequenceSizeForTests();
  assert.equal(size.panes, 512);
  assert.ok(size.streams <= 512 + 16);
  // The most recent stream of a pane is kept; the oldest ones were forgotten first.
  assert.equal(inputAlreadyApplied('p599', { stream: 'a', n: 1 }), true);
  assert.equal(inputAlreadyApplied('p0', { stream: 'a', n: 1 }), false);
});
