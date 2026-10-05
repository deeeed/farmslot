'use strict';

const fs = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_MAX_REQUESTS = 1000;
const DEFAULT_MAX_DURATION_MS = 5 * 60 * 1000;
const MAX_CAPTURE_DURATION_MS = 60 * 60 * 1000;
const MAX_ACTIVE_CAPTURES = 16;
const MAX_COMPLETED_CAPTURES = 16;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MAX_POST_DATA_BYTES = 64 * 1024;
const MAX_REQUEST_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_HUD_STEP_BYTES = 16 * 1024;
const MAX_HUD_UPDATES = 64;
const MAX_RETAINED_STRING_LENGTH = 256;
const MAX_BROKER_TIMEOUT_MS = 60_000;
const SENSITIVE_FIELD = /(?:address|authorization|cookie|key|password|secret|token|user|account)/iu;
const SENSITIVE_VALUE = /(?:0x[a-f0-9]{40,}|[a-f0-9]{64,}|eyJ[a-z0-9_-]{20,}\.[a-z0-9_-]{20,})/iu;
const APPLY_HUD_UPDATE_FUNCTION = `function(step) {
  const bridge = this.__AGENTIC__;
  if (step === null) {
    if (typeof bridge?.hideStep !== 'function') return false;
    setTimeout(() => bridge.hideStep(), 0);
    return true;
  }
  if (typeof bridge?.showStep !== 'function') return false;
  setTimeout(() => bridge.showStep(step), 0);
  return true;
}`;

function brokerSocketPath(runtimeDir, endpointIdentity) {
  const runtimePath = path.resolve(
    runtimeDir || process.env.RECIPE_RUNTIME_DIR || path.join('temp', 'recipe', 'runtime'),
  );
  const socketIdentity =
    endpointIdentity === undefined || endpointIdentity === null
      ? runtimePath
      : `${runtimePath}\u0000${String(endpointIdentity)}`;
  const identity = createHash('sha256').update(socketIdentity).digest('hex').slice(0, 20);
  return path.join('/tmp', `mmh-cdp-${identity}.sock`);
}

function deviceIdFromUrl(wsUrl) {
  const match = /[?&]device=([^&]+)/u.exec(wsUrl || '');
  return match ? match[1] : wsUrl;
}

function safePrimitive(value) {
  if (value === null || ['number', 'boolean'].includes(typeof value)) {
    return value;
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_RETAINED_STRING_LENGTH ||
    SENSITIVE_VALUE.test(value)
  ) {
    return undefined;
  }
  return value;
}

function sanitizePathname(pathname) {
  const segments = String(pathname)
    .split('/')
    .map((segment) =>
      segment.length > 64 || SENSITIVE_VALUE.test(segment) ? '<redacted>' : segment,
    );
  return segments.join('/').slice(0, 1024);
}

function boundedError(error) {
  return String(error?.message || error || 'unknown error').slice(0, MAX_RETAINED_STRING_LENGTH);
}

function boundedTimeout(value, fallback = 10_000) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0
    ? Math.min(MAX_BROKER_TIMEOUT_MS, timeout)
    : fallback;
}

// State recovery is event-driven. Pick a fixed bound below the caller's RPC
// deadline so the broker always answers before the client gives up. Returning
// literals also keeps the timer independent from untrusted request values.
function stateWaitTimeout(value) {
  const timeout = boundedTimeout(value);
  if (timeout <= 500) return 1;
  if (timeout <= 1_000) return 400;
  if (timeout <= 2_000) return 900;
  if (timeout <= 5_000) return 1_900;
  if (timeout <= 10_000) return 4_500;
  if (timeout <= 15_000) return 9_500;
  if (timeout <= 30_000) return 14_500;
  if (timeout <= 45_000) return 29_500;
  if (timeout <= 55_000) return 44_500;
  return 54_500;
}

function readField(value, field) {
  let current = value;
  for (const segment of String(field).split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
  }
  return { found: true, value: safePrimitive(current) };
}

function sanitizeNetworkRequest(request, capture, now) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (
    capture.urlIncludes.length > 0 &&
    !capture.urlIncludes.some((value) => request.url.includes(value))
  ) {
    return null;
  }
  if (
    capture.methods.length > 0 &&
    !capture.methods.includes(String(request.method).toUpperCase())
  ) {
    return null;
  }

  let body = null;
  let bodyInspectable = capture.bodyJsonFields.length === 0;
  if (
    capture.bodyJsonFields.length > 0 &&
    request.postData &&
    Buffer.byteLength(request.postData) <= MAX_POST_DATA_BYTES
  ) {
    try {
      const parsed = JSON.parse(request.postData);
      bodyInspectable = true;
      const entries = [];
      for (const field of capture.bodyJsonFields) {
        const retained = readField(parsed, field);
        if (!retained.found) continue;
        if (retained.value === undefined) {
          bodyInspectable = false;
          continue;
        }
        entries.push([field, retained.value]);
      }
      body = Object.fromEntries(entries);
    } catch {
      body = null;
    }
  }

  return {
    record: {
      elapsedMs: now - capture.startedAtEpochMs,
      host: url.hostname,
      path: sanitizePathname(url.pathname),
      method: String(request.method || 'GET').toUpperCase(),
      ...(body && Object.keys(body).length > 0 ? { body } : {}),
    },
    bodyInspectable,
  };
}

function countsBy(records, selector) {
  const result = Object.create(null);
  for (const record of records) {
    const key = String(selector(record) ?? 'unknown');
    result[key] = (result[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeCapture(input) {
  const id = String(input.id || '').trim();
  if (!/^[a-z0-9._-]{1,100}$/iu.test(id)) {
    throw new Error('Network capture id is invalid');
  }
  const normalizeList = (value, name) => {
    const values = Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
    if (values.length > 20 || values.some((entry) => entry.length > 256)) {
      throw new Error(`Network capture ${name} exceeds its bound`);
    }
    return values;
  };
  const bodyJsonFields = normalizeList(input.bodyJsonFields, 'bodyJsonFields');
  if (bodyJsonFields.some((field) => SENSITIVE_FIELD.test(field))) {
    throw new Error('Network capture body field is sensitive');
  }
  const maxRequests = Number(input.maxRequests ?? DEFAULT_MAX_REQUESTS);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10_000) {
    throw new Error('Network capture maxRequests must be between 1 and 10000');
  }
  const maxDurationMs = Number(input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  if (
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1 ||
    maxDurationMs > MAX_CAPTURE_DURATION_MS
  ) {
    throw new Error('Network capture maxDurationMs is invalid');
  }
  return {
    id,
    startedAtEpochMs: Date.now(),
    urlIncludes: normalizeList(input.urlIncludes, 'urlIncludes'),
    methods: normalizeList(input.methods, 'methods').map((value) => value.toUpperCase()),
    bodyJsonFields,
    maxRequests,
    maxDurationMs,
    requests: [],
    retainedBytes: 0,
    uninspectableBodyRequests: 0,
    droppedRequests: 0,
    reconnects: 0,
    partial: false,
    networkEnabled: false,
    enableErrors: [],
    endedAtEpochMs: null,
  };
}

function brokerOwnerPath(socketPath) {
  return `${socketPath}.owner`;
}

function readBrokerOwner(ownerPath) {
  let source;
  try {
    source = fs.readFileSync(ownerPath, 'utf8');
  } catch (error) {
    if (error.code !== 'EISDIR') return null;
    try {
      source = fs.readFileSync(path.join(ownerPath, 'owner.json'), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    const value = JSON.parse(source);
    return Number.isInteger(value.pid) && typeof value.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimBrokerSocket(socketPath) {
  const ownerPath = brokerOwnerPath(socketPath);
  const owner = { pid: process.pid, token: randomUUID() };
  const candidatePath = `${ownerPath}.claim-${owner.pid}-${owner.token}`;
  fs.mkdirSync(candidatePath, { mode: 0o700 });
  fs.writeFileSync(path.join(candidatePath, 'owner.json'), `${JSON.stringify(owner)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  let claimed = false;
  for (let attempt = 0; attempt < 10 && !claimed; attempt += 1) {
    try {
      fs.renameSync(candidatePath, ownerPath);
      claimed = true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
        fs.rmSync(candidatePath, { recursive: true, force: true });
        throw error;
      }
      const previousOwner = readBrokerOwner(ownerPath);
      if (previousOwner && processIsAlive(previousOwner.pid)) {
        fs.rmSync(candidatePath, { recursive: true, force: true });
        throw new Error(`CDP broker socket is owned by process ${previousOwner.pid}`);
      }
      const stalePath = `${ownerPath}.stale-${randomUUID()}`;
      try {
        fs.renameSync(ownerPath, stalePath);
        fs.rmSync(stalePath, { recursive: true, force: true });
      } catch (staleError) {
        if (staleError.code !== 'ENOENT') {
          fs.rmSync(candidatePath, { recursive: true, force: true });
          throw staleError;
        }
      }
    }
  }
  if (!claimed) {
    fs.rmSync(candidatePath, { recursive: true, force: true });
    throw new Error('CDP broker socket ownership could not be claimed');
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      fs.rmSync(ownerPath, { recursive: true, force: true });
      throw error;
    }
  }
  return { ownerPath, owner };
}

function releaseBrokerSocket(socketPath, ownership) {
  const currentOwner = readBrokerOwner(ownership.ownerPath);
  if (currentOwner?.pid !== ownership.owner.pid || currentOwner?.token !== ownership.owner.token) {
    return;
  }
  fs.rmSync(socketPath, { force: true });
  fs.rmSync(ownership.ownerPath, { recursive: true, force: true });
}

function createCdpBroker({
  socketPath,
  sessions,
  sendCommand,
  requestDiscovery,
  onClientActivity,
}) {
  const captures = new Map();
  const completedCaptures = new Map();
  const hudUpdates = new Map();
  const appliedHudVersions = new Map();
  const hudApplyChains = new Map();
  const clients = new Set();
  const subscriptions = new Map();
  const knownTargets = new Map(
    [...sessions.entries()].flatMap(([deviceId, session]) =>
      session?.brokerReady
        ? [
            [
              deviceId,
              {
                deviceId,
                generation: 1,
                name: String(session.name || ''),
                ready: true,
              },
            ],
          ]
        : [],
    ),
  );
  const sessionWaiters = new Map();
  const targetWaiters = new Set();
  const observedSessions = new Map(
    [...sessions.entries()].flatMap(([deviceId, session]) =>
      session?.brokerReady ? [[deviceId, session]] : [],
    ),
  );

  const capturesFor = (deviceId) => {
    if (!captures.has(deviceId)) captures.set(deviceId, new Map());
    return captures.get(deviceId);
  };

  const completedCapturesFor = (deviceId) => {
    if (!completedCaptures.has(deviceId)) {
      completedCaptures.set(deviceId, new Map());
    }
    return completedCaptures.get(deviceId);
  };

  function targetList({ nameIncludes = '', readyOnly = false } = {}) {
    const pin = String(nameIncludes).trim().toLowerCase();
    return [...knownTargets.values()]
      .filter((target) => !readyOnly || target.ready)
      .filter((target) => !pin || target.name.toLowerCase().includes(pin))
      .map((target) => ({ ...target }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function settleTargetWaiters() {
    for (const waiter of [...targetWaiters]) {
      const targets = targetList({
        nameIncludes: waiter.nameIncludes,
        readyOnly: true,
      });
      if (targets.length === 0) continue;
      targetWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(targets);
    }
  }

  function resolveTargets(params, timeoutMs, socket) {
    const existing = targetList({
      nameIncludes: params.nameIncludes,
      readyOnly: true,
    });
    if (existing.length > 0) return Promise.resolve(existing);
    const retained = targetList({ nameIncludes: params.nameIncludes });
    requestDiscovery?.(
      String(params.nameIncludes || '').trim() && retained.length === 1 ? retained[0].deviceId : '',
    );
    return new Promise((resolve, reject) => {
      const waiter = {
        nameIncludes: String(params.nameIncludes || ''),
        resolve,
        reject,
        socket,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        targetWaiters.delete(waiter);
        reject(new Error('CDP broker never observed the requested target'));
      }, stateWaitTimeout(timeoutMs));
      targetWaiters.add(waiter);
      settleTargetWaiters();
    });
  }

  function waitForSession(deviceId, timeoutMs, socket) {
    if (sessions.get(deviceId)?.brokerReady) return sessions.get(deviceId);
    requestDiscovery?.(deviceId);
    return new Promise((resolve, reject) => {
      const waiters = sessionWaiters.get(deviceId) || new Set();
      const waiter = {
        resolve,
        reject,
        socket,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          if (waiters.size === 0) sessionWaiters.delete(deviceId);
          reject(new Error(`CDP broker target unavailable: ${deviceId}`));
        }, stateWaitTimeout(timeoutMs)),
      };
      waiters.add(waiter);
      sessionWaiters.set(deviceId, waiters);
      const session = sessions.get(deviceId);
      if (session?.brokerReady) {
        waiters.delete(waiter);
        if (waiters.size === 0) sessionWaiters.delete(deviceId);
        clearTimeout(waiter.timer);
        resolve(session);
      }
    });
  }

  async function enableNetwork(deviceId, capture, timeoutMs = 10_000, socket) {
    try {
      const budgetMs = boundedTimeout(timeoutMs);
      const deadline = Date.now() + budgetMs;
      const session = await waitForSession(deviceId, budgetMs, socket);
      const remainingMs = Math.max(1, deadline - Date.now());
      await sendCommand(session, 'Network.enable', {}, remainingMs);
      if (capture.enableErrors.length > 0) capture.partial = true;
      capture.networkEnabled = true;
    } catch (error) {
      if (capture.networkEnabled) capture.partial = true;
      if (capture.enableErrors.length < 20) {
        capture.enableErrors.push(boundedError(error));
      }
    }
  }

  function finishCapture(deviceId, capture, partial = false) {
    capture.partial ||= partial;
    capture.endedAtEpochMs ??= Date.now();
    capturesFor(deviceId).delete(capture.id);
  }

  async function applyHudUpdate(deviceId, timeoutMs, socket) {
    if (!hudUpdates.has(deviceId)) return { status: 'none' };
    const budgetMs = boundedTimeout(timeoutMs);
    const deadline = Date.now() + budgetMs;
    const session = await waitForSession(deviceId, budgetMs, socket);
    const update = hudUpdates.get(deviceId);
    if (!update) return { status: 'none' };
    if (appliedHudVersions.get(deviceId) === update.version) {
      return { status: 'applied', version: update.version };
    }
    let applied = false;
    while (Date.now() < deadline) {
      const globalObject = await sendCommand(
        session,
        'Runtime.evaluate',
        { expression: 'globalThis', returnByValue: false, awaitPromise: false },
        Math.max(1, deadline - Date.now()),
      );
      const objectId = globalObject?.result?.objectId;
      if (!objectId) {
        throw new Error('Mobile HUD runtime did not expose globalThis');
      }
      const evaluation = await sendCommand(
        session,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: APPLY_HUD_UPDATE_FUNCTION,
          arguments: [{ value: update.step }],
          returnByValue: true,
          awaitPromise: false,
        },
        Math.max(1, deadline - Date.now()),
      );
      if (evaluation?.result?.value === true) {
        applied = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!applied) {
      throw new Error('Mobile HUD bridge was not installed before the update deadline');
    }
    if (hudUpdates.get(deviceId)?.version === update.version) {
      appliedHudVersions.set(deviceId, update.version);
    }
    return { status: 'applied', version: update.version };
  }

  function scheduleHudUpdate(deviceId, timeoutMs, socket) {
    const previous = hudApplyChains.get(deviceId) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => applyHudUpdate(deviceId, timeoutMs, socket));
    hudApplyChains.set(deviceId, next);
    void next
      .finally(() => {
        if (hudApplyChains.get(deviceId) === next) hudApplyChains.delete(deviceId);
      })
      .catch(() => undefined);
    return next;
  }

  function expireCapture(deviceId, capture) {
    if (capturesFor(deviceId).get(capture.id) !== capture) return;
    finishCapture(deviceId, capture, true);
    const completed = completedCapturesFor(deviceId);
    completed.set(capture.id, capture);
    while (completed.size > MAX_COMPLETED_CAPTURES) {
      completed.delete(completed.keys().next().value);
    }
  }

  function captureSummary(capture) {
    const bodyType = (record) => record.body?.type ?? 'unknown';
    const endedAtEpochMs = capture.endedAtEpochMs ?? Date.now();
    const exceededMaxDuration = endedAtEpochMs - capture.startedAtEpochMs > capture.maxDurationMs;
    return {
      schemaVersion: 1,
      id: capture.id,
      status: !capture.networkEnabled
        ? 'unavailable'
        : capture.partial || exceededMaxDuration
          ? 'partial'
          : 'complete',
      startedAtEpochMs: capture.startedAtEpochMs,
      endedAtEpochMs,
      maxDurationMs: capture.maxDurationMs,
      reconnects: capture.reconnects,
      droppedRequests: capture.droppedRequests,
      unavailableReasons: capture.networkEnabled ? [] : capture.enableErrors,
      coverageGapReasons: capture.networkEnabled ? capture.enableErrors : [],
      uninspectableBodyRequests: capture.uninspectableBodyRequests,
      projectedBodyFields: capture.bodyJsonFields,
      totalRequests: capture.requests.length,
      requestsByMethod: countsBy(capture.requests, (record) => record.method),
      requestsByHost: countsBy(capture.requests, (record) => record.host),
      requestsByType: countsBy(capture.requests, bodyType),
      requests: capture.requests,
    };
  }

  async function control(deviceId, action, params, timeoutMs = 10_000, socket) {
    if (action === 'list-targets') {
      return targetList({ readyOnly: true }).map(({ deviceId, name }) => ({
        deviceId,
        name,
      }));
    }
    if (action === 'list-target-identities') {
      return targetList({ readyOnly: true }).map(({ deviceId, generation, name }) => ({
        deviceId,
        generation,
        name,
      }));
    }
    if (action === 'resolve-targets') {
      return resolveTargets(params, timeoutMs, socket);
    }
    if (action === 'hud-update') {
      const step = params.step ?? null;
      if (step !== null && (typeof step !== 'object' || Array.isArray(step))) {
        throw new Error('HUD update requires an object step or null');
      }
      if (Buffer.byteLength(JSON.stringify(step)) > MAX_HUD_STEP_BYTES) {
        throw new Error('HUD update exceeds its bound');
      }
      const previousVersion = hudUpdates.get(deviceId)?.version || 0;
      if (hudUpdates.has(deviceId)) {
        hudUpdates.delete(deviceId);
      }
      while (hudUpdates.size >= MAX_HUD_UPDATES) {
        const oldestDeviceId = hudUpdates.keys().next().value;
        hudUpdates.delete(oldestDeviceId);
        appliedHudVersions.delete(oldestDeviceId);
      }
      const version = previousVersion + 1;
      hudUpdates.set(deviceId, { step, version });
      requestDiscovery?.(deviceId);
      void scheduleHudUpdate(deviceId, 10_000).catch(() => undefined);
      return { status: 'queued', version };
    }
    if (action === 'capture-start') {
      const capture = normalizeCapture(params);
      const deviceCaptures = capturesFor(deviceId);
      if (deviceCaptures.size >= MAX_ACTIVE_CAPTURES) {
        throw new Error('Too many active Network captures');
      }
      if (deviceCaptures.has(capture.id)) {
        throw new Error(`Network capture already active: ${capture.id}`);
      }
      completedCapturesFor(deviceId).delete(capture.id);
      deviceCaptures.set(capture.id, capture);
      await enableNetwork(deviceId, capture, Math.max(1, timeoutMs - 500), socket);
      return { id: capture.id, status: 'started' };
    }
    if (action === 'capture-end') {
      const id = String(params.id || '').trim();
      const deviceCaptures = capturesFor(deviceId);
      const completed = completedCapturesFor(deviceId);
      const capture = deviceCaptures.get(id) || completed.get(id);
      if (!capture) throw new Error(`Network capture not active: ${id}`);
      if (deviceCaptures.has(id)) finishCapture(deviceId, capture);
      completed.delete(id);
      return captureSummary(capture);
    }
    throw new Error(`Unknown CDP broker control: ${action}`);
  }

  function writeMessage(socket, message) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  }

  async function handleRequest(socket, request) {
    try {
      onClientActivity?.();
      if (request.type === 'command') {
        const budgetMs = boundedTimeout(request.timeoutMs);
        const deadline = Date.now() + budgetMs;
        const session = await waitForSession(request.deviceId, budgetMs, socket);
        const result = await sendCommand(
          session,
          request.method,
          request.params || {},
          Math.max(1, deadline - Date.now()),
        );
        writeMessage(socket, { id: request.id, result });
        return;
      }
      if (request.type === 'control') {
        const result = await control(
          request.deviceId,
          request.action,
          request.params || {},
          boundedTimeout(request.timeoutMs),
          socket,
        );
        writeMessage(socket, { id: request.id, result });
        return;
      }
      if (request.type === 'subscribe') {
        const entries = subscriptions.get(socket) || new Set();
        entries.add(`${request.deviceId}\u0000${request.method}`);
        subscriptions.set(socket, entries);
        writeMessage(socket, { id: request.id, result: {} });
        return;
      }
      if (request.type === 'unsubscribe') {
        subscriptions.get(socket)?.delete(`${request.deviceId}\u0000${request.method}`);
        writeMessage(socket, { id: request.id, result: {} });
        return;
      }
      throw new Error('Unknown CDP broker request');
    } catch (error) {
      writeMessage(socket, {
        id: request.id,
        error: String(error.message || error),
      });
    }
  }

  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  const ownership = claimBrokerSocket(socketPath);
  const expirySweep = setInterval(() => {
    const now = Date.now();
    for (const [deviceId, deviceCaptures] of captures) {
      for (const capture of deviceCaptures.values()) {
        if (now - capture.startedAtEpochMs >= capture.maxDurationMs) {
          expireCapture(deviceId, capture);
        }
      }
    }
  }, 100);
  const server = net.createServer((socket) => {
    clients.add(socket);
    subscriptions.set(socket, new Set());
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_FRAME_BYTES) {
        writeMessage(socket, { error: 'CDP broker request exceeds its bound' });
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line);
          if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new Error('Invalid CDP broker request');
          }
          void handleRequest(socket, request);
        } catch {
          writeMessage(socket, { error: 'Invalid CDP broker request' });
        }
      }
    });
    const drop = () => {
      clients.delete(socket);
      subscriptions.delete(socket);
      for (const waiter of [...targetWaiters]) {
        if (waiter.socket !== socket) continue;
        targetWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CDP broker client closed'));
      }
      for (const [deviceId, waiters] of sessionWaiters) {
        for (const waiter of [...waiters]) {
          if (waiter.socket !== socket) continue;
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.reject(new Error('CDP broker client closed'));
        }
        if (waiters.size === 0) sessionWaiters.delete(deviceId);
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });
  server.on('error', (error) => {
    releaseBrokerSocket(socketPath, ownership);
    process.stderr.write(`cdp-broker: ${boundedError(error)}\n`);
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));

  return {
    onSessionOpen(deviceId) {
      const session = sessions.get(deviceId);
      if (!session?.brokerReady) return;
      const previous = knownTargets.get(deviceId);
      const name = String(session.name || previous?.name || '');
      for (const [otherDeviceId, target] of knownTargets) {
        if (
          otherDeviceId !== deviceId &&
          name &&
          target.name === name &&
          target.ready &&
          !sessions.get(otherDeviceId)?.brokerReady
        ) {
          knownTargets.set(otherDeviceId, { ...target, ready: false });
        }
      }
      const sessionChanged = observedSessions.get(deviceId) !== session;
      knownTargets.set(deviceId, {
        deviceId,
        generation:
          previous?.generation === undefined
            ? 1
            : previous.generation + (!previous.ready || sessionChanged ? 1 : 0),
        name,
        ready: true,
      });
      observedSessions.set(deviceId, session);
      const waiters = sessionWaiters.get(deviceId);
      if (waiters) {
        sessionWaiters.delete(deviceId);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(session);
        }
      }
      settleTargetWaiters();
      for (const capture of capturesFor(deviceId).values()) {
        if (capture.reconnects > 0) capture.partial = true;
        void enableNetwork(deviceId, capture);
      }
      void scheduleHudUpdate(deviceId, 10_000).catch(() => undefined);
    },
    onSessionClose(deviceId) {
      const previous = knownTargets.get(deviceId);
      if (previous) knownTargets.set(deviceId, { ...previous, ready: false });
      observedSessions.delete(deviceId);
      appliedHudVersions.delete(deviceId);
      for (const capture of capturesFor(deviceId).values()) {
        capture.reconnects += 1;
        capture.partial = true;
      }
    },
    onCdpEvent(deviceId, method, params) {
      if (method === 'Runtime.executionContextsCleared') {
        const target = knownTargets.get(deviceId);
        if (target) knownTargets.set(deviceId, { ...target, generation: target.generation + 1 });
      }
      for (const socket of clients) {
        if (subscriptions.get(socket)?.has(`${deviceId}\u0000${method}`)) {
          writeMessage(socket, { type: 'event', deviceId, method, params });
        }
      }
      if (method !== 'Network.requestWillBeSent') return;
      const now = Date.now();
      for (const capture of capturesFor(deviceId).values()) {
        const sanitized = sanitizeNetworkRequest(params.request || {}, capture, now);
        if (!sanitized) continue;
        const { record } = sanitized;
        if (!sanitized.bodyInspectable) {
          capture.uninspectableBodyRequests += 1;
          capture.partial = true;
        }
        if (now - capture.startedAtEpochMs > capture.maxDurationMs) {
          capture.droppedRequests += 1;
          expireCapture(deviceId, capture);
          continue;
        }
        if (capture.requests.length >= capture.maxRequests) {
          capture.droppedRequests += 1;
          capture.partial = true;
          continue;
        }
        const recordBytes = Buffer.byteLength(JSON.stringify(record));
        if (capture.retainedBytes + recordBytes > MAX_CAPTURE_BYTES) {
          capture.droppedRequests += 1;
          capture.partial = true;
          continue;
        }
        capture.retainedBytes += recordBytes;
        capture.requests.push(record);
      }
    },
    close() {
      clearInterval(expirySweep);
      for (const waiters of sessionWaiters.values()) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('CDP broker closed'));
        }
      }
      sessionWaiters.clear();
      for (const waiter of targetWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('CDP broker closed'));
      }
      targetWaiters.clear();
      for (const socket of clients) socket.destroy();
      server.close();
      releaseBrokerSocket(socketPath, ownership);
    },
  };
}

function createBrokerClient(socketPath, deviceId, timeout) {
  return new Promise((resolve, reject) => {
    const clientTimeout = boundedTimeout(timeout);
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let nextId = 0;
    let buffer = '';
    const pending = new Map();
    const eventHandlers = new Map();
    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error('CDP broker connection timeout'));
    }, clientTimeout);

    const request = (type, value, requestTimeout = clientTimeout) =>
      new Promise((requestResolve, requestReject) => {
        const timeoutMs = boundedTimeout(requestTimeout, clientTimeout);
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          requestReject(new Error('CDP broker request timeout'));
        }, timeoutMs);
        pending.set(id, {
          resolve: (result) => {
            clearTimeout(timer);
            requestResolve(result);
          },
          reject: (error) => {
            clearTimeout(timer);
            requestReject(error);
          },
        });
        socket.write(`${JSON.stringify({ id, deviceId, timeoutMs, type, ...value })}\n`);
      });

    socket.on('connect', () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}, requestTimeout = clientTimeout) {
          return request('command', { method, params }, requestTimeout);
        },
        control(action, params = {}, requestTimeout = clientTimeout) {
          return request('control', { action, params }, requestTimeout);
        },
        on(method, handler) {
          const handlers = eventHandlers.get(method) || new Set();
          handlers.add(handler);
          eventHandlers.set(method, handlers);
          void request('subscribe', { method });
          return () => {
            handlers.delete(handler);
            if (handlers.size === 0) {
              eventHandlers.delete(method);
              void request('unsubscribe', { method }).catch(() => undefined);
            }
          };
        },
        close() {
          socket.destroy();
        },
      });
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_FRAME_BYTES) {
        socket.destroy();
        for (const entry of pending.values()) {
          entry.reject(new Error('CDP broker response exceeds its bound'));
        }
        pending.clear();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error));
          else entry.resolve(message.result);
          continue;
        }
        if (message.type !== 'event') continue;
        for (const handler of eventHandlers.get(message.method) || []) {
          handler(message.params || {});
        }
      }
    });
    socket.on('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    socket.on('close', () => {
      for (const entry of pending.values()) {
        entry.reject(new Error('CDP broker closed'));
      }
      pending.clear();
      eventHandlers.clear();
    });
  });
}

module.exports = {
  brokerSocketPath,
  createBrokerClient,
  createCdpBroker,
  deviceIdFromUrl,
};
