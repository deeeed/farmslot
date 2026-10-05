#!/usr/bin/env node
// console-forwarder — stream device console lines into metro.log.
//
// React Native (Bridgeless) gates its built-in console→Metro forwarding on
// `console._isPolyfilled` (setUpDeveloperTools.js, T214991636); with the Hermes
// native console that gate is false, so app logs (incl. DevLogger) never reach
// Metro's log. The supported contract for log consumption in modern RN is CDP —
// this process does exactly what React Native DevTools does: hold a persistent
// debugger session per device page, enable the Runtime domain once, and stream
// `Runtime.consoleAPICalled` events as they happen.
//
// Recovery: on session loss the runtime's console buffer is replayed on the
// next Runtime.enable, and a per-device cursor (last-seen timestamp + texts at
// that timestamp, persisted next to the log) dedupes it — lines emitted during
// a disconnect, an app reload, or a forwarder restart are backfilled once.
// Dedupe keys on the runtime's console timestamps (fractional-ms doubles), so
// a device clock stepping backwards can drop lines emitted below the cursor:
// replay is a recovery path, not a ledger. Target discovery is a cheap HTTP
// poll against Metro only (never the app runtime): fast while a device is
// unattached, slow when all sessions are live. Never exits on its own; idles
// while Metro is down.
//
// Usage: node console-forwarder.cjs --port <metroPort> --out <logFile>

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { rankRuntimeCandidates } = require('./lib/target-discovery.cjs');
const { formatArgs: formatConsoleArgs } = require('./lib/console-format.cjs');
const {
  brokerSocketPath,
  createCdpBroker,
  deviceIdFromUrl,
} = require('@farmslot/recipe-runner/cdp-broker');
const { createDevtoolsProxy } = require('./lib/devtools-proxy.cjs');
const { resolvePort } = require('./lib/config.cjs');
const { createInspectorWebSocket } = require('./lib/ws-client.cjs');

const HANDSHAKE_TIMEOUT_MS = 3000;
const RUNTIME_ENABLE_TIMEOUT_MS = 60_000;

const DISCOVER_ACTIVE_MS = 1000; // a device is unattached — look for it quickly
const DISCOVER_STEADY_MS = 10000; // all known targets attached — cheap liveness tick
const FLUSH_MS = 100;
const MAX_LINE_CHARS = 4000;

function parseArgs(argv) {
  const args = { port: resolvePort(), out: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
  }
  if (!args.out) {
    process.stderr.write('console-forwarder: --out <logFile> is required\n');
    process.exit(2);
  }
  return args;
}

const { port, out } = parseArgs(process.argv);
const statePath = `${out}.forwarder-state.json`;

// Bridge-priority coordination: the inspector proxy reliably serves one
// debugger slot. cdp-bridge holds this lock while a command runs; we yield the
// slot immediately and re-attach after a settle window — the runtime's console
// buffer replay backfills everything missed, so no lines are lost.
const LOCK_FILE = path.join(path.dirname(out), 'cdp-bridge.lock');
const LOCK_SETTLE_MS = 1500;
// The inspector can deliver NEW_DEBUGGER_OPENED after a short bridge command
// has already removed its lock. Keep a narrow release grace so that delayed
// close event is not mistaken for a human DevTools takeover (which otherwise
// suppresses device logs for five minutes).
const BRIDGE_RELEASE_GRACE_MS = 3000;
const LOCK_STALE_MS = 30000; // unreadable lock body: crashed bridge must not block logs forever
// dev-middleware serves one debugger slot per device; when a debugger we do not
// coordinate with (React Native DevTools) takes it, re-attaching would evict
// the human back and start a mutual-eviction storm. Stand down for a long
// window instead — bridge commands still work (they carry their own lock).
const FOREIGN_DEBUGGER_BACKOFF_MS = 5 * 60 * 1000;

function bridgeLockActive() {
  // The lock body is the bridge pid, so liveness is the real signal: a bridge
  // command may legitimately outlive any fixed mtime window (wallet setup runs
  // with CDP_TIMEOUT=120000). mtime staleness only guards an unreadable body.
  let body;
  try {
    body = fs.readFileSync(LOCK_FILE, 'utf8');
  } catch {
    return false;
  }
  const pid = Number.parseInt(body.trim(), 10);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the pid is alive but owned by another user — still a live bridge.
      return error.code === 'EPERM';
    }
  }
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function yieldSessions() {
  for (const session of sessions.values()) {
    broker?.onSessionClose(session.deviceId);
    session.ws.close();
  }
  sessions.clear();
}

let resumeTimer = null;
let bridgeCoordinationUntil = 0;

function noteBridgeCoordination() {
  bridgeCoordinationUntil = Date.now() + BRIDGE_RELEASE_GRACE_MS;
}

function bridgeCoordinationRecent() {
  return Date.now() < bridgeCoordinationUntil;
}

try {
  fs.watch(path.dirname(out), (_event, filename) => {
    if (filename !== path.basename(LOCK_FILE)) return;
    noteBridgeCoordination();
    if (bridgeLockActive()) {
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      yieldSessions();
    } else if (!resumeTimer) {
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        discover();
      }, LOCK_SETTLE_MS);
    }
  });
} catch {
  // fs.watch unavailable: the stale-mtime check in discover() still guards us.
}

/**
 * deviceId -> { ts, seen } dedupe cursor: highest consoleAPICalled timestamp
 * already written, plus the formatted texts already written AT that timestamp.
 * Runtime stamps are fractional-ms doubles, but two logs in one tick share a
 * stamp — a timestamp-only cursor dropped the second on replay. A device clock
 * stepping backwards can still drop lines (ts below the cursor): replay is a
 * recovery path, not a ledger.
 */
const lastByDevice = new Map();
let savedState = {};
try {
  savedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
} catch (error) {
  // First start has no state file, and a SIGKILL mid-write leaves a truncated
  // one. Both mean "no cursor": replay starts from the beginning.
  if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
}
for (const [device, value] of Object.entries(savedState)) {
  // Numeric values are state written by a timestamp-only forwarder build.
  lastByDevice.set(
    device,
    typeof value === 'number'
      ? { ts: value, seen: new Set() }
      : { ts: Number(value.ts) || 0, seen: new Set(Array.isArray(value.seen) ? value.seen : []) },
  );
}

function serializeState() {
  const state = {};
  for (const [device, cursor] of lastByDevice) {
    state[device] = { ts: cursor.ts, seen: [...cursor.seen] };
  }
  return JSON.stringify(state);
}

/** deviceId -> live WebSocket session state. */
const sessions = new Map();
let broker = null;
let devtoolsProxy = null;

function sendCommand(session, method, params = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (!session.opened) {
      reject(new Error('CDP session is not open'));
      return;
    }
    const id = ++session.nextId;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error(`CDP command timed out: ${method}`));
    }, timeoutMs);
    session.pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    session.ws.send(JSON.stringify({ id, method, params }));
  });
}

broker = createCdpBroker({
  socketPath: brokerSocketPath(path.dirname(out), port),
  sessions,
  sendCommand,
  requestDiscovery(deviceId) {
    foreignDebuggerUntil.delete(deviceId);
    discover();
  },
  onClientActivity: noteBridgeCoordination,
});
devtoolsProxy = createDevtoolsProxy({
  descriptorPath: path.join(path.dirname(out), 'devtools-proxy.json'),
  sessions,
  sendCommand,
  requestDiscovery: discover,
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
});

/** deviceId -> epoch ms until which a foreign debugger owns the slot. */
const foreignDebuggerUntil = new Map();

/** Buffered lines, flushed together so replay bursts are one write. */
let pending = [];
let flushTimer = null;

function flush() {
  flushTimer = null;
  if (pending.length === 0) return;
  const lines = pending.join('\n');
  pending = [];
  fs.appendFile(out, `${lines}\n`, reportWriteFailure);
  fs.writeFile(statePath, serializeState(), reportWriteFailure);
}

// Signal-path flush: process.exit() cancels queued async I/O, so the SIGTERM/
// SIGINT handlers must write synchronously or pending lines and the last-seen
// state are lost on every restart (a stale state file re-duplicates replay).
function flushSync() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const lines = pending.length > 0 ? `${pending.join('\n')}\n` : '';
  pending = [];
  try {
    if (lines) fs.appendFileSync(out, lines);
    fs.writeFileSync(statePath, serializeState());
  } catch (error) {
    reportWriteFailure(error);
  }
}

// A failed write loses that batch of console lines. This process also hosts
// the CDP broker, so it keeps running: slot teardown (runtime dir gone) needs
// no report, anything else (disk full, permissions) goes to the forwarder's
// stderr log once per error code, and the next flush tries again.
let lastWriteFailureCode = null;
function reportWriteFailure(error) {
  if (!error) {
    lastWriteFailureCode = null;
    return;
  }
  if (error.code === 'ENOENT' || error.code === lastWriteFailureCode) return;
  lastWriteFailureCode = error.code;
  process.stderr.write(`[console-forwarder] console log write failed: ${error.message}\n`);
}

function queueLine(line) {
  pending.push(line);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function levelLabel(type) {
  const t = String(type || 'log').toUpperCase();
  return t === 'WARNING' ? 'WARN' : t;
}

function formatArgs(args) {
  return formatConsoleArgs(args, MAX_LINE_CHARS);
}

function deviceNameFromTitle(title) {
  const m = /\(([^)]+)\)\s*$/.exec(title || '');
  return m ? m[1] : title || 'device';
}

function connect(target) {
  const deviceId = deviceIdFromUrl(target.webSocketDebuggerUrl);
  const name = deviceNameFromTitle(target.title);
  let ws;
  try {
    ws = createInspectorWebSocket(target.webSocketDebuggerUrl);
  } catch {
    return;
  }
  const session = {
    deviceId,
    name,
    ws,
    opened: false,
    brokerReady: false,
    nextId: 1,
    pending: new Map(),
  };
  sessions.set(deviceId, session);
  const handshakeTimer = setTimeout(() => ws.close(), HANDSHAKE_TIMEOUT_MS);
  ws.addEventListener('open', async () => {
    clearTimeout(handshakeTimer);
    session.opened = true;
    // A live inspector socket is enough for broker commands. Do not keep the
    // broker unavailable while Runtime.enable replays a large console buffer or
    // while __AGENTIC__ is being installed after a Hermes context handoff.
    // Commands such as status already report agenticPresent=false and their
    // callers retry against the same bounded action deadline.
    session.brokerReady = true;
    broker.onSessionOpen(deviceId);
    devtoolsProxy.onSessionOpen(deviceId, session);
    process.stderr.write(`console-forwarder: attached ${name}\n`);
    try {
      await sendCommand(session, 'Runtime.enable', {}, RUNTIME_ENABLE_TIMEOUT_MS);
      const evaluation = await sendCommand(session, 'Runtime.evaluate', {
        expression: "typeof globalThis.__AGENTIC__ === 'object'",
        returnByValue: true,
        awaitPromise: false,
      });
      if (evaluation?.result?.value !== true) {
        process.stderr.write(`console-forwarder: ${name} is waiting for __AGENTIC__\n`);
      }
    } catch (error) {
      process.stderr.write(
        `console-forwarder: console bootstrap pending for ${name}: ${String(error?.message || error).slice(0, 256)}\n`,
      );
    }
  });
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.id && session.pending.has(msg.id)) {
      const entry = session.pending.get(msg.id);
      session.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.method) {
      broker.onCdpEvent(deviceId, msg.method, msg.params || {});
      devtoolsProxy.onCdpEvent(deviceId, msg.method, msg.params || {});
    }
    if (msg.method !== 'Runtime.consoleAPICalled') return;
    const text = formatArgs(msg.params.args);
    // dev-middleware emits this NOTE on every debugger attach (i.e. ours). Drop it.
    if (text.includes('unsupported debugging client')) return;
    const ts = msg.params.timestamp || Date.now();
    const cursor = lastByDevice.get(deviceId);
    if (cursor && ts < cursor.ts) return;
    if (cursor && ts === cursor.ts) {
      if (cursor.seen.has(text)) return;
      cursor.seen.add(text);
    } else {
      lastByDevice.set(deviceId, { ts, seen: new Set([text]) });
    }
    const time = new Date(ts).toISOString().slice(11, 23);
    queueLine(` ${levelLabel(msg.params.type)}  ${time} [console:${name}] ${text}`);
  });
  const drop = () => {
    clearTimeout(handshakeTimer);
    session.opened = false;
    session.brokerReady = false;
    for (const entry of session.pending.values()) {
      entry.reject(new Error('CDP session closed'));
    }
    session.pending.clear();
    if (sessions.get(deviceId) === session) {
      sessions.delete(deviceId);
      broker.onSessionClose(deviceId);
      process.stderr.write(`console-forwarder: detached ${name}; will re-attach\n`);
    }
  };
  ws.addEventListener('close', (event) => {
    // dev-middleware closes the previous debugger with NEW_DEBUGGER_OPENED when
    // another one attaches. With no bridge lock present that debugger is a
    // human's DevTools session — back off long instead of evicting them back.
    const why = event && event.reason ? String(event.reason) : '';
    if (why.includes('NEW_DEBUGGER_OPENED') && !bridgeLockActive() && !bridgeCoordinationRecent()) {
      foreignDebuggerUntil.set(deviceId, Date.now() + FOREIGN_DEBUGGER_BACKOFF_MS);
      process.stderr.write(
        `console-forwarder: another debugger took ${name}; standing down for ${FOREIGN_DEBUGGER_BACKOFF_MS / 60000} min\n`,
      );
    }
    drop();
  });
  ws.addEventListener('error', drop);
}

function discover() {
  if (bridgeLockActive()) {
    noteBridgeCoordination();
    schedule(DISCOVER_ACTIVE_MS);
    return;
  }
  http
    .get({ host: '127.0.0.1', port, path: '/json/list', timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let targets;
        try {
          targets = JSON.parse(body);
        } catch {
          schedule(DISCOVER_ACTIVE_MS);
          return;
        }
        // Same candidate filter + JS-runtime-first ranking the bridge uses:
        // devices expose multiple pages (page 1 = native C++ runtime) and the
        // first ranked page per device is its JS runtime — attaching to the
        // native page would stream nothing and block the right one.
        let unattached = false;
        const picked = new Set();
        for (const t of rankRuntimeCandidates(targets)) {
          const deviceId = deviceIdFromUrl(t.webSocketDebuggerUrl);
          if (picked.has(deviceId)) continue;
          picked.add(deviceId);
          if (sessions.has(deviceId)) continue;
          if ((foreignDebuggerUntil.get(deviceId) || 0) > Date.now()) continue;
          foreignDebuggerUntil.delete(deviceId);
          unattached = true;
          connect(t);
        }
        schedule(unattached ? DISCOVER_ACTIVE_MS : DISCOVER_STEADY_MS);
      });
    })
    .on('error', () => schedule(DISCOVER_STEADY_MS));
}

let discoverTimer = null;
function schedule(ms) {
  if (discoverTimer) clearTimeout(discoverTimer);
  discoverTimer = setTimeout(discover, ms);
}

process.on('SIGTERM', () => {
  flushSync();
  devtoolsProxy.close();
  broker.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  flushSync();
  devtoolsProxy.close();
  broker.close();
  process.exit(0);
});

process.stderr.write(`console-forwarder: streaming Metro :${port} → ${out}\n`);
discover();
