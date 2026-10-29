import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { WebSocket, WebSocketServer } from 'ws';

import type { RequestFrame } from '@farmslot/protocol';

import type { SlotVars } from '../core/config.js';

await import('./mock-pty.test-support.js');
const vars: SlotVars = {
  slotId: 'lost-reply-slot',
  machine: 'lost-reply-node',
  host: 'fixture.invalid',
  platform: 'cli',
  osType: 'linux',
  sshUser: 'fixture',
  claudePath: '',
  codexPath: '',
  opencodePath: '',
  cursorPath: '',
  grokPath: '',
  dispatchCmd: '',
  recycleCmd: '',
  repo: '/fixture',
  remoteRepo: '/fixture',
  session: 'input',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: 'fixture@fixture.invalid',
  projectName: 'fixture',
  resourceVars: {},
};
const config = await import('../core/config.js');
mock.module('../core/config.js', { namedExports: { ...config, loadSlotVars: async () => vars } });
const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { NodeRpcTimeoutError } = await import('../fleet/node-rpc.js');
const { sendKeys } = await import('./tmux-stream.js');

test(
  'raw literal input is sent once when its executed remote command loses the reply',
  { timeout: 2000 },
  async (t) => {
    const server = createServer();
    const wss = new WebSocketServer({ server });
    let client: WebSocket | undefined;
    let peer: WebSocket | undefined;
    t.after(async () => {
      if (peer) {
        unregisterByWs(peer);
        peer.terminate();
      }
      client?.terminate();
      await new Promise<void>((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    assert(address && typeof address !== 'string');
    const connected = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
    client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await once(client, 'open');
    peer = await connected;
    registerNode(vars.machine, 1, peer);
    const wire = t.mock.method(peer, 'send');
    let markReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      markReceived = resolve;
    });
    const deliveries: RequestFrame[] = [];
    client.on('message', (raw) => {
      const frame: RequestFrame = JSON.parse(raw.toString());
      assert.equal(frame.method, 'exec');
      deliveries.push(frame);
      // The node applied the raw input, but its response was lost. Never acknowledge it.
      markReceived();
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const rejected = assert.rejects(
      sendKeys(vars.slotId, 'input', 'Up', false, undefined, { noRetry: true }),
      NodeRpcTimeoutError,
    );
    await received;
    t.mock.timers.tick(15_000);
    await setImmediate();
    t.mock.timers.tick(3_000);
    await setImmediate();
    t.mock.timers.tick(15_000);
    await setImmediate();
    await rejected;
    t.mock.timers.reset();
    assert.equal(wire.mock.callCount(), 1, 'The gateway must not resend an uncertain input write');
    assert.equal(deliveries.length, 1, 'A lost reply must never duplicate terminal input');
    assert.match(JSON.stringify(deliveries[0].params), /send-keys.*-l/);
  },
);
