/**
 * Dev-only Metro middleware: relays recipe bridge commands between the host
 * runner (farmslot-expo-recipe) and the in-app __FARMSLOT_RECIPE_BRIDGE__.
 */

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;

/** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
const hostWaiters = new Map();

/** @type {Array<{ id: string, command: string, nodeId: string, payload: Record<string, unknown> }>} */
const commandQueue = [];

/** @type {Array<{ res: import('http').ServerResponse, timer: NodeJS.Timeout }>} */
const pollWaiters = [];

let nextCommandId = 0;

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function flushPollWaiters() {
  while (pollWaiters.length > 0 && commandQueue.length > 0) {
    const waiter = pollWaiters.shift();
    if (!waiter) break;
    clearTimeout(waiter.timer);
    const command = commandQueue.shift();
    writeJson(waiter.res, 200, command);
  }
}

function rejectHostWaiter(id, error) {
  const waiter = hostWaiters.get(id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  hostWaiters.delete(id);
  waiter.reject(error);
}

function createMetroRecipeBridgeMiddleware() {
  return {
    handle(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;

      if (pathname === '/farmslot-recipe/command' && req.method === 'POST') {
        void handleHostCommand(req, res);
        return true;
      }
      if (pathname === '/farmslot-recipe/poll' && req.method === 'GET') {
        handleAppPoll(url, res);
        return true;
      }
      if (pathname === '/farmslot-recipe/result' && req.method === 'POST') {
        void handleAppResult(req, res);
        return true;
      }
      return false;
    },
  };
}

async function handleHostCommand(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    return;
  }

  const command = typeof body.command === 'string' ? body.command : '';
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId : 'unknown';
  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? body.payload
      : {};

  if (!command) {
    writeJson(res, 400, { ok: false, error: 'Missing bridge command.' });
    return;
  }

  const id = `cmd-${++nextCommandId}`;
  const timeoutMs =
    typeof body.timeout_ms === 'number' && Number.isFinite(body.timeout_ms)
      ? body.timeout_ms
      : DEFAULT_COMMAND_TIMEOUT_MS;

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        hostWaiters.delete(id);
        const index = commandQueue.findIndex((entry) => entry.id === id);
        if (index >= 0) commandQueue.splice(index, 1);
        reject(
          new Error(
            `Timed out waiting for companion recipe bridge (${timeoutMs}ms). Is EXPO_PUBLIC_FARMSLOT_RECIPE_BRIDGE=1 and the app connected to Metro?`,
          ),
        );
      }, timeoutMs);
      hostWaiters.set(id, { resolve, reject, timer });
      commandQueue.push({ id, command, nodeId, payload });
      flushPollWaiters();
    });
    writeJson(res, 200, result ?? { ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJson(res, 504, { ok: false, error: message });
  }
}

function handleAppPoll(url, res) {
  const timeoutMs = Number(url.searchParams.get('timeout') ?? DEFAULT_POLL_TIMEOUT_MS);
  const boundedTimeout = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1_000), 60_000)
    : DEFAULT_POLL_TIMEOUT_MS;

  if (commandQueue.length > 0) {
    const command = commandQueue.shift();
    writeJson(res, 200, command);
    return;
  }

  const timer = setTimeout(() => {
    const index = pollWaiters.findIndex((waiter) => waiter.res === res);
    if (index >= 0) pollWaiters.splice(index, 1);
    res.statusCode = 204;
    res.end();
  }, boundedTimeout);

  pollWaiters.push({ res, timer });
}

async function handleAppResult(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    writeJson(res, 400, { ok: false, error: 'Invalid JSON body.' });
    return;
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) {
    writeJson(res, 400, { ok: false, error: 'Missing command id.' });
    return;
  }

  const waiter = hostWaiters.get(id);
  if (!waiter) {
    writeJson(res, 404, { ok: false, error: `Unknown command id: ${id}` });
    return;
  }

  clearTimeout(waiter.timer);
  hostWaiters.delete(id);
  waiter.resolve(body.result ?? { ok: true });
  writeJson(res, 200, { ok: true });
}

module.exports = {
  createMetroRecipeBridgeMiddleware,
  rejectHostWaiter,
};
