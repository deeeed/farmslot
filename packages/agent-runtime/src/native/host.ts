import { chmodSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { NativeConversationSubscription } from './conversation.js';
import { authenticated, decodeRequest, type HostIdentity, object } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { privateDirectory, readJson } from './storage.js';
import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_CANCEL_COMMAND,
  NATIVE_WORKER_CLOSE,
  NATIVE_WORKER_CONFIRM_STOPPED,
  NATIVE_WORKER_ENSURE,
  NATIVE_WORKER_INTERRUPT,
  NATIVE_WORKER_READ,
  NATIVE_WORKER_RESPOND,
  NATIVE_WORKER_RESUME,
  NATIVE_WORKER_SEND,
  NATIVE_WORKER_STEER,
  NATIVE_WORKER_TRANSFER,
} from './worker-launch.js';

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
  const commandObservation = new AbortController();
  let subscription: NativeConversationSubscription | undefined;
  socket.on('close', () => {
    subscription?.stop();
    commandObservation.abort();
  });
  socket.on('end', () => {
    void (async () => {
      try {
        const envelope = object(JSON.parse(input));
        if (!authenticated(envelope.token, identity.token))
          throw new Error('Native IPC authentication failed');
        const p = decodeRequest(envelope.request);
        if (p.method === 'subscribe') {
          socket.setTimeout(0);
          const journal = manager.conversation(p.owner, p.id, p.leaseId, p.generation);
          const write = (value: unknown) => {
            if (socket.destroyed) return;
            const encoded = JSON.stringify({ value }) + '\n';
            if (socket.writableLength + Buffer.byteLength(encoded) > 1024 * 1024) {
              subscription?.stop();
              const terminal =
                JSON.stringify({ value: { kind: 'terminal', reason: 'resync-required' } }) + '\n';
              if (socket.writableLength + Buffer.byteLength(terminal) > 1024 * 1024)
                socket.destroy();
              else socket.end(terminal);
              return;
            }
            socket.write(encoded);
          };
          subscription = new NativeConversationSubscription(journal, p.after, (update) => {
            write(update);
            if (update.kind === 'terminal') socket.end();
          });
          // Node's stream preserves write order; the client sees this result before any live frame.
          write(subscription.initial);
          subscription.start();
          if (subscription.initial.kind === 'terminal') {
            subscription.stop();
            socket.end();
          }
          return;
        }
        let value: unknown;
        switch (p.method) {
          case 'commandStatus':
            value = p.waitForAcceptance
              ? await manager.waitCommandStatus(
                  p.owner,
                  p.id,
                  p.commandId,
                  commandObservation.signal,
                )
              : manager.commandStatus(p.owner, p.id, p.commandId);
            break;
          case 'inspect':
            value = manager.inspect(p.owner, p.id);
            break;
          case NATIVE_WORKER_READ:
            value = manager.readWorker(p.owner, p.id, p.leaseId, p.after, p.limit, p.generation);
            break;
          case 'setApprovalMode':
            value = await manager.setApprovalMode(p.owner, p.id, p.approvalMode);
            break;
          case 'create':
            value = await manager.create(p.owner, p.params, undefined, p.requester);
            break;
          case 'ensure':
            value = await manager.ensure(p.owner, p.params, undefined, p.requester);
            break;
          case NATIVE_WORKER_ENSURE:
            value = await manager.ensure(p.owner, p.params, p.launch);
            break;
          case NATIVE_WORKER_RESUME:
            value = await manager.resumeWorker(p.owner, p.params, p.launch);
            break;
          case NATIVE_WORKER_TRANSFER:
            value = manager.transferWorker(p.owner, p.id, p.generation, p.leaseId, p.launch);
            break;
          case NATIVE_WORKER_CANCEL:
            value = await manager.cancelWorker(
              p.owner,
              p.id,
              p.leaseId,
              p.generation,
              p.sourceLeaseId,
              p.resumeCommandId,
            );
            break;
          case NATIVE_WORKER_SEND:
            manager.assertWorkerLease(p.owner, p.id, p.generation, p.leaseId);
            value = await manager.send(p.owner, p.id, p.commandId, p.text);
            break;
          case NATIVE_WORKER_STEER:
            manager.assertWorkerLease(p.owner, p.id, p.generation, p.leaseId);
            value = await manager.steer(p.owner, p.id, p.commandId, p.text);
            break;
          case NATIVE_WORKER_CANCEL_COMMAND:
            manager.assertWorkerLease(p.owner, p.id, p.generation, p.leaseId);
            value = manager.cancelCommand(p.owner, p.id, p.commandId);
            break;
          case NATIVE_WORKER_RESPOND:
            manager.assertWorkerLease(p.owner, p.id, p.generation, p.leaseId);
            value = await manager.respond(p.owner, p.id, p.requestId, p.response);
            break;
          case NATIVE_WORKER_CLOSE:
            value = await manager.closeWorker(p.owner, p.id, p.generation, p.leaseId);
            break;
          case NATIVE_WORKER_CONFIRM_STOPPED:
            value = manager.confirmWorkerStopped(p.owner, p.id, p.generation, p.leaseId);
            break;
          case NATIVE_WORKER_INTERRUPT:
            manager.assertWorkerLease(p.owner, p.id, p.generation, p.leaseId);
            value = await manager.interrupt(p.owner, p.id);
            break;
          case 'list':
            value = manager.list(p.owner);
            break;
          case 'read':
            value = manager.read(p.owner, p.id, p.after, p.limit);
            break;
          case 'send':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = await manager.send(p.owner, p.id, p.commandId, p.text);
            break;
          case 'steer':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = await manager.steer(p.owner, p.id, p.commandId, p.text);
            break;
          case 'cancelCommand':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = manager.cancelCommand(p.owner, p.id, p.commandId);
            break;
          case 'respond':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = await manager.respond(p.owner, p.id, p.requestId, p.response);
            break;
          case 'interrupt':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = await manager.interrupt(p.owner, p.id);
            break;
          case 'close':
            manager.assertUnmanagedSession(p.owner, p.id);
            value = await manager.close(p.owner, p.id);
            break;
        }
        if (!socket.destroyed) socket.end(JSON.stringify({ value: value ?? null }));
      } catch (error) {
        if (!socket.destroyed)
          socket.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              ...((error as { code?: string }).code === 'NOT_FOUND'
                ? { errorCode: 'NOT_FOUND' }
                : {}),
            }),
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
