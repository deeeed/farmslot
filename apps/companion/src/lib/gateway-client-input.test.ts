import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { mock, type TestContext } from 'node:test';

import { type WebSocket, WebSocketServer } from 'ws';

import {
  type GatewayAuthConnectResult,
  Methods,
  type PersonSessionAuth,
  type PersonSessionGrant,
  type RequestFrame,
  type ResponseFrame,
} from '@farmslot/protocol';

import { createTerminalInputQueue, TerminalInputCancelledError } from './terminal-input-queue';

mock.module('react-native', {
  namedExports: { AppState: { addEventListener: () => ({ remove() {} }) } },
});

function deferred() {
  return Promise.withResolvers<void>();
}
function auth(person: boolean): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: Date.now(),
    principal: {
      id: 'input-person',
      displayName: 'Input test',
      subjectKind: person ? 'person' : 'service',
      roles: [],
    },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      workspaceAccess: 'farm',
    },
  };
}
function grant(): PersonSessionGrant {
  const at = Date.now();
  return {
    session: {
      id: 'a'.repeat(32),
      principalId: 'input-person',
      principalGeneration: 0,
      deviceName: 'Input test',
      deviceKind: 'companion',
      createdAt: new Date(at).toISOString(),
      lastRefreshedAt: new Date(at).toISOString(),
      refreshExpiresAt: new Date(at + 30 * 86400_000).toISOString(),
      revokedAt: null,
    },
    refreshToken: `fsr_${'a'.repeat(32)}_${'r'.repeat(43)}`,
    accessToken: `fsa_${'a'.repeat(32)}_${'s'.repeat(43)}`,
    accessExpiresAt: new Date(at + 3600_000).toISOString(),
  };
}
async function serverFixture(t: TestContext, person: boolean) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let closeTask: Promise<void> | undefined;
  const close = () =>
    (closeTask ??= (async () => {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    })());
  t.after(close);
  const refreshStarted = deferred();
  let pendingRefresh: { socket: WebSocket; id: string } | null = null;
  let refreshes = 0;
  const inputs: unknown[] = [];
  function reply(socket: WebSocket, id: string, payload: unknown) {
    const frame: ResponseFrame = { type: 'res', id, ok: true, payload };
    socket.send(JSON.stringify(frame));
  }
  wss.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const frame: RequestFrame = JSON.parse(raw.toString());
      if (frame.method === Methods.AUTH_SESSION_REFRESH) {
        if (++refreshes === 1) reply(socket, frame.id, grant());
        else {
          pendingRefresh = { socket, id: frame.id };
          refreshStarted.resolve();
        }
      } else if (frame.method === Methods.AUTH_CONNECT) reply(socket, frame.id, auth(person));
      else if (frame.method === Methods.TERMINAL_INPUT) {
        inputs.push(frame.params);
        reply(socket, frame.id, { sent: true });
      } else throw new Error('Unexpected test method ' + frame.method);
    }),
  );
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    inputs,
    refreshStarted,
    releaseRefresh() {
      assert(pendingRefresh);
      reply(pendingRefresh.socket, pendingRefresh.id, grant());
    },
    close,
  };
}

test('disposing input during a real deferred person refresh prevents its eventual transport write', async (t) => {
  const { GatewayClient } = await import('./gateway-client');
  let now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now);
  const server = await serverFixture(t, true);
  const initial = grant();
  let saved: PersonSessionAuth | null = {
    session: initial.session,
    refreshToken: initial.refreshToken,
  };
  const client = new GatewayClient(server.url, {
    sessionStorage: {
      load: async () => saved,
      save: async (value) => {
        saved = value;
      },
    },
  });
  const connected = deferred();
  client.onConnectionChange((state) => {
    if (state === 'connected') connected.resolve();
  });
  try {
    client.connect();
    await connected.promise;
    now += 3600_000;
    const queue = createTerminalInputQueue((data, assertActive) =>
      client.request('terminal.input', { slotId: 'old', data }, 1000, {
        assertCurrent: assertActive,
      }),
    );
    const sent = assert.rejects(queue.write('a'), TerminalInputCancelledError);
    await server.refreshStarted.promise;
    const buffered = assert.rejects(queue.write('b'), TerminalInputCancelledError);
    queue.dispose();
    server.releaseRefresh();
    await Promise.all([sent, buffered]);
    assert.deepEqual(server.inputs, [], 'No old key reaches the wire after refresh completes');
    await client.request('terminal.input', { slotId: 'new', data: 'fresh' });
    assert.deepEqual(server.inputs, [{ slotId: 'new', data: 'fresh' }]);
  } finally {
    client.disconnect();
    await server.close();
    clock.mock.restore();
  }
});

test('a caller cancelled during connection wait is checked again immediately before sending', async (t) => {
  const { GatewayClient } = await import('./gateway-client');
  const server = await serverFixture(t, false);
  const client = new GatewayClient(server.url, { token: 'fixture' });
  let active = true;
  const rejected = assert.rejects(
    client.request('terminal.input', { slotId: 'old', data: 'a' }, 1000, {
      assertCurrent() {
        if (!active) throw new TerminalInputCancelledError();
      },
    }),
    TerminalInputCancelledError,
  );
  try {
    active = false;
    client.connect();
    await rejected;
    assert.deepEqual(server.inputs, []);
  } finally {
    client.disconnect();
    await server.close();
  }
});
