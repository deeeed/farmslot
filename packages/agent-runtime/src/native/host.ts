import { chmodSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { authenticated, decodeRequest, type HostIdentity, object } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { privateDirectory, readJson } from './storage.js';

// The supervisor must durably register this PID before the host can bind or launch.
await new Promise<void>((resolve, reject) => {
  process.once('message', (message) => {
    if (message === 'start') resolve();
    else reject(new Error('Invalid native host startup release'));
  });
  process.once('disconnect', () =>
    reject(new Error('Native supervisor stopped before host registration')),
  );
});
const root = process.argv[2]!;
const identity = readJson<HostIdentity>(join(root, 'host.json'));
const manager = new NativeSessionManager(
  join(root, 'sessions'),
  identity.executionNodeId ?? 'local',
);
const server = createServer({ allowHalfOpen: true }, (socket) => {
  socket.setEncoding('utf8');
  socket.setTimeout(50_000, () => socket.destroy());
  let input = '';
  socket.on('error', (error: NodeJS.ErrnoException) => {
    // Peer loss only ends this RPC. The host and its operation remain authoritative.
    if (!['EPIPE', 'ECONNRESET'].includes(error.code ?? '')) throw error;
  });
  socket.on('data', (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) socket.destroy();
  });
  socket.on('end', () => {
    void (async () => {
      try {
        const envelope = object(JSON.parse(input));
        if (!authenticated(envelope.token, identity.token))
          throw new Error('Native IPC authentication failed');
        const p = decodeRequest(envelope.request);
        let value: unknown;
        switch (p.method) {
          case 'create':
            value = await manager.create(p.owner, p.params);
            break;
          case 'ensure':
            value = await manager.ensure(p.owner, p.params);
            break;
          case 'list':
            value = manager.list(p.owner);
            break;
          case 'read':
            value = manager.read(p.owner, p.id, p.after, p.limit);
            break;
          case 'send':
            value = await manager.send(p.owner, p.id, p.commandId, p.text);
            break;
          case 'respond':
            value = await manager.respond(p.owner, p.id, p.requestId, p.response);
            break;
          case 'interrupt':
            value = await manager.interrupt(p.owner, p.id);
            break;
          case 'close':
            value = await manager.close(p.owner, p.id);
            break;
        }
        if (!socket.destroyed) socket.end(JSON.stringify({ value: value ?? null }));
      } catch (error) {
        if (!socket.destroyed)
          socket.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
      }
    })();
  });
});
privateDirectory(join(identity.socket, '..'));
try {
  unlinkSync(identity.socket);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
server.listen(identity.socket, () => {
  chmodSync(identity.socket, 0o600);
  process.send?.('ready');
});
