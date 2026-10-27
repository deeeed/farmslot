// Prove gate-review prefetch in the real Command Center against a private gateway: prefetch order
// and refusal, offline gate review, untracked and ignored files, fix-loop bytes and gate-open
// measurements. Sources are a private farm; GitHub and provider CLIs are logged guards.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const source = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const execute = promisify(execFile);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
const configFile = process.env.FARMSLOT_GATE_REVIEW_PROOF;
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.equal(config.sourceRoot, source);
const root = config.caseRoot;
const fixture = JSON.parse(await readFile(path.join(root, 'fixture.json'), 'utf8'));
const artifacts = path.join(root, 'client');
await mkdir(artifacts, { recursive: true });
const WebSocket = createRequire(path.join(source, 'package.json'))('ws');
const CDP = 'http://127.0.0.1:19222';
const UI = 'http://127.0.0.1:5208/';
const PROBE = path.join(source, 'apps/command-center/scripts/probes/offline-gate-review.js');
const probeSource = await readFile(PROBE, 'utf8');
const gate = fixture.gate;
const slotRun = new Map([
  [gate.slotId, gate.runId],
  ...fixture.active.map((run) => [run.slotId, run.id]),
]);
const runIds = new Set(slotRun.values());
// Needles for the ignored file: its secret line and its path as a diff side or a read entry.
const IGNORED = [fixture.secret, 'b/.env', '"path":".env"'];

const cdp = async (args, env = process.env) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(source, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { cwd: source, timeout: 120000, maxBuffer: 16 * 1024 * 1024, env },
      )
    ).stdout,
  );
let probeSerial = 0;
async function inspect(target, params) {
  const file = path.join(artifacts, `.probe-${++probeSerial % 4}.js`);
  await writeFile(file, `const PARAMS = ${JSON.stringify(params ?? {})};\n${probeSource}`);
  return cdp(['eval', target, '--file', file]);
}
async function until(check, label, target, { timeout = 30000, interval = 400, params } = {}) {
  const end = Date.now() + timeout;
  let last;
  do {
    try {
      last = await inspect(target, params);
      if (check(last)) return last;
    } catch (error) {
      // A read-only probe can race a navigation or lazy module load; the deadline still applies.
      last = { probeError: error.message.slice(-500) };
    }
    await delay(interval);
  } while (Date.now() < end);
  await save('timeout-' + label.replace(/[^a-z0-9]+/gi, '-').slice(0, 60), last);
  const { store, ...shown } = last ?? {};
  assert.fail(
    label +
      ': ' +
      JSON.stringify({
        ...shown,
        content: store?.content.map(({ kind, id }) => `${kind}:${id}`),
        queries: store?.queries,
      }).slice(0, 6000),
  );
}
const save = (name, value) =>
  writeFile(path.join(artifacts, name + '.json'), JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
  });
const image = (name, target) => cdp(['screenshot', target, path.join(artifacts, name + '.png')]);
const url = (viewer, hash) =>
  `${UI}?gate-proof=${encodeURIComponent(config.name)}&viewer=${viewer}${hash}`;
const gateRoute = (tab) => `#run/${gate.runId}?tab=${tab}`;

/** One CDP session to the browser, or to one exact page target. */
async function devtools(calls, target) {
  const endpoint = target
    ? (await (await fetch(CDP + '/json')).json()).find((page) => page.id === target.slice(1))
        ?.webSocketDebuggerUrl
    : (await (await fetch(CDP + '/json/version')).json()).webSocketDebuggerUrl;
  assert(endpoint, 'CDP target is missing');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const serial = ++id;
      pending.set(serial, (message) =>
        message.error ? reject(new Error(message.error.message)) : resolve(message.result),
      );
      socket.send(JSON.stringify({ id: serial, method, params }));
    });
  try {
    return await calls(call);
  } finally {
    socket.close();
  }
}
const navigate = (target, href) =>
  devtools(async (call) => {
    await call('Page.enable');
    await call('Page.navigate', { url: href });
  }, target);
/**
 * Page-side timing of gateway requests and replies, on the page's own clock: when the page hands
 * a request to its socket and when a reply's message event reaches the page. Installed before the
 * gateway socket is created; it changes no frame.
 */
const SOCKET_LOG = `(() => {
  if (window.__gateProofSockets) return;
  const log = (window.__gateProofSockets = []);
  const Native = window.WebSocket;
  const send = Native.prototype.send;
  const frame = (data) => {
    if (typeof data !== 'string' || !data.startsWith('{')) return undefined;
    try { return JSON.parse(data); } catch { return undefined; }
  };
  Native.prototype.send = function (data) {
    const request = frame(data);
    if (request?.type === 'req')
      log.push({ at: performance.now(), dir: 'send', id: request.id, method: request.method, runId: request.params?.runId, slotId: request.params?.slotId });
    return send.call(this, data);
  };
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (event) => {
        const reply = frame(event.data);
        if (reply?.type === 'res') log.push({ at: performance.now(), dir: 'reply', id: reply.id, error: reply.error?.code });
      });
    }
  };
})()`;
/** Close the page's live gateway socket; the client reconnects on a new connection. */
const dropGatewaySocket = (target) =>
  devtools(async (call) => {
    await call('Runtime.enable');
    const prototype = await call('Runtime.evaluate', { expression: 'WebSocket.prototype' });
    const sockets = await call('Runtime.queryObjects', {
      prototypeObjectId: prototype.result.objectId,
      objectGroup: 'gate-review-proof',
    });
    const closed = await call('Runtime.callFunctionOn', {
      objectId: sockets.objects.objectId,
      functionDeclaration: `function() {
        let count = 0;
        const at = performance.now();
        for (const socket of this)
          if (socket.readyState === WebSocket.OPEN && new URL(socket.url).pathname === '/ws') {
            socket.close(1000, 'Gate review proof reconnect');
            count++;
          }
        return { count, at };
      }`,
      returnByValue: true,
    });
    await call('Runtime.releaseObjectGroup', { objectGroup: 'gate-review-proof' });
    return closed.result.value;
  }, target);
async function ownTabs(ids) {
  config.ownedTabIds = ids;
  await writeFile(configFile + '.tabs.tmp', JSON.stringify(config, null, 2) + '\n');
  await rename(configFile + '.tabs.tmp', configFile);
}
/** A separate window keeps each viewer foreground; hidden documents retire their reads. */
async function openWindow(viewer, hash, bounds) {
  const targetId = await devtools(async (call) => {
    const { targetId } = await call('Target.createTarget', {
      url: url(viewer, hash),
      newWindow: true,
    });
    const { windowId } = await call('Browser.getWindowForTarget', { targetId });
    await call('Browser.setWindowBounds', { windowId, bounds });
    return targetId;
  });
  await ownTabs([...new Set([...(config.ownedTabIds ?? [config.tabId]), targetId])]);
  return '@' + targetId;
}
async function checkpoint(name) {
  const request = path.join(artifacts, name + '-request.json');
  await writeFile(request + '.tmp', JSON.stringify({ case: config.name, tabId: config.tabId }));
  await rename(request + '.tmp', request);
  const end = Date.now() + 120000;
  while (true) {
    try {
      const ack = JSON.parse(await readFile(path.join(artifacts, name + '-ack.json'), 'utf8'));
      assert.equal(ack.case, config.name);
      return ack;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    assert(Date.now() < end, name + ' controller acknowledgement deadline');
    await delay(100);
  }
}
async function dismissUpdateNotice(target) {
  const shown = await cdp([
    'eval',
    target,
    "return Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.primary'))",
  ]);
  if (shown) await cdp(['click', target, 'whats-new-modal >>> .primary']);
}

/** Gateway RPC as the fixture's admin actor, for package preparation and reads only. */
async function rpc(method, params) {
  const profiles = JSON.parse(await readFile(path.join(root, 'home/gateways.json'), 'utf8'));
  const socket = new WebSocket(config.gatewayUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const pending = new Map();
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'res') pending.get(frame.id)?.(frame);
  });
  let serial = 0;
  const call = (name, value) =>
    new Promise((resolve, reject) => {
      const id = `proof-${++serial}`;
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 120000);
      pending.set(id, (frame) => {
        clearTimeout(timer);
        if (frame.ok) resolve(frame.payload);
        else reject(new Error(`${name}: ${frame.error?.code} ${frame.error?.message}`));
      });
      socket.send(JSON.stringify({ type: 'req', id, method: name, params: value }));
    });
  try {
    await call('auth.connect', {
      token: profiles.gateways[config.name].secret,
      clientKind: 'ui',
      clientName: 'gate-review-proof',
    });
    return await call(method, params);
  } finally {
    socket.close();
  }
}
const pendingPackage = (run) =>
  run.decisions.find((decision) => !decision.resolvedAt && decision.payload?.kind === 'ready')
    ?.payload.prPackage;

/**
 * Every gateway websocket frame and every `/api/run-artifact` transfer on one page: raw JSONL
 * for the ignored-file scan, and summaries for byte and order analysis.
 */
async function recordFrames(target, label) {
  const page = (await (await fetch(CDP + '/json')).json()).find(
    (entry) => entry.id === target.slice(1),
  );
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const raw = createWriteStream(path.join(artifacts, `frames-${label}.jsonl`), { mode: 0o600 });
  const rows = [];
  const http = new Map();
  socket.on('message', (data) => {
    const { method, params } = JSON.parse(String(data));
    if (!method) return;
    const wall = Date.now();
    if (method === 'Network.requestWillBeSent') {
      const address = new URL(params.request.url, 'http://localhost');
      if (address.pathname !== '/api/run-artifact') return;
      const row = {
        kind: 'http',
        wall,
        runId: address.searchParams.get('runId'),
        path: address.searchParams.get('path'),
      };
      http.set(params.requestId, row);
      rows.push(row);
      return;
    }
    const request = http.get(params?.requestId);
    if (method === 'Network.responseReceived' && request) request.status = params.response.status;
    if (method === 'Network.loadingFinished' && request) {
      request.bytes = params.encodedDataLength;
      request.doneWall = wall;
    }
    if (method === 'Network.loadingFailed' && request) request.failed = params.errorText;
    if (!['Network.webSocketFrameSent', 'Network.webSocketFrameReceived'].includes(method)) return;
    const payload = params.response.payloadData;
    const dir = method.endsWith('Sent') ? 'sent' : 'received';
    // Every frame is kept for the ignored-file scan; only gateway frames are analysed.
    raw.write(JSON.stringify({ wall, dir, opcode: params.response.opcode, payload }) + '\n');
    if (params.response.opcode !== 1 || !payload.startsWith('{')) return;
    const frame = JSON.parse(payload);
    // Vite's websocket also carries JSON, never gateway request, reply or event frames.
    if (!['req', 'res', 'event'].includes(frame.type)) return;
    const row = {
      kind: 'ws',
      wall,
      // CDP's monotonic network time orders a send against a reply within one millisecond.
      ts: params.timestamp,
      dir,
      socket: params.requestId,
      bytes: Buffer.byteLength(payload, 'utf8'),
      type: frame.type,
      id: frame.id,
      method: frame.method,
      event: frame.event,
      error: frame.error?.code,
    };
    if (frame.type === 'req') row.params = summarizeParams(frame.params);
    if (frame.type === 'res' && Array.isArray(frame.payload?.entries))
      row.entries = frame.payload.entries.map(({ path: file, status, id, size }) => ({
        path: file,
        status,
        id,
        size,
      }));
    rows.push(row);
  });
  socket.send(JSON.stringify({ id: 1, method: 'Network.enable' }));
  await delay(300);
  return {
    rows,
    async stop() {
      socket.close();
      await new Promise((resolve) => raw.end(resolve));
      return rows;
    },
  };
}
function summarizeParams(params) {
  if (!params || typeof params !== 'object') return undefined;
  const keys = ['runId', 'slotId', 'ref', 'base', 'head', 'target', 'includeUntracked', 'after'];
  const out = Object.fromEntries(
    keys.filter((key) => key in params).map((key) => [key, params[key]]),
  );
  if (Array.isArray(params.paths)) out.paths = params.paths;
  if (Array.isArray(params.have)) out.have = params.have;
  return out;
}
/** The run a prefetch read belongs to. `git.log` is a later check, never part of a first pass. */
function readRun(row, { checks = false } = {}) {
  if (row.kind === 'http') return runIds.has(row.runId) ? row.runId : undefined;
  if (row.type !== 'req') return undefined;
  if (row.method === 'run.get') return row.params?.runId;
  if (row.method === 'git.diff') return row.params?.runId ?? slotRun.get(row.params?.slotId);
  if (row.method === 'git.show') return slotRun.get(row.params?.slotId);
  if (row.method === 'git.log' && checks) return slotRun.get(row.params?.slotId);
  return undefined;
}
const replyTo = (rows, request) =>
  rows.find((row) => row.type === 'res' && row.socket === request.socket && row.id === request.id);
/** Each run's first prefetch request to its last reply; overlapping windows are runs in flight. */
function runWindows(rows, since, until) {
  const windows = new Map();
  for (const row of rows) {
    if (row.wall < since || row.wall > until) continue;
    const run = readRun(row);
    if (!run) continue;
    const end =
      row.kind === 'http' ? (row.doneWall ?? row.wall) : (replyTo(rows, row)?.wall ?? row.wall);
    const window = windows.get(run) ?? { run, start: row.wall, end, reads: [] };
    window.reads.push(row.kind === 'http' ? `http ${row.path}` : row.method);
    window.start = Math.min(window.start, row.wall);
    window.end = Math.max(window.end, end);
    windows.set(run, window);
  }
  const list = [...windows.values()].sort((a, b) => a.start - b.start);
  const maxInFlight = Math.max(
    0,
    ...list.map(
      (window) =>
        list.filter((other) => other.start <= window.start && other.end > window.start).length,
    ),
  );
  return { list, maxInFlight };
}
const sumBytes = (rows) => rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
/** Bytes a run's prefetch moved: its requests and replies, and its artifact transfers. */
function runTransfer(rows, runId, since, until) {
  const requests = rows.filter(
    (row) => row.wall >= since && row.wall <= until && readRun(row) === runId,
  );
  const sent = requests.filter((row) => row.kind === 'ws');
  const replies = sent.map((row) => replyTo(rows, row)).filter(Boolean);
  const http = requests.filter((row) => row.kind === 'http');
  return {
    sentBytes: sumBytes(sent),
    receivedBytes: sumBytes(replies),
    httpBytes: sumBytes(http),
    totalBytes: sumBytes(sent) + sumBytes(replies) + sumBytes(http),
    reads: requests.map((row) => {
      if (row.kind === 'http') return { http: row.path, status: row.status, bytes: row.bytes };
      const reply = replyTo(rows, row);
      return {
        method: row.method,
        ...(row.params?.paths ? { paths: row.params.paths } : {}),
        ...(row.params?.have ? { have: row.params.have } : {}),
        replyBytes: reply?.bytes,
        ...(reply?.error ? { error: reply.error } : {}),
        ...(reply?.entries ? { entries: reply.entries } : {}),
      };
    }),
  };
}
function parseDiff(text) {
  const files = [];
  let current;
  for (const line of text.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = { oldPath: header[1], newPath: header[2], binary: false };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(line);
    if (index) [current.oldId, current.newId] = [index[1], index[2]];
    if (line.startsWith('new file mode')) current.added = true;
    if (line.startsWith('deleted file mode')) current.deleted = true;
    if (line.startsWith('Binary files') || line === 'GIT binary patch') current.binary = true;
  }
  return files;
}
const claims = {};
const evidence = {};
const A = '@' + config.tabId;

// ── 1. A real package for the pending gate; the first connection prefetches the gate first ──
const ownerFrames = await recordFrames(A, 'owner');
// A stored identity from an earlier principal may open its store before sign-in; never this one.
const signedOut = await until((value) => value.auth, 'The new principal starts signed out', A);
assert.notEqual(signedOut.scope?.principalId, fixture.actor.principalId);
const firstRefresh = await rpc('run.refreshPublishPackage', {
  runId: gate.runId,
  decisionId: gate.decisionId,
});
const firstPackage = pendingPackage((await rpc('run.get', { runId: gate.runId })).run);
assert(firstPackage.reviewSnapshot?.diffPath && firstPackage.reviewSnapshot.diffHash);
const images = firstPackage.evidenceManifest.filter(
  (entry) => /\.png$/u.test(entry.path) && entry.sha256,
);
assert(images.length >= 2, 'The package carries evidence images');
evidence.firstPackage = {
  refreshed: firstRefresh.packageId,
  id: firstPackage.id,
  diffHash: firstPackage.reviewSnapshot.diffHash,
  diffPath: firstPackage.reviewSnapshot.diffPath,
  baseSha: firstPackage.reviewSnapshot.baseSha,
  headSha: firstPackage.reviewSnapshot.headSha,
  untrackedFiles: firstPackage.reviewSnapshot.untrackedFiles,
  images: images.map(({ path: file, sha256, sizeBytes }) => ({ path: file, sha256, sizeBytes })),
};
const loginAt = Date.now();
assert((await cdp(['login', A])).authenticated);
await dismissUpdateNotice(A);
const gateHeld = (value, diffHash) =>
  value.store?.content.some((entry) => entry.kind === 'diff' && entry.id === diffHash) &&
  images.every((entry) =>
    value.store.content.some((held) => held.kind === 'artifact' && held.id === entry.sha256),
  );
const runsHeld = (value) =>
  fixture.active.every((run) =>
    value.store?.queries.some((id) => id.startsWith('git.diff:') && id.includes(run.id)),
  );
const firstHeld = await until(
  (value) =>
    value.connection === 'connected' &&
    value.persistent &&
    value.scope?.principalId === fixture.actor.principalId &&
    gateHeld(value, firstPackage.reviewSnapshot.diffHash) &&
    runsHeld(value),
  'The first connection prefetches the gate and every active run',
  A,
  { timeout: 120000, interval: 1000 },
);
const heldAt = Date.now();
await delay(3000);
const order = runWindows(ownerFrames.rows, loginAt, heldAt + 3000);
const firstRead = ownerFrames.rows.find((row) => row.wall >= loginAt && readRun(row));
evidence.order = { firstRead, windows: order.list, maxInFlight: order.maxInFlight };
evidence.firstTransfer = runTransfer(ownerFrames.rows, gate.runId, loginAt, heldAt + 3000);
await save('prefetch-order', { ...evidence.order, firstTransfer: evidence.firstTransfer });
await save('first-held', firstHeld);
assert.equal(readRun(firstRead), gate.runId, 'The pending gate is read first');
assert.equal(firstRead.method, 'run.get');
assert.equal(order.list.length, runIds.size, 'The gate and every active run were prefetched');
assert.equal(order.list[0].run, gate.runId);
assert(order.maxInFlight <= 2, 'At most two runs are prefetched at once');
claims.gateReviewPrefetchOrder = true;

// ── 2. Untracked new file prefetched; the ignored .env is never transferred or stored ──
const untracked = fixture.active.find((run) => run.id === fixture.untrackedRun);
const untrackedQuery = firstHeld.store.queries.find(
  (id) => id.startsWith('git.diff:') && id.includes(untracked.id),
);
const untrackedFile = 'notes/new-file.md';
const scanned = await inspect(A, { queries: [untrackedQuery], scan: IGNORED });
const slotDiff = scanned.store.rows[untrackedQuery].data.diff;
const newFileId = parseDiff(slotDiff).find((file) => file.newPath === untrackedFile)?.newId;
const newFile = (await inspect(A, { content: [{ kind: 'blob', id: newFileId }] })).store
  .verified[0];
evidence.untracked = {
  query: untrackedQuery,
  untrackedFile,
  newFile,
  storeHits: scanned.store.hits,
  storedRows: scanned.store.queries.length,
  storedContent: scanned.store.content.length,
};
await save('untracked-env', evidence.untracked);
assert(slotDiff.includes(`b/${untrackedFile}`), 'The held diff carries the untracked new file');
assert(newFile.present && newFile.blobHash === newFileId, 'Its new side is held by blob id');
assert(!slotDiff.includes('.env'), 'The held diff never names the ignored file');
assert.deepEqual(scanned.store.hits, [], 'No stored row or held byte carries the ignored file');

// ── 3. Fix loop: a new package transfers only the new diff and bases not already held ──
const loopStart = Date.now();
await checkpoint('fix-loop');
const secondRefresh = await rpc('run.refreshPublishPackage', {
  runId: gate.runId,
  decisionId: gate.decisionId,
});
const secondPackage = pendingPackage((await rpc('run.get', { runId: gate.runId })).run);
assert.notEqual(secondPackage.id, firstPackage.id);
assert.notEqual(secondPackage.reviewSnapshot.diffHash, firstPackage.reviewSnapshot.diffHash);
await until(
  (value) => gateHeld(value, secondPackage.reviewSnapshot.diffHash),
  'The new package diff is held',
  A,
  { timeout: 120000, interval: 1000 },
);
await delay(4000);
const loopEnd = Date.now();
const loopRows = ownerFrames.rows.filter((row) => row.wall >= loopStart && row.wall <= loopEnd);
const loop = {
  refreshed: secondRefresh.packageId,
  packageId: secondPackage.id,
  diffHash: secondPackage.reviewSnapshot.diffHash,
  diffPath: secondPackage.reviewSnapshot.diffPath,
  gate: runTransfer(ownerFrames.rows, gate.runId, loopStart, loopEnd),
  window: {
    receivedBytes: sumBytes(loopRows.filter((row) => row.kind === 'ws' && row.dir === 'received')),
    sentBytes: sumBytes(loopRows.filter((row) => row.kind === 'ws' && row.dir === 'sent')),
    httpBytes: sumBytes(loopRows.filter((row) => row.kind === 'http')),
    events: loopRows.filter((row) => row.type === 'event').map((row) => row.event),
    otherReads: loopRows
      .filter((row) => row.type === 'req' && readRun(row, { checks: true }) !== gate.runId)
      .map((row) => row.method),
  },
};
evidence.fixLoop = loop;
await save('fix-loop', loop);
const loopHttp = loop.gate.reads.filter((read) => read.http);
const loopShow = loop.gate.reads.filter((read) => read.method === 'git.show');
const statuses = loopShow.flatMap((read) => read.entries ?? []);
assert.deepEqual(
  loopHttp.map((read) => [read.http, read.status]),
  [[secondPackage.reviewSnapshot.diffPath, 200]],
  'Only the new diff is read over HTTP',
);
assert(loopShow.length >= 1 && loopShow.every((read) => read.have?.length));
assert(statuses.some((entry) => entry.status === 'held'));
assert(
  statuses.every((entry) => entry.status === 'held' || entry.status === 'too-large'),
  'No held base is sent again',
);
claims.gateReviewFixLoopBytes = true;

// ── 4. Gate diff open: five samples with nothing held, five after prefetch ──
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(target, viewer, persistent, connected = true) {
  const samples = [];
  for (let index = 0; index < 5; index++) {
    // Each sample is a new document, so nothing is in memory; only the owner's store holds data.
    await navigate(target, url(`${viewer}-${index}`, '#runs'));
    await until(
      (value) =>
        value.loaded &&
        (value.connection === 'connected') === connected &&
        value.persistent === persistent,
      'Measurement start',
      target,
    );
    // The owner's new connection runs its prefetch pass first; the open is measured after it.
    await delay(8000);
    await dismissUpdateNotice(target);
    samples.push(
      await cdp([
        'baseline',
        target,
        'gate',
        gateRoute('diff'),
        JSON.stringify({ runId: gate.runId }),
      ]),
    );
  }
  return {
    samples,
    medianMs: median(samples.map((sample) => sample.elapsedMs)),
    medianDiffReplyMs: median(samples.flatMap((sample) => sample.diffReplyMs ?? [])),
    medianTotalBytes: median(samples.map((sample) => sample.totalBytes)),
    medianFrameBytes: median(samples.map((sample) => sample.receivedBytes)),
    medianArtifactBytes: median(samples.map((sample) => sample.artifactBytes)),
  };
}
const B = await openWindow('fresh', '#runs', { left: 900, top: 39, width: 900, height: 1040 });
const fresh = await until((value) => value.connection === 'connected', 'Second viewer', B, {
  timeout: 60000,
});
assert.equal(fresh.persistent, false, 'The second viewer holds nothing and never prefetches');
const nothingHeld = await measure(B, 'fresh', false);
await devtools((call) => call('Target.closeTarget', { targetId: B.slice(1) }));
await ownTabs([config.tabId]);
const afterPrefetch = await measure(A, 'owner-measure', true);
evidence.measurements = { nothingHeld, afterPrefetch };
await save('gate-open-measurements', evidence.measurements);
assert.equal(nothingHeld.samples.length + afterPrefetch.samples.length, 10);
claims.gateReviewDiffMeasured = true;

// ── 5. Gate offline: details, diff and evidence render; both sides proven from the store ──
const held = await inspect(A, {
  content: [{ kind: 'diff', id: secondPackage.reviewSnapshot.diffHash }],
  withText: true,
});
const touched = parseDiff(held.store.verified[0].text);
const manifest = new Map(
  (secondPackage.reviewSnapshot.untrackedFiles ?? []).map((file) => [file.path, file.blobSha]),
);
// Bases the gateway answered `too-large` are over the content cap and load when opened.
const overCap = new Set(
  ownerFrames.rows.flatMap((row) =>
    (row.entries ?? []).filter((entry) => entry.status === 'too-large').map((entry) => entry.path),
  ),
);
await checkpoint('cold-outage');
await until((value) => value.connection !== 'connected', 'Gateway gone', A);
const offlineFrames = await recordFrames(A, 'offline');
await navigate(
  A,
  url('owner-offline', `${gateRoute('diff')}&file=${encodeURIComponent('src/beta.ts')}`),
);
const offlineDiff = await until(
  (value) =>
    value.connection !== 'connected' &&
    value.persistent &&
    value.gate?.diffTable &&
    value.gate.tabs.some((tab) => tab.label.startsWith('Evidence')),
  'The gate details and package diff render offline',
  A,
  { timeout: 60000 },
);
await image('offline-diff', A);
await navigate(A, url('owner-offline', gateRoute('evidence')));
await until(
  (value) => value.gate?.images.length >= images.length,
  'Evidence images are listed offline',
  A,
);
// The previews sit in the collapsed publish-file picker; a reviewer opens it to see them.
await cdp(['click', A, 'ready-workspace details.rdy-publish-file-selection > summary']);
const offlineEvidence = await until(
  (value) =>
    value.gate?.workspace &&
    value.gate.images.filter((entry) => entry.complete && entry.width > 0).length >= images.length,
  'Evidence images render offline',
  A,
  { timeout: 60000 },
);
await image('offline-evidence', A);
const keys = [];
for (const file of touched) {
  if (file.binary) continue;
  if (!file.added) keys.push({ kind: 'blob', id: file.oldId });
  if (!file.deleted) keys.push({ kind: 'blob', id: manifest.get(file.newPath) ?? file.newId });
}
for (const blobSha of manifest.values()) keys.push({ kind: 'blob', id: blobSha });
const verified = (await inspect(A, { content: keys })).store.verified;
const find = (id) => verified.find((entry) => entry.id === id);
const sides = touched.map((file) => ({
  ...file,
  eligible: !file.binary && !overCap.has(file.oldPath),
  base: file.binary || file.added ? undefined : find(file.oldId),
  next: file.binary || file.deleted ? undefined : find(manifest.get(file.newPath) ?? file.newId),
}));
for (const [file, blobSha] of manifest)
  if (!touched.some((entry) => entry.newPath === file))
    sides.push({ newPath: file, added: true, eligible: true, next: find(blobSha) });
// The same open with the gateway stopped: five new documents, each rendering from held content.
const offlineHeld = await measure(A, 'owner-offline-measure', true, false);
evidence.measurements.offlineHeld = offlineHeld;
await save('gate-open-measurements', evidence.measurements);
assert(offlineHeld.samples.every((sample) => sample.method === 'local' && sample.totalBytes === 0));
const offlineRows = await offlineFrames.stop();
await save('offline-gate', {
  offlineDiff,
  offlineEvidence,
  overCap: [...overCap],
  sides,
  offlineSentFrames: offlineRows.filter((row) => row.dir === 'sent').length,
});
assert(
  sides.some((file) => file.binary),
  'The package includes a binary file',
);
assert(
  sides.some((file) => !file.binary && !file.eligible),
  'The package includes an over-cap file',
);
for (const file of sides.filter((entry) => entry.eligible)) {
  if (!file.added)
    assert(file.base?.present && file.base.blobHash === file.base.id, `Base of ${file.oldPath}`);
  if (!file.deleted)
    assert(file.next?.present && file.next.blobHash === file.next.id, `New ${file.newPath}`);
}
for (const file of sides.filter((entry) => !entry.eligible))
  assert(!file.base?.present && !file.next?.present, `${file.newPath} loads when opened`);
assert.equal(offlineRows.filter((row) => row.dir === 'sent').length, 0);
claims.gateReviewOffline = true;
claims.gateReviewBothSides = true;

// ── 6. Recovery ──
await checkpoint('cold-recovery');
await navigate(A, url('owner', '#runs'));
await until((value) => value.connection === 'connected', 'Owner reconnects', A, {
  timeout: 60000,
});
await ownerFrames.stop();

// ── 7. An operator principal: the first refusal stops prefetch until a new connection ──
await cdp(['click', A, '[data-testid="account-menu"]']);
await cdp(['click', A, '[data-testid="account-sign-out"]']);
await cdp(['click', A, '[data-testid="account-sign-out-confirm"]']);
await until((value) => value.auth, 'Signed out', A);
const operatorFrames = await recordFrames(A, 'operator');
// The signed-out document opens its next gateway socket through the page-side timing log.
assert.equal(await cdp(['eval', A, `${SOCKET_LOG}; return true`]), true);
const operatorEnv = { ...process.env, FARMSLOT_GATEWAY_PROFILE: fixture.operator.profile };
/** One connection, then a forced reconnect: 20 seconds each, read from the recorded frames. */
async function observeConnections(first, since) {
  await delay(20000);
  const reconnectAt = Date.now();
  const dropped = await dropGatewaySocket(A);
  assert(dropped.count >= 1);
  const reconnected = await until(
    (value) => value.connection === 'connected' && value.connectionId !== first.connectionId,
    'Operator reconnects on a new connection',
    A,
    { timeout: 60000 },
  );
  await delay(20000);
  return {
    since,
    reconnectAt,
    until: Date.now(),
    notice: first.notice,
    connectionIds: [first.connectionId, reconnected.connectionId],
    page: pageTiming(
      await cdp(['eval', A, 'return window.__gateProofSockets ?? null']),
      dropped.at,
    ),
  };
}
/**
 * Per connection, in the page's own event order: every prefetch read the page handed to its
 * socket, and whether it came after the first refusal's message event reached the page.
 */
function pageTiming(log, droppedAt) {
  assert(Array.isArray(log), 'The page-side socket log is installed');
  const prefetchRead = (entry) =>
    entry.dir === 'send' &&
    ((entry.method === 'run.get' && runIds.has(entry.runId)) ||
      (entry.method.startsWith('git.') && slotRun.has(entry.slotId)));
  return [
    [-Infinity, droppedAt],
    [droppedAt, Infinity],
  ].map(([from, to]) => {
    const window = log
      .map((entry, index) => ({ ...entry, index }))
      .filter((entry) => entry.at >= from && entry.at < to);
    const replies = new Map(
      window.filter((entry) => entry.dir === 'reply').map((entry) => [entry.id, entry]),
    );
    const reads = window.filter(prefetchRead);
    const refusal = reads
      .map((entry) => replies.get(entry.id))
      .filter((reply) => reply?.error === 'AUTH_FORBIDDEN')
      .sort((a, b) => a.index - b.index)[0];
    return {
      firstRefusalReachedPageAt: refusal?.at,
      reads: reads.map((entry) => ({
        method: entry.method,
        runId: entry.runId ?? slotRun.get(entry.slotId),
        sentByPageAt: entry.at,
        replyReachedPageAt: replies.get(entry.id)?.at,
        error: replies.get(entry.id)?.error,
        sentAfterFirstRefusal: refusal !== undefined && entry.index > refusal.index,
        ...(refusal
          ? { sentAfterFirstRefusalMs: Math.round((entry.at - refusal.at) * 10) / 10 }
          : {}),
      })),
    };
  });
}
const sameDocumentAt = Date.now();
assert((await cdp(['login', A], operatorEnv)).authenticated);
const signedIn = await until(
  (value) => value.connection === 'connected' && value.principalId === fixture.operator.principalId,
  'Operator signed in',
  A,
  { timeout: 60000 },
);
// A new principal in the tab that signed out can stay on memory storage, which never prefetches,
// until a new document. The same document is always recorded; it is asserted only when asked.
const sameDocument = await observeConnections(signedIn, sameDocumentAt);
const reloadAt = Date.now();
// The new document gets the same page-side log before any of its scripts run.
await devtools(async (call) => {
  await call('Page.enable');
  const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', {
    source: SOCKET_LOG,
  });
  await call('Page.navigate', { url: url('operator', '#runs') });
  await delay(3000);
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
}, A);
const operator = await until(
  (value) =>
    value.connection === 'connected' &&
    value.persistent &&
    !value.notice &&
    value.timeOrigin !== signedIn.timeOrigin &&
    value.principalId === fixture.operator.principalId &&
    value.scope?.principalId === fixture.operator.principalId,
  'Operator connected',
  A,
  { timeout: 60000 },
);
const reloaded = await observeConnections(operator, reloadAt);
const operatorState = await inspect(A, { scan: IGNORED });
assert.equal(operatorState.scope.principalId, fixture.operator.principalId);
const operatorRows = await operatorFrames.stop();
const reads = (since, until) =>
  operatorRows
    .filter((row) => row.wall >= since && row.wall < until && readRun(row, { checks: true }))
    .map((row) => ({
      wall: row.wall,
      ts: row.ts,
      method: row.method,
      runId: readRun(row, { checks: true }),
      error: replyTo(operatorRows, row)?.error,
      repliedTs: replyTo(operatorRows, row)?.ts,
    }));
// The gate's run.get is the first prefetch read. Prefetch starts at most two runs at once, so the
// run started beside the gate may already be reading when the refusal lands; neither continues
// past run.get, and no other run starts for the rest of the connection.
const observed = (window) => {
  const connections = [
    reads(window.since, window.reconnectAt),
    reads(window.reconnectAt, window.until),
  ];
  return {
    ...window,
    connections,
    sentAfterFirstRefusal: connections.map((connection) => {
      const refusedTs = Math.min(...connection.map((read) => read.repliedTs));
      return connection
        .filter((read) => read.ts > refusedTs)
        .map(({ runId, ts }) => ({ runId, ts }));
    }),
  };
};
const assertSameDocument = process.env.FARMSLOT_GATE_REVIEW_SAME_DOCUMENT === '1';
const refusal = {
  principalId: operator.principalId,
  sameDocument: { asserted: assertSameDocument, ...observed(sameDocument) },
  reloaded: observed(reloaded),
  operatorStore: {
    content: operatorState.store.content,
    refusedReads: operatorState.store.queries.filter(
      (id) => id.startsWith('run.get:') || id.startsWith('git.'),
    ),
  },
};
evidence.refusal = refusal;
await save('operator-refusal', refusal);
const checked = [refusal.reloaded, ...(assertSameDocument ? [refusal.sameDocument] : [])];
// On the page's own event order, nothing is handed to the socket once the first refusal arrives.
for (const connection of checked.flatMap((window) => window.page)) {
  assert.equal(connection.reads[0]?.runId, gate.runId, "The gate's run.get is sent first");
  assert.equal(connection.reads[0].method, 'run.get');
  assert(connection.firstRefusalReachedPageAt !== undefined, 'The operator is refused');
  assert(
    connection.reads.every((read) => !read.sentAfterFirstRefusal),
    'No prefetch read is sent after the first refusal reaches the page',
  );
}
for (const connection of checked.flatMap((window) => window.connections)) {
  assert.equal(connection[0]?.runId, gate.runId, "The gate's run.get is the first prefetch read");
  assert(connection.length <= 2, 'Only the runs already in flight');
  assert(connection.every((read) => read.method === 'run.get' && read.error === 'AUTH_FORBIDDEN'));
  assert.equal(new Set(connection.map((read) => read.runId)).size, connection.length);
}
assert.deepEqual(refusal.operatorStore.content, [], 'The operator store holds no content');
assert.deepEqual(refusal.operatorStore.refusedReads, [], 'No refused read is stored');
claims.gateReviewRefusalStops = true;

// The ignored .env: in no frame recorded on any connection, and in no row either principal stored.
const frameHits = [];
for (const label of ['owner', 'offline', 'operator'])
  for (const line of (await readFile(path.join(artifacts, `frames-${label}.jsonl`), 'utf8'))
    .split('\n')
    .filter(Boolean)) {
    const { payload } = JSON.parse(line);
    for (const needle of IGNORED) if (payload.includes(needle)) frameHits.push({ label, needle });
  }
evidence.ignoredFile = { frameHits, operatorStoreHits: operatorState.store.hits };
await save('ignored-file', evidence.ignoredFile);
assert.deepEqual(frameHits, [], 'The ignored .env appears in no websocket frame');
assert.deepEqual(operatorState.store.hits, []);
claims.gateReviewUntrackedEnv = true;

await save('result', { claims, evidence });
console.log(JSON.stringify(claims));
