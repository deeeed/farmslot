import assert from 'node:assert/strict';
import test from 'node:test';

import { ExecRequests } from './exec-requests.js';

test('cancel waits for actual closeout and cannot reach another connection', async () => {
  const owner = new ExecRequests();
  const other = new ExecRequests();
  let finish!: () => void;
  let runningSignal!: AbortSignal;
  const execution = owner.run('request', async (signal) => {
    runningSignal = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return 'closed';
  });
  await Promise.resolve();
  assert.equal(other.cancel('request'), false);
  assert.equal(runningSignal.aborted, false);
  assert.equal(owner.cancel('request'), true);
  assert.equal(runningSignal.aborted, true);
  await assert.rejects(
    owner.run('request', async () => 'duplicate'),
    /already active/,
  );
  finish();
  assert.equal(await execution, 'closed');
  assert.equal(owner.cancel('request'), false);
});

test('connection close aborts all of its requests and prevents late starts', async () => {
  const owner = new ExecRequests();
  const executions = ['first', 'second'].map((id) =>
    owner.run(id, async (signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return signal.aborted;
    }),
  );
  await Promise.resolve();
  const closed = owner.close();
  assert.deepEqual(await Promise.all(executions), [true, true]);
  await closed;
  await assert.rejects(
    owner.run('late', async () => false),
    /connection is closed/,
  );
});

test('failed executions release their request without changing another request', async () => {
  const owner = new ExecRequests();
  await assert.rejects(
    owner.run('failed', async () => {
      throw new Error('spawn failed');
    }),
    /spawn failed/,
  );
  assert.equal(owner.cancel('failed'), false);
  assert.equal(await owner.run('failed', async () => 'reused'), 'reused');
});

test('a connection closed before execution begins cannot start a queued command', async () => {
  const owner = new ExecRequests();
  let effects = 0;
  const execution = owner.run('queued', async () => {
    effects += 1;
  });
  const closed = owner.close();
  await assert.rejects(execution, { name: 'AbortError' });
  await closed;
  assert.equal(effects, 0);
});
