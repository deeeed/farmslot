import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inputSequenceSizeForTests,
  resetInputSequencesForTests,
  runInputInOrder,
  writeSequencedInput,
} from './terminal-input-sequence.js';

type Seq = { stream: string; n: number };

/** What terminal.worker.input does for one batch: in order, written at most once. */
function writer(pane: string, typed: string[]) {
  return (data: string, seq?: Seq, outcome: 'ok' | 'local-error' | 'remote-timeout' = 'ok') =>
    runInputInOrder(pane, () =>
      writeSequencedInput(pane, seq, (dispatched) => {
        if (outcome === 'local-error') throw new Error('node mini is not connected');
        if (outcome === 'remote-timeout') {
          dispatched();
          typed.push(data);
          throw new Error('Request tmux.send timed out');
        }
        typed.push(data);
      }),
    );
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
  await write('x');
  await write('x');
  assert.deepEqual(typed, ['echo ONCE\r', 'pwd\r', 'ls\r', 'x', 'x']);
});

test('a batch that failed before reaching the pane is written by its resend', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('slot:mmt-3', typed);
  await assert.rejects(write('make\r', { stream: 'a', n: 1 }, 'local-error'), /not connected/);
  await write('make\r', { stream: 'a', n: 1 });
  assert.deepEqual(typed, ['make\r']);
});

// A remote node may have typed the batch even though its answer never came back.
test('a batch whose remote write ended without an answer is never written again by a resend', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%7', typed);
  await assert.rejects(
    write('make deploy\r', { stream: 'a', n: 1 }, 'remote-timeout'),
    /timed out/,
  );
  await assert.rejects(write('make deploy\r', { stream: 'a', n: 1 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'TERMINAL_INPUT_UNCERTAIN');
    return true;
  });
  // The user's explicit resend carries a new number and is written.
  await write('make deploy\r', { stream: 'a', n: 2 });
  assert.deepEqual(typed, ['make deploy\r', 'make deploy\r']);
});

test('a resend that arrives while the original is still being written waits for it', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => (release = resolve));
  const pane = 'mini:%4';
  const original = runInputInOrder(pane, () =>
    writeSequencedInput(pane, { stream: 'a', n: 1 }, async () => {
      await slow;
      typed.push('echo once\r');
    }),
  );
  const resend = writer(pane, typed)('echo once\r', { stream: 'a', n: 1 });
  release();
  await Promise.all([original, resend]);
  assert.deepEqual(typed, ['echo once\r']);
});

test('a malformed sequence is refused before anything is written', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  const write = writer('mini:%8', typed);
  for (const seq of [
    { stream: '', n: 1 },
    { stream: 'x'.repeat(65), n: 1 },
    { stream: 'a', n: Number.POSITIVE_INFINITY },
    { stream: 'a', n: -1 },
    { stream: 'a', n: 1.5 },
  ])
    await assert.rejects(write('x', seq), /seq needs a stream/);
  assert.deepEqual(typed, []);
});

test('remembered streams and panes stay bounded', async () => {
  resetInputSequencesForTests();
  const typed: string[] = [];
  for (let stream = 0; stream < 40; stream++)
    await writer('pane', typed)('k', { stream: `s${stream}`, n: 1 });
  for (let pane = 0; pane < 600; pane++)
    await writer(`p${pane}`, typed)('k', { stream: 'a', n: 1 });
  const size = inputSequenceSizeForTests();
  assert.equal(size.panes, 512);
  assert.ok(size.streams <= 512 + 16);
  // The most recent pane is still remembered; the oldest was forgotten first.
  const before = typed.length;
  await writer('p599', typed)('k', { stream: 'a', n: 1 });
  await writer('p0', typed)('k', { stream: 'a', n: 1 });
  assert.equal(typed.length, before + 1);
});
