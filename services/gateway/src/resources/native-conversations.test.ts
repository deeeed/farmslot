import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import type { NativeConversationUpdate, NativeSessionReadResult } from '@farmslot/protocol';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { createGatewayAuthRuntime } from '../security/auth.js';
import type { ClientState } from '../server/client-state.js';

import { NativeConversations } from './native-conversations.js';

const page: NativeSessionReadResult = {
  session: {
    id: 'session',
    generation: 'process',
    hostPid: 1,
    runner: 'codex',
    nativeSessionId: 'conversation',
    ownerPrincipalId: 'farm',
    executionNodeId: 'stream-node',
    accountContextId: 'ambient',
    cwd: '/work',
    executable: '/bin/codex',
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
const cursor = {
  executionNodeId: 'stream-node',
  sessionId: 'session',
  hostGeneration: 'host',
  generation: 'process',
  sequence: 0,
};
const initial: NativeConversationUpdate = {
  kind: 'reset',
  cursor,
  snapshot: { ...page, historyBefore: 0, truncated: false },
};
const delta: NativeConversationUpdate = {
  kind: 'delta',
  cursor: { ...cursor, sequence: 1 },
  page: {
    ...page,
    cursor: 1,
    events: [
      {
        sessionId: 'session',
        generation: 'process',
        sequence: 1,
        at: '2026-11-07T00:00:00Z',
        type: 'text.delta',
        text: 'committed',
      },
    ],
  },
};
function socket() {
  // ws exposes its accepted-server constructor at runtime but omits it from ClientOptions.
  const ws: WebSocket = Reflect.construct(WebSocket, [null, undefined, {}]);
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  return ws;
}
function client(): ClientState {
  return {
    id: 'viewer',
    ws: socket(),
    authenticated: true,
    terminalHandlers: new Map(),
    workerTerminalHandlers: new Map(),
    ptyHandlers: new Map(),
    terminalIdentities: new Map(),
    workerSessionHistoryHandlers: new Map(),
    workerSessionHistorySubscribeSeq: new Map(),
    terminalSubscribeSeq: new Map(),
    screenHandlers: new Map(),
    thumbnailSubscribed: false,
  };
}
const target = { sessionId: 'session', executionNodeId: 'stream-node' };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'native-stream-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  const runtime = createGatewayAuthRuntime({ FARMSLOT_HOME: home });
  const roles = [{ role: 'admin' as const, scope: { kind: 'global' as const } }];
  runtime.writer.createPrincipal({ type: 'service', displayName: 'Farm' }, roles, 'farm');
  runtime.writer.issueCredential('farm', 'fixture');
  const reader = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Reader' },
    roles,
    'reader',
  );
  runtime.writer.createPrincipal(
    { type: 'node', displayName: 'Node', machine: 'stream-node', nativeOwnerPrincipalId: 'farm' },
    [],
    'node-stream',
  );
  runtime.writer.issueCredential('node-stream', 'fixture');
  const ws = socket();
  let current = true;
  registerNode(
    'stream-node',
    1,
    ws,
    undefined,
    undefined,
    {
      ownerPrincipalId: 'farm',
      supportsStandaloneDelegation: true,
      conversationStreaming: 1,
    },
    { principalId: 'node-stream', valid: () => current },
  );
  return {
    reader,
    ws,
    revoke() {
      current = false;
    },
    close() {
      unregisterByWs(ws);
      if (previous === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('remote events arriving with the initial response wait for client activation; readers share one tap', async () => {
  const f = fixture();
  const received: unknown[] = [];
  const a = client(),
    b = client();
  let opens = 0,
    stops = 0;
  const broker = new NativeConversations(async (_node, method, value) => {
    if (method.endsWith('unsubscribe')) {
      stops++;
      return { ok: true };
    }
    opens++;
    const params = value as { subscriptionId: string };
    // This event arrives before the await continuation of the subscribe RPC.
    broker.accept(f.ws, { ...delta, subscriptionId: params.subscriptionId });
    return initial;
  });
  try {
    const first = await broker.subscribe(
      a,
      target,
      () => f.reader,
      (_event, payload) => received.push(payload),
    );
    assert.equal(first.kind, 'reset');
    assert.deepEqual(received, []);
    const second = await broker.subscribe(
      b,
      target,
      () => f.reader,
      () => undefined,
    );
    assert.equal(opens, 1);
    assert.equal(second.kind, 'reset');
    if (second.kind === 'reset') assert.equal(second.snapshot.events[0].text, 'committed');
    broker.activate(a, first.subscriptionId);
    await settle();
    assert.equal(received.length, 1);
    broker.disconnect(a);
    assert.equal(stops, 0);
    broker.disconnect(b);
    await settle();
    assert.equal(stops, 1);
  } finally {
    broker.disconnect(a);
    broker.disconnect(b);
    f.close();
  }
});

test('invalid cursor opens no tap; current node revocation terminates an idle subscription', async () => {
  const f = fixture();
  const c = client();
  const received: unknown[] = [];
  let opens = 0,
    stops = 0;
  const broker = new NativeConversations(async (_node, method) => {
    if (method.endsWith('unsubscribe')) {
      stops++;
      return { ok: true };
    }
    opens++;
    return initial;
  });
  try {
    await assert.rejects(
      broker.subscribe(
        c,
        { ...target, after: { ...cursor, sequence: -1 } },
        () => f.reader,
        () => undefined,
      ),
      { code: 'INVALID_PARAMS' },
    );
    assert.equal(opens, 0);
    const result = await broker.subscribe(
      c,
      target,
      () => f.reader,
      (_event, payload) => received.push(payload),
    );
    broker.activate(c, result.subscriptionId);
    f.revoke();
    broker.reconcile();
    await settle();
    assert.deepEqual(received, [
      { subscriptionId: result.subscriptionId, kind: 'terminal', reason: 'access-denied' },
    ]);
    assert.equal(stops, 1);
  } finally {
    broker.disconnect(c);
    f.close();
  }
});

test('failed initial identity validation releases the remote tap', async () => {
  const f = fixture();
  let stops = 0;
  const broker = new NativeConversations(async (_node, method) => {
    if (method.endsWith('unsubscribe')) {
      stops++;
      return { ok: true };
    }
    assert.equal(initial.kind, 'reset');
    return {
      ...initial,
      snapshot: { ...initial.snapshot, session: { ...page.session, ownerPrincipalId: 'foreign' } },
    };
  });
  try {
    await assert.rejects(
      broker.subscribe(
        client(),
        target,
        () => f.reader,
        () => undefined,
      ),
      { code: 'NATIVE_SOURCE_UNAVAILABLE' },
    );
    await settle();
    assert.equal(stops, 1);
  } finally {
    f.close();
  }
});

test('streamed worker metadata uses the same acceptance policy as explicit history reads', async () => {
  const { nativeWorkerEffectiveSession } = await import('../runners/native/worker-history.js');
  const { storedRun } = await import('../../../../packages/protocol/test/fixtures/run.js');
  const { session } = page;
  const controllable = {
    ...session,
    capabilities: { ...session.capabilities, cancelQueued: true, steer: true },
  };
  const context = {
    id: 'worker',
    runId: 'run',
    slotId: 'slot',
    role: 'primary' as const,
    status: 'working' as const,
    label: 'Worker',
  };
  const run = storedRun('run', {
    slotId: 'slot',
    agentContexts: [context],
    acceptanceRegistration: {
      schemaVersion: 1,
      runId: 'run',
      revision: 1,
      intake: {
        provider: 'github',
        repository: 'example/repo',
        prNumber: 1,
        headSha: 'a'.repeat(40),
        capturedAt: '2026-11-07T00:00:00Z',
      },
      original: [],
      derived: [],
      units: [],
    },
  });
  const effective = nativeWorkerEffectiveSession(run, context.id, controllable);
  assert.equal(effective.capabilities.steer, undefined);
  assert.equal(effective.capabilities.cancelQueued, undefined);
  assert.equal(effective.capabilities.interrupt, controllable.capabilities.interrupt);
  assert.equal(
    nativeWorkerEffectiveSession(
      { ...run, acceptanceRegistration: undefined },
      context.id,
      controllable,
    ),
    controllable,
  );
  assert.equal(
    nativeWorkerEffectiveSession(
      { ...run, agentContexts: [{ ...context, role: 'review' }] },
      context.id,
      controllable,
    ),
    controllable,
  );
});

test('queued updates drain in order under one authorization pass', async () => {
  const f = fixture();
  const c = client();
  const received: { kind: string; subscriptionId: string; cursor?: { sequence: number } }[] = [];
  const step = (sequence: number): NativeConversationUpdate => ({
    kind: 'delta',
    cursor: { ...cursor, sequence },
    page: {
      ...page,
      cursor: sequence,
      events: [
        {
          sessionId: 'session',
          generation: 'process',
          sequence,
          at: '2026-11-07T00:00:00Z',
          type: 'text.delta',
          text: `chunk ${sequence}`,
        },
      ],
    },
  });
  let principalReads = 0;
  const broker = new NativeConversations(async (_node, method, value) => {
    if (method.endsWith('unsubscribe')) return { ok: true };
    const params = value as { subscriptionId: string };
    // Five updates arrive before the client activates, so they queue for one drain.
    for (let sequence = 1; sequence <= 5; sequence++)
      broker.accept(f.ws, { ...step(sequence), subscriptionId: params.subscriptionId });
    return initial;
  });
  try {
    const result = await broker.subscribe(
      c,
      target,
      () => {
        principalReads++;
        return f.reader;
      },
      (_event, payload) => received.push(payload as (typeof received)[number]),
    );
    principalReads = 0;
    broker.activate(c, result.subscriptionId);
    await settle();
    assert.deepEqual(
      received.map((payload) => [payload.kind, payload.cursor?.sequence, payload.subscriptionId]),
      [1, 2, 3, 4, 5].map((sequence) => ['delta', sequence, result.subscriptionId]),
    );
    // One authorization (two reads) for the pass, then one reader check per emitted update.
    // Authorizing per update would read the principal three times per update.
    assert.equal(principalReads, 2 + 5);
  } finally {
    broker.disconnect(c);
    f.close();
  }
});
