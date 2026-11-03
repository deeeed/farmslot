import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  Methods,
  type NativeCommandReceipt,
  type NativeSessionCatalogResult,
  type NativeSessionReadResult,
} from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  nativeObservationQuery,
} from '@farmslot/protocol/client-cache';
import { catalogForNativeRunners, ReviewDispatchViewModel } from '@farmslot/review-dispatch';

import { ResourceCacheConformanceTransport } from '../../../../../../packages/protocol/src/client-cache/conformance.js';
import { litBinding, litBindings, litText } from '../../testing/lit-text.js';

import type { NativeSessionFixture } from './native-session-view.js';
import type { NativeSessionApi } from './native-workspace.js';

// The view keeps its command and draft in localStorage, which node lacks.
const stored = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
});

// The workspace pane pulls CSS and Monaco that node can't load; the gateway client opens sockets.
mock.module('./native-workspace.js', { namedExports: {} });
mock.module('../../gateway-client.js', { namedExports: { gateway: {} } });
mock.module('../../state.js', {
  namedExports: {
    getState: () => ({ globalFilters: { projects: [], machines: [] }, fleet: null }),
    subscribe: () => () => undefined,
  },
});
let offlineCache: GatewayResourceCache | undefined;
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => offlineCache,
    getResourceWorkspaceAccess: () => 'farm',
    getResourceNativeOwnerId: () => (offlineCache ? 'offline-native-owner' : undefined),
    getResourceWorkspaceKey: () => (offlineCache ? 'offline-native-owner-scope' : undefined),
    subscribeResourceCache: () => () => undefined,
  },
});

const { NativeSessionView } = await import('./native-session-view.js');

test('native route renders stored catalog while disconnected and keeps creation unavailable', async () => {
  const scope = {
    gatewayUrl: 'ws://offline-native.invalid',
    principalId: 'offline-native-owner',
    principalGeneration: 0,
  };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  const catalog: NativeSessionCatalogResult = {
    runners: [
      {
        runner: 'codex',
        models: ['stored-model'],
        defaultModel: 'stored-model',
        modes: ['default'],
      },
    ],
    contexts: [{ cwd: '/workspace/offline-fixture', label: 'Stored working directory' }],
  };
  for (const [method, data] of [
    [Methods.NATIVE_SESSION_CATALOG, catalog],
    [Methods.NATIVE_SESSION_LIST, { sessions: [] }],
  ] as const) {
    const query = nativeObservationQuery(method, {}, scope.principalId);
    await store.putQuery({
      id: query.id,
      data,
      bytes: JSON.stringify(data).length,
      observedAt: 123,
    });
  }
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  offlineCache = createGatewayResourceCache({ transport, store });
  const view = new NativeSessionView();
  try {
    await Reflect.get(view, 'refreshSessions').call(view);
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(Reflect.get(view, 'catalog'), catalog);
    assert.equal(Reflect.get(view, 'catalogCurrent'), false);
    const rendered = litText(Reflect.get(view, 'render').call(view));
    assert.match(rendered, /Stored working directory/);
    assert.doesNotMatch(rendered, /Connect to the gateway to choose a runner/);
    assert.equal(transport.requestCount, 0);
  } finally {
    for (const stop of Reflect.get(view, 'inventoryStops')) stop();
    await offlineCache.dispose();
    offlineCache = undefined;
  }
});

test('cold native collection refusals retain their code through the real cache and header', async () => {
  const scope = {
    gatewayUrl: 'ws://native-denial.invalid',
    principalId: 'offline-native-owner',
    principalGeneration: 1,
  };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.connected = true;
  transport.connection.authority = authority;
  const capabilities = transport.connection.capabilities;
  assert(capabilities?.resourceChanges);
  transport.connection.capabilities = {
    ...capabilities,
    resourceChanges: { ...capabilities.resourceChanges, observedReads: 1 },
  };
  offlineCache = createGatewayResourceCache({ transport, store });
  const view = new NativeSessionView();
  Reflect.set(view, 'connected', true);
  try {
    await Reflect.get(view, 'refreshSessions').call(view);
    for (let i = 0; i < 2; i++) (await transport.nextRead()).reject('AUTH_FORBIDDEN');
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(Reflect.get(view, 'catalogCurrent'), false);
    const status = litBinding(Reflect.get(view, 'render').call(view), '.context=');
    assert(status && typeof status === 'object');
    assert.equal(Reflect.get(status, 'readErrorCode'), 'AUTH_FORBIDDEN');
    assert.equal(Reflect.get(status, 'connected'), true);
    assert.equal(transport.requestCount, 2);
  } finally {
    for (const stop of Reflect.get(view, 'inventoryStops')) stop();
    await offlineCache.dispose();
    offlineCache = undefined;
  }
});

for (const [executionNodeId, homeDirectory] of [
  ['macwork', '/Users/native-person'],
  ['mini', '/Volumes/Data/operator'],
] as const) {
  test(`custom directory stays on ${executionNodeId} and defaults to its reported home`, async () => {
    const catalog: NativeSessionCatalogResult = {
      runners: [
        {
          runner: 'codex',
          models: ['gpt-6.1-sol'],
          defaultModel: 'gpt-6.1-sol',
          modes: ['default'],
        },
      ],
      executionNodes: [{ executionNodeId, label: executionNodeId, homeDirectory }],
      contexts: [{ executionNodeId, cwd: `${homeDirectory}/project`, label: 'Project' }],
    };
    let requested: unknown;
    const view = new NativeSessionView();
    Object.assign(view, {
      connected: true,
      creating: true,
      catalog,
      executionNodeId,
      cwd: `${homeDirectory}/project`,
      profileReady: true,
      mode: 'default',
      prompt: 'Read the workspace',
      fixture: {
        catalog: async () => catalog,
        list: async () => ({ sessions: [] }),
        read: async () => page(receipt(false)),
      },
      executionPicker: new ReviewDispatchViewModel({
        context: { allowedActions: ['chat'] },
        catalog: catalogForNativeRunners(catalog.runners, undefined, executionNodeId),
        sequence: [{ runner: 'codex', model: 'gpt-6.1-sol', effort: null, mode: 'cold' }],
      }),
      api: {
        request: async (method: string, params: unknown) => {
          assert.equal(method, Methods.NATIVE_SESSION_CREATE);
          requested = params;
          throw new Error('Captured without starting');
        },
      },
    });
    // Header session selector is first; the working-directory selector is next.
    const change = litBindings(Reflect.get(view, 'render').call(view), '@change=')[1];
    assert(typeof change === 'function');
    const event = new Event('change');
    Object.defineProperty(event, 'target', { value: { value: `custom:${executionNodeId}` } });
    Reflect.apply(change, view, [event]);
    assert.equal(Reflect.get(view, 'executionNodeId'), executionNodeId);
    assert.equal(Reflect.get(view, 'cwd'), homeDirectory);
    await Reflect.get(view, 'create').call(view);
    assert.deepEqual(requested, {
      executionNodeId,
      cwd: homeDirectory,
      runner: 'codex',
      model: 'gpt-6.1-sol',
      effort: undefined,
      mode: 'default',
    });
  });
}

test('custom directory does not redirect an unavailable selected machine or create there', async () => {
  let requests = 0;
  const catalog: NativeSessionCatalogResult = {
    runners: [],
    contexts: [],
    executionNodes: [
      { executionNodeId: 'macpro', label: 'macpro', homeDirectory: '/Users/farm' },
      {
        executionNodeId: 'macwork',
        label: 'macwork',
        homeDirectory: '/Users/person',
        unavailableReason: 'Refresh native host',
      },
    ],
  };
  const view = new NativeSessionView();
  Object.assign(view, {
    connected: true,
    creating: true,
    fixture: {
      catalog: async () => catalog,
      list: async () => ({ sessions: [] }),
      read: async () => page(receipt(false)),
    },
    catalog,
    executionNodeId: 'macwork',
    cwd: '',
    profileReady: true,
    api: {
      request: async () => {
        requests++;
      },
    },
  });
  assert.match(litText(Reflect.get(view, 'render').call(view)), /macwork.*Refresh native host/s);
  const change = litBindings(Reflect.get(view, 'render').call(view), '@change=')[1];
  assert(typeof change === 'function');
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: { value: 'custom:macwork' } });
  Reflect.apply(change, view, [event]);
  assert.equal(Reflect.get(view, 'executionNodeId'), 'macwork');
  await Reflect.get(view, 'create').call(view);
  assert.equal(Reflect.get(view, 'cwd'), '', 'disabled target is not selected');
  assert.equal(requests, 0);
});

test('native Default sends the selected node model after switching execution nodes', async () => {
  const catalog: NativeSessionCatalogResult = {
    runners: [
      {
        runner: 'pi',
        models: ['xai/grok-4.7'],
        nodeModels: { macpro: ['xai/grok-4.7'], mini: ['litellm/glm-5p3'] },
        defaultModel: 'xai/grok-4.7',
        modes: ['default'],
      },
    ],
    contexts: [],
  };
  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: catalogForNativeRunners(catalog.runners, undefined, 'macpro'),
    sequence: [{ runner: 'pi', model: 'xai/grok-4.7', effort: null, mode: 'cold' }],
  });
  let requested: unknown;
  const api: NativeSessionApi = {
    request: async (method, params) => {
      assert.equal(method, Methods.NATIVE_SESSION_CREATE);
      requested = params;
      throw new Error('Request captured without starting a session');
    },
  };
  const fixture: NativeSessionFixture = {
    catalog: async () => catalog,
    list: async () => ({ sessions: [] }),
    read: async () => page(receipt(false)),
  };
  const view = Object.create(NativeSessionView.prototype) as {
    updated(changed: Map<string, unknown>): void;
    create(): Promise<void>;
  };
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.assign(view, {
    requestUpdate: () => undefined,
    executionPicker: picker,
    executionNodeId: 'mini',
    connected: true,
    fixture,
    api,
    profileReady: true,
    revision: 0,
    cwd: '/fixture',
    catalog: {
      ...catalog,
      executionNodes: [{ executionNodeId: 'mini', label: 'mini', homeDirectory: '/fixture' }],
    },
    customCwd: true,
    prompt: 'Read the workspace',
    unavailableNodes: [],
    mode: 'default',
  });
  view.updated(new Map([['executionNodeId', 'macpro']]));
  assert.equal(picker.selection?.model, 'litellm/glm-5p3');
  // The Default button stores null, exactly as the shared picker does on a click.
  picker.setModel(picker.rows[0].id, null);
  await view.create();
  assert.deepEqual(requested, {
    executionNodeId: 'mini',
    runner: 'pi',
    model: 'litellm/glm-5p3',
    effort: undefined,
    mode: 'default',
    cwd: '/fixture',
  });
});

/** The private state and methods the tests drive. */
interface View {
  draft: string;
  localCommand?: { commandId: string; text: string };
  poll(): Promise<void>;
  editQueued(): Promise<void>;
  sessionKey(suffix: string): string;
}

const text = 'Then reply with only the word NEXT.';

function page(receipt: NativeCommandReceipt, generation = 'generation'): NativeSessionReadResult {
  return {
    session: {
      id: 'session',
      generation,
      hostPid: 0,
      runner: 'fixture',
      nativeSessionId: 'conversation',
      ownerPrincipalId: 'owner',
      executionNodeId: 'local',
      accountContextId: 'owner',
      cwd: '/fixture',
      executable: '',
      version: 'fixture',
      mode: 'default',
      accountMode: 'native',
      state: 'closed',
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
    cursor: 0,
    hasMore: false,
    commands: [receipt],
    pendingRequests: [],
  };
}

// Built from the prototype so no DOM or render cycle is needed; one fixture read, no rescheduling.
function makeView(receipt: NativeCommandReceipt, draft: string, generation?: string): View {
  const view = Object.create(NativeSessionView.prototype) as View;
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.defineProperty(view, 'updateComplete', { value: Promise.resolve(true) });
  Object.assign(view, {
    requestUpdate: () => undefined,
    schedule: () => undefined,
    followTimeline: () => undefined,
    fixture: { read: async () => page(receipt, generation) },
    storageScope: 'fixture',
    selectedId: 'session',
    selectedNodeId: 'local',
    connected: true,
    polling: false,
    revision: 0,
    transcript: { events: [], cursor: 0 },
    responseAttempts: new Set<string>(),
    draft,
    localCommand: {
      sessionId: 'session',
      executionNodeId: 'local',
      generation: 'generation',
      commandId: 'queued',
      text,
    },
  });
  stored.clear();
  stored.set(view.sessionKey('command:session'), JSON.stringify(view.localCommand));
  return view;
}

const receipt = (submitted: boolean): NativeCommandReceipt => ({
  commandId: 'queued',
  generation: 'generation',
  state: 'failed',
  outcome: 'interrupted',
  submitted,
  accepted: submitted,
});

test('a queued message the session closed before taking goes back to the composer', async () => {
  const view = makeView(receipt(false), 'typed meanwhile');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, `${text}\n\ntyped meanwhile`);
  assert.equal(stored.get(view.sessionKey('draft:session')), view.draft);
  assert.equal(stored.has(view.sessionKey('command:session')), false);
});

test('a delivered message that failed stays out of the composer', async () => {
  const view = makeView(receipt(true), '');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, '');
  assert.equal(stored.has(view.sessionKey('draft:session')), false);
});

test('a queued message a resume carried into the new generation stays out of the composer', async () => {
  // The host may still deliver it: its receipt moved to the new generation, still queued.
  const carried = {
    ...receipt(false),
    generation: 'resumed',
    state: 'pending' as const,
    queued: true,
  };
  const view = makeView(carried, '', 'resumed');
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, '');
});

test('terminal text added before a worker conversation opens lands in that conversation', async () => {
  const { queueNativeChatContext } = await import('./native-chat-context.js');
  const { nativeWorkerAttemptKey } = await import('./native-worker-target.js');
  const worker = {
    runId: 'run',
    contextId: 'context',
    label: 'rev-claude native',
    readOnly: false,
    binding: {
      sessionId: 'worker-session',
      executionNodeId: 'macpro',
      ownerPrincipalId: 'owner',
      generation: 'generation',
      leaseId: 'lease',
      commandId: 'command',
    },
  };
  const view = Object.create(NativeSessionView.prototype) as View & {
    connect(): Promise<void>;
    worker: typeof worker;
  };
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.assign(view, {
    requestUpdate: () => undefined,
    schedule: () => undefined,
    // A fresh mount, as the terminal's tab switch makes it: no scope read yet.
    fixture: { read: async () => undefined },
    storageScope: '',
    revision: 0,
    worker,
  });
  stored.clear();
  // The standalone conversation's last selection, which connect() reads first.
  stored.set('farmslot-native:fixture:selected', 'other-session');
  stored.set('farmslot-native:fixture:selected-node', 'local');
  queueNativeChatContext(nativeWorkerAttemptKey(worker), '```\nerror: a.rs:3\n```');
  Object.assign(view, { storageScope: 'fixture' });
  stored.set(view.sessionKey('draft:worker-session'), 'look at this:');
  Object.assign(view, { storageScope: '' });

  await view.connect();

  assert.equal(view.draft, 'look at this:\n\n```\nerror: a.rs:3\n```');
  Object.assign(view, { storageScope: 'fixture' });
  assert.equal(stored.get(view.sessionKey('draft:worker-session')), view.draft);
  assert.equal(stored.has(view.sessionKey('draft:other-session')), false);
});

test('Edit removes the queued message, and the composer gets its text back', async () => {
  const queued: NativeCommandReceipt = {
    commandId: 'queued',
    generation: 'generation',
    state: 'pending',
    queued: true,
    submitted: false,
    accepted: false,
  };
  const removed = {
    ...queued,
    queued: false,
    state: 'failed' as const,
    outcome: 'cancelled' as const,
  };
  const requests: Array<[string, unknown]> = [];
  const edit = async (cancelQueued: boolean) => {
    const view = makeView(removed, 'typed meanwhile');
    const session = page(queued).session;
    Object.assign(view, {
      session: {
        ...session,
        state: 'running',
        capabilities: { ...session.capabilities, cancelQueued },
      },
      receipts: [queued],
      caughtUp: true,
      busy: false,
      api: {
        request: async (method: string, params: unknown) => {
          requests.push([method, params]);
          return { receipt: removed };
        },
      },
    });
    await view.editQueued();
    return view;
  };
  // A session on an older host cannot remove it: no request, and the message stays.
  const older = await edit(false);
  assert.deepEqual(requests, []);
  assert.equal(older.localCommand?.commandId, 'queued');
  const view = await edit(true);
  assert.deepEqual(requests, [
    [
      Methods.NATIVE_SESSION_CANCEL,
      { sessionId: 'session', executionNodeId: 'local', commandId: 'queued' },
    ],
  ]);
  await view.poll();
  assert.equal(view.localCommand, undefined);
  assert.equal(view.draft, `${text}\n\ntyped meanwhile`);
});

test('prompt-first creation sends the first message once and keeps its delivery id', async () => {
  stored.clear();
  const result = page(receipt(false));
  result.session.state = 'idle';
  result.session.runner = 'codex';
  const calls: Array<{ method: string; params: unknown }> = [];
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api: NativeSessionApi = {
    async request<T>(
      method: Parameters<NativeSessionApi['request']>[0],
      params?: unknown,
    ): Promise<T> {
      calls.push({ method, params });
      if (method === Methods.NATIVE_SESSION_CREATE) {
        await pending;
        return { session: result.session } as T;
      }
      if (method === Methods.NATIVE_SESSION_SEND) return { accepted: true } as T;
      throw new Error(`Unexpected test RPC ${method}`);
    },
  };
  const picker = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog: {
      runners: [
        {
          id: 'codex',
          models: [{ id: 'gpt-6.1-sol' }],
          defaultModel: 'gpt-6.1-sol',
          efforts: [],
          defaultEffort: null,
          allowCustomModels: false,
        },
      ],
    },
  });
  const view = new NativeSessionView();
  Object.defineProperty(view, 'isConnected', { value: true });
  Object.assign(view, {
    api,
    fixture: {
      catalog: async () => ({ runners: [], contexts: [] }),
      list: async () => ({ sessions: [] }),
      read: async () => result,
    },
    connected: true,
    profileReady: true,
    catalog: {
      runners: [],
      contexts: [],
      executionNodes: [{ executionNodeId: 'local', label: 'local', homeDirectory: '/fixture' }],
    },
    customCwd: true,
    executionPicker: picker,
    cwd: '/fixture',
    executionNodeId: 'local',
    prompt: 'Read the workspace',
    revision: 0,
    requestUpdate: () => undefined,
    selectRouted(id: string) {
      Object.assign(this, { selectedId: id, busy: false, revision: 1 });
    },
    sessionKey: (key: string) => `prompt-first:${key}`,
    refreshSessions: async () => undefined,
    schedule: () => undefined,
  });
  const create = Reflect.get(view, 'create');
  assert.equal(typeof create, 'function');
  const first = create.call(view);
  await create.call(view);
  assert.equal(calls.length, 1, 'a second Enter must not start another session');
  release?.();
  await first;
  assert.deepEqual(
    calls.map((call) => call.method),
    [Methods.NATIVE_SESSION_CREATE, Methods.NATIVE_SESSION_SEND],
  );
  const command = JSON.parse(stored.get('prompt-first:command:session') ?? '{}');
  assert.equal(command.text, 'Read the workspace');
  assert.equal(command.sessionId, result.session.id);
  assert.match(command.commandId, /^[0-9a-f-]{36}$/);
  assert.equal(Reflect.get(view, 'prompt'), '');
  assert.equal(
    Reflect.get(view, 'busy'),
    false,
    'creating and first delivery release the same transition',
  );
});

test('embedded launch controls keep the current route and New restores the target', () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const previousHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const location = { hash: '#runs?projects=terminal' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  Object.defineProperty(globalThis, 'history', {
    configurable: true,
    value: {
      replaceState(_state: unknown, _unused: string, url: string) {
        location.hash = url;
      },
    },
  });
  try {
    const view = new NativeSessionView();
    Object.assign(view, {
      cwd: '/workspace/custom',
      executionNodeId: 'mini',
      customCwd: true,
      requestUpdate: () => undefined,
      schedule: () => undefined,
    });
    Reflect.get(view, 'syncLaunchUrl').call(view);
    assert.equal(location.hash, '#runs?projects=terminal');
    location.hash = '#native?cwd=%2Fworkspace%2Fcustom&custom=true&executionNodeId=mini';
    Reflect.get(view, 'selectRouted').call(view, 'existing', 'mini');
    Reflect.get(view, 'selectRouted').call(view, '');
    assert.equal(new URLSearchParams(location.hash.split('?')[1]).get('executionNodeId'), 'mini');
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    if (previousHistory) Object.defineProperty(globalThis, 'history', previousHistory);
    else Reflect.deleteProperty(globalThis, 'history');
  }
});

test('launcher URL restores a permitted custom model', () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hash: '#native?runner=codex&model=custom-provider-model' },
  });
  try {
    const catalog: NativeSessionCatalogResult = {
      runners: [
        { runner: 'codex', models: ['listed'], defaultModel: 'listed', modes: ['default'] },
      ],
      contexts: [],
    };
    const view = new NativeSessionView();
    Object.assign(view, {
      catalog,
      requestUpdate: () => undefined,
      executionPicker: new ReviewDispatchViewModel({
        context: { allowedActions: ['chat'] },
        catalog: catalogForNativeRunners(catalog.runners),
      }),
    });
    Reflect.get(view, 'updated').call(view, new Map());
    assert.equal(Reflect.get(view, 'model'), 'custom-provider-model');
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
