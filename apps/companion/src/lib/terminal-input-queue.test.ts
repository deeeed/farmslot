import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalInputQueue,
  keysRetryingNotice,
  TerminalInputCancelledError,
  withoutKeysRetryingNotice,
} from './terminal-input-queue';

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
test('a request that failed before it was sent is retried in order with the keys typed behind it', async () => {
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
  first.reject(new Error('Not connected'));
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
      if (refusals-- > 0) throw new Error('refused before sending');
      return Promise.resolve();
    },
    { retryDelayMs: () => 0 },
  );
  await Promise.all([queue.write('x'), queue.write('y')]);
  assert.deepEqual(sent, ['x', 'xy', 'xy']);
  await queue.write('ok');
  assert.deepEqual(sent, ['x', 'xy', 'xy', 'ok']);
});

// A lost reply after the frame went out: the pane may already have run the command.
test('input that failed after it was sent is held, never resent on its own', async () => {
  const pane: string[] = [];
  const holds: Array<string | null> = [];
  let loseReply = true;
  const queue = createTerminalInputQueue(
    async (data, _assertActive, markSent) => {
      pane.push(data);
      markSent();
      if (loseReply) {
        loseReply = false;
        throw new Error('Request terminal.input timed out after 10000ms');
      }
    },
    { retryDelayMs: () => 0, onHold: (held) => holds.push(held ? held.data : null) },
  );
  const once = queue.write('echo ONCE\r');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = queue.write('pwd\r');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(pane, ['echo ONCE\r'], 'nothing goes out while input is held');
  assert.deepEqual(holds, ['echo ONCE\r']);

  queue.resend();
  await Promise.all([once, next]);
  assert.deepEqual(pane, ['echo ONCE\r', 'echo ONCE\rpwd\r'], 'resend keeps the typed order');
  assert.deepEqual(holds, ['echo ONCE\r', null]);
});

test('discarding held input drops only it; the keys typed since go out', async () => {
  const pane: string[] = [];
  let loseReply = true;
  const queue = createTerminalInputQueue(async (data, _assertActive, markSent) => {
    pane.push(data);
    markSent();
    if (loseReply) {
      loseReply = false;
      throw new Error('Connection closed');
    }
  });
  const held = queue.write('make deploy\r');
  const discarded = assert.rejects(held, TerminalInputCancelledError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const next = queue.write('ls\r');
  queue.discard();
  await discarded;
  await next;
  assert.deepEqual(pane, ['make deploy\r', 'ls\r']);
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

test('keys still waiting are mentioned from the second failure and cleared once they go through', () => {
  assert.equal(keysRetryingNotice(new Error('Not connected'), 0), null, 'one failure is a blip');
  const notice = keysRetryingNotice(new Error('Not connected'), 1);
  assert.equal(notice, 'Keys not delivered yet, retrying in order: Not connected');
  assert.equal(withoutKeysRetryingNotice(notice), null);
  assert.equal(withoutKeysRetryingNotice('Pane gone'), 'Pane gone', 'other errors stay');
});

// With a gateway that writes each sequence number once, the phone resends on its own.
test(
  'a batch whose reply was lost is resent as is, and keys typed meanwhile follow it',
  { timeout: 5_000 },
  async () => {
    const requests: Array<{ data: string; n: number; stream: string }> = [];
    const holds: unknown[] = [];
    let loseReply = true;
    const typedDuringRetry = deferred();
    const queue = createTerminalInputQueue(
      async (data, _assertActive, markSent, seq) => {
        requests.push({ data, n: seq.n, stream: seq.stream });
        markSent();
        if (loseReply) {
          loseReply = false;
          await typedDuringRetry.promise;
          throw new Error('Request terminal.input timed out after 10000ms');
        }
      },
      {
        retryDelayMs: () => 0,
        resendsAreSafe: () => true,
        stream: 'q1',
        onHold: (h) => holds.push(h),
      },
    );
    const once = queue.write('echo ONCE\r');
    const next = queue.write('pwd\r');
    typedDuringRetry.resolve();
    await Promise.all([once, next]);
    assert.deepEqual(requests, [
      { data: 'echo ONCE\r', n: 1, stream: 'q1' },
      { data: 'echo ONCE\r', n: 1, stream: 'q1' },
      { data: 'pwd\r', n: 2, stream: 'q1' },
    ]);
    assert.deepEqual(holds, [], 'nothing to resend or discard by hand');
  },
);

test(
  'a numbered batch that failed before it was sent is resent alone, not merged',
  { timeout: 5_000 },
  async () => {
    const requests: Array<{ data: string; n: number }> = [];
    let refuse = true;
    const queue = createTerminalInputQueue(
      async (data, _assertActive, _markSent, seq) => {
        requests.push({ data, n: seq.n });
        if (refuse) {
          refuse = false;
          await Promise.resolve();
          throw new Error('Not connected');
        }
      },
      { retryDelayMs: () => 0, resendsAreSafe: () => true },
    );
    await Promise.all([queue.write('a'), queue.write('b')]);
    assert.deepEqual(requests, [
      { data: 'a', n: 1 },
      { data: 'a', n: 1 },
      { data: 'b', n: 2 },
    ]);
  },
);
