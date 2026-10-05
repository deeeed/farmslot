import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

import { waitFor } from '../_helpers.js';

const require = createRequire(import.meta.url);

type WsClientModule = {
  createWSClient: (
    url: string,
    timeoutMs: number,
  ) => Promise<{ send: (method: string, params: unknown) => Promise<unknown>; close: () => void }>;
};
type DiscoveryModule = { discoverAllTargets: (port: number) => Promise<unknown[]> };

const wsClient = require(
  fileURLToPath(new URL('../../bridge-runtime/lib/ws-client.cjs', import.meta.url)),
) as WsClientModule;
const discovery = require(
  fileURLToPath(new URL('../../bridge-runtime/lib/target-discovery.cjs', import.meta.url)),
) as DiscoveryModule;

const { createWSClient } = wsClient;
const consoleForwarderPath = fileURLToPath(
  new URL('../../bridge-runtime/console-forwarder.cjs', import.meta.url),
);

describe('Mobile CDP client', () => {
  it('sends the inspector Origin and receives CDP replies', async () => {
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ origin }: { origin: string }) =>
        origin === `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    let observedOrigin: string | undefined;
    server.on('connection', (socket: WebSocket, request: http.IncomingMessage) => {
      observedOrigin = request.headers.origin as string;
      socket.on('message', (message: Buffer) => {
        const command = JSON.parse(String(message)) as { id: number; params?: unknown };
        socket.send(JSON.stringify({ id: command.id, result: { value: 'object' } }));
      });
    });
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const port = (server.address() as { port: number }).port;

      // A connection without the correct Origin must be rejected.
      const rejected = new WebSocket(`ws://127.0.0.1:${port}/inspector/debug`);
      await assert.rejects(
        new Promise<void>((resolve, reject) => {
          rejected.once('open', resolve);
          rejected.once('error', reject);
        }),
        /401/,
      );

      const client = await createWSClient(`ws://127.0.0.1:${port}/inspector/debug`, 2000);
      try {
        assert.equal(observedOrigin, `http://127.0.0.1:${port}`);
        const result = await client.send('Runtime.evaluate', {
          expression: 'typeof globalThis.__AGENTIC__',
        });
        assert.deepEqual(result, { value: 'object' });
      } finally {
        client.close();
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('connects the console collector through the same Origin policy', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'inspector-origin-'));
    const output = path.join(directory, 'app-console.log');
    let port: number;
    const metro = http.createServer(
      (_request: http.IncomingMessage, response: http.ServerResponse) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify([
            {
              id: 'device-1',
              title: 'React Native (origin-test)',
              webSocketDebuggerUrl: `ws://${_request.headers.host}/inspector/debug?device=origin-test&page=1`,
            },
          ]),
        );
      },
    );
    const inspector = new WebSocketServer({
      server: metro,
      verifyClient: ({ origin }: { origin: string }) => origin === `http://127.0.0.1:${port}`,
    });
    inspector.on('connection', (socket: WebSocket) => {
      socket.on('message', (message: Buffer) => {
        const command = JSON.parse(String(message)) as {
          id: number;
          method?: string;
          params?: { expression?: string };
        };
        const value = command.params?.expression?.includes("=== 'object'") ? true : 'object';
        socket.send(
          JSON.stringify({
            id: command.id,
            result: { result: { type: typeof value, value } },
          }),
        );
        if (command.method === 'Runtime.enable') {
          socket.send(
            JSON.stringify({
              method: 'Runtime.consoleAPICalled',
              params: {
                type: 'log',
                timestamp: Date.now(),
                args: [{ type: 'string', value: 'origin-proof' }],
              },
            }),
          );
        }
      });
    });
    let collector: ReturnType<typeof spawn> | undefined;
    try {
      await new Promise<void>((resolve) => metro.listen(0, resolve));
      port = (metro.address() as { port: number }).port;
      const targets = await discovery.discoverAllTargets(port);
      assert.equal(targets.length, 1);
      collector = spawn(
        process.execPath,
        [consoleForwarderPath, '--port', String(port), '--out', output],
        { stdio: 'ignore' },
      );
      await waitFor(async () => {
        const content = await readFile(output, 'utf8');
        assert.ok(content.includes('origin-proof'), 'expected origin-proof in console output');
      }, 5000);
    } finally {
      if (collector && collector.exitCode === null) {
        const exited = new Promise<void>((resolve) => collector!.once('exit', resolve));
        collector.kill('SIGTERM');
        await exited;
      }
      for (const socket of inspector.clients) socket.terminate();
      await new Promise<void>((resolve) => inspector.close(() => resolve()));
      await new Promise<void>((resolve) => metro.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
