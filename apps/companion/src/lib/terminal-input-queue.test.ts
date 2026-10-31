import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalInputQueue, TerminalInputCancelledError } from './terminal-input-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('a slow first request batches fast typing and Enter in exact order, with one in flight', async () => {
  const requests: string[] = [];
  const first = deferred();
  const second = deferred();
  let active = 0;
  let maximum = 0;
  const queue = createTerminalInputQueue(async (data) => {
    requests.push(data);
    maximum = Math.max(maximum, ++active);
    await (requests.length === 1 ? first.promise : second.promise);
    active--;
  });
  const writes = ['a', 'b', 'c', '\u001b[D', '\r'].map((data) => queue.write(data));
  assert.deepEqual(requests, ['a']);
  first.resolve();
  await writes[0];
  assert.deepEqual(requests, ['a', 'bc\u001b[D\r']);
  second.resolve();
  await Promise.all(writes);
  assert.equal(maximum, 1);
  assert.equal(requests.join(''), 'abc\u001b[D\r');
});

// Arthur's rule: a keystroke is never dropped.
test('a failed request keeps its keys and the keys typed behind it, and retries them in order', async () => {
  const first = deferred();
  const sent: string[] = [];
  const retries: number[] = [];
  const queue = createTerminalInputQueue(
    async (data) => {
      sent.push(data);
      if (sent.length === 1) await first.promise;
    },
    { retryDelayMs: () => 0, onRetry: (_error, attempt) => retries.push(attempt) },
  );
  const a = queue.write('a');
  const b = queue.write('b');
  first.reject(new Error('offline'));
  await Promise.all([a, b]);
  assert.deepEqual(sent, ['a', 'ab']);
  assert.deepEqual(retries, [0]);
  await queue.write('c');
  assert.deepEqual(sent, ['a', 'ab', 'c']);
});

test('a synchronous send failure is retried and later input follows it', async () => {
  const sent: string[] = [];
  let refusals = 2;
  const queue = createTerminalInputQueue(
    (data) => {
      sent.push(data);
      if (refusals-- > 0) throw new Error('refused');
      return Promise.resolve();
    },
    { retryDelayMs: () => 0 },
  );
  await Promise.all([queue.write('x'), queue.write('y')]);
  assert.deepEqual(sent, ['x', 'xy', 'xy']);
  await queue.write('ok');
  assert.deepEqual(sent, ['x', 'xy', 'xy', 'ok']);
});

test('keys waiting to be retried are dropped only when their target goes away', async () => {
  const sent: string[] = [];
  const queue = createTerminalInputQueue(
    (data) => {
      sent.push(data);
      return Promise.reject(new Error('offline'));
    },
    { retryDelayMs: () => 60_000 },
  );
  const waiting = queue.write('a');
  const rejected = assert.rejects(waiting, TerminalInputCancelledError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  queue.dispose();
  await rejected;
  assert.deepEqual(sent, ['a']);
});

test('disconnect or target disposal rejects buffered input and never replays it on a new queue', async () => {
  const first = deferred();
  const sent: string[] = [];
  const old = createTerminalInputQueue(async (data) => {
    sent.push(data);
    await first.promise;
  });
  const inFlight = old.write('old-a');
  const buffered = old.write('old-b');
  const rejected = assert.rejects(buffered, TerminalInputCancelledError);
  old.dispose();
  await rejected;
  await assert.rejects(old.write('old-c'), TerminalInputCancelledError);
  const next = createTerminalInputQueue(async (data) => {
    sent.push(data);
  });
  await next.write('new target');
  first.resolve();
  await inFlight;
  assert.deepEqual(sent, ['old-a', 'new target']);
});
