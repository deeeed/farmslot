import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunGetParams, RunGetResult } from '@farmslot/protocol';

import { readRunProgressively } from './progressive-run-read.js';

function result(summary: string): RunGetResult {
  return {
    run: {
      id: 'run-a',
      familyId: 'run-a',
      parentRunId: null,
      familyRootTicketOrPr: 'TAT-1',
      lane: 'production',
      variant: null,
      flowType: 'dev',
      mode: 'autonomous',
      status: 'human-gating',
      project: 'project',
      ticketOrPr: 'TAT-1',
      slotId: 'slot',
      branch: 'branch',
      taskFile: null,
      steps: [],
      decisions: [],
      metrics: {
        nudgeCount: 0,
        model: null,
        runner: null,
        runnerSessionId: null,
        runnerSessionPath: null,
      },
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
      summary,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('stored facts paint while current readiness remains held, then current data wins', async () => {
  const live = deferred<RunGetResult>();
  const shown = deferred<RunGetResult>();
  const requests: RunGetParams[] = [];
  let completed = false;
  const read = readRunProgressively(
    'run-a',
    async (params) => {
      requests.push(params);
      return params.view === 'snapshot' ? result('saved gate') : live.promise;
    },
    shown.resolve,
  ).then((value) => {
    completed = true;
    return value;
  });

  assert.equal((await shown.promise).run.summary, 'saved gate');
  assert.equal(completed, false, 'a display snapshot must not verify current actions');
  assert.deepEqual(requests, [{ runId: 'run-a', view: 'snapshot' }, { runId: 'run-a' }]);
  live.resolve(result('current gate'));
  assert.equal((await read).run.summary, 'current gate');
});

test('a failed current read preserves the displayed facts but rejects action verification', async () => {
  const live = deferred<RunGetResult>();
  const shown = deferred<RunGetResult>();
  const read = readRunProgressively(
    'run-a',
    async (params) => (params.view ? result('saved gate') : live.promise),
    shown.resolve,
  );
  assert.equal((await shown.promise).run.summary, 'saved gate');
  live.reject(new Error('Current source unavailable'));
  await assert.rejects(read, /Current source unavailable/);
});

test('a late stored reply cannot replace the current run', async () => {
  const stored = deferred<RunGetResult>();
  let shown = false;
  const read = readRunProgressively(
    'run-a',
    async (params) => (params.view ? stored.promise : result('current gate')),
    () => {
      shown = true;
    },
  );
  assert.equal((await read).run.summary, 'current gate');
  stored.resolve(result('old gate'));
  await stored.promise;
  assert.equal(shown, false);
});

test('a failed optional snapshot falls back to the current read', async () => {
  const read = readRunProgressively(
    'run-a',
    async (params) => {
      if (params.view) throw new Error('Snapshot refused');
      return result('current gate');
    },
    () => assert.fail('there is no snapshot'),
  );
  assert.equal((await read).run.summary, 'current gate');
});

test('two failed reads retain both failures and the current not-found classification', async () => {
  const read = readRunProgressively(
    'run-a',
    async () => {
      throw new Error('Run not found: run-a');
    },
    () => assert.fail('there is no snapshot'),
  );
  await assert.rejects(read, (error: unknown) => {
    assert(error instanceof AggregateError);
    assert.match(error.message, /^Run not found:/);
    assert.equal(error.errors.length, 2);
    return true;
  });
});
