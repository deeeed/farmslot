// network-observer.cjs — network capture for a browser extension: attach to
// every target of the loaded extension (page, background, service worker) on
// one browser CDP connection, follow targets as they come and go, and feed
// their Network events to a recipe-runner CDP broker that owns the captures.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  brokerSocketPath,
  createBrokerClient,
  createCdpBroker,
} = require('@farmslot/recipe-runner/cdp-broker');

const {
  asBrowserCdpTarget,
  connectBrowserCdp,
  extensionIdFromCdpTargets,
} = require('./browser-cdp.cjs');

const DEVICE_ID = 'extension';
const DEFAULT_TIMEOUT_MS = 10000;
const EXTENSION_TARGET_TYPES = new Set(['background_page', 'other', 'page', 'service_worker']);

const asRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/**
 * @param {{ cdpPort: number, runtimeDir: string, extensionId?: string, connectTimeoutMs?: number, commandTimeoutMs?: number }} options
 *   `runtimeDir` keys the broker socket; the timeouts bound the CDP connection
 *   and every command, broker call and capture control. `extensionId` names the
 *   extension to capture; without it, the first extension with a target is
 *   used, which can be a component or policy extension in a branded Chrome.
 * @returns {Promise<import('@farmslot/adapter-sdk').NetworkCaptureBackend>}
 */
async function createExtensionNetworkObserver({
  cdpPort,
  runtimeDir,
  extensionId: requestedExtensionId,
  connectTimeoutMs = DEFAULT_TIMEOUT_MS,
  commandTimeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!Number.isInteger(cdpPort) || cdpPort <= 0) {
    throw new Error('Extension network observation requires a valid CDP port.');
  }

  const connection = await connectBrowserCdp(cdpPort, {
    timeoutMs: connectTimeoutMs,
    commandTimeoutMs,
  });

  let closed = false;
  let extensionId = null;
  let broker = null;
  const targetSessions = new Map();
  const attaching = new Set();

  const send = (method, params = {}, sessionId, timeoutMs = commandTimeoutMs) =>
    connection.send(method, params, sessionId, timeoutMs);

  const relevantTarget = (target) => {
    if (!extensionId || !EXTENSION_TARGET_TYPES.has(target.type)) return false;
    try {
      return new URL(target.url).hostname === extensionId;
    } catch {
      return false;
    }
  };

  const refreshBrokerSession = () => {
    if (!broker) return;
    broker.onSessionClose(DEVICE_ID);
    broker.onSessionOpen(DEVICE_ID);
  };

  const attachTarget = async (target) => {
    if (
      closed ||
      !relevantTarget(target) ||
      targetSessions.has(target.targetId) ||
      attaching.has(target.targetId)
    ) {
      return;
    }
    attaching.add(target.targetId);
    try {
      const result = asRecord(
        await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }),
      );
      const sessionId = String(result.sessionId ?? '');
      if (sessionId) {
        targetSessions.set(target.targetId, sessionId);
        refreshBrokerSession();
      }
    } catch (error) {
      if (!/already attached/iu.test(String(error))) broker?.onSessionClose(DEVICE_ID);
    } finally {
      attaching.delete(target.targetId);
    }
  };

  connection.onEvent(({ method, params, sessionId }) => {
    if (method === 'Target.targetCreated') {
      const target = asBrowserCdpTarget(params.targetInfo);
      if (target) void attachTarget(target);
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const target = asBrowserCdpTarget(params.targetInfo);
      const attachedSessionId = String(params.sessionId ?? '');
      if (target && attachedSessionId && relevantTarget(target)) {
        targetSessions.set(target.targetId, attachedSessionId);
        refreshBrokerSession();
      }
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = String(params.sessionId ?? '');
      for (const [targetId, activeSessionId] of targetSessions) {
        if (activeSessionId !== detachedSessionId) continue;
        targetSessions.delete(targetId);
        refreshBrokerSession();
      }
      return;
    }
    if (sessionId && method.startsWith('Network.')) {
      broker?.onCdpEvent(DEVICE_ID, method, params);
    }
  });

  connection.onClose(() => {
    if (!closed) broker?.onSessionClose(DEVICE_ID);
  });

  await send('Target.setDiscoverTargets', { discover: true });
  const targetInfos = asRecord(await send('Target.getTargets')).targetInfos;
  const targets = Array.isArray(targetInfos) ? targetInfos : [];
  extensionId = requestedExtensionId || extensionIdFromCdpTargets(targets);
  if (!extensionId) {
    connection.close();
    throw new Error('Extension CDP browser or loaded extension target is unavailable.');
  }
  await Promise.all(targets.map(asBrowserCdpTarget).filter(Boolean).map(attachTarget));
  if (targetSessions.size === 0) {
    connection.close();
    throw new Error('Extension CDP exposes no attachable extension targets.');
  }

  const sessions = new Map([[DEVICE_ID, { brokerReady: true }]]);
  const socketPath = brokerSocketPath(path.join(runtimeDir, 'extension-network'));
  broker = createCdpBroker({
    socketPath,
    sessions,
    async sendCommand(_session, method, params, timeoutMs) {
      const sessionIds = [...new Set(targetSessions.values())];
      if (sessionIds.length === 0) {
        throw new Error('Extension CDP has no active extension target sessions.');
      }
      const results = await Promise.allSettled(
        sessionIds.map((sessionId) => send(method, params, sessionId, timeoutMs)),
      );
      const successes = results.filter((result) => result.status === 'fulfilled');
      if (successes.length === 0) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        throw new Error(
          `Extension CDP command failed on every target: ${String(firstFailure?.reason ?? method)}`,
        );
      }
      if (successes.length !== results.length) {
        results.forEach((result, index) => {
          if (result.status === 'fulfilled') return;
          const failedSession = sessionIds[index];
          for (const [targetId, sessionId] of targetSessions) {
            if (sessionId === failedSession) targetSessions.delete(targetId);
          }
        });
        broker?.onSessionClose(DEVICE_ID);
      }
      return successes[0].value;
    },
    requestDiscovery() {
      void send('Target.getTargets')
        .then((result) => {
          const infos = asRecord(result).targetInfos;
          if (!Array.isArray(infos)) return;
          for (const value of infos) {
            const target = asBrowserCdpTarget(value);
            if (target) void attachTarget(target);
          }
        })
        .catch(() => broker?.onSessionClose(DEVICE_ID));
    },
  });
  broker.onSessionOpen(DEVICE_ID);
  await waitForSocket(socketPath, commandTimeoutMs);
  const client = await createBrokerClient(socketPath, DEVICE_ID, commandTimeoutMs);

  return {
    start(params) {
      return client.control('capture-start', params, commandTimeoutMs);
    },
    async end(id) {
      return asRecord(await client.control('capture-end', { id }, commandTimeoutMs));
    },
    async close() {
      closed = true;
      client.close();
      broker?.close();
      connection.close();
    },
  };
}

async function waitForSocket(socketPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Extension network observer broker did not start.');
}

module.exports = { createExtensionNetworkObserver };
