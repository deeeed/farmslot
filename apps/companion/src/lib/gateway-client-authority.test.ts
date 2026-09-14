import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { type GatewayAuthConnectResult, Methods } from '@farmslot/protocol';

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
