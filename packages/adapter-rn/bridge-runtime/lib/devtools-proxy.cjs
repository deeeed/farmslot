'use strict';

const fs = require('node:fs');
const { WebSocket, WebSocketServer } = require('ws');

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const SESSION_TIMEOUT_MS = 10_000;
const EVENT_GATED_DOMAINS = new Set([
  'Debugger',
  'Log',
  'Network',
  'Page',
  'ReactNativeApplication',
  'Runtime',
]);

function createDevtoolsProxy({
  descriptorPath,
  sessions,
  sendCommand,
  requestDiscovery,
  allowedOrigins,
}) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new Error('DevTools proxy requires at least one allowed Origin');
  }
  let listeningPort = null;
  const clients = new Set();
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: MAX_FRAME_BYTES,
  });

  async function waitForSession(deviceId) {
    const ready = sessions.get(deviceId);
    if (ready?.brokerReady) return ready;
    requestDiscovery();
    const deadline = Date.now() + SESSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const session = sessions.get(deviceId);
      if (session?.brokerReady) return session;
    }
    throw new Error('Hermes runtime is unavailable or reloading; retry the command');
  }

  function writeDescriptor() {
    if (!listeningPort) return;
    fs.writeFileSync(
      descriptorPath,
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, port: listeningPort })}\n`,
      { mode: 0o600 },
    );
  }

  async function forward(client, message) {
    if (
      !message ||
      typeof message !== 'object' ||
      !Number.isInteger(message.id) ||
      typeof message.method !== 'string'
    ) {
      return;
    }
    if (message.method.endsWith('.disable')) {
      client.enabled.delete(message.method.replace(/\.disable$/u, '.enable'));
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify({ id: message.id, result: {} }));
      }
      return;
    }
    const isEnable = message.method.endsWith('.enable');
    if (isEnable) {
      client.enabled.set(message.method, message.params || {});
    }
    try {
      const session = await waitForSession(client.deviceId);
      const result = await sendCommand(
        session,
        message.method,
        message.params || {},
        SESSION_TIMEOUT_MS,
      );
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify({ id: message.id, result }));
      }
    } catch (error) {
      if (isEnable) client.enabled.delete(message.method);
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32000,
              message: String(error?.message || error).slice(0, 256),
            },
          }),
        );
      }
    }
  }

  server.on('connection', (socket, request) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const deviceId = url.searchParams.get('device');
    if (!deviceId || !allowedOrigins.includes(request.headers.origin)) {
      socket.close(1008, 'invalid DevTools proxy Origin or device');
      return;
    }
    for (const client of clients) {
      if (client.deviceId === deviceId) {
        client.socket.close(1000, 'replaced by a newer DevTools window');
      }
    }
    const client = { socket, deviceId, enabled: new Map() };
    clients.add(client);
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      void forward(client, message);
    });
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);
  });

  server.on('listening', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return;
    listeningPort = address.port;
    writeDescriptor();
  });

  return {
    onSessionOpen(deviceId, session) {
      for (const client of clients) {
        if (client.deviceId !== deviceId) continue;
        for (const [method, params] of client.enabled) {
          void sendCommand(session, method, params, SESSION_TIMEOUT_MS).catch(() => undefined);
        }
      }
    },
    onCdpEvent(deviceId, method, params) {
      const payload = JSON.stringify({ method, params });
      const domain = method.split('.', 1)[0];
      for (const client of clients) {
        if (
          client.deviceId === deviceId &&
          client.socket.readyState === WebSocket.OPEN &&
          (!EVENT_GATED_DOMAINS.has(domain) || client.enabled.has(`${domain}.enable`))
        ) {
          client.socket.send(payload);
        }
      }
    },
    close() {
      for (const client of clients) client.socket.close();
      server.close();
      fs.rmSync(descriptorPath, { force: true });
    },
  };
}

module.exports = { createDevtoolsProxy };
