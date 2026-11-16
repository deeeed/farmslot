import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubStepCollector } from '../../run-engine/sub-step-collector.js';

import { createPrepareGitTimer } from './prepare-git-timing.js';
import { createPrepareStream } from './prepare-stream.js';

test('Git timing retains each command result and exact nested duration without changing its phase', async (t) => {
  let clock = 1_000;
  t.mock.method(Date, 'now', () => clock);
  const collector = createSubStepCollector();
  const stream = createPrepareStream(collector.emit, {
    slotId: 'git-timing',
    requestId: 'timing-request',
    startTime: clock,
  });
  t.after(() => stream.complete(0));
  const timeGit = createPrepareGitTimer(
    (record) => stream.step(record.name, record.detail, record),
    () => clock,
  );
  const calls: string[] = [];
  stream.step('branch', 'Preparing the branch');
  const missing = { stdout: 'retained stdout', stderr: 'retained stderr', exitCode: 128 };
  const first = await timeGit('fetch-work-branch', async () => {
    calls.push('fetch');
    clock += 40;
    return missing;
  });
  assert.equal(first, missing, 'expected missing-branch handling receives the original result');
  clock += 10;
  const success = { stdout: 'checked out', stderr: '', exitCode: 0 };
  const second = await timeGit(
    'checkout-default',
    async () => {
      calls.push('guarded checkout');
      clock += 25;
      return success;
    },
    'guarded-mutation',
  );
  assert.equal(second, success);
  await timeGit('fetch-work-branch', async () => {
    calls.push('fetch');
    clock += 5;
    return success;
  });
  assert.deepEqual(calls, ['fetch', 'guarded checkout', 'fetch']);
  clock += 20;
  stream.step('fixtures', 'Syncing fixtures');
  const records = collector.finish();
  assert.deepEqual(
    records.map(({ name, durationMs }) => ({ name, durationMs })),
    [
      { name: 'git.1.fetch-work-branch', durationMs: 40 },
      { name: 'git.2.checkout-default', durationMs: 25 },
      { name: 'git.3.fetch-work-branch', durationMs: 5 },
      { name: 'branch', durationMs: 100 },
      { name: 'fixtures', durationMs: 0 },
    ],
  );
  assert.equal(records[0].outcome, 'failed');
  assert.equal(records[1].outcome, 'ok');
  assert.deepEqual(JSON.parse(records[1].detail!), {
    operation: 'checkout-default',
    scope: 'guarded-mutation',
    durationMs: 25,
    exitCode: 0,
  });
  assert.doesNotMatch(collector.getLastOutput(), /retained stdout|retained stderr|checked out/);
});

test('Git timing rethrows the original cancellation or transport failure after recording it', async () => {
  let clock = 0;
  const records: Array<{ detail: string; durationMs: number; outcome: string }> = [];
  const timeGit = createPrepareGitTimer(
    (record) => records.push(record),
    () => clock,
  );
  const cancellation = new Error('owned command cancelled');
  await assert.rejects(
    timeGit('fetch-default', async () => {
      clock = 12.5;
      throw cancellation;
    }),
    (error) => error === cancellation,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].durationMs, 12.5);
  assert.equal(records[0].outcome, 'failed');
  assert.equal(JSON.parse(records[0].detail).exitCode, null);
  assert.doesNotMatch(records[0].detail, /owned command cancelled/);
});
