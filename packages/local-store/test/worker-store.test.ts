import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import { resourceStoreScopeId, runResourceStoreConformance } from '@farmslot/protocol/client-cache';

import { ResourceStoreWorkerClient } from '../src/worker-client.js';
import type { StoreWorkerPort } from '../src/worker-protocol.js';

function fixture() {
  const worker = new Worker(new URL('./sqlite-worker.fixture.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
  });
  const port: StoreWorkerPort = {
    postMessage: (request) => worker.postMessage(request),
    onMessage(listener) {
      worker.on('message', listener);
      return () => {
        worker.off('message', listener);
      };
    },
    onError(listener) {
      worker.on('error', listener);
      return () => {
        worker.off('error', listener);
      };
    },
    terminate() {
      void worker.terminate();
    },
  };
  const client = new ResourceStoreWorkerClient(port);
  return { client, worker };
}

test('the browser worker adapter runs portable conformance against real SQLite WebAssembly', async () => {
  const { client, worker } = fixture();
  try {
    const passed = await runResourceStoreConformance((scope) => client.open(scope));
    assert.equal(passed.length, 18);
    const diagnostics = await client.diagnostics();
    assert.equal(diagnostics.storage, 'memory-test');
    assert.equal(diagnostics.integrity, 'ok');
  } finally {
    client.close();
    await worker.terminate();
  }
});

test('a different tab deleting a scope seals existing proxies and removes its SQL rows', async () => {
  const { client, worker } = fixture();
  const scope = { gatewayUrl: 'ws://sqlite.invalid/', principalId: 'p', principalGeneration: 0 };
  try {
    const old = await client.open(scope);
    await old.putQuery({ id: 'q', data: { value: 'before deletion' }, observedAt: 1, bytes: 20 });
    await client.deleteScope(resourceStoreScopeId(scope));
    assert(old.deleted);
    await old.putQuery({ id: 'q', data: { value: 'late' }, observedAt: 2, bytes: 5 });
    const fresh = await client.open(scope);
    assert.equal(await fresh.getQuery('q'), undefined);
    await old.close();
    await fresh.close();
  } finally {
    client.close();
    await worker.terminate();
  }
});
