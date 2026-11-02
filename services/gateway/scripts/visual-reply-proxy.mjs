import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

/** Preserve the visual proof's terminal-only transport contract. */
export function createVisualReplyProxy(options) {
  return createRunReplyProxy({ ...options, method: 'terminal.send' });
}

/** Setup-only legacy snapshots followed by an outage of these owned client connections. */
export function createOfflineSnapshotProxy(options) {
  return createRunReplyProxy({ ...options, offlineSnapshots: true, armed: false });
}

/** Private proof transport: delay a scoped RPC response without changing its bytes. */
export async function createRunReplyProxy({
  upstreamPort,
  runId,
  method,
  params,
  armed = true,
  holdResponse = () => true,
  offlineSnapshots = false,
  allowRequest,
  port = 0,
}) {
  assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
  assert(Number.isSafeInteger(upstreamPort) && upstreamPort > 0);
  if (offlineSnapshots) assert.equal(typeof allowRequest, 'function');
  else if (method === 'run.list')
    assert(runId === undefined && params && typeof params === 'object');
  else assert.match(runId, /^[a-f0-9-]{36}$/);
  const methods = new Set([
    'terminal.send',
    'run.get',
    'native.session.read',
    'task.progress',
    'run.list',
  ]);
  assert(offlineSnapshots || methods.has(method));
  let offline = false;
  let blocked = 0;
  let selected = { method, params, armed, holdResponse };
  const matchesParams = (actual) =>
    selected.params === undefined ||
    (Object.keys(actual ?? {}).length === Object.keys(selected.params).length &&
      Object.entries(selected.params).every(
        ([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value),
      ));
  let failure;
  let held;
  const pairs = new Set();
  const fresh = () => ({ requests: 0, held: false, released: false, expired: false });
  let evidence = fresh();
  const counts = new Map();
  const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const server = createServer((incoming, outgoing) => {
    if (offline || (offlineSnapshots && !['GET', 'HEAD'].includes(incoming.method))) {
      outgoing.writeHead(offline ? 503 : 405);
      outgoing.end();
      return;
    }
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
    if (offline) {
      downstream.close();
      return;
    }
    const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${incoming.url}`);
    const pair = { downstream, upstream };
    pairs.add(pair);
    const waiting = [];
    const targetIds = new Map();
    downstream.on('message', (bytes, binary) => {
      if (offlineSnapshots) {
        const frame = binary ? undefined : JSON.parse(String(bytes));
        const policy = frame?.type === 'req' ? allowRequest(frame) : false;
        if (!policy) {
          blocked++;
          if (frame?.id)
            downstream.send(
              JSON.stringify({
                type: 'res',
                id: frame.id,
                ok: false,
                error: {
                  code: 'PROOF_READ_ONLY',
                  message: 'This snapshot fixture permits reads only',
                },
              }),
            );
          return;
        }
        // Preparation uses real legacy replies, never manufactured data or revision stamps.
        if (policy === true || policy.snapshot) delete frame.resourceRead;
        bytes = JSON.stringify(frame);
        counts.set(frame.method, (counts.get(frame.method) ?? 0) + 1);
      }
      if (!binary) {
        const frame = JSON.parse(String(bytes));
        if (
          !offlineSnapshots &&
          frame.type === 'req' &&
          (selected.method === 'run.list'
            ? frame.method === 'run.list' && matchesParams(frame.params)
            : (frame.params?.runId ?? frame.params?.worker?.runId) === runId)
        ) {
          counts.set(frame.method, (counts.get(frame.method) ?? 0) + 1);
          if (frame.method === selected.method && matchesParams(frame.params)) {
            evidence.requests++;
            targetIds.set(frame.id, {
              method: frame.method,
              params: frame.params,
              after: frame.params?.after ?? 0,
            });
          }
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
      const pending = frame?.type === 'res' ? targetIds.get(frame.id) : undefined;
      if (frame?.type === 'res') targetIds.delete(frame.id);
      if (
        pending?.method === selected.method &&
        selected.armed &&
        !evidence.held &&
        selected.holdResponse(frame)
      ) {
        evidence.held = true;
        evidence.heldMethod = pending.method;
        evidence.heldRequestId = frame.id;
        evidence.heldParams = pending.params;
        evidence.heldAfter = pending.after;
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
      // Closing an owned connecting socket is the intentional offline transition.
      if (!offline) failure = error;
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
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    state() {
      if (failure) throw failure;
      return {
        ...evidence,
        method: selected.method,
        counts: Object.fromEntries(counts),
        offline,
        blocked,
      };
    },
    setOffline(value) {
      assert(offlineSnapshots, 'Only the snapshot fixture owns an outage switch');
      offline = value;
      if (offline)
        for (const { downstream, upstream } of pairs) {
          downstream.terminate();
          upstream.terminate();
        }
    },
    arm(options = {}) {
      assert(!held, 'Release the current response before selecting another proof boundary');
      const method = options.method ?? selected.method;
      assert(methods.has(method));
      selected = {
        method,
        params: options.params ?? (method === selected.method ? selected.params : undefined),
        armed: true,
        holdResponse: options.holdResponse ?? selected.holdResponse,
      };
      if (method === 'run.list') assert(runId === undefined && selected.params);
      evidence = fresh();
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
