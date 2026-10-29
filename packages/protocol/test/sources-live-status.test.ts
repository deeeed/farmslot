import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createMemoryResourceStore } from '../src/client-cache/index.js';
import { Methods } from '../src/rpc/registry.js';
import type { SourcesStatusResult } from '../src/rpc/sources.js';
import { sourceStatusQuery } from '../src/sources/client.js';
import { SourceStatusController } from '../src/sources/controller.js';

import { sourceCacheFixture } from './fixtures/source-cache.js';
import { sourceStatusFixture } from './fixtures/source-status.js';

async function settle() {
  await setImmediate();
  await setImmediate();
}
function panel(t: TestContext) {
  let respond: () => Promise<SourcesStatusResult> = async () => sourceStatusFixture();
  const transport = sourceCacheFixture(async <T>(method: string): Promise<T> => {
    assert.equal(method, Methods.SOURCES_STATUS, 'Passive observations never execute a command');
    return (await respond()) as T;
  });
  const controller = new SourceStatusController(
    transport.client,
    {
      connectionKey: 'farm',
      target: { scope: 'farm', targetId: 'farm' },
      actions: ['pin', 'unpin'],
    },
    transport.cache,
  );
  t.after(async () => {
    controller.dispose();
    await transport.cache.dispose();
  });
  return {
    controller,
    transport,
    respond(next: () => Promise<SourcesStatusResult>) {
      respond = next;
    },
  };
}

test('an external pin updates an open cache-backed panel; duplicates do not read again', async (t) => {
  const p = panel(t);
  await p.controller.refresh();
  assert.equal(p.transport.reads, 1);
  assert.equal(p.controller.getSnapshot().view?.line, 'pack experiment');
  p.respond(async () => {
    const value = sourceStatusFixture();
    value.pinRevision = 3;
    value.effectiveSelections![0].effectiveRef = 'main';
    return value;
  });
  p.transport.publish(1);
  await settle();
  assert.equal(p.controller.getSnapshot().view?.line, 'pack main');
  assert.equal(p.transport.reads, 2);
  p.transport.publish(1);
  p.transport.publish(0);
  await settle();
  assert.equal(p.transport.reads, 2);
});

test('two writes during a slow read never restore stale ready source facts', async (t) => {
  const p = panel(t);
  await p.controller.refresh();
  let release!: (data: SourcesStatusResult) => void;
  p.respond(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  p.transport.publish(1);
  await settle();
  assert.equal(p.transport.reads, 2);
  p.transport.publish(2);
  p.transport.publish(3);
  p.transport.publish(3);
  await settle();
  assert.equal(p.transport.reads, 2);
  const latest = sourceStatusFixture();
  latest.pinRevision = 5;
  latest.effectiveSelections![0].effectiveRef = 'main';
  p.respond(async () => latest);
  release(sourceStatusFixture());
  await settle();
  assert.equal(p.transport.reads, 3);
  assert.equal(p.controller.getSnapshot().freshness, 'ready');
  assert.equal(p.controller.getSnapshot().view?.pinRevision, 5);
  assert.equal(p.controller.getSnapshot().view?.line, 'pack main');
});

test('disconnect retains stale facts, disables direct actions, and reconnect refetches without command replay', async (t) => {
  const p = panel(t);
  await p.controller.refresh();
  p.transport.disconnect();
  assert.equal(p.controller.getSnapshot().freshness, 'stale');
  assert.equal(p.controller.getSnapshot().view?.line, 'pack experiment');
  assert.equal(p.controller.getSnapshot().interactive, false);
  const selections = p.controller.getSnapshot().selections;
  p.controller.select({ sourceId: 'pack', selection: 'branch', ref: 'offline' });
  p.controller.clearSelection('pack');
  await p.controller.apply('pin', 'pack');
  assert.equal(p.transport.commands, 0);
  assert.deepEqual(p.controller.getSnapshot().selections, selections);
  assert.equal(p.transport.reads, 1);
  p.transport.reconnect();
  await settle();
  assert.equal(p.transport.reads, 2);
  assert.equal(p.controller.getSnapshot().freshness, 'ready');
  p.transport.disconnect();
  p.transport.reconnect('source-test-restarted');
  await settle();
  assert.equal(p.transport.reads, 3);
  assert.equal(p.controller.getSnapshot().freshness, 'ready');
});

test('stale age repaints without reads or selection changes and stops when ready or disposed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const p = panel(t);
  await p.controller.refresh();
  let paints = 0;
  const stop = p.controller.subscribe(() => paints++);
  t.after(stop);
  p.transport.disconnect();
  const stale = p.controller.getSnapshot();
  const beforePaint = paints;
  t.mock.timers.tick(1000);
  assert.equal(paints, beforePaint + 1, 'A visible stale age must repaint as time passes');
  const aged = p.controller.getSnapshot();
  assert.notEqual(aged, stale, 'External-store renderers need a new snapshot reference');
  assert.equal(aged.observedAt, stale.observedAt);
  assert.equal(aged.view, stale.view);
  assert.equal(aged.selections, stale.selections);
  assert.equal(p.transport.reads, 1);
  assert.equal(p.transport.commands, 0);
  p.transport.reconnect();
  await settle();
  assert.equal(p.controller.getSnapshot().freshness, 'ready');
  const readyPaints = paints;
  t.mock.timers.tick(60_000);
  assert.equal(paints, readyPaints, 'Ready data needs no age repaint timer');
  assert.equal(p.transport.reads, 2);
  p.transport.disconnect();
  p.controller.dispose();
  const disposedPaints = paints;
  t.mock.timers.tick(60_000);
  assert.equal(paints, disposedPaints);
  assert.equal(p.transport.reads, 2);
});

test('cold offline hydration keeps observation age and never enables source mutations', async (t) => {
  const store = createMemoryResourceStore();
  const transport = sourceCacheFixture(async <T>(): Promise<T> => {
    throw new Error('Offline reads are forbidden');
  }, store);
  transport.disconnect();
  const query = sourceStatusQuery();
  await store.setMetadata({
    scope: transport.connection().scope,
    authority: transport.connection().authority!,
  });
  await store.putQuery({
    id: query.id,
    data: sourceStatusFixture(),
    observedAt: 123456,
    bytes: 2000,
  });
  const controller = new SourceStatusController(
    transport.client,
    { actions: ['sync'] },
    transport.cache,
  );
  t.after(async () => {
    controller.dispose();
    await transport.cache.dispose();
  });
  await controller.refresh();
  assert.equal(controller.getSnapshot().freshness, 'stale');
  assert.equal(controller.getSnapshot().observedAt, 123456);
  assert.equal(controller.getSnapshot().view?.line, 'pack experiment');
  assert.equal(controller.getSnapshot().interactive, false);
  await controller.apply('sync', 'pack');
  assert.equal(transport.reads, 0);
  assert.equal(transport.commands, 0);
});

test('a refused source read hides and evicts its saved facts', async (t) => {
  const p = panel(t);
  await p.controller.refresh();
  await settle();
  const query = sourceStatusQuery();
  assert(await p.transport.store.getQuery(query.id));
  p.respond(async () => {
    throw Object.assign(new Error('Denied'), { code: 'AUTH_FORBIDDEN' });
  });
  p.transport.publish(1);
  await settle();
  assert.equal(p.controller.getSnapshot().view, undefined);
  assert.equal(p.controller.getSnapshot().hidden, true);
  assert.equal(await p.transport.store.getQuery(query.id), undefined);
});

test('missing notification support never marks a bounded read current or enables actions', async (t) => {
  const p = panel(t);
  await p.controller.refresh();
  p.transport.unsupported();
  await settle();
  const beforeRetry = p.transport.reads;
  await p.controller.refresh();
  assert.equal(p.controller.getSnapshot().unsupported, true);
  assert.equal(p.controller.getSnapshot().interactive, false);
  assert.equal(
    p.transport.reads,
    beforeRetry + 1,
    'Explicit Retry repeats one read without inventing freshness',
  );
});

test('an empty source context stays hidden while an ordinary read error remains visible', async (t) => {
  const p = panel(t);
  p.respond(async () => ({
    ...sourceStatusFixture(),
    configured: false,
    declarations: [],
    locks: [],
    effectiveSelections: [],
  }));
  await p.controller.refresh();
  assert.equal(p.controller.getSnapshot().hidden, true);
  p.respond(async () => {
    throw new Error('Execution node is disconnected');
  });
  await p.controller.refresh();
  assert.equal(p.controller.getSnapshot().hidden, false);
  assert.equal(p.controller.getSnapshot().error, 'Execution node is disconnected');
});
