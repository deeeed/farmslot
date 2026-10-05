import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';

import { waitFor } from '../_helpers.js';

const require = createRequire(import.meta.url);

interface DevtoolsProxyOptions {
  descriptorPath: string;
  sessions: Map<string, unknown>;
  sendCommand: ReturnType<typeof mock.fn>;
  requestDiscovery: ReturnType<typeof mock.fn>;
  allowedOrigins: string[];
}

interface DevtoolsProxy {
  close(): void;
  onCdpEvent(deviceId: string, event: string, params: unknown): void;
  onSessionOpen(deviceId: string, session: unknown): void;
}

type ProxyModule = { createDevtoolsProxy: (options: DevtoolsProxyOptions) => DevtoolsProxy };

const proxyModule = require(
  fileURLToPath(new URL('../../bridge-runtime/lib/devtools-proxy.cjs', import.meta.url)),
) as ProxyModule;
const { createDevtoolsProxy } = proxyModule;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  mock.restoreAll();
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('DevTools broker proxy', () => {
  it('fails fast without an allowed debugger Origin', () => {
    assert.throws(
      () =>
        createDevtoolsProxy({
          descriptorPath: '/tmp/unused-devtools-proxy.json',
          sessions: new Map(),
          sendCommand: mock.fn(),
          requestDiscovery: mock.fn(),
          allowedOrigins: [],
        }),
      /requires at least one allowed Origin/,
    );
  });

  it('forwards commands and events and restores enabled domains after reload', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'devtools-proxy-'));
    const descriptorPath = path.join(directory, 'proxy.json');
    const firstSession = { brokerReady: true };
    const sessions = new Map<string, unknown>([['device-1', firstSession]]);
    const sendCommand = mock.fn<(...args: unknown[]) => Promise<{ accepted: boolean }>>(
      async () => ({ accepted: true }),
    );
    const proxy = createDevtoolsProxy({
      descriptorPath,
      sessions,
      sendCommand,
      requestDiscovery: mock.fn(),
      allowedOrigins: ['http://127.0.0.1:8161'],
    });
    cleanups.push(async () => {
      proxy.close();
      await rm(directory, { recursive: true, force: true });
    });

    let descriptor: { port: number };
    await waitFor(async () => {
      descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as { port: number };
      assert.ok(descriptor.port > 0, 'descriptor port should be > 0');
    });

    const socket = new WebSocket(`ws://127.0.0.1:${descriptor!.port}/devtools?device=device-1`, {
      origin: 'http://127.0.0.1:8161',
    });
    cleanups.push(() => socket.close());
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const messages: unknown[] = [];
    socket.on('message', (data: Buffer) => messages.push(JSON.parse(String(data))));

    socket.send(JSON.stringify({ id: 7, method: 'Runtime.enable', params: {} }));
    await waitFor(() => {
      const found = messages.some(
        (m) =>
          (m as { id?: number; result?: unknown }).id === 7 &&
          JSON.stringify((m as { result?: unknown }).result) === JSON.stringify({ accepted: true }),
      );
      assert.ok(found, 'expected response for Runtime.enable (id:7)');
    });

    socket.send(JSON.stringify({ id: 8, method: 'Runtime.disable', params: {} }));
    await waitFor(() => {
      const found = messages.some((m) => (m as { id?: number }).id === 8);
      assert.ok(found, 'expected response for Runtime.disable (id:8)');
      const r = messages.find((m) => (m as { id?: number }).id === 8) as { result?: unknown };
      assert.deepEqual(r.result, {});
    });
    // Runtime.disable must NOT be forwarded to sendCommand.
    assert.ok(
      !sendCommand.mock.calls.some((c) => c.arguments[1] === 'Runtime.disable'),
      'Runtime.disable should not have been forwarded to sendCommand',
    );

    socket.send(JSON.stringify({ id: 9, method: 'Runtime.enable', params: {} }));
    await waitFor(() => {
      const found = messages.some((m) => (m as { id?: number }).id === 9);
      assert.ok(found, 'expected response for second Runtime.enable (id:9)');
    });

    proxy.onCdpEvent('device-1', 'Runtime.executionContextCreated', {
      context: { id: 1 },
    });
    await waitFor(() => {
      const found = messages.some(
        (m) =>
          (m as { method?: string }).method === 'Runtime.executionContextCreated' &&
          JSON.stringify((m as { params?: unknown }).params) ===
            JSON.stringify({ context: { id: 1 } }),
      );
      assert.ok(found, 'expected Runtime.executionContextCreated event');
    });

    // Simulate session reload: proxy should re-enable Runtime on the new session.
    const nextSession = { brokerReady: true };
    sessions.set('device-1', nextSession);
    proxy.onSessionOpen('device-1', nextSession);
    await waitFor(() => {
      const found = sendCommand.mock.calls.some(
        (c) =>
          c.arguments[0] === nextSession &&
          c.arguments[1] === 'Runtime.enable' &&
          JSON.stringify(c.arguments[2]) === '{}' &&
          typeof c.arguments[3] === 'number',
      );
      assert.ok(
        found,
        'sendCommand should have been called with (nextSession, Runtime.enable, {}, number)',
      );
    });

    // A connection from a disallowed origin must be rejected with code 1008.
    const rejected = new WebSocket(`ws://127.0.0.1:${descriptor!.port}/devtools?device=device-1`, {
      origin: 'http://example.com',
    });
    await new Promise<void>((resolve) => {
      rejected.once('close', (code: number) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    // A second allowed connection replaces the first (old socket closes with 1000).
    const replacement = new WebSocket(
      `ws://127.0.0.1:${descriptor!.port}/devtools?device=device-1`,
      { origin: 'http://127.0.0.1:8161' },
    );
    const replaced = new Promise<void>((resolve) => {
      socket.once('close', (code: number) => {
        assert.equal(code, 1000);
        resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      replacement.once('open', resolve);
      replacement.once('error', reject);
    });
    await replaced;
    replacement.close();
  });
});
