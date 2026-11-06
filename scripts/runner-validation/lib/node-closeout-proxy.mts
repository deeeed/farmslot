import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

interface Frame {
  type?: string;
  id?: string;
  method?: string;
  ok?: boolean;
  error?: { code?: string; message?: string };
  params?: { root?: string; relPath?: string };
  payload?: { requestId?: string; exitCode?: number };
}

/** Relay real frames unchanged. The extra exec only creates an owned closeout window. */
export class NodeCloseoutProxy {
  private server?: WebSocketServer;
  private readonly sockets = new Set<WebSocket>();
  private node?: WebSocket;
  private held?: { socket: WebSocket; bytes: Buffer; binary: boolean };
  private target?: string;
  private holdWhen?: () => Promise<boolean>;
  private heldId?: string;
  private readonly closeoutId = `closeout-${randomUUID()}`;
  closeoutResult?: Frame;
  heldMethod?: string;
  shutdownRefusals = 0;
  shutdownError?: Frame['error'];

  async start(gatewayUrl: string): Promise<string> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server = server;
    server.on('connection', (client) => {
      const gateway = new WebSocket(gatewayUrl);
      this.sockets.add(client);
      this.sockets.add(gateway);
      const queued: Array<{ bytes: Buffer; binary: boolean }> = [];
      gateway.on('open', () => {
        for (const frame of queued) gateway.send(frame.bytes, { binary: frame.binary });
        queued.length = 0;
      });
      client.on('message', (raw, binary) => {
        const bytes = buffer(raw);
        const frame: Frame = JSON.parse(bytes.toString());
        if (frame.type === 'req' && frame.method === 'node.connect') this.node = client;
        if (frame.id === this.closeoutId || frame.payload?.requestId === this.closeoutId) {
          if (frame.type === 'res') this.closeoutResult = frame;
          return;
        }
        if (frame.type === 'res' && frame.id === this.heldId && frame.ok === false) {
          this.shutdownRefusals++;
          this.shutdownError = frame.error;
        }
        if (gateway.readyState === WebSocket.OPEN) gateway.send(bytes, { binary });
        else queued.push({ bytes, binary });
      });
      gateway.on('message', async (raw, binary) => {
        const bytes = buffer(raw);
        const frame: Frame = JSON.parse(bytes.toString());
        const params = frame.params;
        if (
          this.target &&
          frame.method === 'fs.exists' &&
          params?.root &&
          params.relPath &&
          path.resolve(params.root, params.relPath) === this.target &&
          (await this.holdWhen?.())
        ) {
          this.target = undefined;
          this.heldMethod = frame.method;
          this.heldId = frame.id;
          this.held = { socket: client, bytes, binary };
          return;
        }
        if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
      });
      for (const [socket, peer] of [
        [client, gateway],
        [gateway, client],
      ]) {
        socket.on('error', () => peer.terminate());
        socket.on('close', () => {
          this.sockets.delete(socket);
          peer.terminate();
        });
      }
    });
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    return `ws://127.0.0.1:${address.port}`;
  }

  holdExists(file: string, when: () => Promise<boolean>): void {
    this.target = file;
    this.holdWhen = when;
  }
  isHeld(): boolean {
    return Boolean(this.held);
  }

  startCloseout(argv: string[]): void {
    assert(this.node?.readyState === WebSocket.OPEN);
    this.node.send(
      JSON.stringify({
        type: 'req',
        id: this.closeoutId,
        method: 'exec',
        params: { argv, requestScoped: true, closeoutTimeoutMs: 5000, timeout: 30000 },
      }),
    );
  }

  release(): void {
    assert(this.held);
    this.held.socket.send(this.held.bytes, { binary: this.held.binary });
    this.held = undefined;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    if (this.server) {
      const server = this.server;
      this.server = undefined;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

function buffer(raw: RawData): Buffer {
  return Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
}
