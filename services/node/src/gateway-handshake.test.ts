import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import type { RequestFrame } from '@farmslot/protocol';

import {
  authenticateNode,
  GatewayRequestError,
  isDeterministicHandshakeRejection,
  registerNode,
  sendGatewayRequest,
} from './gateway-handshake.js';

type Responder = (frame: RequestFrame, server: WebSocket) => void;

/** A real ws server whose reply policy each test chooses. */
async function serverWith(respond: Responder) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  wss.on('connection', (server) => {
    server.on('message', (raw) => respond(JSON.parse(raw.toString()) as RequestFrame, server));
  });
  const { port } = wss.address() as { port: number };
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(client, 'open');
  return {
    client,
    close: async () => {
      for (const socket of wss.clients) socket.terminate();
      client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

function listenerCounts(socket: WebSocket) {
  return {
    message: socket.listenerCount('message'),
    close: socket.listenerCount('close'),
    error: socket.listenerCount('error'),
  };
}

async function rejection(promise: Promise<unknown>): Promise<GatewayRequestError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GatewayRequestError, `expected GatewayRequestError, got ${error}`);
    return error;
  }
  throw new Error('expected the request to reject');
}

test('a refusal frame rejects with the gateway code, message and action, then cleans up', async () => {
  const harness = await serverWith((frame, server) => {
    server.send(
      JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: false,
        error: {
          code: 'AUTH_FORBIDDEN',
          message: 'Native node owner must match its server-issued assignment',
          userAction: 'bind the node to its owner and reconnect',
        },
      }),
    );
  });
  try {
    const before = listenerCounts(harness.client);
    const error = await rejection(
      registerNode(harness.client, { machine: 'm', pid: 1, capabilities: [] }),
    );
    assert.equal(error.code, 'AUTH_FORBIDDEN');
    assert.equal(error.message, 'Native node owner must match its server-issued assignment');
    assert.equal(error.userAction, 'bind the node to its owner and reconnect');
    assert.equal(isDeterministicHandshakeRejection(error), true);
    assert.deepEqual(listenerCounts(harness.client), before);
    assert.equal(harness.client.readyState, WebSocket.OPEN, 'the helper never closes the socket');
  } finally {
    await harness.close();
  }
});

test('a silent gateway times out and releases its listeners', async () => {
  const harness = await serverWith(() => {
    // Never answer: the registration frame is swallowed exactly like the
    // fire-and-forget bug this helper replaces.
  });
  try {
    const before = listenerCounts(harness.client);
    const error = await rejection(
      sendGatewayRequest(harness.client, 'node.connect', {}, { timeoutMs: 50 }),
    );
    assert.equal(error.code, 'TIMEOUT');
    assert.match(error.message, /node\.connect within 50ms/u);
    assert.equal(isDeterministicHandshakeRejection(error), false);
    assert.deepEqual(listenerCounts(harness.client), before);
  } finally {
    await harness.close();
  }
});

test('a socket closed mid-request settles with the close code and cleans up', async () => {
  const harness = await serverWith((_frame, server) => {
    server.close(1011, 'internal gateway error');
  });
  try {
    const before = listenerCounts(harness.client);
    const closed = once(harness.client, 'close');
    const error = await rejection(
      authenticateNode(harness.client, { machine: 'm', credential: { token: 'secret-token' } }),
    );
    assert.equal(error.code, 'SOCKET_CLOSED');
    assert.match(error.message, /auth\.connect \(close 1011 internal gateway error\)/u);
    assert.doesNotMatch(error.message, /secret-token/u, 'failure lines never carry the credential');
    assert.equal(isDeterministicHandshakeRejection(error), false);
    await closed;
    assert.deepEqual(listenerCounts(harness.client), before);
  } finally {
    await harness.close();
  }
});

test('a socket that is not open rejects immediately instead of throwing synchronously', async () => {
  const client = new WebSocket('ws://127.0.0.1:1');
  client.on('error', () => {
    // The refused connection is the point; the assertion below is on the request.
  });
  const error = await rejection(sendGatewayRequest(client, 'auth.connect', {}));
  assert.equal(error.code, 'SOCKET_NOT_OPEN');
  client.terminate();
});

test('auth then registration resolve on their own ACKs while unrelated frames flow past', async () => {
  const seen: string[] = [];
  const harness = await serverWith((frame, server) => {
    seen.push(frame.method);
    // Interleave traffic that is NOT the answer: a gateway-initiated request
    // and an event, exactly what the gateway pushes right after node.connect.
    server.send(
      JSON.stringify({ type: 'req', id: 'auto-metrics', method: 'system.metrics.subscribe' }),
    );
    server.send(JSON.stringify({ type: 'event', event: 'node.connected', payload: {} }));
    server.send('not-json');
    if (frame.method === 'auth.connect') {
      const params = frame.params as { clientKind: string; token?: string };
      assert.equal(params.clientKind, 'node');
      assert.equal(params.token, 'node-secret');
      server.send(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { ok: true } }));
      return;
    }
    if (frame.method === 'node.connect') {
      const params = frame.params as { machine: string; nativeSessions?: unknown };
      assert.equal(params.machine, 'proof-node');
      assert.deepEqual(params.nativeSessions, { ownerPrincipalId: 'owner-1' });
      server.send(
        JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: { registered: true } }),
      );
    }
  });
  try {
    const before = listenerCounts(harness.client);
    const auth = await authenticateNode(harness.client, {
      machine: 'proof-node',
      credential: { token: 'node-secret' },
    });
    assert.equal(auth.ok, true);
    const registration = await registerNode(harness.client, {
      machine: 'proof-node',
      pid: process.pid,
      capabilities: [],
      nativeSessions: { ownerPrincipalId: 'owner-1' },
    });
    assert.deepEqual(registration, { registered: true });
    assert.deepEqual(seen, ['auth.connect', 'node.connect']);
    assert.deepEqual(listenerCounts(harness.client), before);
  } finally {
    await harness.close();
  }
});

test('only gateway-evaluated refusals count as deterministic', () => {
  for (const code of ['AUTH_FAILED', 'AUTH_FORBIDDEN', 'AUTH_RATE_LIMITED', 'INVALID_PARAMS']) {
    assert.equal(isDeterministicHandshakeRejection(new GatewayRequestError(code, code)), true);
  }
  for (const code of ['TIMEOUT', 'SOCKET_CLOSED', 'SOCKET_ERROR', 'INTERNAL_ERROR']) {
    assert.equal(isDeterministicHandshakeRejection(new GatewayRequestError(code, code)), false);
  }
  assert.equal(isDeterministicHandshakeRejection(new Error('AUTH_FORBIDDEN')), false);
});
