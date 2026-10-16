import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = new URL('./', import.meta.url);

test('daemon bounds transient reconnects, registers once and preserves auth refusal pacing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-reconnect-'));
  const originalEnv = { ...process.env };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const originalListeners = new Map(signals.map((s) => [s, process.listeners(s)]));
  const logs: string[] = [];
  class Socket extends EventEmitter {
    static OPEN = 1;
    static sockets: Socket[] = [];
    static authError: string | null = null;
    readyState = 0;
    requests: { method: string }[] = [];
    constructor(
      readonly url: string,
      readonly options?: { handshakeTimeout?: number },
    ) {
      super();
      Socket.sockets.push(this);
    }
    send(raw: string, callback?: (error?: Error) => void) {
      const frame = JSON.parse(raw);
      this.requests.push(frame);
      const failure = frame.method === 'auth.connect' ? Socket.authError : null;
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'res',
              id: frame.id,
              ok: !failure,
              ...(failure
                ? { error: { code: failure, message: 'Synthetic refusal' } }
                : { payload: { registered: true } }),
            }),
          ),
        ),
      );
      callback?.();
    }
    open() {
      this.readyState = Socket.OPEN;
      this.emit('open');
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  t.after(async () => {
    for (const s of signals)
      for (const listener of process.listeners(s))
        if (!originalListeners.get(s)!.includes(listener)) process.removeListener(s, listener);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    for (const socket of Socket.sockets) socket.removeAllListeners();
    await rm(root, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    MACHINE_NAME: 'reconnect-fixture',
    GATEWAY_URL: 'ws://127.0.0.1:1',
    FARMSLOT_HOME: root,
  });
  t.mock.method(console, 'log', (...values: unknown[]) => logs.push(values.join(' ')));
  t.mock.method(console, 'error', (...values: unknown[]) => logs.push(values.join(' ')));
  const realWs = await import('ws');
  const { default: originalSocket, ...wsExports } = realWs;
  void originalSocket;
  t.mock.module('ws', { defaultExport: Socket, namedExports: { ...wsExports, WebSocket: Socket } });
  const exec = await import(new URL('commands/exec.ts', source).href);
  t.mock.module(new URL('commands/exec.ts', source).href, {
    namedExports: {
      ...exec,
      exec: async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }),
    },
  });
  t.mock.module(new URL('gateway-credential.ts', source).href, {
    namedExports: { resolveGatewayCredential: () => ({ token: 'synthetic-node-credential' }) },
  });
  t.mock.module(new URL('commands/capture-helper-path.ts', source).href, {
    namedExports: {
      captureHelperPath: () => '/fixture/capture-helper',
      resolveNativeCaptureHelperPath: () => '/fixture/capture-helper',
    },
  });
  t.mock.module(new URL('commands/screen-control.ts', source).href, {
    namedExports: { startScreenControlServer() {}, stopScreenControlServer() {} },
  });
  t.mock.module(new URL('commands/native-session.ts', source).href, {
    namedExports: {
      NativeNodeSessions: class {
        declaration = undefined;
      },
    },
  });
  t.mock.module(new URL('commands/sources.ts', source).href, {
    namedExports: { NodeSources: class {} },
  });
  await import(new URL('index.ts', source).href);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  for (const delay of [500, 1000, 2000, 2000, 2000, 2000]) {
    const before = Socket.sockets.length;
    Socket.sockets.at(-1)!.close();
    t.mock.timers.tick(delay);
    assert.equal(
      Socket.sockets.length,
      before + 1,
      'a transient outage must never sleep beyond two seconds',
    );
  }
  const healthy = Socket.sockets.at(-1)!;
  assert.equal(healthy.options?.handshakeTimeout, 5000);
  healthy.open();
  await drain();
  assert.deepEqual(
    healthy.requests.map((r) => r.method),
    ['auth.connect', 'node.connect'],
  );
  assert(logs.some((l) => l.startsWith('Registered with gateway')));
  healthy.close();
  t.mock.timers.tick(500);
  for (const code of [
    'AUTH_FORBIDDEN',
    'AUTH_PERSON_SESSION_REQUIRED',
    'AUTH_SESSION_ENDED',
    'AUTH_RECONNECT_REQUIRED',
  ]) {
    Socket.authError = code;
    Socket.sockets.at(-1)!.open();
    await drain();
    const rejectedCount = Socket.sockets.length;
    t.mock.timers.tick(29_999);
    assert.equal(Socket.sockets.length, rejectedCount);
    t.mock.timers.tick(1);
    assert.equal(
      Socket.sockets.length,
      rejectedCount + 1,
      'auth refusal retains its thirty-second pace',
    );
  }
});
