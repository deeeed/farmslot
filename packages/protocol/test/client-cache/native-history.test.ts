import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  type ResourceReadMethod,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import {
  nativeHistoryParams,
  nativeHistoryQuery,
  nativeObservationDependencies,
  nativeTimeline,
  nativeWork,
  readNativeHistory,
  retainNativeMessages,
  sameNativeHistoryIdentity,
} from '../../src/client-cache/native-history.js';
import type { NativeSessionEvent, NativeSessionReadResult } from '../../src/rpc/native-session.js';
import { Methods } from '../../src/rpc/registry.js';

const session: NativeSessionReadResult['session'] = {
  id: 'session',
  executionNodeId: 'local',
  ownerPrincipalId: 'owner-a',
  profileId: 'profile',
  accountContextId: 'account',
  generation: 'generation',
  nativeSessionId: 'native',
  hostPid: 1,
  runner: 'sample',
  cwd: '/workspace',
  executable: '',
  version: 'sample',
  mode: 'default',
  accountMode: 'native',
  state: 'idle',
  capabilities: {
    modes: ['default'],
    streaming: true,
    tools: true,
    approvals: true,
    questions: true,
    interrupt: true,
    resume: true,
  },
};
const event = (sequence: number, text: string, commandId = 'command'): NativeSessionEvent => ({
  sequence,
  text,
  commandId,
  generation: session.generation,
  sessionId: session.id,
  at: '2026-10-23T00:00:00Z',
  type: 'text.delta',
});
const page = (
  events: NativeSessionEvent[],
  cursor = events.at(-1)?.sequence ?? 0,
): NativeSessionReadResult => ({
  session,
  events,
  cursor,
  hasMore: false,
  commands: [],
  pendingRequests: [],
});
const target = { sessionId: session.id, executionNodeId: 'local' };
const signal = () => new AbortController().signal;
const basicController = () => {
  const controller = new AbortController();
  Object.defineProperties(controller.signal, {
    throwIfAborted: { value: undefined },
    reason: { value: undefined },
  });
  return controller;
};

test('a superseded native history page retains loaded messages and retries without a change notice', async () => {
  const query = nativeHistoryQuery(target, 'owner-a');
  class NativeTransport extends ResourceCacheConformanceTransport {
    override async request<T>(
      method: ResourceReadMethod,
      params: unknown,
      signal: AbortSignal,
    ): Promise<ResourceReadResult<T>> {
      const result = await super.request<T>(method, params, signal);
      return {
        ...result,
        resourceState: {
          epoch: 'conformance-epoch',
          dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
        },
      };
    }
  }
  const transport = new NativeTransport({
    gatewayUrl: 'ws://native-history.test',
    principalId: 'owner-a',
    principalGeneration: 0,
  });
  const capabilities = transport.connection.capabilities;
  assert(capabilities?.resourceChanges);
  transport.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      ...capabilities,
      resourceChanges: { ...capabilities.resourceChanges, observedReads: 1 },
    },
  });
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    const warm = cache.retry(query);
    const saved = { ...page([event(1, 'loaded')]), value: 'saved' };
    (await transport.nextRead()).resolve(saved);
    assert.equal((await warm).status, 'ready');
    const superseded = cache.retry(query);
    (await transport.nextRead()).reject('RESOURCE_OBSERVATION_CHANGED');
    await superseded;
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).error?.code, 'RESOURCE_OBSERVATION_CHANGED');
    assert.equal(cache.read(query).data?.cursor, 1);
    assert.equal(cache.read(query).data?.events[0].text, 'loaded');
    const followup = await transport.nextRead();
    assert.equal(transport.requestCount, 3);
    followup.resolve({ ...page([event(2, ' fresh')]), value: 'fresh' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).status, 'ready');
    assert.equal(cache.read(query).data?.cursor, 2);
    assert.equal(nativeTimeline(cache.read(query).data!.events)[0].text, 'loaded fresh');
  } finally {
    stop();
    await cache.dispose();
  }
});

test('200 logical messages retain every fragment of the newest message', () => {
  const events = Array.from({ length: 205 }, (_, i) =>
    event(i + 1, `message-${i}`, `command-${i}`),
  );
  events.push(...Array.from({ length: 500 }, (_, i) => event(206 + i, `${i},`, 'command-204')));
  const saved = retainNativeMessages(events);
  assert.equal(nativeTimeline(saved).length, 200);
  assert.equal(saved[0].commandId, 'command-5');
  assert.equal(
    nativeTimeline(saved).at(-1)?.text,
    'message-204' + Array.from({ length: 500 }, (_, i) => `${i},`).join(''),
  );
  assert.deepEqual(retainNativeMessages(saved), saved);
});

test('a running turn keeps its start through the cache, so its working time can be shown', async () => {
  const at = (
    sequence: number,
    type: NativeSessionEvent['type'],
    extra: Partial<NativeSessionEvent> = {},
  ) => ({
    ...event(sequence, ''),
    type,
    text: undefined,
    at: `2026-10-23T00:00:0${sequence}Z`,
    ...extra,
  });
  const bash = { nativeId: 'tool-1', tool: { name: 'Bash' } };
  const running = [
    at(1, 'command.submitted', { text: 'Run the tests.' }),
    at(2, 'command.accepted'),
    at(3, 'turn.started'),
    at(4, 'tool.started', bash),
  ];
  const result = await readNativeHistory(
    target,
    undefined,
    async () => ({ data: page(running) }),
    signal(),
  );
  assert.deepEqual(nativeWork(result.data.events), {
    since: Date.parse('2026-10-23T00:00:03Z'),
    tool: 'Bash',
  });
  assert.deepEqual(retainNativeMessages(result.data.events), result.data.events);
  const done = retainNativeMessages([
    ...running,
    at(5, 'tool.completed', bash),
    at(6, 'text.delta', { text: 'Done.' }),
    at(7, 'turn.completed'),
  ]);
  assert.equal(nativeWork(done), undefined);
  assert(!done.some((item) => item.type === 'turn.started'), 'a finished turn keeps no start');
  // A host restarted mid-turn cannot continue it.
  assert.equal(nativeWork([...running, at(5, 'session.started')]), undefined);
});

test('keeping the running turn start never reorders tool cards that finished out of order', () => {
  const at = (
    sequence: number,
    type: NativeSessionEvent['type'],
    extra: Partial<NativeSessionEvent> = {},
  ) => ({
    ...event(sequence, ''),
    type,
    text: undefined,
    ...extra,
  });
  const tool = (id: string, name: string) => ({ nativeId: id, tool: { name } });
  // A Task whose nested Bash ends first, then parallel reads that finish in reverse order.
  const events = [
    at(1, 'command.submitted', { text: 'Investigate.' }),
    at(2, 'turn.started'),
    at(3, 'tool.started', tool('task', 'Task')),
    at(4, 'tool.started', tool('bash', 'Bash')),
    at(5, 'tool.completed', tool('bash', 'Bash')),
    at(6, 'tool.completed', tool('task', 'Task')),
    at(7, 'tool.started', tool('a', 'Read')),
    at(8, 'tool.started', tool('b', 'Grep')),
    at(9, 'tool.completed', tool('b', 'Grep')),
    at(10, 'tool.completed', tool('a', 'Read')),
  ];
  const order = (items: NativeSessionEvent[]) => nativeTimeline(items).map((entry) => entry.text);
  const saved = retainNativeMessages(events);
  assert.deepEqual(order(saved), order(events));
  assert.deepEqual(order(saved), ['Investigate.', 'Task', 'Bash', 'Read', 'Grep']);
  assert.deepEqual(retainNativeMessages(saved), saved);
  assert.equal(nativeWork(saved)?.since, Date.parse(events[1].at));
});

test('a snapshot saved by the previous reader is read again from its start, once', async () => {
  const at = (sequence: number, type: NativeSessionEvent['type']) => ({
    ...event(sequence, ''),
    type,
    text: sequence === 1 ? 'Run the tests.' : undefined,
  });
  const history = [at(1, 'command.submitted'), at(2, 'turn.started'), at(3, 'text.delta')];
  // The previous reader dropped turn.started but kept the cursor.
  const saved = {
    ...page([history[0], history[2]], 3),
    historyRead: { pageReadCount: 1, pageAfters: [0] },
  };
  const afters: Array<number | undefined> = [];
  const read = (previous: NativeSessionReadResult) =>
    readNativeHistory(
      target,
      previous,
      async (params) => {
        afters.push(params.after);
        const after = params.after ?? 0;
        return {
          data: page(
            history.filter((item) => item.sequence > after),
            3,
          ),
        };
      },
      signal(),
    );
  const replayed = await read(saved);
  assert.deepEqual(afters, [undefined]);
  assert.equal(nativeWork(replayed.data.events)?.since, Date.parse(history[1].at));
  assert.equal(nativeTimeline(replayed.data.events).length, 2, 'no message twice');
  await read(replayed.data);
  assert.deepEqual(afters, [undefined, 3], 'the replayed snapshot resumes from its cursor');
});

test('a resolved request stays through the cache; a snapshot that dropped it is read again', async () => {
  const at = (
    sequence: number,
    type: NativeSessionEvent['type'],
    extra: Partial<NativeSessionEvent> = {},
  ) => ({
    ...event(sequence, ''),
    type,
    text: undefined,
    ...extra,
  });
  const request = { id: 'request', title: 'Allow runner action?', detail: 'rm -r build' };
  const history = [
    at(1, 'command.submitted', { text: 'Clean up.' }),
    at(2, 'approval.requested', { nativeId: 'native-request', request }),
    at(3, 'approval.resolved', {
      nativeId: 'native-request',
      request,
      response: { decision: 'approve' },
    }),
    at(4, 'turn.completed', { status: 'completed' }),
  ];
  assert.deepEqual(
    retainNativeMessages(history).map((item) => item.sequence),
    [1, 3, 4],
  );
  // The previous reader kept no resolutions, but kept the cursor.
  const saved = {
    ...page([history[0], history[3]], 4),
    historyRead: { pageReadCount: 1, pageAfters: [0], projection: 2 },
  };
  const afters: Array<number | undefined> = [];
  const replayed = await readNativeHistory(
    target,
    saved,
    async (params) => {
      afters.push(params.after);
      const after = params.after ?? 0;
      return {
        data: page(
          history.filter((item) => item.sequence > after),
          4,
        ),
      };
    },
    signal(),
  );
  assert.deepEqual(afters, [undefined]);
  assert.deepEqual(
    nativeTimeline(replayed.data.events).map(({ kind, text }) => [kind, text]),
    [
      ['user', 'Clean up.'],
      ['resolution', 'Approved: rm -r build'],
      ['status', 'Turn completed'],
    ],
  );
});

test('a finished tool keeps its key through the cache, so a card the reader opened stays open', () => {
  const at = (
    sequence: number,
    type: NativeSessionEvent['type'],
    extra: Partial<NativeSessionEvent> = {},
  ) => ({
    ...event(sequence, ''),
    type,
    text: undefined,
    ...extra,
  });
  const bash = { nativeId: 'tool-1', tool: { name: 'Bash' } };
  const running = [at(1, 'command.submitted', { text: 'Run it.' }), at(2, 'tool.started', bash)];
  const keyOf = (events: NativeSessionEvent[]) =>
    nativeTimeline(events).find((e) => e.kind === 'tool')?.key;
  assert.equal(keyOf(retainNativeMessages(running)), 2);
  const finished = retainNativeMessages([
    ...running,
    at(3, 'text.delta', { text: 'ok' }),
    at(4, 'tool.completed', bash),
  ]);
  assert.equal(keyOf(finished), 2);
  assert.equal(
    nativeTimeline(finished).find((e) => e.kind === 'tool')?.event.type,
    'tool.completed',
  );
  assert.deepEqual(retainNativeMessages(finished), finished);
});

test('cursor pages merge into one complete observation and keep the conservative stamp', async () => {
  const calls: number[] = [];
  const result = await readNativeHistory(
    target,
    undefined,
    async (params) => {
      const after = params.after ?? 0;
      calls.push(after);
      return {
        data: { ...page([event(after + 1, after ? 'second' : 'first')]), hasMore: !after },
        resourceState: {
          epoch: 'epoch',
          dependencies: [
            {
              key: {
                family: 'native-session',
                nodeId: 'local',
                ownerId: 'owner-a',
                sessionId: 'session',
              },
              revision: after ? 9 : 3,
            },
          ],
        },
      };
    },
    signal(),
  );
  assert.deepEqual(calls, [0, 1]);
  assert.equal(result.data.cursor, 2);
  assert.equal(result.data.hasMore, false);
  assert.equal(nativeTimeline(result.data.events)[0].text, 'firstsecond');
  assert.equal(result.resourceState?.dependencies[0].revision, 3);
});

test('saved absolute cursor resumes without replaying old fragments or commands', async () => {
  const previous = page([event(1, 'old')], 100);
  let calls = 0;
  const result = await readNativeHistory(
    target,
    previous,
    async (params) => {
      calls++;
      assert.equal(params.after, 100);
      return { data: page([event(101, 'new')]) };
    },
    signal(),
  );
  assert.equal(calls, 1);
  assert.equal(result.data.cursor, 101);
  assert.equal(nativeTimeline(result.data.events)[0].text, 'oldnew');
});

test('session, owner, account/profile, generation and lease replacement never inherit saved history', async () => {
  const previous = page([event(1, 'private')]);
  for (const field of [
    'id',
    'executionNodeId',
    'ownerPrincipalId',
    'profileId',
    'accountContextId',
    'nativeSessionId',
    'generation',
    'workerLeaseId',
  ] as const) {
    const next = { ...page([]), session: { ...session, [field]: 'replacement' } };
    assert.equal(sameNativeHistoryIdentity(previous, next), false);
    await assert.rejects(
      readNativeHistory(target, previous, async () => ({ data: next }), signal()),
      (error: unknown) => (error as { code: string }).code === 'NOT_FOUND',
    );
  }
});

test('missing/deleted sessions preserve the refusal for the shared cache eviction path', async () => {
  await assert.rejects(
    readNativeHistory(
      target,
      page([event(1, 'private')]),
      async () => {
        throw Object.assign(new Error('Removed by authorized lookup'), { code: 'NOT_FOUND' });
      },
      signal(),
    ),
    (error: unknown) => (error as { code: string }).code === 'NOT_FOUND',
  );
});

test('held late page is ignored after cancellation and cannot start another page', async () => {
  const controller = new AbortController();
  let release!: (value: { data: NativeSessionReadResult }) => void;
  let calls = 0;
  const result = readNativeHistory(
    target,
    undefined,
    () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    controller.signal,
  );
  controller.abort();
  release({ data: { ...page([event(1, 'late private text')]), hasMore: true } });
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('basic AbortSignal drains pages without throwIfAborted or reason', async () => {
  const controller = basicController();
  const calls: number[] = [];
  const result = await readNativeHistory(
    target,
    undefined,
    async (params) => {
      const after = params.after ?? 0;
      calls.push(after);
      return { data: { ...page([event(after + 1, 'text')]), hasMore: !after } };
    },
    controller.signal,
  );
  assert.deepEqual(calls, [0, 1]);
  assert.equal(result.data.cursor, 2);
});

test('a basic signal aborted before reading refuses without a request', async () => {
  const controller = basicController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    readNativeHistory(
      target,
      undefined,
      async () => {
        calls++;
        return { data: page([]) };
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 0);
});

test('a basic signal aborted during I/O drops the reply and cannot drain another page', async () => {
  const controller = basicController();
  let calls = 0;
  await assert.rejects(
    readNativeHistory(
      target,
      undefined,
      async () => {
        calls++;
        controller.abort();
        return { data: { ...page([event(1, 'late private text')]), hasMore: true } };
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('a modern signal preserves its explicit cancellation reason', async () => {
  const controller = new AbortController();
  const reason = new Error('The owner changed');
  controller.abort(reason);
  await assert.rejects(
    readNativeHistory(target, undefined, async () => ({ data: page([]) }), controller.signal),
    (error: unknown) => error === reason,
  );
});

test('cursor variants cannot consume the ten-session retention policy', () => {
  for (const variant of [{ after: 1 }, { limit: 200 }, { cursor: 2 }])
    assert.throws(() => nativeHistoryParams({ ...target, ...variant }), /cursors/);
  assert.deepEqual(nativeHistoryParams({ sessionId: 'session' }), target);
  const query = nativeHistoryQuery(target, 'owner-a');
  assert.equal(query.persisted, true);
  assert.equal(query.retention?.maxEntries, 10);
  assert.equal(query.id.includes('after'), false);
});

test('two readers and admin use distinct authorized native/profile key scopes', () => {
  for (const method of [
    Methods.NATIVE_SESSION_READ,
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_PROFILE_LIST,
  ]) {
    const owners = ['owner-a', 'owner-b', 'admin'].map((owner) =>
      nativeObservationDependencies(method, target, owner),
    );
    assert.notDeepEqual(owners[0], owners[1]);
    assert.notDeepEqual(owners[0], owners[2]);
    assert.throws(() => nativeObservationDependencies(method, target, ''), /authenticated owner/);
  }
});

test('released worker boundaries cannot grow or silently transfer to a successor', async () => {
  const worker = {
    runId: 'run',
    contextId: 'context',
    leaseId: 'lease',
    generation: session.generation,
  };
  const previous = {
    ...page([event(1, 'task history')]),
    session: { ...session, workerLeaseId: 'lease' },
    scope: { leaseId: 'lease', startAfter: 0, endAt: 1, released: true },
  };
  await assert.rejects(
    readNativeHistory(
      { ...target, worker },
      previous,
      async () => ({
        data: { ...previous, scope: { ...previous.scope, endAt: 2, released: false } },
      }),
      signal(),
    ),
    /boundaries/,
  );
});

// These integration cases require the parent-owned cache/registry delta. They exercise the
// existing store and lifecycle boundary rather than a second transcript storage implementation.
import { createGatewayResourceCache } from '../../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import type { ResourceReadMethod } from '../../src/client-cache/registry.js';
import {
  createMemoryResourceStore,
  type ResourceStoreScope,
} from '../../src/client-cache/store.js';
import type { ResourceReadResult } from '../../src/client-cache/types.js';

interface HeldNativeRead {
  params: unknown;
  signal: AbortSignal;
  resolve(value: NativeSessionReadResult, revision?: number): void;
  reject(code: string): void;
}
class NativeTransport extends ResourceCacheConformanceTransport {
  constructor(scope: ResourceStoreScope) {
    super(scope);
    const capabilities = this.connection.capabilities!;
    this.connection.capabilities = {
      ...capabilities,
      resourceChanges: {
        ...capabilities.resourceChanges!,
        observedReads: 1,
      },
    };
  }
  private queue: HeldNativeRead[] = [];
  private waiting?: (read: HeldNativeRead) => void;
  override request<T>(
    _method: ResourceReadMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ResourceReadResult<T>> {
    this.requestCount++;
    return new Promise((resolve, reject) => {
      const read: HeldNativeRead = {
        params,
        signal,
        resolve: (data, revision = 0) =>
          resolve({
            data: data as T,
            resourceState: {
              epoch: 'conformance-epoch',
              dependencies: nativeObservationDependencies(
                Methods.NATIVE_SESSION_READ,
                params,
                this.connection.scope.principalId!,
              ).map((key) => ({ key, revision })),
            },
          }),
        reject: (code) => reject(Object.assign(new Error(code), { code })),
      };
      if (this.waiting) {
        const receive = this.waiting;
        this.waiting = undefined;
        receive(read);
      } else this.queue.push(read);
    });
  }
  nextNative(): Promise<HeldNativeRead> {
    const read = this.queue.shift();
    if (read) return Promise.resolve(read);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
const storeScope = {
  gatewayUrl: 'ws://native-history.invalid/',
  profileId: 'profile',
  principalId: 'owner-a',
  principalGeneration: 0,
};

test('several observers share the history read and reconnect performs no command replay', async () => {
  const transport = new NativeTransport(storeScope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const query = nativeHistoryQuery(target, 'owner-a');
  const stops = [cache.observe(query, () => {}), cache.observe(query, () => {})];
  try {
    const read = await transport.nextNative();
    const ready = cache.retry(query);
    read.resolve(page([event(1, 'private')]));
    assert.equal((await ready).status, 'ready');
    assert.equal(transport.requestCount, 1);
    transport.setConnection({ connected: false }, 'network');
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).data?.events[0].text, 'private');
    transport.setConnection({ connected: true, id: 2 });
    const next = await transport.nextNative();
    assert.equal((next.params as { after: number }).after, 1);
    const settled = cache.retry(query);
    next.resolve(page([], 1));
    assert.equal((await settled).status, 'ready');
    assert.equal(transport.requestCount, 2);
  } finally {
    stops.forEach((stop) => stop());
    await cache.dispose();
  }
});

test('history stays actionable while a change rereads it; failed and offline history waits', async () => {
  const transport = new NativeTransport(storeScope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const query = nativeHistoryQuery(target, 'owner-a');
  const stop = cache.observe(query, () => {});
  const change = (revision: number) =>
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [{ key: query.dependencies[0], revision, kind: 'updated' }],
    });
  const canAct = () => {
    const state = cache.read(query);
    return nativeHistoryCanAct(state, state.data, transport.connection.connected);
  };
  const reread = async (settle: (read: HeldNativeRead) => void) => {
    const read = await transport.nextNative();
    const settled = cache.retry(query);
    settle(read);
    await settled;
  };
  try {
    await reread((read) => read.resolve(page([event(1, 'first')])));
    assert(canAct());

    change(1);
    assert.equal(cache.read(query).status, 'stale');
    assert(canAct(), 'a change notice keeps current history actionable');
    await reread((read) => {
      change(2);
      read.resolve(page([event(2, 'second')]), 1);
    });
    assert.equal(cache.read(query).status, 'stale');
    assert(canAct(), 'a reply that trails a write made during its read stays actionable');
    await reread((read) => read.resolve(page([event(3, 'third')]), 2));
    assert.equal(cache.read(query).status, 'ready');

    change(3);
    await reread((read) => read.reject('RESOURCE_OBSERVATION_CHANGED'));
    assert(canAct(), 'a read superseded by a newer write still trails only that write');

    change(4);
    await reread((read) => read.reject('NATIVE_SOURCE_UNAVAILABLE'));
    assert.equal(cache.read(query).status, 'stale');
    assert(!canAct(), 'a failed reread waits for a current read');

    const recovered = cache.retry(query);
    (await transport.nextNative()).resolve(page([event(4, 'fourth')]), 4);
    assert.equal((await recovered).status, 'ready');
    transport.setConnection({ connected: false }, 'network');
    assert.equal(cache.read(query).status, 'stale');
    assert(!canAct(), 'offline history waits for a current read');
    transport.setConnection({ connected: true, id: 2 });
    assert(canAct(), 'after reconnecting, the due reread does not lock input, as for held lists');
  } finally {
    stop();
    await cache.dispose();
  }
});

test('eleven opened sessions persist ten canonical histories; cold data keeps original age', async () => {
  const transport = new NativeTransport(storeScope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const savedStore = createMemoryResourceStore();
  let lastQuery = nativeHistoryQuery(target, 'owner-a');
  try {
    for (let i = 0; i < 11; i++) {
      lastQuery = nativeHistoryQuery({ ...target, sessionId: `session-${i}` }, 'owner-a');
      const ready = cache.retry(lastQuery);
      const read = await transport.nextNative();
      read.resolve({ ...page([]), session: { ...session, id: `session-${i}` } });
      assert.equal((await ready).status, 'ready');
    }
    const entries = await store.listQueries();
    assert.equal(entries.length, 10);
    assert(
      !entries.some(
        (entry) =>
          entry.id === nativeHistoryQuery({ ...target, sessionId: 'session-0' }, 'owner-a').id,
      ),
    );
    await savedStore.setMetadata((await store.getMetadata())!);
    for (const entry of entries) await savedStore.putQuery((await store.getQuery(entry.id))!);
    const original = (await store.getQuery(lastQuery.id))!;
    await cache.dispose();
    const offline = new NativeTransport(storeScope);
    const cold = createGatewayResourceCache({ transport: offline, store: savedStore });
    try {
      const restored = await cold.retry(lastQuery);
      assert.equal(restored.status, 'stale');
      assert(
        !nativeHistoryCanAct(restored, restored.data, true),
        'saved history waits for a live read',
      );
      assert.equal(restored.observedAt, original.observedAt);
      assert.deepEqual(restored.data, original.data);
      assert.equal(offline.requestCount, 0);
    } finally {
      await cold.dispose();
    }
  } finally {
    await cache.dispose();
  }
});

test('authority retirement fences a held reply and authorized not-found evicts saved history', async () => {
  const transport = new NativeTransport(storeScope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const query = nativeHistoryQuery(target, 'owner-a');
  try {
    const first = cache.retry(query);
    (await transport.nextNative()).resolve(page([event(1, 'private')]));
    await first;
    const removed = cache.retry(query);
    (await transport.nextNative()).reject('NOT_FOUND');
    assert.equal((await removed).data, undefined);
    assert.equal(await store.getQuery(query.id), undefined);
    const pending = cache.retry(query);
    const held = await transport.nextNative();
    transport.setConnection({ connected: false }, 'sign-out');
    held.resolve(page([event(1, 'late private')]));
    await pending;
    assert.equal(cache.read(query).data, undefined);
    assert.equal(held.signal.aborted, true);
  } finally {
    await cache.dispose();
  }
});

import {
  nativeHistoryStorageId,
  storedNativeHistoryMatches,
} from '../../src/client-cache/native-history.js';
test('lease variants share one durable session entry but cannot hydrate each other', () => {
  const worker = {
    runId: 'run',
    contextId: 'context',
    generation: session.generation,
    leaseId: 'first',
  };
  const first = nativeHistoryQuery({ ...target, worker }, 'owner-a');
  const second = nativeHistoryQuery(
    { ...target, worker: { ...worker, leaseId: 'second' } },
    'owner-a',
  );
  assert.notEqual(first.id, second.id);
  assert.equal(nativeHistoryStorageId(first), nativeHistoryStorageId(second));
  const saved = {
    ...page([]),
    session: { ...session, workerLeaseId: 'first' },
    scope: { leaseId: 'first', startAfter: 0, endAt: 0, released: true },
  };
  assert(storedNativeHistoryMatches({ ...target, worker }, saved));
  assert(
    !storedNativeHistoryMatches({ ...target, worker: { ...worker, leaseId: 'second' } }, saved),
  );
});

import {
  nativeHistoryCanAct,
  nativeHistoryCanSend,
} from '../../src/client-cache/native-history.js';
test('cold, saved, unsupported and replaced rendered snapshots disable real command eligibility', () => {
  const saved = page([event(1, 'saved')]);
  const now = Date.parse('2026-10-30T00:00:00Z');
  const resourceState = { epoch: 'epoch', dependencies: [] };
  for (const status of ['loading', 'error', 'unsupported'] as const)
    assert(!nativeHistoryCanAct({ status, data: saved, resourceState }, saved, true, now));
  const ready = { status: 'ready' as const, data: saved, resourceState };
  assert(!nativeHistoryCanAct(ready, saved, false, now));
  assert(!nativeHistoryCanAct({ ...ready, data: { ...saved } }, saved, true, now));
  assert(nativeHistoryCanAct(ready, saved, true, now));
  // A reread that is only due keeps input usable; saved data does not.
  const due = { status: 'stale' as const, data: saved, resourceState, observedAt: now };
  assert(nativeHistoryCanAct(due, saved, true, now));
  assert(!nativeHistoryCanAct(due, saved, false, now));
  assert(!nativeHistoryCanAct({ status: 'stale', data: saved }, saved, true, now), 'restored');
  const failed = { code: 'NATIVE_SOURCE_UNAVAILABLE', message: 'unavailable' };
  assert(!nativeHistoryCanAct({ ...due, error: failed }, saved, true, now));
  const superseded = {
    ...due,
    error: { code: 'RESOURCE_OBSERVATION_CHANGED', message: 'changed' },
  };
  assert(nativeHistoryCanAct(superseded, saved, true, now + 59_999));
  assert(!nativeHistoryCanAct(superseded, saved, true, now + 60_000));
});

test('turn status records do not consume the 200 logical message allowance', () => {
  const events: NativeSessionEvent[] = [];
  for (let i = 0; i < 205; i++) {
    events.push(event(i * 2 + 1, `answer-${i}`, `command-${i}`));
    events.push({
      ...event(i * 2 + 2, '', `command-${i}`),
      type: 'turn.completed',
      status: 'completed',
    });
  }
  const saved = nativeTimeline(retainNativeMessages(events));
  assert.equal(saved.filter((entry) => entry.kind === 'assistant').length, 200);
  assert.equal(saved.find((entry) => entry.kind === 'assistant')?.text, 'answer-5');
});

test('tool events do not consume the 200 conversation message allowance', () => {
  const events: NativeSessionEvent[] = [];
  for (let i = 0; i < 205; i++) {
    const command = `command-${i}`;
    events.push(event(events.length + 1, `message-${i}`, command));
    events.push({
      ...event(events.length + 1, '', command),
      type: 'tool.started',
      nativeId: `tool-${i}`,
      tool: { name: 'read_file' },
    });
    events.push({
      ...event(events.length + 1, '', command),
      type: 'tool.completed',
      nativeId: `tool-${i}`,
      tool: { name: 'read_file' },
    });
  }
  const retained = nativeTimeline(retainNativeMessages(events));
  assert.equal(retained.filter((entry) => entry.kind === 'assistant').length, 200);
  assert.equal(retained[0].event.commandId, 'command-5');
});

test('a newer read while a turn streams refuses an answer on the old snapshot, not a message', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const resourceState = { epoch: 'epoch', dependencies: [] };
  const rendered = page([event(1, 'counting')]);
  const read = (data: NativeSessionReadResult) => ({
    status: 'ready' as const,
    data,
    resourceState,
  });
  // The worker kept streaming: the cache holds a newer read than the one on screen.
  const newer = read(page([event(1, 'counting'), event(2, ' on')]));
  assert(!nativeHistoryCanAct(newer, rendered, true, now));
  assert(nativeHistoryCanSend(newer, rendered, true, now));
  // Another conversation by now: resumed, another worker lease, or the task released.
  const resumed = read({
    ...newer.data,
    session: { ...newer.data.session, generation: 'resumed' },
  });
  assert(!nativeHistoryCanSend(resumed, rendered, true, now), 'resumed generation');
  const leased = read({ ...newer.data, session: { ...newer.data.session, workerLeaseId: 'next' } });
  assert(!nativeHistoryCanSend(leased, rendered, true, now), 'another lease');
  const scope = { leaseId: 'lease', startAfter: 0, endAt: 9, released: true };
  const released = read({ ...newer.data, scope });
  assert(
    !nativeHistoryCanSend(
      released,
      { ...rendered, scope: { ...scope, released: false } },
      true,
      now,
    ),
  );
  // Saved, offline or incomplete history still waits.
  assert(
    !nativeHistoryCanSend({ status: 'stale', data: rendered }, rendered, true, now),
    'restored',
  );
  assert(!nativeHistoryCanSend(newer, rendered, false, now));
  assert(!nativeHistoryCanSend(read({ ...newer.data, hasMore: true }), rendered, true, now));
});
