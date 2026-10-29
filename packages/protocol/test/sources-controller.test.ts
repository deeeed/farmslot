import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { Methods } from '../src/rpc/registry.js';
import type { SourcesStatusResult } from '../src/rpc/sources.js';
import type { SourceRpcRequest } from '../src/sources/client.js';
import { SourceStatusController } from '../src/sources/controller.js';
import type { SourceStatusViewContext } from '../src/sources/status-view.js';

import { sourceCacheFixture } from './fixtures/source-cache.js';
import { sourceStatusFixture } from './fixtures/source-status.js';

function panel(t: TestContext, request: SourceRpcRequest, context: SourceStatusViewContext) {
  const transport = sourceCacheFixture(request);
  const controller = new SourceStatusController(transport.client, context, transport.cache);
  t.after(async () => {
    controller.dispose();
    await transport.cache.dispose();
  });
  return { controller, transport };
}

test('context and cache replacement never resubscribe a disposed connection', async (t) => {
  const context: SourceStatusViewContext = {
    connectionKey: 'old',
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['pin'],
  };
  const { controller, transport } = panel(t, async <T>() => sourceStatusFixture() as T, context);
  await controller.refresh();
  await transport.cache.dispose('profile-change');
  const replacement = sourceCacheFixture(
    async <T>() => ({ ...sourceStatusFixture(), declarationRevision: 19 }) as T,
  );
  t.after(() => replacement.cache.dispose());
  assert.doesNotThrow(() =>
    controller.bind({ ...context, connectionKey: 'new' }, replacement.cache),
  );
  await controller.refresh();
  assert.equal(controller.getSnapshot().view?.declarationRevision, 19);
  assert.equal(controller.getSnapshot().freshness, 'ready');
});

test('selected draft inputs block dispatch until cache facts are ready and after read failure', async (t) => {
  let release!: (status: SourcesStatusResult) => void;
  let deny = false;
  const held = new Promise<SourcesStatusResult>((resolve) => {
    release = resolve;
  });
  const { controller } = panel(
    t,
    async <T>(): Promise<T> => {
      if (deny) throw new Error('Source connection unavailable');
      return (await held) as T;
    },
    { actions: [], selections: [{ sourceId: 'pack', selection: 'branch', ref: 'experiment' }] },
  );
  assert(controller.getSnapshot().selectionRefusal);
  const ready = controller.refresh();
  release(sourceStatusFixture());
  await ready;
  assert.equal(controller.getSnapshot().freshness, 'ready');
  assert.equal(controller.getSnapshot().selectionRefusal, undefined);
  deny = true;
  await controller.refresh();
  assert.equal(controller.getSnapshot().selectionRefusal, 'Source connection unavailable');
  assert.equal(controller.getSnapshot().freshness, 'stale');
  assert.equal(controller.getSnapshot().canEdit, false);
});

test('a late cache response cannot replace the newly selected node', async (t) => {
  let release!: (status: SourcesStatusResult) => void;
  const held = new Promise<SourcesStatusResult>((resolve) => {
    release = resolve;
  });
  const { controller } = panel(
    t,
    async <T>(_method: string, params: unknown): Promise<T> => {
      if ((params as { nodeId: string }).nodeId === 'node-a') return (await held) as T;
      return { ...sourceStatusFixture(), declarationRevision: 9 } as T;
    },
    {
      connectionKey: 'farm',
      target: { scope: 'node', targetId: 'node-a' },
      actions: ['pin', 'unpin'],
    },
  );
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

test('uncertain mutations retain their exact branch and target without a post-command status read', async (t) => {
  const requests: unknown[] = [];
  let lost = true;
  const { controller, transport } = panel(
    t,
    async <T>(method: string, params: unknown): Promise<T> => {
      if (method === Methods.SOURCES_STATUS) return sourceStatusFixture() as T;
      requests.push(structuredClone(params));
      if (lost) {
        lost = false;
        throw new Error('response lost');
      }
      return { operationId: (params as { operationId: string }).operationId } as T;
    },
    {
      connectionKey: 'farm',
      target: { scope: 'node', targetId: 'node-a' },
      actions: ['pin', 'unpin'],
    },
  );
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
  const before = transport.reads;
  await controller.retry();
  assert.equal(
    transport.reads,
    before,
    'Only a writer notification refreshes the observation after a command',
  );
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(controller.getSnapshot().pending, undefined);
  assert.equal(controller.getSnapshot().view?.target?.targetId, 'node-b');
});

test('another farm or an offline cache cannot submit a retained mutation', async (t) => {
  let mutations = 0;
  const { controller, transport } = panel(
    t,
    async <T>(method: string): Promise<T> => {
      if (method === Methods.SOURCES_STATUS) return sourceStatusFixture() as T;
      mutations++;
      throw new Error('response lost');
    },
    {
      connectionKey: 'original-farm',
      target: { scope: 'farm', targetId: 'farm' },
      actions: ['unpin'],
    },
  );
  await controller.refresh();
  await controller.apply('unpin', 'pack');
  transport.disconnect();
  await controller.retry();
  assert.equal(mutations, 1);
  assert.equal(controller.getSnapshot().canRetry, false);
  controller.setContext({
    connectionKey: 'other-farm',
    target: { scope: 'farm', targetId: 'farm' },
    actions: ['unpin'],
  });
  transport.reconnect();
  await controller.refresh();
  await controller.retry();
  assert.equal(mutations, 1);
  assert.equal(controller.getSnapshot().canRetry, false);
  assert(controller.getSnapshot().error?.includes('original farm'));
});

test('selection echoes retain facts without starting another cache read', async (t) => {
  const { controller, transport } = panel(
    t,
    async <T>(): Promise<T> => sourceStatusFixture() as T,
    { actions: [], selections: [] },
  );
  await controller.refresh();
  const selected = { sourceId: 'pack', selection: 'branch' as const, ref: 'experiment' };
  controller.select(selected);
  assert.equal(controller.setContext({ actions: [], selections: [selected] }), false);
  assert.equal(controller.getSnapshot().view?.rows[0].selection?.ref, 'experiment');
  assert.equal(controller.getSnapshot().view?.declarationRevision, 1);
  assert.equal(transport.reads, 1);
});

test('partial sync diagnostics survive cache reads until another explicit operation', async (t) => {
  let partial = true;
  let readFailure = false;
  const diagnostic = { nodeId: 'node-1', sourceId: 'pack', reason: 'Node source sync timed out' };
  const { controller } = panel(
    t,
    async <T>(method: string, params: unknown): Promise<T> => {
      if (method === Methods.SOURCES_STATUS) {
        if (readFailure) throw new Error('Source status unavailable');
        return sourceStatusFixture() as T;
      }
      return {
        ...sourceStatusFixture(),
        operationId: (params as { operationId: string }).operationId,
        errors: partial ? [diagnostic] : [],
      } as T;
    },
    { connectionKey: 'farm', target: { scope: 'node', targetId: 'node-1' }, actions: ['sync'] },
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
