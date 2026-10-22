import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

/** Private proof transport: hold one real terminal reply, without changing its bytes. */
export async function createVisualReplyProxy({ upstreamPort, runId }) {
  assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
  assert(Number.isSafeInteger(upstreamPort) && upstreamPort > 0);
  assert.match(runId, /^[a-f0-9-]{36}$/);
  let failure;
  let held;
  const pairs = new Set();
  const evidence = { requests: 0, held: false, released: false, expired: false };
  const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const server = createServer((incoming, outgoing) => {
    const forwarded = request(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
      },
      (reply) => {
        outgoing.writeHead(reply.statusCode, reply.headers);
        reply.pipe(outgoing);
      },
    );
    forwarded.on('error', (error) => {
      failure = error;
      outgoing.destroy(error);
    });
    incoming.pipe(forwarded);
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('error', (error) => {
    failure = error;
  });
  sockets.on('connection', (downstream, incoming) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${incoming.url}`);
    const pair = { downstream, upstream };
    pairs.add(pair);
    const waiting = [];
    const targetIds = new Set();
    downstream.on('message', (bytes, binary) => {
      if (!binary) {
        const frame = JSON.parse(String(bytes));
        if (
          frame.type === 'req' &&
          frame.method === 'terminal.send' &&
          frame.params?.runId === runId
        ) {
          evidence.requests++;
          targetIds.add(frame.id);
        }
      }
      if (upstream.readyState === WebSocket.CONNECTING) waiting.push([bytes, binary]);
      else if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
    });
    upstream.on('open', () => {
      for (const [bytes, binary] of waiting) upstream.send(bytes, { binary });
      waiting.length = 0;
    });
    upstream.on('message', (bytes, binary) => {
      const frame = binary ? undefined : JSON.parse(String(bytes));
      if (frame?.type === 'res' && targetIds.delete(frame.id) && !evidence.held) {
        evidence.held = true;
        evidence.responseOk = frame.ok;
        evidence.errorCode = frame.error?.code;
        evidence.errorMessage = frame.error?.message;
        evidence.responseDigest = digest(bytes);
        evidence.heldAt = Date.now();
        held = { downstream, bytes, binary };
        held.timer = setTimeout(() => {
          evidence.expired = true;
          release();
        }, 14000);
        return;
      }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes, { binary });
    });
    const close = () => {
      upstream.terminate();
      downstream.terminate();
      pairs.delete(pair);
    };
    downstream.on('error', (error) => {
      failure = error;
      close();
    });
    upstream.on('error', (error) => {
      failure = error;
      close();
    });
    downstream.on('close', close);
    upstream.on('close', close);
  });
  function release() {
    if (!held) return;
    const { downstream, bytes, binary, timer } = held;
    held = undefined;
    clearTimeout(timer);
    if (downstream.readyState !== WebSocket.OPEN) {
      failure = new Error('The held reply lost its socket.');
      return;
    }
    downstream.send(bytes, { binary });
    evidence.released = true;
    evidence.releasedAt = Date.now();
    evidence.deliveredDigest = digest(bytes);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    state() {
      if (failure) throw failure;
      return { ...evidence };
    },
    release,
    async close() {
      if (held) clearTimeout(held.timer);
      held = undefined;
      for (const { downstream, upstream } of pairs) {
        downstream.terminate();
        upstream.terminate();
      }
      await new Promise((resolve, reject) =>
        sockets.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
