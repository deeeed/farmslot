import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTerminalInputQueue,
  keysRetryingNotice,
  TerminalInputCancelledError,
  TerminalInputMaybeTypedError,
  terminalInputRetryDelayMs,
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
test('a request that failed before it was sent is resent as is, and the keys typed behind it follow', async () => {
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
  assert.deepEqual(sent, ['a', 'a', 'b']);
  assert.deepEqual(retries, [0]);
  await queue.write('c');
  assert.deepEqual(sent, ['a', 'a', 'b', 'c']);
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
  assert.deepEqual(sent, ['x', 'x', 'x', 'y']);
  await queue.write('ok');
  assert.deepEqual(sent, ['x', 'x', 'x', 'y', 'ok']);
});

// A gateway without numbered input cannot tell a resend from new keys: the batch it may have typed
// is dropped with a notice, never sent twice, and the keys typed since go out.
test('a gateway without numbering: input that failed after it was sent is dropped, not resent', async () => {
  const pane: string[] = [];
  let loseReply = true;
  const queue = createTerminalInputQueue(
    async (data, _assertActive, markSent) => {
      pane.push(data);
      markSent(false);
      if (loseReply) {
        loseReply = false;
        throw new Error('Request terminal.input timed out after 10000ms');
      }
    },
    { retryDelayMs: () => 0 },
  );
  const once = queue.write('echo ONCE\r');
  const dropped = assert.rejects(once, (error: unknown) => {
    assert.ok(error instanceof TerminalInputMaybeTypedError);
    assert.match(error.message, /may have reached the terminal.*timed out/);
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.write('pwd\r');
  await dropped;
  assert.deepEqual(pane, ['echo ONCE\r', 'pwd\r']);
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
    let loseReply = true;
    const typedDuringRetry = deferred();
    const queue = createTerminalInputQueue(
      async (data, _assertActive, markSent, seq) => {
        requests.push({ data, n: seq.n, stream: seq.stream });
        markSent(true);
        if (loseReply) {
          loseReply = false;
          await typedDuringRetry.promise;
          throw new Error('Request terminal.input timed out after 10000ms');
        }
      },
      { retryDelayMs: () => 0, stream: 'q1' },
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
      { retryDelayMs: () => 0 },
    );
    await Promise.all([queue.write('a'), queue.write('b')]);
    assert.deepEqual(requests, [
      { data: 'a', n: 1 },
      { data: 'a', n: 1 },
      { data: 'b', n: 2 },
    ]);
  },
);

// The pane records what it was typed, so a restarted gateway drops the repeat itself.
test('a batch whose reply was lost goes to a restarted gateway as is', async () => {
  const requests: Array<{ data: string; n: number }> = [];
  let restarts = 1;
  const queue = createTerminalInputQueue(
    async (data, _assertActive, markSent, seq) => {
      requests.push({ data, n: seq.n });
      markSent(true);
      if (restarts-- > 0) throw new Error('Connection closed');
    },
    { retryDelayMs: () => 0 },
  );
  await queue.write('make deploy\r');
  await queue.write('ls\r');
  assert.deepEqual(requests, [
    { data: 'make deploy\r', n: 1 },
    { data: 'make deploy\r', n: 1 },
    { data: 'ls\r', n: 2 },
  ]);
});

// Only a node predating numbered input answers this: the batch is dropped, the keys behind it go.
test('a batch the gateway reports uncertain is dropped with a notice; later keys go out', async () => {
  const requests: string[] = [];
  const queue = createTerminalInputQueue(
    async (data, _assertActive, markSent) => {
      requests.push(data);
      markSent(true);
      if (requests.length === 1)
        throw Object.assign(new Error('may already be in the terminal'), {
          code: 'TERMINAL_INPUT_UNCERTAIN',
        });
    },
    { retryDelayMs: () => 0 },
  );
  const uncertain = assert.rejects(queue.write('make deploy\r'), TerminalInputMaybeTypedError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await queue.write('ls\r');
  await uncertain;
  assert.deepEqual(requests, ['make deploy\r', 'ls\r']);
});

// The gateway proves a refusal wrote nothing: it is retried, more slowly, until the pane is ready.
test('a batch the gateway refused is retried on the longer backoff, then the keys behind it', async () => {
  const requests: string[] = [];
  const delays: Array<[number, boolean]> = [];
  const retries: string[] = [];
  const queue = createTerminalInputQueue(
    async (data, _assertActive, markSent) => {
      requests.push(data);
      markSent(true);
      if (requests.length <= 2)
        throw Object.assign(new Error('No PTY or agent available for slot demo-work-1'), {
          code: 'INTERNAL_ERROR',
        });
    },
    {
      retryDelayMs: (attempt, answered) => {
        delays.push([attempt, answered]);
        return 0;
      },
      onRetry: (error, attempt) => retries.push(keysRetryingNotice(error, attempt) ?? 'quiet'),
    },
  );
  const first = queue.write('ls\r');
  const second = queue.write('pwd\r');
  await Promise.all([first, second]);
  assert.deepEqual(requests, ['ls\r', 'ls\r', 'ls\r', 'pwd\r']);
  assert.deepEqual(delays, [
    [0, true],
    [1, true],
  ]);
  assert.deepEqual(retries, [
    'quiet',
    'Keys not delivered yet, retrying in order: No PTY or agent available for slot demo-work-1',
  ]);
});

test('retries back off to 4 s without an answer and 30 s after a refusal', () => {
  assert.deepEqual(
    [0, 1, 4, 10].map((attempt) => terminalInputRetryDelayMs(attempt, false)),
    [250, 500, 4_000, 4_000],
  );
  assert.deepEqual(
    [0, 4, 6, 10].map((attempt) => terminalInputRetryDelayMs(attempt, true)),
    [250, 4_000, 16_000, 30_000],
  );
});
