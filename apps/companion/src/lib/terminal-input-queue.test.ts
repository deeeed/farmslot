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

test('failure reaches all affected callers and drops unsent keys without retry', async () => {
  const first = deferred();
  const sent: string[] = [];
  const queue = createTerminalInputQueue(async (data) => {
    sent.push(data);
    if (sent.length === 1) await first.promise;
  });
  const a = queue.write('a');
  const b = queue.write('b');
  const checks = [assert.rejects(a, /offline/), assert.rejects(b, /offline/)];
  first.reject(new Error('offline'));
  await Promise.all(checks);
  assert.deepEqual(sent, ['a']);
  await queue.write('new input');
  assert.deepEqual(sent, ['a', 'new input']);
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

test('a synchronous send failure is reported and does not wedge later input', async () => {
  const sent: string[] = [];
  const queue = createTerminalInputQueue((data) => {
    sent.push(data);
    if (data === 'bad') throw new Error('refused');
    return Promise.resolve();
  });
  await assert.rejects(queue.write('bad'), /refused/);
  await queue.write('ok');
  assert.deepEqual(sent, ['bad', 'ok']);
});
