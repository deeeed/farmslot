// Real endpoint proof of publication/read cadence. No browser, provider or cache data injection.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { GatewayClient } from '../../../packages/cli/src/gateway-client.js';
import {
  createGatewayResourceCache,
  createResourceCacheTransport,
  RESOURCE_PUBLISH_INTERVAL_MS,
  resourceKeyId,
  resourceQuery,
} from '../../../packages/protocol/src/client-cache/index.js';
import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.GATEWAY_PORT, '7913');
const directory = await realpath(process.env.FARMSLOT_PLANNING_RACE_ARTIFACTS);
assert.equal(path.resolve(process.env.FARMSLOT_COPILOT_DIR), path.join(directory, 'copilot'));
const { sessionId } = JSON.parse(await readFile(path.join(directory, 'setup.json'), 'utf8'));
const ready = JSON.parse(
  await readFile(
    path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
    'utf8',
  ),
);
assert.equal(ready.method, 'chat.sessionContext');
assert.equal(ready.port, 7915);
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).port, '7913');
const credentials = new GatewayClient({ ...target, timeout: 5000 });
const writer = await credentials.connect();
const socket = new WebSocket('ws://127.0.0.1:7915/ws');
const pending = new Map();
const events = new Map();
const transitions = [];
let serial = 0;
let closing = false;
let socketFailure;
let cache;
let stop;
let writing;
const writes = [];
const claims = {};
const evidence = { sessionId, writes, transitions };
async function until(read, accepts, label, timeout = 5000) {
  const deadline = performance.now() + timeout;
  let result;
  do {
    result = await read();
    if (accepts(result)) return result;
    if (socketFailure) throw socketFailure;
    await delay(5);
  } while (performance.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(result)}`);
}
function request(method, params, observed = false, signal) {
  return new Promise((resolve, reject) => {
    const id = `cadence-${++serial}`;
    const finish = (error, frame) => {
      clearTimeout(timer);
      pending.delete(id);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(frame);
    };
    const abort = () => finish(new Error('Owned observation aborted'));
    const timer = setTimeout(() => finish(new Error(`RPC deadline: ${method}`)), 5000);
    if (signal?.aborted) return abort();
    pending.set(id, { finish });
    signal?.addEventListener('abort', abort, { once: true });
    socket.send(
      JSON.stringify({
        type: 'req',
        id,
        method,
        params,
        ...(observed ? { resourceRead: { version: 1 } } : {}),
      }),
    );
  });
}
socket.on('message', (bytes) => {
  const frame = JSON.parse(String(bytes));
  if (frame.type === 'res') {
    const call = pending.get(frame.id);
    if (call) call.finish(frame.ok ? undefined : new Error(JSON.stringify(frame.error)), frame);
  } else if (frame.type === 'event') {
    for (const listener of events.get(frame.event) ?? []) listener(frame.payload);
  }
});
socket.on('error', (error) => {
  socketFailure = error;
});
socket.on('close', () => {
  if (!closing) socketFailure ??= new Error('Unexpected observed socket close');
  for (const call of pending.values()) call.finish(new Error('Observed socket closed'));
});
async function status() {
  const response = await fetch('http://127.0.0.1:7915/planning-race-status', {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const value = await response.json();
  assert.equal(value.startId, ready.startId);
  assert(!value.stopped && !value.failure);
  return value;
}
async function control(action) {
  const response = await fetch('http://127.0.0.1:7915/api/planning-race-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proof-owner': ready.owner },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  assert.equal((await response.json()).startId, ready.startId);
}
try {
  await until(
    () => socket.readyState,
    (state) => state === WebSocket.OPEN,
    'Observed socket open',
  );
  const authentication = (
    await request('auth.connect', {
      clientKind: 'ui',
      clientName: 'owned-headless-cadence',
      ...(await credentials.currentCredentials()),
    })
  ).payload;
  assert(authentication.capabilities.resourceChanges?.epoch);
  const client = {
    async requestResource(method, params, signal) {
      const frame = await request(method, params, true, signal);
      return { data: frame.payload, resourceState: frame.resourceState };
    },
    subscribe(event, listener) {
      const listeners = events.get(event) ?? new Set();
      events.set(event, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnectionChange: () => () => undefined,
    reconnect: () => assert.fail('No connection or epoch substitution'),
  };
  const transport = createResourceCacheTransport(client, () => ({
    id: 1,
    connected: true,
    gatewayUrl: target.url,
    profileId: 'proof',
    authentication,
  }));
  cache = createGatewayResourceCache({ transport });
  const query = resourceQuery('chat.sessionContext', { sessionId });
  stop = cache.observe(query, (state) =>
    transitions.push({
      at: Date.now(),
      status: state.status,
      observedAt: state.observedAt,
      messages: state.data?.messages,
      usage: state.data?.usage,
    }),
  );
  await until(
    () => cache.read(query),
    (state) => state.status === 'ready',
    'Actual initial context',
  );
  assert.equal(cache.read(query).data.messages.total, 1);
  assert.equal(cache.read(query).data.usage.totalInputTokens, 123);
  evidence.initial = await status();
  const interval = RESOURCE_PUBLISH_INTERVAL_MS.copilot;
  assert.equal(interval, 200);
  // Keep initial read outside the slow-read boundary being measured.
  await delay(interval + 50);
  await control('arm');
  async function clear() {
    const startedAt = Date.now();
    await writer.call('chat.clear', { sessionId });
    writes.push({ startedAt, completedAt: Date.now() });
  }
  await clear();
  const held = await until(status, (value) => value.held, 'Hold an actual stamped reply');
  const firstHeldEvent = held.events.length;
  let keepWriting = true;
  writing = (async () => {
    // A bounded busy writer. The server still applies its normal 200ms publication cadence.
    for (let i = 0; i < 40 && keepWriting; i++) {
      await clear();
      await delay(35);
    }
  })();
  const published = await until(
    status,
    (value) => value.events.length >= firstHeldEvent + 2,
    'Newer publications during the held reply',
  );
  const releaseAt = published.events.at(-1).at + interval - 35;
  await delay(Math.max(0, releaseAt - Date.now()));
  await control('release');
  await delay(interval * 2);
  keepWriting = false;
  await writing;
  const finalSource = await writer.call('chat.sessionContext', { sessionId });
  const initialRevision = evidence.initial.copilotReplies[0].resourceState.dependencies.find(
    (dependency) => dependency.key.sessionId === sessionId,
  ).revision;
  const finalRevision = initialRevision + writes.length;
  evidence.finalRevision = finalRevision;
  await until(
    async () => ({ proxy: await status(), state: cache.read(query) }),
    ({ proxy, state }) => {
      const latest = proxy.events
        .at(-1)
        ?.changes.find((change) => change.key.sessionId === sessionId);
      const covered = proxy.copilotReplies
        .at(-1)
        ?.resourceState?.dependencies.find(
          (dependency) => resourceKeyId(dependency.key) === resourceKeyId(latest?.key),
        );
      return (
        state.status === 'ready' &&
        latest?.revision === finalRevision &&
        covered?.revision === finalRevision
      );
    },
    'Final ready read covers the last actual owning write',
  );
  evidence.busy = await status();
  const actual = cache.read(query).data;
  assert.equal(actual.sessionId, sessionId);
  assert.deepEqual(actual.messages, finalSource.messages);
  assert.deepEqual(actual.usage, finalSource.usage);
  assert.equal(actual.messages.total, 0);
  claims.realWriterState = true;
  const stale = transitions.filter((row) => row.at >= evidence.busy.held.releasedAt);
  assert(stale.some((row) => row.status === 'stale'));
  assert(stale.some((row) => row.status === 'ready' && row.messages?.total === 0));
  claims.heldReplyRevalidated = true;
  const starts = evidence.busy.requests.map((row) => row.at);
  const gaps = starts.slice(1).map((at, i) => at - starts[i]);
  evidence.readGapsMs = gaps;
  evidence.minimumReadGapMs = Math.min(...gaps);
  evidence.publicationGapsMs = evidence.busy.events
    .slice(1)
    .map((event, i) => event.at - evidence.busy.events[i].at);
  assert(gaps.length >= 4, 'Exercise both sides of the held-reply boundary');
  // Wire timestamps can differ by 2ms from the client's monotonic request start.
  assert(
    gaps.every((gap) => gap >= interval - 2),
    `Automatic read cadence: ${JSON.stringify(gaps)}`,
  );
  assert(
    evidence.busy.events.length < writes.length,
    'Actual publications coalesce multiple real writes',
  );
  claims.boundedAutomaticReads = true;
  const idleBefore = await status();
  const idleStarted = Date.now();
  await delay(interval * 3);
  const idleAfter = await status();
  assert.equal(idleAfter.requests.length, idleBefore.requests.length, 'No idle polling');
  assert.equal(idleAfter.events.length, idleBefore.events.length, 'No idle source publications');
  assert(
    Object.values(idleAfter.commands).every((value) => value === 0),
    'No observed-client command/provider launch',
  );
  evidence.idle = {
    startedAt: idleStarted,
    finishedAt: Date.now(),
    before: idleBefore.requests.length,
    after: idleAfter.requests.length,
  };
  claims.idleQuiet = true;
} finally {
  if (writing) await writing;
  stop?.();
  await cache?.dispose();
  closing = true;
  if (socket.readyState !== WebSocket.CLOSED) {
    socket.close();
    await until(
      () => socket.readyState,
      (state) => state === WebSocket.CLOSED,
      'Observed socket close',
    );
  }
  writer.close();
  await writeFile(
    path.join(directory, 'evidence.json'),
    JSON.stringify({ claims, ...evidence }, null, 2) + '\n',
    { mode: 0o600 },
  );
}
console.log(JSON.stringify({ claims }));
