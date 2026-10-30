import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  createGatewayResourceCache,
  RESOURCE_PUBLISH_INTERVAL_MS,
  RESOURCE_REREAD_INTERVAL_MS,
  RESOURCE_RETRY_MAX_WAIT_MS,
  type ResourceCacheTransport,
  type ResourceKey,
  type ResourceQuery,
  resourceQuery,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

/** A gateway whose reads stay open until the test answers or fails them. */
function pacedGateway(t: TestContext, query: ResourceQuery) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  let changed: ((payload: ResourceChangedPayload) => void) | undefined;
  let revision = 0;
  const pending: Array<{ answer: () => void; fail: (error: Error) => void }> = [];
  let reads = 0;
  const transport: ResourceCacheTransport = {
    getConnection: () => ({
      id: 1,
      connected: true,
      authMode: 'token',
      scope: { gatewayUrl: 'ws://pacing.test', principalId: 'operator', principalGeneration: 0 },
      authority: { workspaceAccess: 'farm', roles: [] },
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        resourceChanges: {
          version: 1,
          epoch: 'pacing-epoch',
          versionLists: false,
          observedReads: 1,
          workspaceReads: 1,
          upstreamObservers: { version: 1, methods: ['pr.list'] },
        },
      },
    }),
    onConnectionChange: () => () => {},
    onResourceChanged: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    request<T>() {
      reads++;
      const sampled = revision;
      return new Promise<ResourceReadResult<T>>((resolve, reject) =>
        pending.push({
          answer: () =>
            resolve({
              data: { observation: { status: 'ready', observedAt: Date.now() } } as T,
              resourceState: {
                epoch: 'pacing-epoch',
                dependencies: query.dependencies.map((key) => ({ key, revision: sampled })),
              },
            }),
          fail: reject,
        }),
      );
    },
    replaceObservers: async (params) => ({ version: 1, sequence: params.sequence, applied: true }),
    resynchronize: () => assert.fail('The source epoch did not change'),
  };
  const cache = createGatewayResourceCache({ transport });
  return {
    cache,
    reads: () => reads,
    pending,
    change(keys: readonly ResourceKey[] = query.dependencies) {
      revision++;
      changed!({
        version: 1,
        epoch: 'pacing-epoch',
        changes: keys.map((key) => ({ key, revision, kind: 'updated' })),
      });
    },
    async flush() {
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test('a farm-wide slot read changing all the time is reread once per interval', async (t) => {
  const query = resourceQuery('fleet.status', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1000);
    gateway.change();
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.reads(), 1, 'A slot change right after a read waits for the interval');
    gateway.change();
    t.mock.timers.tick(RESOURCE_REREAD_INTERVAL_MS.slots! - 1001);
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'Changes during the interval leave one follow-up');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.cache.read(query).status, 'ready');
  } finally {
    stop();
  }
});

test('a change to a key that is not paced is read at its own cadence', async (t) => {
  const query = resourceQuery('copilot.status', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  const only = (family: string) => query.dependencies.filter((key) => key.family === family);
  try {
    await gateway.flush();
    gateway.pending.shift()!.answer();
    await gateway.flush();
    t.mock.timers.tick(1000);
    gateway.change(only('slots'));
    await gateway.flush();
    assert.equal(gateway.reads(), 1, 'A slot change waits for the slot interval');
    gateway.change(only('copilot'));
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'A copilot change is not held back by the slot change');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    gateway.change(only('slots'));
    t.mock.timers.tick(100);
    gateway.change(only('copilot'));
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'The copilot change waits only for its own interval');
    t.mock.timers.tick(RESOURCE_PUBLISH_INTERVAL_MS.copilot! - 101);
    await gateway.flush();
    assert.equal(gateway.reads(), 2);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 3, 'An armed slot wait gives way to the copilot cadence');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

test('a timed-out read is not sent again while the gateway may still be working on it', async (t) => {
  const query = resourceQuery('backlog.list', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  const timeOut = async (ms: number) => {
    gateway.change();
    t.mock.timers.tick(ms);
    gateway.pending.shift()!.fail(new Error('Request backlog.list timed out'));
    await gateway.flush();
  };
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    await timeOut(15_000);
    assert.equal(gateway.reads(), 1, 'A changed source does not reread at once after a timeout');
    t.mock.timers.tick(14_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'The first retry waits as long as the failed read took');
    await timeOut(15_000);
    t.mock.timers.tick(29_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'Each further failure doubles the wait');
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 3);
    for (let read = 4; read <= 8; read++) {
      await timeOut(15_000);
      t.mock.timers.tick(RESOURCE_RETRY_MAX_WAIT_MS);
      await gateway.flush();
      assert.equal(gateway.reads(), read, 'The wait stops growing at its maximum');
    }
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.cache.read(query).status, 'ready');
    gateway.change();
    await gateway.flush();
    assert.equal(gateway.reads(), 9, 'An answer ends the wait');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

test('a retry reads at once during the wait, and a returning observer reads when it ends', async (t) => {
  const query = resourceQuery('backlog.list', {});
  const gateway = pacedGateway(t, query);
  let stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    gateway.change();
    t.mock.timers.tick(15_000);
    gateway.pending.shift()!.fail(new Error('Request backlog.list timed out'));
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    void gateway.cache.retry(query);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'A retry is not delayed');
    t.mock.timers.tick(1_000);
    gateway.pending.shift()!.fail(new Error('Request backlog.list failed'));
    await gateway.flush();
    stop();
    stop = gateway.cache.observe(query, () => {});
    await gateway.flush();
    t.mock.timers.tick(1_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'A returning observer waits out the failed read');
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 3, 'and then reads');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.cache.read(query).status, 'ready');
    gateway.change();
    await gateway.flush();
    assert.equal(gateway.reads(), 4);
    gateway.change();
    t.mock.timers.tick(3_000);
    gateway.pending.shift()!.fail(new Error('Request backlog.list timed out'));
    await gateway.flush();
    t.mock.timers.tick(2_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 4);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 5, 'An answer resets the wait to the failed read length');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

test('a slot change cannot postpone a reread already due for another reason', async (t) => {
  const query = resourceQuery('fleet.status', {});
  const gateway = pacedGateway(t, query);
  let stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    t.mock.timers.tick(1_000);
    gateway.pending.shift()!.fail(new Error('Request fleet.status failed'));
    await gateway.flush();
    assert.equal(gateway.reads(), 1, 'An unchanged source is not reread after a failure');
    stop();
    stop = gateway.cache.observe(query, () => {});
    await gateway.flush();
    t.mock.timers.tick(500);
    gateway.change();
    await gateway.flush();
    t.mock.timers.tick(499);
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'The returning observer reads when the failure wait ends');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

test('the PR list waits longer for the slot, worker and run changes it only cross-references', async (t) => {
  const query = resourceQuery('pr.list', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  const only = (family: string) => query.dependencies.filter((key) => key.family === family);
  const interval = 30_000;
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    gateway.pending.shift()!.answer();
    await gateway.flush();
    for (let second = 1; second < interval / 1000; second++) {
      t.mock.timers.tick(1000);
      gateway.change([...only('workers'), ...only('runs'), ...only('slots')]);
      await gateway.flush();
    }
    assert.equal(gateway.reads(), 1, 'Worker, run and slot changes wait for the PR list interval');
    t.mock.timers.tick(1000);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'and then read once');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    t.mock.timers.tick(1000);
    gateway.change(only('workers'));
    await gateway.flush();
    gateway.change(only('upstream'));
    await gateway.flush();
    assert.equal(gateway.reads(), 3, 'A GitHub change is read at once');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

async function listWaitsForRunWrites(t: TestContext, query: ResourceQuery) {
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    gateway.pending.shift()!.answer();
    await gateway.flush();
    t.mock.timers.tick(60_000);
    gateway.change();
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'A change after a quiet minute is read at once');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    for (let second = 1; second < 30; second++) {
      t.mock.timers.tick(1000);
      gateway.change();
      await gateway.flush();
    }
    assert.equal(gateway.reads(), 2, 'Changes within 30 s of the last read wait');
    t.mock.timers.tick(1000);
    await gateway.flush();
    assert.equal(gateway.reads(), 3, 'and then read once');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    void gateway.cache.retry(query);
    await gateway.flush();
    assert.equal(gateway.reads(), 4, 'A retry is not delayed');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
}

test('the run list waits 30 s for the run writes that change it', (t) =>
  listWaitsForRunWrites(t, resourceQuery('run.list', {})));

test('a decision list paced by its consumer waits 30 s for the run writes that change it', (t) =>
  listWaitsForRunWrites(t, {
    ...resourceQuery('decision.list', {}),
    rereadIntervalMs: { decisions: 30_000 },
  }));

test('the registered decision list reads each change at once, for consumers that act only on a ready inbox', async (t) => {
  const query = resourceQuery('decision.list', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    gateway.pending.shift()!.answer();
    await gateway.flush();
    t.mock.timers.tick(1000);
    gateway.change();
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'A change a second after the last read is read at once');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});

test('retryAfterPending reads after a read in flight instead of joining it', async (t) => {
  const query = resourceQuery('decision.list', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    void gateway.cache.retry(query);
    const after = gateway.cache.retryAfterPending!(query);
    await gateway.flush();
    assert.equal(gateway.reads(), 1, 'retry joins the read in flight; retryAfterPending waits');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'and then reads');
    gateway.pending.shift()!.answer();
    assert.equal((await after).status, 'ready');
  } finally {
    stop();
  }
});
