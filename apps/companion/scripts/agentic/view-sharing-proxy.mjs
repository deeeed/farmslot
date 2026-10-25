#!/usr/bin/env node
// Owned proof transport. Frames are forwarded unchanged; receipts omit credentials and text.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, readFile, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const caseDir = process.env.FARMSLOT_VIEW_SHARING_CASE;
assert(caseDir && path.isAbsolute(caseDir));
const fixture = JSON.parse(await readFile(path.join(caseDir, 'fixture.json'), 'utf8'));
const receiptDir = process.env.FARMSLOT_VIEW_SHARING_PROXY_ARTIFACTS_DIR ?? caseDir;
assert(
  path.isAbsolute(receiptDir) &&
    (receiptDir === caseDir || receiptDir.startsWith(caseDir + path.sep)),
);
assert.equal(fixture.sourceRoot, sourceRoot);
const port = Number(process.env.FARMSLOT_VIEW_SHARING_PROXY_PORT);
assert(Number.isInteger(port) && port > 1024 && port < 65536 && port !== fixture.gatewayPort);
const startId = randomUUID();
const startAt = new Date().toISOString();
const receipt = {
  sourceRoot,
  caseDir,
  startId,
  startAt,
  pid: process.pid,
  port,
  upstreamPort: fixture.gatewayPort,
};
const stats = {
  ...receipt,
  requests: [],
  mutations: [],
  responses: [],
  failure: null,
  stopped: false,
  clientOrigins: [],
};
const pairs = new Set();
const plannedFile = path.join(caseDir, 'planned-offline.json');
const mutationMethods = new Set([
  'terminal.worker.input',
  'terminal.input',
  'terminal.send',
  'chat.send',
  'copilot.start',
  'copilot.configure',
  'copilot.stop',
  'run.create',
  'run.createNative',
  'run.resume',
  'run.replay',
  'run.resolveDecision',
  'native.session.create',
  'native.session.submit',
  'native.session.resume',
  'native.session.abort',
  'native.session.close',
]);
const hash = (data) => createHash('sha256').update(data).digest('hex');
let closing = false;
async function plannedOffline() {
  let bytes, metadata;
  try {
    metadata = await lstat(plannedFile);
    bytes = await readFile(plannedFile);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  assert(metadata.isFile() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o600);
  const marker = JSON.parse(bytes);
  assert.equal(marker.sourceRoot, sourceRoot);
  assert.equal(marker.caseDir, caseDir);
  assert.equal(marker.proxyStartId, startId);
  assert.equal(marker.proxyPid, process.pid);
  assert.equal(marker.kind, 'view-sharing-offline');
  return true;
}
const persist = () =>
  writeFile(path.join(receiptDir, 'proxy-final.json'), JSON.stringify(stats, null, 2) + '\n', {
    mode: 0o600,
  });
function closePair(pair) {
  if (!pairs.delete(pair)) return;
  for (const socket of [pair.incoming, pair.upstream]) socket.terminate();
}
async function fail(code) {
  if (stats.failure) return;
  stats.failure = code;
  await persist();
  for (const pair of [...pairs]) closePair(pair);
  console.error(code);
  process.exitCode = 1;
  closing = true;
  server.close();
  sockets.close();
}
const server = createServer((request, response) => {
  if (request.url === '/view-sharing-counts') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(stats));
    return;
  }
  const upstream = httpRequest(
    {
      hostname: '127.0.0.1',
      port: fixture.gatewayPort,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (result) => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    },
  );
  upstream.on('error', (error) => {
    response.writeHead(502);
    response.end('Private upstream unavailable');
    void plannedOffline()
      .then((planned) => {
        if (!planned && !closing) return fail('UNEXPECTED_HTTP_ERROR:' + error.code);
      })
      .catch((error) => fail('INVALID_OFFLINE_MARKER:' + error.message));
  });
  request.pipe(upstream);
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (incoming, request) => {
  if (request.headers.origin && !stats.clientOrigins.includes(request.headers.origin))
    stats.clientOrigins.push(request.headers.origin);
  const upstream = new WebSocket(fixture.gatewayUrl, {
    headers: { ...(request.headers.origin ? { Origin: request.headers.origin } : {}) },
  });
  const pair = { incoming, upstream, queued: [], queuedBytes: 0, connectionId: randomUUID() };
  pairs.add(pair);
  incoming.on('message', (bytes, binary) => {
    try {
      const frame = binary ? {} : JSON.parse(bytes.toString());
      if (frame.type === 'req' && typeof frame.method === 'string') {
        const observed = {
          at: Date.now(),
          connectionId: pair.connectionId,
          origin: request.headers.origin ?? null,
          id: frame.id,
          method: frame.method,
          ...(frame.params?.runId ? { runId: frame.params.runId } : {}),
          ...(typeof frame.params?.data === 'string'
            ? { dataSha256: hash(frame.params.data) }
            : {}),
        };
        assert(stats.requests.length < 10000, 'Request evidence bound exceeded');
        stats.requests.push(observed);
        if (mutationMethods.has(frame.method)) stats.mutations.push(observed);
      }
    } catch (error) {
      void fail('UNREADABLE_REQUEST_FRAME:' + error.message);
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes, { binary });
    else if (upstream.readyState === WebSocket.CONNECTING) {
      pair.queuedBytes += bytes.length;
      if (pair.queuedBytes > 8 * 1024 * 1024) {
        void fail('PENDING_BYTES_LIMIT');
        return;
      }
      pair.queued.push([bytes, binary]);
    } else closePair(pair);
  });
  upstream.on('open', () => {
    for (const [bytes, binary] of pair.queued) upstream.send(bytes, { binary });
    pair.queued = [];
    pair.queuedBytes = 0;
  });
  upstream.on('message', (bytes, binary) => {
    try {
      const frame = binary ? {} : JSON.parse(bytes.toString());
      if (frame.type === 'res')
        stats.responses.push({
          at: Date.now(),
          connectionId: pair.connectionId,
          origin: request.headers.origin ?? null,
          id: frame.id,
          ok: frame.ok === true,
          runId: frame.payload?.run?.id,
        });
    } catch (error) {
      void fail('UNREADABLE_RESPONSE_FRAME:' + error.message);
      return;
    }
    if (incoming.readyState === WebSocket.OPEN) incoming.send(bytes, { binary });
  });
  for (const peer of [incoming, upstream]) {
    peer.on('close', () => closePair(pair));
    peer.on('error', (error) => {
      if (closing || !pairs.has(pair)) return;
      void plannedOffline()
        .then((planned) => {
          if (planned && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code))
            closePair(pair);
          else return fail('UNEXPECTED_SOCKET_ERROR:' + (error.code ?? error.message));
        })
        .catch((error) => fail('INVALID_OFFLINE_MARKER:' + error.message));
    });
  }
});
sockets.on('error', () => void fail('WEBSOCKET_LISTENER_ERROR'));
server.on('error', () => void fail('HTTP_LISTENER_ERROR'));
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
await writeFile(
  path.join(receiptDir, 'proxy-ready.json'),
  JSON.stringify(receipt, null, 2) + '\n',
  {
    flag: 'wx',
    mode: 0o600,
  },
);
console.log(JSON.stringify({ ready: true, ...receipt }));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    closing = true;
    stats.stopped = true;
    for (const pair of [...pairs]) closePair(pair);
    sockets.close();
    server.close();
    await persist();
    await appendFile(
      path.join(receiptDir, 'proxy-stopped.jsonl'),
      JSON.stringify({ ...receipt, at: Date.now(), signal }) + '\n',
      { mode: 0o600 },
    );
  });
