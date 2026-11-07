import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../src/client-cache/conformance.js';
import { nativeConversationStorageId } from '../src/client-cache/native-conversation.js';
import {
  createNativeConversationCache,
  type NativeConversationState,
  reduceNativeConversation,
} from '../src/client-cache/native-conversation.js';
import {
  nativeHistoryCanAct,
  nativeHistoryQuery,
  nativeHistoryStorageId,
} from '../src/client-cache/native-history.js';
import { createMemoryResourceStore } from '../src/client-cache/store.js';
import type { ResourceCacheConnection } from '../src/client-cache/types.js';
import type {
  NativeConversationUpdate,
  NativeSessionDeltaPayload,
  NativeSessionReadResult,
  NativeSessionSubscribeParams,
} from '../src/rpc/native-session.js';

const target = { sessionId: 'session', executionNodeId: 'mini' };
const cursor = { ...target, hostGeneration: 'host', generation: 'process', sequence: 0 };
const page: NativeSessionReadResult = {
  session: {
    id: 'session',
    generation: 'process',
    hostPid: 1,
    runner: 'pi',
    nativeSessionId: 'conversation',
    ownerPrincipalId: 'farm',
    executionNodeId: 'mini',
    accountContextId: 'ambient',
    cwd: '/work',
    executable: '/bin/pi',
    version: '1',
    mode: 'default',
    accountMode: 'native',
    state: 'running',
    capabilities: {
      modes: ['default'],
      streaming: true,
      tools: true,
      approvals: true,
      questions: true,
      interrupt: true,
      resume: true,
    },
  },
  events: [],
  commands: [],
  pendingRequests: [],
  cursor: 0,
  hasMore: false,
};
const initial: NativeConversationUpdate = {
  kind: 'reset',
  cursor,
  snapshot: { ...page, historyBefore: 0, truncated: false },
};
function delta(
  sequence: number,
  text = 'text',
): Extract<NativeSessionDeltaPayload, { kind: 'delta' }> {
  return {
    subscriptionId: 'subscription',
    kind: 'delta',
    cursor: { ...cursor, sequence },
    page: {
      cursor: sequence,
      events: [
        {
          sessionId: target.sessionId,
          generation: 'process',
          sequence,
          at: '2026-11-07T00:00:00Z',
          type: 'text.delta',
          text,
          commandId: 'command',
        },
      ],
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

test('shared reduction appends text, ignores duplicates and rejects gaps or generation/lease splices', () => {
  let snapshot = reduceNativeConversation(undefined, initial);
  snapshot = reduceNativeConversation(snapshot, delta(1, 'hello'));
  snapshot = reduceNativeConversation(snapshot, delta(2, ' world'));
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].text, 'hello world');
  assert.deepEqual(reduceNativeConversation(snapshot, delta(2, ' world')), snapshot);
  assert.throws(() => reduceNativeConversation(snapshot, delta(4)), /gap/);
  assert.throws(
    () =>
      reduceNativeConversation(snapshot, {
        ...delta(3),
        cursor: { ...cursor, sequence: 3, generation: 'successor' },
      }),
    /source changed/,
  );
  assert.throws(
    () =>
      reduceNativeConversation(snapshot, {
        ...delta(3),
        cursor: {
          ...cursor,
          sequence: 3,
          worker: {
            runId: 'run',
            contextId: 'review',
            generation: 'process',
            leaseId: 'new-lease',
          },
        },
      }),
    /source changed/,
  );
});

test('tool interleaving, request metadata and completion do not duplicate assistant text', () => {
  let snapshot = reduceNativeConversation(undefined, initial);
  snapshot = reduceNativeConversation(snapshot, delta(1, 'before'));
  const tool = {
    ...delta(2),
    page: {
      ...delta(2).page,
      events: [
        {
          ...delta(2).page.events[0],
          type: 'tool.started' as const,
          text: undefined,
          nativeId: 'tool',
        },
      ],
    },
  };
  snapshot = reduceNativeConversation(snapshot, tool);
  snapshot = reduceNativeConversation(snapshot, delta(3, 'after'));
  const completion = {
    ...delta(4),
    page: {
      cursor: 4,
      session: { ...page.session, state: 'idle' as const },
      commands: [
        {
          commandId: 'command',
          generation: 'process',
          submitted: true,
          accepted: true,
          state: 'completed' as const,
        },
      ],
      pendingRequests: [],
      events: [{ ...delta(4).page.events[0], type: 'turn.completed' as const, text: undefined }],
    },
  };
  snapshot = reduceNativeConversation(snapshot, completion);
  assert.equal(snapshot.session.state, 'idle');
  assert.deepEqual(
    snapshot.events.filter((event) => event.type === 'text.delta').map((event) => event.text),
    ['before', 'after'],
  );
  assert.equal(snapshot.commands[0].state, 'completed');
});

test('bounded active text retains the prefix and exposes its original journal continuation', () => {
  let snapshot = reduceNativeConversation(undefined, initial);
  for (let i = 1; i <= 30; i++)
    snapshot = reduceNativeConversation(snapshot, delta(i, `${i}:` + 'x'.repeat(60_000)));
  assert.ok(snapshot.events[0].text?.startsWith('1:'));
  assert.ok(snapshot.retainedBytes <= 832 * 1024);
  assert.ok(snapshot.omissions?.length);
  assert.equal(snapshot.omissions?.[0].through, 30);
  assert.ok(snapshot.streamCursor);
  const reset = {
    ...initial,
    kind: 'reset' as const,
    cursor: snapshot.streamCursor,
    snapshot: { ...snapshot, events: [{ ...snapshot.events[0], text: 'durable prefix' }] },
  };
  snapshot = reduceNativeConversation(snapshot, reset);
  assert.equal(snapshot.events[0].text, 'durable prefix');
  assert.equal(snapshot.cursor, 30);
});

test('two views share one logical subscription, initial-before-live, pause and reconnect never send commands', async () => {
  let connected: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let listener: ((payload: NativeSessionDeltaPayload) => void) | undefined;
  const subscriptions: NativeSessionSubscribeParams[] = [];
  const stopped: string[] = [];
  const saved: NativeConversationState['data'][] = [];
  const controller = createNativeConversationCache(
    {
      async subscribe(params) {
        subscriptions.push(params);
        listener?.(delta(1, 'arrived before the promise continuation'));
        return { ...initial, subscriptionId: 'subscription' };
      },
      async unsubscribe(id) {
        stopped.push(id);
      },
      onDelta(callback) {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    },
    {
      load: async () => undefined,
      save: async (_target, snapshot) => {
        saved.push(snapshot);
      },
      forget: async () => undefined,
    },
    () => connected,
  );
  const states: NativeConversationState[] = [];
  const first = controller.api.observe(target, (state) => states.push(state));
  const second = controller.api.observe(target, () => undefined);
  await settle();
  assert.equal(subscriptions.length, 1);
  assert.equal(states.at(-1)?.data?.events[0].text, 'arrived before the promise continuation');
  first();
  assert.deepEqual(stopped, []);
  connected = { ...connected, connected: false };
  controller.connectionChanged(false);
  assert.equal(controller.api.read(target).status, 'stale');
  assert.equal(controller.api.read(target).data?.cursor, 1);
  connected = { ...connected, id: 2, connected: true };
  controller.connectionChanged(false);
  await settle();
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[1].after?.sequence, 1);
  second();
  await settle();
  assert.equal(stopped.length, 2);
  assert.ok(saved.length);
  controller.dispose(false);
});

test('access withdrawal evicts the held conversation; a late initial reply is unsubscribed', async () => {
  const connected: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let release!: (result: typeof initial & { subscriptionId: string }) => void;
  const result = new Promise<typeof initial & { subscriptionId: string }>((resolve) => {
    release = resolve;
  });
  let stops = 0;
  const controller = createNativeConversationCache(
    {
      subscribe: async () => result,
      unsubscribe: async () => {
        stops++;
      },
      onDelta: () => () => undefined,
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => connected,
  );
  const stop = controller.api.observe(target, () => undefined);
  await settle();
  stop();
  release({ ...initial, subscriptionId: 'late' });
  await settle();
  assert.equal(stops, 1);
  controller.connectionChanged(true);
  assert.equal(controller.api.read(target).data, undefined);
  controller.dispose(true);
});

test('last detach withdraws action authority before an asynchronous reopen', async () => {
  const connected: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let opens = 0;
  let release!: (result: typeof initial & { subscriptionId: string }) => void;
  const pending = new Promise<typeof initial & { subscriptionId: string }>((resolve) => {
    release = resolve;
  });
  const controller = createNativeConversationCache(
    {
      subscribe: async () => (++opens === 1 ? { ...initial, subscriptionId: 'first' } : pending),
      unsubscribe: async () => undefined,
      onDelta: () => () => undefined,
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => connected,
  );
  const stop = controller.api.observe(target, () => undefined);
  await settle();
  assert.equal(controller.api.read(target).status, 'ready');
  stop();
  assert.equal(controller.api.read(target).status, 'stale');
  assert.equal(controller.api.read(target).conversation, undefined);
  const second = controller.api.observe(target, () => undefined);
  assert.equal(controller.api.read(target).status, 'stale');
  await settle();
  release({ ...initial, subscriptionId: 'second' });
  await settle();
  assert.equal(controller.api.read(target).status, 'ready');
  second();
  await controller.dispose(false);
});

test('an old unsubscribe refusal cannot evict a replacement subscription', async () => {
  const connected: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let reject!: (error: Error) => void;
  const retired = new Promise<void>((_resolve, decline) => {
    reject = decline;
  });
  let opens = 0;
  const controller = createNativeConversationCache(
    {
      subscribe: async () => ({ ...initial, subscriptionId: `id-${++opens}` }),
      unsubscribe: async (id) => (id === 'id-1' ? retired : undefined),
      onDelta: () => () => undefined,
    },
    {
      load: async () => undefined,
      save: async () => undefined,
      forget: async () => {
        throw new Error('Replacement must not be evicted');
      },
    },
    () => connected,
  );
  const first = controller.api.observe(target, () => undefined);
  await settle();
  first();
  const second = controller.api.observe(target, () => undefined);
  await settle();
  reject(Object.assign(new Error('old credential refused'), { code: 'AUTH_FORBIDDEN' }));
  await settle();
  assert.equal(controller.api.read(target).status, 'ready');
  assert.ok(controller.api.read(target).data);
  second();
  await controller.dispose(false);
});

test('every in-flight open recovers after their shared early-frame inbox overflows', async () => {
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let receive!: (payload: NativeSessionDeltaPayload) => void;
  const held: Array<() => void> = [];
  let opens = 0;
  const controller = createNativeConversationCache(
    {
      async subscribe(params) {
        const index = ++opens;
        const result = {
          ...initial,
          subscriptionId: `s${index}`,
          cursor: { ...cursor, sessionId: params.sessionId },
          snapshot: { ...initial.snapshot, session: { ...page.session, id: params.sessionId } },
        };
        if (index <= 2)
          return new Promise<typeof result>((resolve) => {
            held.push(() => resolve(result));
          });
        return result;
      },
      unsubscribe: async () => undefined,
      onDelta(listener) {
        receive = listener;
        return () => undefined;
      },
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => connection,
  );
  const other = { ...target, sessionId: 'other' };
  const a = controller.api.observe(target, () => undefined);
  const b = controller.api.observe(other, () => undefined);
  await settle();
  assert.equal(held.length, 2);
  receive({ ...delta(1, 'x'.repeat(600_000)), subscriptionId: 's1' });
  receive({ ...delta(1, 'y'.repeat(600_000)), subscriptionId: 's2' });
  held.forEach((release) => release());
  await settle();
  assert.equal(opens, 4, 'Both affected views require a fresh bounded reset');
  assert.equal(controller.api.read(target).status, 'ready');
  assert.equal(controller.api.read(other).status, 'ready');
  a();
  b();
  await controller.dispose(false);
});

test('cache disposal persists the final streamed text before closing storage', async () => {
  const base = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://test',
    principalId: 'reader',
    principalGeneration: 0,
  });
  base.setConnection({
    id: 1,
    connected: true,
    capabilities: { ...base.connection.capabilities!, conversationStreaming: 1 },
  });
  let receive!: (payload: NativeSessionDeltaPayload) => void;
  const transport = Object.assign(base, {
    conversations: {
      subscribe: async () => ({ ...initial, subscriptionId: 'subscription' }),
      unsubscribe: async () => undefined,
      onDelta(listener: (payload: NativeSessionDeltaPayload) => void) {
        receive = listener;
        return () => undefined;
      },
    },
  });
  const store = createMemoryResourceStore();
  const savedStore = createMemoryResourceStore();
  const close = store.close.bind(store);
  store.close = async () => {
    for (const row of await store.listQueries()) {
      const saved = await store.getQuery(row.id);
      if (saved) await savedStore.putQuery(saved);
    }
    await close();
  };
  const cache = createGatewayResourceCache({ transport, store });
  cache.conversations!.observe(target, () => undefined);
  await settle();
  receive(delta(1, 'last committed text'));
  await cache.dispose('network');
  const saved = await savedStore.getQuery<{ cursor: number; events: Array<{ text?: string }> }>(
    nativeConversationStorageId(target),
  );
  assert.equal(saved?.data.cursor, 1);
  assert.equal(saved?.data.events[0].text, 'last committed text');
});

test('an old native offline history stays visible but cannot invent live authority or a host cursor', async () => {
  const scope = { gatewayUrl: 'ws://test', principalId: 'reader', principalGeneration: 0 };
  const transport = new ResourceCacheConformanceTransport(scope);
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: transport.connection.authority! });
  const saved = {
    ...page,
    cursor: 1,
    events: delta(1, 'saved before the upgrade').page.events,
    historyRead: { projection: 5, pageReadCount: 1, pageAfters: [0] },
  };
  await store.putQuery({
    id: nativeHistoryStorageId(nativeHistoryQuery(target, 'reader')),
    data: saved,
    bytes: JSON.stringify(saved).length,
    observedAt: Date.now(),
  });
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.conversations!.observe(target, () => undefined);
  await settle();
  const state = cache.conversations!.read(target);
  assert.equal(state.data?.events[0].text, 'saved before the upgrade');
  assert.equal(state.data?.streamCursor, undefined);
  assert.equal(state.status, 'stale');
  assert.equal(nativeHistoryCanAct(state, state.data, false), false);
  assert.equal(transport.requestCount, 0);
  stop();
  await cache.dispose('network');
});

test('a host transport loss resumes reads once, then a metadata recovery rearms a failed source', async () => {
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let receive!: (payload: NativeSessionDeltaPayload) => void;
  let opens = 0;
  let available = true;
  const controller = createNativeConversationCache(
    {
      subscribe: async () => {
        opens++;
        if (!available) throw new Error('Host unavailable');
        return { ...initial, subscriptionId: `source-${opens}` };
      },
      unsubscribe: async () => undefined,
      onDelta(listener) {
        receive = listener;
        return () => undefined;
      },
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => connection,
  );
  const stop = controller.api.observe(target, () => undefined);
  await settle();
  available = false;
  receive({ kind: 'terminal', reason: 'source-unavailable', subscriptionId: 'source-1' });
  await settle();
  assert.equal(opens, 2, 'A live transport loss gets one immediate passive recovery attempt');
  assert.equal(controller.api.read(target).status, 'stale');
  available = true;
  controller.resourcesChanged({
    version: 1,
    epoch: 'scope',
    changes: [
      {
        key: { family: 'native-session', nodeId: 'mini', ownerId: 'reader', sessionId: 'session' },
        kind: 'updated',
        revision: 1,
      },
    ],
  });
  await settle();
  assert.equal(opens, 3);
  assert.equal(controller.api.read(target).status, 'ready');
  stop();
  await controller.dispose(false);
});

test('stream paint metrics measure committed text and cancel work when the last viewer leaves', async () => {
  const { PerformanceRecorder } = await import('../src/performance/recorder.js');
  let clock = 0;
  const metrics = new PerformanceRecorder('command-center', { clock: () => clock });
  const paints = new Set<() => void>();
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://paint-test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  let receive!: (payload: NativeSessionDeltaPayload) => void;
  const controller = createNativeConversationCache(
    {
      subscribe: async () => ({ ...initial, subscriptionId: 'subscription' }),
      unsubscribe: async () => undefined,
      onDelta(listener) {
        receive = listener;
        return () => undefined;
      },
    },
    { load: async () => undefined, save: async () => undefined, forget: async () => undefined },
    () => connection,
    {
      performance: metrics,
      afterPaint(paint) {
        paints.add(paint);
        return () => {
          paints.delete(paint);
        };
      },
    },
  );
  const stop = controller.api.observe(target, () => undefined);
  await settle();
  clock = 0.016;
  for (const paint of [...paints]) {
    paints.delete(paint);
    paint();
  }
  receive({ ...delta(1, 'first committed text'), subscriptionId: 'subscription' });
  clock = 0.032;
  for (const paint of [...paints]) {
    paints.delete(paint);
    paint();
  }
  const text = metrics
    .snapshot()
    .histograms.find((row) => row.name === 'farmslot_native_text_render_seconds');
  assert.equal(text?.count, 1);
  assert.equal(text?.max, 0.016);
  receive({ ...delta(2, 'next text'), subscriptionId: 'subscription' });
  assert.equal(paints.size, 1);
  stop();
  assert.equal(paints.size, 0, 'No scheduled stream paint survives its final viewer');
  await controller.dispose(false);
});

test('a delayed disk hydration cannot restore content after a live access refusal', async () => {
  let resolveLoad!: (value: ReturnType<typeof reduceNativeConversation>) => void;
  let forgets = 0;
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://denied-test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  const controller = createNativeConversationCache(
    {
      subscribe: async () => {
        throw Object.assign(new Error('Access withdrawn'), { code: 'AUTH_FORBIDDEN' });
      },
      unsubscribe: async () => undefined,
      onDelta: () => () => undefined,
    },
    {
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
        }),
      save: async () => undefined,
      forget: async () => {
        forgets++;
      },
    },
    () => connection,
  );
  const stop = controller.api.observe(target, () => undefined);
  controller.resourcesChanged({
    version: 1,
    epoch: 'scope',
    changes: [
      {
        key: { family: 'native-session', scope: 'owner', ownerId: 'reader' },
        kind: 'updated',
        revision: 1,
      },
    ],
  });
  await settle();
  assert.equal(controller.api.read(target).error?.code, 'AUTH_FORBIDDEN');
  resolveLoad(reduceNativeConversation(undefined, initial));
  await settle();
  assert.equal(controller.api.read(target).data, undefined);
  assert.equal(controller.api.read(target).status, 'error');
  assert.equal(forgets, 1);
  stop();
  await controller.dispose(false);
});

test('a definitive journal-page denial evicts the conversation and withdraws live authority', async () => {
  let forgets = 0,
    stops = 0;
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://page-denied-test' },
    capabilities: {
      conversationStreaming: 1,
      httpBearerAuth: true,
      voiceInstructionFormatting: true,
    },
  };
  const controller = createNativeConversationCache(
    {
      subscribe: async () => ({ ...initial, subscriptionId: 'subscription' }),
      unsubscribe: async () => {
        stops++;
      },
      onDelta: () => () => undefined,
      readPage: async () => {
        throw Object.assign(new Error('Access withdrawn'), { code: 'AUTH_FORBIDDEN' });
      },
    },
    {
      load: async () => undefined,
      save: async () => undefined,
      forget: async () => {
        forgets++;
      },
    },
    () => connection,
  );
  const stop = controller.api.observe(target, () => undefined);
  await settle();
  assert.equal(controller.api.read(target).status, 'ready');
  await controller.api.readPage(target, 0);
  assert.equal(controller.api.read(target).data, undefined);
  assert.equal(controller.api.read(target).conversation, undefined);
  assert.equal(controller.api.read(target).error?.code, 'AUTH_FORBIDDEN');
  assert.equal(forgets, 1);
  assert.equal(stops, 1);
  stop();
  await controller.dispose(false);
});

test('pre-upgrade chat history remains readable offline through the immutable archive', async () => {
  const { resourceQuery } = await import('../src/client-cache/registry.js');
  const { Methods } = await import('../src/rpc/registry.js');
  const { canonicalResourceJson } = await import('../src/client-cache/keys.js');
  const scope = { gatewayUrl: 'ws://archive-test', principalId: 'reader', principalGeneration: 0 };
  const transport = new ResourceCacheConformanceTransport(scope);
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: transport.connection.authority! });
  const query = resourceQuery(Methods.CHAT_ARCHIVE, { sessionId: 'saved-session' });
  const data = {
    messages: [
      {
        id: 'saved-message',
        role: 'assistant',
        content: 'pre-upgrade saved response',
        timestamp: '2026-11-05T00:00:00Z',
      },
    ],
  };
  await store.putQuery({
    id: `chat.history:${canonicalResourceJson(query.params)}`,
    data,
    bytes: JSON.stringify(data).length,
    observedAt: 123,
  });
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => undefined);
  await settle();
  assert.deepEqual(cache.read(query).data, data);
  assert.equal(transport.requestCount, 0);
  stop();
  await cache.dispose('network');
});

for (const delayedLock of [false, true])
  test(
    `a refusal survives immediate profile close${delayedLock ? ' with another tab holding the write lock' : ''}`,
    { timeout: 2000 },
    async (t) => {
      const scope = {
        gatewayUrl: 'ws://refusal-close',
        principalId: 'reader',
        principalGeneration: 0,
      };
      const base = new ResourceCacheConformanceTransport(scope);
      base.setConnection({
        id: 1,
        connected: true,
        capabilities: { ...base.connection.capabilities!, conversationStreaming: 1 },
      });
      let receive!: (payload: NativeSessionDeltaPayload) => void;
      const transport = Object.assign(base, {
        conversations: {
          subscribe: async () => ({ ...initial, subscriptionId: 'subscription' }),
          unsubscribe: async () => undefined,
          onDelta(listener: (payload: NativeSessionDeltaPayload) => void) {
            receive = listener;
            return () => undefined;
          },
        },
      });
      const store = createMemoryResourceStore();
      const reopened = createMemoryResourceStore();
      await store.setMetadata({ scope, authority: base.connection.authority! });
      const legacyId = nativeHistoryStorageId(nativeHistoryQuery(target, 'reader'));
      const snapshot = reduceNativeConversation(undefined, initial);
      for (const [id, data] of [
        [nativeConversationStorageId(target), snapshot],
        [legacyId, { ...page, historyRead: { projection: 5, pageReadCount: 0, pageAfters: [] } }],
      ] as const)
        await store.putQuery({
          id,
          data,
          bytes: JSON.stringify(data).length,
          observedAt: Date.now(),
        });
      const close = store.close.bind(store);
      store.close = async () => {
        await reopened.setMetadata({ scope, authority: base.connection.authority! });
        for (const row of await store.listQueries()) {
          const saved = await store.getQuery(row.id);
          if (saved) await reopened.putQuery(saved);
        }
        await close();
      };
      let release!: () => void;
      const lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.after(release);
      let locks = 0;
      const cache = createGatewayResourceCache({ transport, store });
      let retirement: Promise<void> | undefined;
      let retiring = false;
      const stop = cache.conversations!.observe(target, (state) => {
        if (state.error?.code === 'AUTH_FORBIDDEN' && !retiring) {
          retiring = true;
          retirement = cache.dispose('profile-change');
        }
      });
      await settle();
      if (delayedLock)
        store.withWriteLock = async (write) => {
          locks++;
          await lock;
          return write();
        };
      receive({ kind: 'terminal', reason: 'access-denied', subscriptionId: 'subscription' });
      assert(retirement);
      await retirement;
      assert.equal(locks, 0);
      const offline = new ResourceCacheConformanceTransport(scope);
      const next = createGatewayResourceCache({ transport: offline, store: reopened });
      const unobserve = next.conversations!.observe(target, () => undefined);
      await settle();
      assert.equal(next.conversations!.read(target).data, undefined);
      assert.equal(await reopened.getQuery(nativeConversationStorageId(target)), undefined);
      assert.equal(await reopened.getQuery(legacyId), undefined);
      stop();
      unobserve();
      await next.dispose('network');
    },
  );
