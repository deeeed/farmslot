import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = new URL('./', import.meta.url);
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test('the daemon advertises conditional writes and answers a refused write with its details', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'node-conditional-'));
  const repo = path.join(root, 'repo');
  const originalEnv = { ...process.env };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const originalListeners = new Map(signals.map((s) => [s, process.listeners(s)]));
  type Frame = {
    type: string;
    id: string;
    method?: string;
    params?: Record<string, unknown>;
    ok?: boolean;
    payload?: unknown;
    error?: { code: string; message: string; details?: unknown };
  };
  class Socket extends EventEmitter {
    static OPEN = 1;
    static sockets: Socket[] = [];
    readyState = 0;
    requests: Frame[] = [];
    replies = new Map<string, Frame>();
    constructor(readonly url: string) {
      super();
      Socket.sockets.push(this);
    }
    send(raw: string, callback?: (error?: Error) => void) {
      const frame = JSON.parse(raw) as Frame;
      if (frame.type === 'res') this.replies.set(frame.id, frame);
      else {
        this.requests.push(frame);
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'res',
                id: frame.id,
                ok: true,
                payload: { registered: true },
              }),
            ),
          ),
        );
      }
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
    MACHINE_NAME: 'conditional-fixture',
    GATEWAY_URL: 'ws://127.0.0.1:1',
    FARMSLOT_HOME: root,
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
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
        async startObservation() {}
        stopObservation() {}
        observationReceipt() {
          return undefined;
        }
      },
    },
  });
  t.mock.module(new URL('commands/sources.ts', source).href, {
    namedExports: { NodeSources: class {} },
  });
  await import(new URL('index.ts', source).href);
  const socket = Socket.sockets.at(-1)!;
  socket.open();
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(check());
  };
  await settle(() => socket.requests.some((frame) => frame.method === 'node.connect'));
  const registration = socket.requests.find((frame) => frame.method === 'node.connect')!;
  assert.equal(registration.params?.conditionalWrites, true);

  await mkdir(repo);
  await writeFile(path.join(repo, 'a.txt'), 'one');
  const call = async (id: string, method: string, params: Record<string, unknown>) => {
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'req', id, method, params })));
    await settle(() => socket.replies.has(id));
    return socket.replies.get(id)!;
  };
  const read = await call('read', 'fs.read', { root: repo, relPath: 'a.txt' });
  assert.deepEqual(read.payload, { content: 'one', hash: sha256('one') });
  const stale = await call('stale', 'fs.write', {
    root: repo,
    relPath: 'a.txt',
    content: 'lost',
    expectedHash: 'stale',
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error?.code, 'FS_CONFLICT');
  assert.deepEqual(stale.error?.details, { reason: 'hash', currentHash: sha256('one') });
  assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'one');
  const written = await call('write', 'fs.write', {
    root: repo,
    relPath: 'a.txt',
    content: 'two',
    expectedHash: sha256('one'),
  });
  assert.deepEqual(written.payload, { ok: true, hash: sha256('two') });
  const malformed = await call('malformed', 'fs.delete', {
    root: repo,
    relPath: 'a.txt',
    expectedHash: null,
  });
  assert.match(malformed.error?.message ?? '', /expectedHash must be a string/);
  socket.close();
});
