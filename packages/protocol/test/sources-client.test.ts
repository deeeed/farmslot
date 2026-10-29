import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '../src/rpc/registry.js';
import {
  createSourceCommandClient,
  type PreparedSourceCommand,
  type SourceRpcRequest,
} from '../src/sources/client.js';

import { sourceStatusFixture } from './fixtures/source-status.js';

test('a lost acknowledgement retries the original operation and revisions without another status read', async () => {
  const status = sourceStatusFixture();
  const requests: Array<{ method: string; params: unknown }> = [];
  let lost = true;
  const request: SourceRpcRequest = async <T>(method: string, params: unknown): Promise<T> => {
    requests.push({ method, params: structuredClone(params) });
    if (method === Methods.SOURCES_STATUS) return structuredClone(status) as T;
    if (lost) {
      lost = false;
      throw new Error('response lost');
    }
    return { operationId: (params as { operationId: string }).operationId } as T;
  };
  const client = createSourceCommandClient(request);
  const prepared = await client.preparePin(
    { sourceId: 'pack', ref: 'experiment', scope: 'node', targetId: 'node-1' },
    'owned-operation',
  );
  assert.deepEqual(requests[0].params, { sourceId: 'pack', nodeId: 'node-1' });
  await assert.rejects(client.execute(prepared), /response lost/);
  status.pinRevision = 12;
  await client.execute(prepared);
  assert.equal(requests.filter((request) => request.method === Methods.SOURCES_STATUS).length, 1);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(prepared.params.expectedPinRevision, 2);
  assert.equal(prepared.params.operationId, 'owned-operation');
});

test('unsupported pins, local refs and immutable runs refuse before mutation', async () => {
  const status = sourceStatusFixture();
  const client = createSourceCommandClient(async <T>(method: string): Promise<T> => {
    assert.equal(method, Methods.SOURCES_STATUS);
    return structuredClone(status) as T;
  });
  await assert.rejects(
    client.preparePin({ sourceId: 'pack', ref: '/tmp/checkout', scope: 'farm', targetId: 'farm' }),
    /pushed branch/,
  );
  delete status.pinRevision;
  await assert.rejects(
    client.prepareUnpin({ sourceId: 'pack', scope: 'farm', targetId: 'farm' }),
    /does not support/,
  );
  status.pinRevision = 2;
  status.runSource = {
    runId: 'run-1',
    state: 'locked',
    canSelectSources: false,
    selectionRefusal: 'Inputs are already admitted',
  };
  await assert.rejects(
    client.prepareUnpin({ sourceId: 'pack', scope: 'run', targetId: 'run-1' }),
    /already admitted/,
  );
});

test('a cache-backed client refuses while its cache is unavailable and never reads status directly', async () => {
  const methods: string[] = [];
  const client = createSourceCommandClient(
    async <T>(method: PreparedSourceCommand['method']): Promise<T> => {
      methods.push(method);
      return {} as T;
    },
    () => undefined,
  );
  await assert.rejects(client.status(), /Wait for source facts/);
  await assert.rejects(client.prepareSync(), /Wait for source facts/);
  assert.deepEqual(methods, []);
});

test('a response for another operation cannot confirm a source mutation', async () => {
  const client = createSourceCommandClient(
    async <T>(method: string): Promise<T> =>
      (method === Methods.SOURCES_STATUS
        ? sourceStatusFixture()
        : { operationId: 'another-operation' }) as T,
  );
  const command = await client.prepareSync({ nodeId: 'node-1' }, 'sync-operation');
  await assert.rejects(client.execute(command), /different operation/);
});
