// Minimal browser-level Chrome DevTools Protocol client with flattened target
// sessions, for the long-running web-dapp wallet host. Page-level UI actions use
// @farmslot/recipe-runner/runtime/cdp instead.

import WebSocket from 'ws';

export async function browserWebSocketUrl(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `CDP on 127.0.0.1:${port} did not answer within ${timeoutMs}ms: ${lastError?.message ?? 'no response'}`,
  );
}

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const client = new CdpClient();
    client.#ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      client.#ws.once('open', resolve);
      client.#ws.once('error', reject);
    });
    client.#ws.on('message', (data) => client.#dispatch(JSON.parse(String(data))));
    client.#ws.on('close', () => {
      for (const { reject } of client.#pending.values()) reject(new Error('CDP connection closed'));
      client.#pending.clear();
      client.#emit('close', {}, undefined);
    });
    return client;
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    this.#emit(message.method, message.params ?? {}, message.sessionId);
  }

  #emit(method, params, sessionId) {
    for (const handler of this.#handlers.get(method) ?? []) {
      try {
        handler(params, sessionId);
      } catch (error) {
        process.stderr.write(`[cdp] handler for ${method} failed: ${error?.stack ?? error}\n`);
      }
    }
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, new Set());
    this.#handlers.get(method).add(handler);
    return () => this.#handlers.get(method)?.delete(handler);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.#nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  close() {
    this.#ws?.close();
  }
}
