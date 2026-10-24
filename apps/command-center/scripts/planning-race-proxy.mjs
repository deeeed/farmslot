// Delay one actual observed planning reply. Never synthesize data, revisions or credentials.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import WebSocket, { WebSocketServer } from 'ws';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const controlPath = '/api/planning-race-control';

export async function startPlanningRaceProxy({
  port,
  upstream,
  directory,
  method = 'backlog.list',
}) {
  const target = new URL(upstream);
  assert.equal(target.protocol, 'ws:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '7913', 'Use the isolated proof gateway');
  assert.equal(port, 7915, 'Use the isolated browser race proxy');
  assert(['backlog.list', 'roadmap.list', 'intelligence.triage.get'].includes(method));
  const artifacts = await realpath(directory);
  const owner = randomUUID();
  const startId = randomUUID();
  const pairs = new Set();
  let connection = 0;
  let armed = false;
  let held;
  let latestEvent;
  let stopped = false;
  let failure;
  const requests = [];
  const events = [];
  const controls = [];
  const duplicates = [];
  const authentications = [];
  const barrierReplies = [];
  const commands = {
    'intelligence.triage.analyze': 0,
    'intelligence.triage.feedback': 0,
    'run.resolveDecision': 0,
  };
  let persistence = Promise.resolve();
  const status = () => ({
    startId,
    stopped,
    failure,
    armed,
    requests,
    events,
    controls,
    duplicates,
    method,
    authentications,
    barrierReplies,
    commands,
    held: held?.receipt,
  });
  const persist = () => {
    const bytes = JSON.stringify(status(), null, 2) + '\n';
    persistence = persistence.then(() =>
      writeFile(path.join(artifacts, 'proxy-status.json'), bytes, { mode: 0o600 }),
    );
    return persistence;
  };
  const close = async () => {
    if (stopped) return;
    stopped = true;
    for (const pair of pairs) {
      pair.client.terminate();
      pair.upstream.terminate();
    }
    pairs.clear();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    await persist();
  };
  const fail = async (code) => {
    if (failure) return;
    failure = code;
    process.exitCode = 1;
    await close();
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/planning-race-status' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(status()));
      return;
    }
    if (request.url !== controlPath || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (request.headers['x-proof-owner'] !== owner) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      let bytes = Buffer.alloc(0);
      for await (const chunk of request) {
        bytes = Buffer.concat([bytes, chunk]);
        assert(bytes.length <= 4096, 'Bound control metadata');
      }
      const input = JSON.parse(bytes);
      assert(
        ['trace-ready', 'arm', 'duplicate', 'release', 'release-after-authority-change'].includes(
          input.action,
        ),
      );
      if (input.action === 'arm') {
        assert(!armed && !held, 'One held reply per case');
        armed = true;
      } else if (input.action === 'duplicate') {
        assert(latestEvent && duplicates.length === 0 && held && !held.receipt.releasedAt);
        assert.equal(latestEvent.pair.client.readyState, WebSocket.OPEN);
        await new Promise((resolve, reject) =>
          latestEvent.pair.client.send(latestEvent.bytes, { binary: false }, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        duplicates.push({ ...latestEvent.receipt, duplicatedAt: Date.now() });
      } else if (input.action === 'release' || input.action === 'release-after-authority-change') {
        assert(held && !held.receipt.releasedAt, 'Release the original held reply once');
        assert.equal(digest(held.bytes), held.receipt.frameSha256, 'Held bytes changed');
        let destination = held.pair;
        if (input.action === 'release-after-authority-change') {
          const previous = held.receipt.authentication;
          assert(previous.roleNames.includes('admin'));
          const candidates = [...pairs].filter(
            (pair) =>
              pair.connection !== held.pair.connection &&
              pair.authentication?.principalId === previous.principalId &&
              pair.authentication.workspaceAccess === 'farm' &&
              pair.authentication.roleNames.includes('operator') &&
              !pair.authentication.roleNames.includes('admin') &&
              pair.client.readyState === WebSocket.OPEN,
          );
          assert.equal(candidates.length, 1, 'Require the actual downgraded actor connection');
          [destination] = candidates;
          held.receipt.destinationAuthentication = structuredClone(destination.authentication);
          held.receipt.replayedAt = Date.now();
        }
        assert.equal(destination.client.readyState, WebSocket.OPEN, 'Release on a live socket');
        await new Promise((resolve, reject) =>
          destination.client.send(held.bytes, { binary: false }, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        held.receipt.deliveredConnection = destination.connection;
        held.receipt.releasedAt = Date.now();
      }
      controls.push({ action: input.action, at: Date.now() });
      await persist();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ accepted: true, startId }));
    } catch {
      response.writeHead(500);
      response.end('Owned control failed');
      await fail('CONTROL_FAILED');
    }
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (client) => {
    const pair = {
      client,
      upstream: new WebSocket(upstream),
      connection: ++connection,
      reads: new Map(),
    };
    pairs.add(pair);
    const waiting = [];
    let buffered = 0;
    let candidate;
    const drop = () => {
      if (!pairs.delete(pair)) return;
      client.terminate();
      pair.upstream.terminate();
    };
    client.on('message', (bytes, binary) => {
      if (!binary) {
        let frame;
        try {
          frame = JSON.parse(String(bytes));
        } catch {
          void fail('INVALID_CLIENT_FRAME');
          return;
        }
        if (frame.type === 'req' && frame.method === 'auth.connect') pair.authRequestId = frame.id;
        if (frame.type === 'req' && Object.hasOwn(commands, frame.method)) {
          commands[frame.method]++;
          void persist();
        }
        if (frame.type === 'req' && frame.method === 'backlog.list') {
          assert(pair.reads.size < 100);
          pair.reads.set(frame.id, {
            requestAt: Date.now(),
            observed: frame.resourceRead?.version === 1,
          });
        }
        if (frame.type === 'req' && frame.method === method) {
          assert(requests.length < 100, 'Bound planning requests');
          const receipt = {
            id: frame.id,
            connection: pair.connection,
            at: Date.now(),
            observed: frame.resourceRead?.version === 1,
            paramsSha256: digest(JSON.stringify(frame.params)),
          };
          requests.push(receipt);
          if (armed) {
            assert(!candidate && !held);
            assert(receipt.observed, 'Hold a real observed read');
            candidate = receipt;
            armed = false;
          }
          void persist();
        }
      }
      if (pair.upstream.readyState === WebSocket.CONNECTING) {
        buffered += bytes.length;
        if (buffered > 8 * 1024 * 1024) {
          void fail('BUFFER_LIMIT');
          return;
        }
        waiting.push([bytes, binary]);
      } else if (pair.upstream.readyState === WebSocket.OPEN) pair.upstream.send(bytes, { binary });
      else drop();
    });
    pair.upstream.on('open', () => {
      for (const [bytes, binary] of waiting) pair.upstream.send(bytes, { binary });
      waiting.length = 0;
    });
    pair.upstream.on('message', (bytes, binary) => {
      if (!binary) {
        let frame;
        try {
          frame = JSON.parse(String(bytes));
        } catch {
          void fail('INVALID_GATEWAY_FRAME');
          return;
        }
        if (frame.type === 'res' && frame.id === pair.authRequestId && frame.ok) {
          const principal = frame.payload?.principal;
          assert(principal?.id && Array.isArray(principal.roles));
          // Retain only verified identity/authority, never credentials or the auth payload.
          pair.authentication = {
            connection: pair.connection,
            principalId: principal.id,
            roleNames: principal.roles.map((binding) => binding.role).sort(),
            workspaceAccess: frame.payload.capabilities.workspaceAccess,
            authenticatedAt: Date.now(),
          };
          authentications.push(pair.authentication);
          void persist();
        }
        const read = frame.type === 'res' ? pair.reads.get(frame.id) : undefined;
        if (read) pair.reads.delete(frame.id);
        if (candidate && frame.type === 'res' && frame.id === candidate.id) {
          assert(frame.ok && frame.resourceState?.epoch && frame.payload);
          assert(pair.authentication, 'Bind held data to the actual authenticated connection');
          held = {
            pair,
            bytes: Buffer.from(bytes),
            receipt: {
              ...candidate,
              receivedAt: Date.now(),
              frameSha256: digest(bytes),
              payloadSha256: digest(JSON.stringify(frame.payload)),
              resourceState: frame.resourceState,
              authentication: structuredClone(pair.authentication),
            },
          };
          candidate = undefined;
          void persist();
          return;
        }
        if (
          read?.observed &&
          frame.ok &&
          frame.resourceState?.epoch &&
          held?.receipt.replayedAt &&
          read.requestAt > held.receipt.replayedAt
        ) {
          assert(barrierReplies.length < 100);
          barrierReplies.push({
            method: 'backlog.list',
            connection: pair.connection,
            requestAt: read.requestAt,
            forwardedAt: Date.now(),
            resourceState: frame.resourceState,
            payloadSha256: digest(JSON.stringify(frame.payload)),
          });
          void persist();
        }
        if (frame.type === 'event' && frame.event === 'resource.changed') {
          const changes = frame.payload?.changes?.filter((row) =>
            method === 'intelligence.triage.get'
              ? row.key.family === 'assessment' && row.key.scope === 'farm'
              : row.key.family === 'planning' &&
                row.key.collection === (method === 'roadmap.list' ? 'roadmap' : 'backlog'),
          );
          if (changes?.length) {
            assert(events.length < 100);
            const receipt = {
              connection: pair.connection,
              at: Date.now(),
              epoch: frame.payload.epoch,
              changes,
              frameSha256: digest(bytes),
            };
            events.push(receipt);
            latestEvent = { pair, receipt, bytes: Buffer.from(bytes) };
            void persist();
          }
        }
      }
      if (client.readyState === WebSocket.OPEN) client.send(bytes, { binary });
    });
    for (const peer of [client, pair.upstream]) {
      peer.on('close', drop);
      peer.on('error', () => {
        if (!stopped && pairs.has(pair)) void fail('UNEXPECTED_SOCKET_ERROR');
      });
    }
  });
  server.on('error', () => void fail('LISTENER_ERROR'));
  sockets.on('error', () => void fail('WEBSOCKET_ERROR'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await writeFile(
    path.join(artifacts, 'proxy-ready.json'),
    JSON.stringify({ startId, owner, port, upstream, method, pid: process.pid }),
    { flag: 'wx', mode: 0o600 },
  );
  await persist();
  return { close, status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
  assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const proxy = await startPlanningRaceProxy(config);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void proxy.close());
}
