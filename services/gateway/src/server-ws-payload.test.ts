// Proves oversized inbound WebSocket frames close the offending socket with
// 1009 and do NOT crash the gateway process (unhandled 'error' on the socket).
process.env.NODE_TEST_CONTEXT = '1';

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from './security/auth.js';
import {
  createWebSocketServer,
  DEFAULT_WS_MAX_PAYLOAD_BYTES,
  resetServerGlobalsForTests,
} from './server.js';

test('DEFAULT_WS_MAX_PAYLOAD_BYTES matches the ws library default (100 MiB)', () => {
  assert.equal(DEFAULT_WS_MAX_PAYLOAD_BYTES, 100 * 1024 * 1024);
});

test('oversized inbound frame closes the client with 1009 without killing the process', async () => {
  resetServerGlobalsForTests();
  const authRuntime = createGatewayAuthRuntime();
  // Tiny cap so the test does not allocate 100 MiB.
  const maxPayload = 256;
  const httpServer = createServer();
  const wss = createWebSocketServer(httpServer, authRuntime, { maxPayload });

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = httpServer.address() as { port: number };

    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for close 1009')), 5_000);
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('open', () => {
        // Frame larger than maxPayload → server Receiver emits error + close 1009.
        client.send(Buffer.alloc(maxPayload + 64, 0x61));
      });
      client.on('close', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      client.on('error', () => {
        // Client may see a reset when the server closes on 1009; still wait for close.
      });
    });

    assert.equal(closeCode, 1009, 'ws close code for message too big');
  } finally {
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    resetServerGlobalsForTests();
  }
});

test('credential-store refresh failure closes only the initializing websocket', async () => {
  resetServerGlobalsForTests();
  const authRuntime = createGatewayAuthRuntime({
    FARMSLOT_HOME: mkdtempSync(join(tmpdir(), 'farmslot-ws-connect-fault-')),
    FARMSLOT_GATEWAY_TOKEN: 'connect-fault-token',
    GATEWAY_HOST: '127.0.0.1',
  });
  initializeGatewayIdentity(authRuntime, { host: '127.0.0.1' });
  const originalStore = readFileSync(authRuntime.store.path, 'utf8');
  const httpServer = createServer();
  const wss = createWebSocketServer(httpServer, authRuntime);

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = httpServer.address() as { port: number };
    writeFileSync(authRuntime.store.path, '{');

    const close = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for credential-store fault close')),
        5_000,
      );
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      client.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      client.on('error', reject);
    });
    assert.deepEqual(close, { code: 1011, reason: 'internal gateway error' });

    writeFileSync(authRuntime.store.path, originalStore);
    const recovered = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      recovered.once('open', resolve);
      recovered.once('error', reject);
    });
    recovered.close();
  } finally {
    writeFileSync(authRuntime.store.path, originalStore);
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    resetServerGlobalsForTests();
  }
});
