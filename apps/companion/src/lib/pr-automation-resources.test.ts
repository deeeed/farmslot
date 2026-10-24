import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { PRPushListResult } from '@farmslot/protocol';
import type { ResourceQuery, ResourceQueryState } from '@farmslot/protocol/client-cache';

let owner = 'owner-a';
const data: PRPushListResult = { attention: [], devices: [], deliveries: [] };
let state: ResourceQueryState<PRPushListResult> = { status: 'ready', data };
let retries = 0;
let pending: ((value: ResourceQueryState<PRPushListResult>) => void) | undefined;
const cache = {
  read(query: ResourceQuery<unknown>) {
    assert.equal(query.method, 'prPush.list');
    assert.equal(query.persisted, false);
    return state;
  },
  retry(query: ResourceQuery<unknown>) {
    assert.equal(query.method, 'prPush.list');
    retries++;
    return new Promise<ResourceQueryState<PRPushListResult>>((resolve) => {
      pending = resolve;
    });
  },
};
mock.module('./resource-cache', {
  namedExports: { getResourceCache: () => cache, getResourceWorkspaceKey: () => owner },
});

test('notification registration admission reuses a ready canonical read and refuses late owner/error replies', async () => {
  const { readPRPushDevices } = await import('./pr-automation-resources');
  assert.equal(await readPRPushDevices<PRPushListResult>(), data);
  assert.equal(retries, 0);
  state = { status: 'stale', data, observedAt: 123 };
  const late = readPRPushDevices<PRPushListResult>();
  assert.equal(retries, 1);
  assert(pending);
  owner = 'owner-b';
  pending({ status: 'ready', data });
  await assert.rejects(late, /owner changed/);
  const failure = readPRPushDevices<PRPushListResult>();
  assert(pending);
  state = {
    status: 'error',
    error: { code: 'READ_FAILED', message: 'Private source unavailable' },
  };
  pending(state);
  await assert.rejects(failure, /Private source unavailable/);
});
