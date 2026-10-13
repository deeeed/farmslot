import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods } from '../src/rpc/registry.js';
import type { SourcesStatusResult } from '../src/rpc/sources.js';
import { createSourceCommandClient } from '../src/sources/client.js';
import { SourceStatusController } from '../src/sources/controller.js';

import { sourceStatusFixture } from './fixtures/source-status.js';

test('selected draft inputs block dispatch until current source facts load and after read failure', async () => {
  let release!: (status: SourcesStatusResult) => void;
  let deny = false;
  const held = new Promise<SourcesStatusResult>((resolve) => {
    release = resolve;
  });
  const client = createSourceCommandClient(async <T>(): Promise<T> => {
    if (deny) throw new Error('Source connection unavailable');
    return (await held) as T;
  });
  const controller = new SourceStatusController(client, {
    actions: [],
    selections: [{ sourceId: 'pack', selection: 'branch', ref: 'experiment' }],
  });
  assert(controller.getSnapshot().selectionRefusal);
  const refresh = controller.refresh();
  assert(controller.getSnapshot().selectionRefusal);
  release(sourceStatusFixture());
  await refresh;
  assert.equal(controller.getSnapshot().selectionRefusal, undefined);
  deny = true;
  await controller.refresh();
  assert.equal(controller.getSnapshot().selectionRefusal, 'Source connection unavailable');
});

test('a late status response cannot replace the newly selected node', async () => {
  let release!: (status: SourcesStatusResult) => void;
  const held = new Promise<SourcesStatusResult>((resolve) => {
    release = resolve;
  });
  const client = createSourceCommandClient(
    async <T>(_method: string, params: unknown): Promise<T> => {
      const node = (params as { nodeId: string }).nodeId;
      if (node === 'node-a') return (await held) as T;
      return { ...sourceStatusFixture(), declarationRevision: 9 } as T;
    },
  );
  const controller = new SourceStatusController(client, {
    connectionKey: 'farm',
    target: { scope: 'node', targetId: 'node-a' },
    actions: ['pin', 'unpin'],
  });
  const old = controller.refresh();
  controller.setContext({
    connectionKey: 'farm',
    target: { scope: 'node', targetId: 'node-b' },
    actions: ['pin', 'unpin'],
  });
  await controller.refresh();
  release(sourceStatusFixture());
  await old;
  assert.equal(controller.getSnapshot().view?.declarationRevision, 9);
  assert.equal(controller.getSnapshot().view?.target?.targetId, 'node-b');
});

test('uncertain mutations keep their original branch and target across view changes and retries', async () => {
  const requests: unknown[] = [];
  let lost = true;
  const client = createSourceCommandClient(
    async <T>(method: string, params: unknown): Promise<T> => {
      if (method === Methods.SOURCES_STATUS) return sourceStatusFixture() as T;
      requests.push(structuredClone(params));
      if (lost) {
        lost = false;
        throw new Error('response lost');
      }
      return { operationId: (params as { operationId: string }).operationId } as T;
    },
  );
  const controller = new SourceStatusController(client, {
    connectionKey: 'farm',
    target: { scope: 'node', targetId: 'node-a' },
    actions: ['pin', 'unpin'],
  });
  await controller.refresh();
  controller.select({ sourceId: 'pack', selection: 'branch', ref: 'experiment' });
  await controller.apply('pin', 'pack');
  assert(controller.getSnapshot().pendingLabel?.includes('experiment'));
  controller.setContext({
    connectionKey: 'farm',
    target: { scope: 'node', targetId: 'node-b' },
    actions: ['pin', 'unpin'],
  });
  await controller.refresh();
  assert(controller.getSnapshot().pendingLabel?.includes('node-a'));
  await controller.retry();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(controller.getSnapshot().pending, undefined);
  assert.equal(controller.getSnapshot().view?.target?.targetId, 'node-b');
});

test('another farm connection cannot submit a retained mutation', async () => {
  let mutations = 0;
  const client = createSourceCommandClient(async <T>(method: string): Promise<T> => {
    if (method === Methods.SOURCES_STATUS) return sourceStatusFixture() as T;
    mutations++;
    throw new Error('response lost');
  });
  const controller = new SourceStatusController(client, {
    connectionKey: 'original-farm',
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['unpin'],
  });
  await controller.refresh();
  await controller.apply('unpin', 'pack');
  controller.setContext({
    connectionKey: 'other-farm',
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['unpin'],
  });
  await controller.retry();
  assert.equal(mutations, 1);
  assert.equal(controller.getSnapshot().canRetry, false);
  assert(controller.getSnapshot().error?.includes('original farm'));
});

test('controlled selection echoes keep loaded facts and do not trigger another status read', async () => {
  let reads = 0;
  const controller = new SourceStatusController(
    createSourceCommandClient(async <T>(): Promise<T> => {
      reads++;
      return sourceStatusFixture() as T;
    }),
    { actions: [], selections: [] },
  );
  await controller.refresh();
  const selected = { sourceId: 'pack', selection: 'branch' as const, ref: 'experiment' };
  controller.select(selected);
  assert.equal(controller.setContext({ actions: [], selections: [selected] }), false);
  assert.equal(controller.getSnapshot().view?.rows[0].selection?.ref, 'experiment');
  assert.equal(controller.getSnapshot().view?.declarationRevision, 1);
  assert.equal(reads, 1);
});

test('partial sync diagnostics survive automatic and manual refresh until another operation', async () => {
  let partial = true;
  let readFailure = false;
  const diagnostic = {
    nodeId: 'node-1',
    sourceId: 'pack',
    reason: 'Node source sync timed out',
  };
  const controller = new SourceStatusController(
    createSourceCommandClient(async <T>(method: string, params: unknown): Promise<T> => {
      if (method === Methods.SOURCES_STATUS) {
        if (readFailure) throw new Error('Source status unavailable');
        return sourceStatusFixture() as T;
      }
      return {
        ...sourceStatusFixture(),
        operationId: (params as { operationId: string }).operationId,
        errors: partial ? [diagnostic] : [],
      } as T;
    }),
    {
      connectionKey: 'farm',
      target: { scope: 'node', targetId: 'node-1' },
      actions: ['sync'],
    },
  );
  await controller.refresh();
  await controller.apply('sync', 'pack');
  const operationError = controller.getSnapshot().operationError;
  assert(operationError?.includes(diagnostic.reason));
  assert(operationError.includes(diagnostic.nodeId));
  assert(operationError.includes(diagnostic.sourceId));
  assert(controller.getSnapshot().notice?.includes('completed with errors'));
  assert.equal(controller.getSnapshot().pending, undefined);
  assert.equal(controller.getSnapshot().canRetry, false);
  assert.equal(controller.getSnapshot().interactive, true);
  assert.deepEqual(controller.getSnapshot().view?.errors, []);

  await controller.refresh();
  assert.equal(controller.getSnapshot().operationError, operationError);
  readFailure = true;
  await controller.refresh();
  assert.equal(controller.getSnapshot().error, 'Source status unavailable');
  assert.equal(controller.getSnapshot().operationError, operationError);
  readFailure = false;
  await controller.refresh();
  assert.equal(controller.getSnapshot().error, undefined);
  assert.equal(controller.getSnapshot().operationError, operationError);

  partial = false;
  await controller.apply('sync', 'pack');
  assert.equal(controller.getSnapshot().operationError, undefined);
  assert(controller.getSnapshot().notice?.endsWith('applied.'));
});
