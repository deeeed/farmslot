'use strict';

const { BRIDGE_ERROR_CODES, coded } = require('./bridge-errors.cjs');
const WebSocket = require('ws');

function createInspectorWebSocket(wsUrl) {
  const origin = new URL(wsUrl).origin.replace(/^ws/, 'http');
  return new WebSocket(wsUrl, { origin });
}

/**
 * Minimal CDP client that supplies the debugger Origin required by Metro.
 */
function createWSClient(wsUrl, timeout) {
  return new Promise((resolve, reject) => {
    const ws = createInspectorWebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const eventHandlers = new Map();

    const timer = setTimeout(() => {
      ws.close();
      reject(
        coded(
          new Error(`CDP connection timeout after ${timeout}ms`),
          BRIDGE_ERROR_CODES.CDP_TIMEOUT,
        ),
      );
    }, timeout);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        /** Send a CDP command and wait for the response */
        send(method, params = {}, msgTimeout = timeout) {
          return new Promise((res, rej) => {
            const id = ++msgId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(
                coded(
                  new Error(`CDP message timeout after ${msgTimeout}ms for ${method}`),
                  BRIDGE_ERROR_CODES.CDP_TIMEOUT,
                ),
              );
            }, msgTimeout);
            pending.set(id, {
              resolve: (v) => {
                clearTimeout(timer);
                res(v);
              },
              reject: (e) => {
                clearTimeout(timer);
                rej(e);
              },
            });
            const msg = JSON.stringify({ id, method, params });
            ws.send(msg);
          });
        },
        on(method, handler) {
          const handlers = eventHandlers.get(method) || new Set();
          handlers.add(handler);
          eventHandlers.set(method, handlers);
          return () => {
            handlers.delete(handler);
            if (handlers.size === 0) eventHandlers.delete(method);
          };
        },
        close() {
          ws.close();
        },
      });
    };

    ws.onmessage = (evt) => {
      const data = typeof evt.data === 'string' ? evt.data : evt.data.toString();
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        // Non-JSON frame — ignore
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        } else {
          res(msg.result);
        }
        return;
      }
      if (!msg.method) return;
      for (const handler of eventHandlers.get(msg.method) || []) {
        handler(msg.params || {});
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      reject(
        coded(new Error(`WebSocket error: ${err.message || err}`), BRIDGE_ERROR_CODES.WS_CLOSED),
      );
    };

    ws.onclose = () => {
      clearTimeout(timer);
      for (const [, { reject: rej }] of pending) {
        rej(coded(new Error('WebSocket closed'), BRIDGE_ERROR_CODES.WS_CLOSED));
      }
      pending.clear();
      eventHandlers.clear();
    };
  });
}

module.exports = { createWSClient, createInspectorWebSocket };
