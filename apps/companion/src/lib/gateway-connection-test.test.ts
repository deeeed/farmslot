import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type RequestFrame } from '@farmslot/protocol';

import { testGatewayConnection } from './gateway-connection-test';

test('connection tests authenticate and prove gateway.ping before succeeding', async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const sentMethods: string[] = [];

  class TestWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readyState = TestWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = TestWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data: string): void {
      const request = JSON.parse(data) as RequestFrame;
      sentMethods.push(request.method);
      const payload =
        request.method === Methods.AUTH_CONNECT
          ? {
              ok: true,
              clientKind: 'companion',
              authMode: 'token',
              authenticatedAt: Date.now(),
              capabilities: {
                httpBearerAuth: true,
                voiceInstructionFormatting: true,
                gatewayPing: true,
              },
            }
          : { ok: true, serverTimeMs: Date.now() };
      const respond = () =>
        this.onmessage?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload,
          }),
        } as MessageEvent);
      if (request.method === Methods.GATEWAY_PING) setTimeout(respond, 15);
      else queueMicrotask(respond);
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  try {
    const result = await testGatewayConnection(
      'ws://gateway.test/ws',
      { token: 'test-token' },
      { connectMs: 5, pingMs: 50 },
    );
    assert.deepEqual(sentMethods, [Methods.AUTH_CONNECT, Methods.GATEWAY_PING]);
    assert.equal(result.ok, true);
    assert.equal(result.authMode, 'token');
    assert.equal(result.gatewayPingSupported, true);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('connection tests accept authenticated legacy gateways without calling gateway.ping', async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const sentMethods: string[] = [];

  class LegacyWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readyState = LegacyWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = LegacyWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data: string): void {
      const request = JSON.parse(data) as RequestFrame;
      sentMethods.push(request.method);
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: {
              ok: true,
              clientKind: 'companion',
              authMode: 'token',
              authenticatedAt: Date.now(),
              capabilities: {
                httpBearerAuth: true,
                voiceInstructionFormatting: true,
              },
            },
          }),
        } as MessageEvent),
      );
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = LegacyWebSocket as unknown as typeof WebSocket;
  try {
    const result = await testGatewayConnection('ws://legacy-gateway.test/ws', {
      token: 'test-token',
    });
    assert.deepEqual(sentMethods, [Methods.AUTH_CONNECT]);
    assert.equal(result.ok, true);
    assert.equal(result.gatewayPingSupported, false);
    assert.match(result.compatibilityHint ?? '', /older gateway.*update Farmslot/i);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('connection tests reject an unsuccessful auth payload without probing ping', async () => {
  const OriginalWebSocket = globalThis.WebSocket;
  const sentMethods: string[] = [];

  class TestWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readyState = TestWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = TestWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data: string): void {
      const request = JSON.parse(data) as RequestFrame;
      sentMethods.push(request.method);
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: { ok: false },
          }),
        } as MessageEvent),
      );
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  try {
    await assert.rejects(
      testGatewayConnection('ws://gateway.test/ws', { token: 'wrong-token' }),
      /authentication failed/i,
    );
    assert.deepEqual(sentMethods, [Methods.AUTH_CONNECT]);
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('connection tests reject an invalid gateway.ping payload', async () => {
  const OriginalWebSocket = globalThis.WebSocket;

  class TestWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readyState = TestWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = TestWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data: string): void {
      const request = JSON.parse(data) as RequestFrame;
      const payload =
        request.method === Methods.AUTH_CONNECT
          ? {
              ok: true,
              clientKind: 'companion',
              authMode: 'token',
              authenticatedAt: Date.now(),
              capabilities: {
                httpBearerAuth: true,
                voiceInstructionFormatting: true,
                gatewayPing: true,
              },
            }
          : { ok: true };
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload,
          }),
        } as MessageEvent),
      );
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
  try {
    await assert.rejects(
      testGatewayConnection('ws://gateway.test/ws', { token: 'test-token' }),
      /invalid ping response/i,
    );
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});

test('connection tests enforce a separate bounded ping timeout after authentication', async () => {
  const OriginalWebSocket = globalThis.WebSocket;

  class PingBlackholeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;

    readyState = PingBlackholeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(_url: string) {
      queueMicrotask(() => {
        this.readyState = PingBlackholeWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(data: string): void {
      const request = JSON.parse(data) as RequestFrame;
      if (request.method !== Methods.AUTH_CONNECT) return;
      queueMicrotask(() =>
        this.onmessage?.({
          data: JSON.stringify({
            type: 'res',
            id: request.id,
            ok: true,
            payload: {
              ok: true,
              clientKind: 'companion',
              authMode: 'token',
              authenticatedAt: Date.now(),
              capabilities: {
                httpBearerAuth: true,
                voiceInstructionFormatting: true,
                gatewayPing: true,
              },
            },
          }),
        } as MessageEvent),
      );
    }

    close(): void {
      this.readyState = 3;
    }
  }

  globalThis.WebSocket = PingBlackholeWebSocket as unknown as typeof WebSocket;
  try {
    await assert.rejects(
      testGatewayConnection(
        'ws://gateway.test/ws',
        { token: 'test-token' },
        { connectMs: 10, pingMs: 15 },
      ),
      /ping timed out after 15ms/,
    );
  } finally {
    globalThis.WebSocket = OriginalWebSocket;
  }
});
