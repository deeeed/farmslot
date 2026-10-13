import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  createSourceCommandClient,
  type GatewayAuthConnectResult,
  Methods,
  type ResponseFrame,
  SourceStatusController,
} from '@farmslot/protocol';

import { sourceStatusFixture } from '../../../../packages/protocol/test/fixtures/source-status';

mock.module('react-native', {
  namedExports: { AppState: { addEventListener: () => ({ remove() {} }) } },
});

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static sockets: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<{ id: string; method: string; params: unknown }> = [];
  constructor(readonly url: string) {
    Socket.sockets.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  response(id: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: true, payload }) });
  }
  failure(id: string, error: NonNullable<ResponseFrame['error']>) {
    this.onmessage?.({ data: JSON.stringify({ type: 'res', id, ok: false, error }) });
  }
  event(event: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type: 'event', event, payload }) });
  }
}

function auth(id: string, access: 'farm' | 'native' | 'none'): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: Date.now(),
    principal: { id, displayName: id, subjectKind: 'person', roles: [] },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      gatewayPing: true,
      workspaceAccess: access,
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('native authentication is published before listeners and never sends a farm bootstrap request', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'owner' });
  const observed: string[] = [];
  client.onConnectionChange((state) => {
    if (state === 'connected')
      observed.push(`${client.authenticatedPrincipal?.id}:${client.workspaceAccess}`);
  });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('owner-a', 'native'));
    await settle();
    assert.deepEqual(observed, ['owner-a:native']);
    await assert.rejects(client.request(Methods.FLEET_STATUS), /cannot access farm/);
    await assert.rejects(
      client.request(Methods.NATIVE_SESSION_READ, { worker: { runId: 'run' } }),
      /cannot access farm/,
    );
    const request = client.request(Methods.NATIVE_SESSION_LIST);
    socket.response(socket.sent.at(-1)!.id, { sessions: [] });
    assert.deepEqual(await request, { sessions: [] });
    assert.deepEqual(
      socket.sent.map((frame) => frame.method),
      [Methods.AUTH_CONNECT, Methods.NATIVE_SESSION_LIST],
    );
    let leaked = false;
    client.subscribe('fleet.updated', () => {
      leaked = true;
    });
    socket.event('fleet.updated', { marker: 'protected' });
    assert.equal(leaked, false);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('settled old account responses and queued requests cannot cross a credential replacement', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
  try {
    client.connect();
    const old = Socket.sockets.at(-1)!;
    old.open();
    old.response(old.sent[0].id, auth('admin', 'farm'));
    await settle();
    const request = assert.rejects(client.request(Methods.FLEET_STATUS), /identity changed/);
    old.response(old.sent.at(-1)!.id, { marker: 'old-admin' });
    client.setConnection('ws://localhost:19777', { token: 'owner' });
    assert.equal(client.authenticatedPrincipal, null);
    assert.equal(client.workspaceAccess, 'none');
    await request;
    const current = Socket.sockets.at(-1)!;
    current.open();
    current.response(current.sent[0].id, auth('owner-a', 'native'));
    await settle();
    const authenticatedId = () => client.authenticatedPrincipal?.id;
    assert.equal(authenticatedId(), 'owner-a');
    assert.deepEqual(
      current.sent.map((frame) => frame.method),
      [Methods.AUTH_CONNECT],
    );
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('policy revocation clears authority before disconnect listeners and farm compatibility remains', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777', { token: 'admin' });
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const request = client.request(Methods.FLEET_STATUS);
    socket.response(socket.sent.at(-1)!.id, { fleet: 'allowed' });
    assert.deepEqual(await request, { fleet: 'allowed' });
    let disconnectedAccess: string | undefined;
    client.onConnectionChange((state) => {
      if (state === 'disconnected') disconnectedAccess = client.workspaceAccess;
    });
    socket.close(1008);
    assert.equal(disconnectedAccess, 'none');
    assert.equal(client.authenticatedPrincipal, null);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('native RPC rejection preserves its code, details and next action', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777');
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const rejection = {
      code: 'SOURCE_STATE_STALE',
      message: 'Source pins changed before applying this request.',
      details: { expectedPinRevision: 2, pinRevision: 3 },
      userAction: 'Review current source pins and try again.',
    };
    const request = assert.rejects(client.request(Methods.SOURCES_PIN), (error: Error) => {
      assert(error instanceof Error);
      for (const [key, value] of Object.entries(rejection))
        assert.deepEqual(Reflect.get(error, key), value);
      return true;
    });
    socket.failure(socket.sent.at(-1)!.id, rejection);
    await request;
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});

test('native stale source rejection releases editing and prepares a fresh command', async () => {
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const { GatewayClient } = await import('./gateway-client');
  const client = new GatewayClient('ws://localhost:19777');
  try {
    client.connect();
    const socket = Socket.sockets.at(-1)!;
    socket.open();
    socket.response(socket.sent[0].id, auth('admin', 'farm'));
    await settle();
    const controller = new SourceStatusController(
      createSourceCommandClient((method, params) => client.request(method, params)),
      {
        connectionKey: 'farm',
        target: { scope: 'farm', targetId: 'farm' },
        actions: ['pin'],
      },
    );
    const refresh = controller.refresh();
    socket.response(socket.sent.at(-1)!.id, sourceStatusFixture());
    await refresh;
    controller.select({ sourceId: 'pack', selection: 'branch', ref: 'experiment' });
    const stale = controller.apply('pin', 'pack');
    socket.response(socket.sent.at(-1)!.id, sourceStatusFixture());
    await settle();
    const oldCommand = socket.sent.at(-1)!;
    assert.equal(oldCommand.method, Methods.SOURCES_PIN);
    socket.failure(oldCommand.id, {
      code: 'SOURCE_STATE_STALE',
      message: 'Source pins changed before applying this request.',
      details: { pinRevision: 3 },
    });
    await stale;
    assert.equal(controller.getSnapshot().pending, undefined);
    assert.equal(controller.getSnapshot().canRetry, false);
    assert.equal(controller.getSnapshot().canEdit, true);
    assert(controller.getSnapshot().operationError?.includes('Source pins changed'));

    const freshStatus = { ...sourceStatusFixture(), pinRevision: 3 };
    const refreshed = controller.refresh();
    socket.response(socket.sent.at(-1)!.id, freshStatus);
    await refreshed;
    assert(controller.getSnapshot().operationError?.includes('Source pins changed'));
    controller.select({ sourceId: 'pack', selection: 'branch', ref: 'experiment/fresh' });
    const fresh = controller.apply('pin', 'pack');
    socket.response(socket.sent.at(-1)!.id, freshStatus);
    await settle();
    const freshCommand = socket.sent.at(-1)!;
    assert.equal(freshCommand.method, Methods.SOURCES_PIN);
    const oldParams = oldCommand.params as Record<string, unknown>;
    const freshParams = freshCommand.params as Record<string, unknown>;
    assert.notEqual(freshParams.operationId, oldParams.operationId);
    assert.equal(freshParams.expectedPinRevision, 3);
    assert.equal(freshParams.ref, 'experiment/fresh');
    socket.response(freshCommand.id, { operationId: freshParams.operationId });
    await settle();
    assert.equal(socket.sent.at(-1)!.method, Methods.SOURCES_STATUS);
    socket.response(socket.sent.at(-1)!.id, freshStatus);
    await fresh;
    assert.equal(controller.getSnapshot().operationError, undefined);
    assert.equal(controller.getSnapshot().pending, undefined);
    assert.equal(controller.getSnapshot().canEdit, true);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalSocket;
  }
});
