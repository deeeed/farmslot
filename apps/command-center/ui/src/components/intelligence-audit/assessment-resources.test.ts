import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { AssessmentHistoryResult } from '@farmslot/protocol';

let owner = 'first-owner';
let connection = 1;
const history: AssessmentHistoryResult = {
  records: [],
  retentionDays: 30,
  auditHealth: { status: 'ok', failedWritesSinceStart: 0 },
};
let state = { status: 'ready', data: history };
let retries = 0;
let finish: (() => void) | undefined;
let hold = false;
const methods: string[] = [];
const cache = {
  read(query: { method: string }) {
    methods.push(query.method);
    return state;
  },
  async retry() {
    retries++;
    if (hold)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return state;
  },
};
let activeCache: typeof cache | undefined = cache;
mock.module('../../gateway-client.js', {
  namedExports: {
    gateway: {
      get connectionEpoch() {
        return connection;
      },
    },
  },
});
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => activeCache,
    getResourceWorkspaceKey: () => owner,
  },
});
const { readAssessment } = await import('./assessment-resources.js');

test('ready assessment reads use the shared cache; Refresh explicitly retries', async () => {
  assert.equal(
    await readAssessment<AssessmentHistoryResult>('assessment.list', { limit: 50 }),
    history,
  );
  assert.equal(retries, 0);
  assert.equal(
    await readAssessment<AssessmentHistoryResult>('assessment.list', { limit: 50 }, true),
    history,
  );
  assert.equal(retries, 1);
  assert.deepEqual(methods, [
    'assessment.list',
    'assessment.list',
    'assessment.list',
    'assessment.list',
  ]);
});

test('late assessment replies cannot cross cache owner or connection boundaries', async () => {
  hold = true;
  const pending = readAssessment<AssessmentHistoryResult>('assessment.list', {}, true);
  owner = 'replacement-owner';
  finish?.();
  await assert.rejects(pending, /owner or connection changed/);
  const connectionPending = readAssessment<AssessmentHistoryResult>('assessment.list', {}, true);
  connection++;
  finish?.();
  await assert.rejects(connectionPending, /owner or connection changed/);
  hold = false;
});

test('ordinary errors and unavailable stores remain failures instead of empty history', async () => {
  state = { status: 'error', data: history };
  await assert.rejects(readAssessment('assessment.list'), /current assessment read/);
  activeCache = undefined;
  await assert.rejects(readAssessment('assessment.list'), /store is unavailable/);
});
