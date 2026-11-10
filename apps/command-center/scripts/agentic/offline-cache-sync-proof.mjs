import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const source = process.env.FARMSLOT_PROOF_SOURCE_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(origin && source && endpoint && output && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const cacheModule = `/@fs${fileURLToPath(new URL('../../../../packages/protocol/src/client-cache/index.ts', import.meta.url))}`;
const errors = [];
let stopRouting;
let offline = false;
const sockets = new Map();
page.on('response', (response) => {
  if (response.status() >= 400)
    errors.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`);
});
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await mkdir(output, { recursive: true });
async function until(read) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Offline-cache browser proof deadline');
}
async function receipt() {
  return page.evaluate(async (cacheModule) => {
    const { resourceQuery, nativeObservationQuery } = await import(cacheModule);
    const { getState, runHistoryQuery } = await import('/src/state.ts');
    const { getResourceCache, getResourceNativeOwnerId } = await import('/src/resource-cache.ts');
    const { gateway } = await import('/src/gateway-client.ts');
    const notice = document.querySelector('farm-resource-store-notice');
    const state = getResourceCache()?.read(runHistoryQuery);
    const route = location.hash.split('?')[0];
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const owner = getResourceNativeOwnerId();
    const primary =
      route === '#native' && owner
        ? ['native.session.list', 'native.session.catalog'].map((method) =>
            nativeObservationQuery(method, {}, owner),
          )
        : route === '#runs/compare'
          ? [params.get('a'), params.get('b')].map((runId) => resourceQuery('run.get', { runId }))
          : [runHistoryQuery];
    return {
      route,
      primary: primary.map((query) => ({
        method: query.method,
        status: getResourceCache()?.read(query).status,
      })),
      connection: gateway.connectionState,
      sync: notice?.shadowRoot
        ?.querySelector('[data-testid=resource-sync-status]')
        ?.textContent.trim(),
      storeNotice:
        notice?.shadowRoot
          ?.querySelector('[data-testid=resource-store-notice]')
          ?.textContent.trim() ?? null,
      runsStatus: state?.status,
      runIds: state?.data?.runs.map((run) => run.id).sort(),
      observedAt: state?.observedAt,
      visibleRunIds: getState()
        .runs.map((run) => run.id)
        .sort(),
      fault: window.__offlineProof,
    };
  }, cacheModule);
}
try {
  // Source-only proxy keeps the existing agent-owned login on its original origin.
  // Gateway requests and authentication stay on that origin, without credential reads.
  const proxy = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname.startsWith('/api/') || url.pathname === '/ws')
      return route.continue();
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'const styles=new Map();export const createHotContext=()=>({on(){},accept(){},prune(){},dispose(){},data:{}});export const injectQuery=(url)=>url;export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement("style");document.head.append(s);styles.set(id,s)}s.textContent=css}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id)}',
      });
    const response = await fetch(new URL(url.pathname + url.search, source));
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key),
        ),
      ),
      body: Buffer.from(await response.arrayBuffer()),
    });
  };
  await page.route(`${origin}/**`, proxy);
  await browser.contexts()[0].route(`${origin}/@fs/**`, proxy);
  stopRouting = () => browser.contexts()[0].unroute(`${origin}/@fs/**`, proxy);
  await page.routeWebSocket('**/ws', (route) => {
    if (offline) {
      route.close();
      return;
    }
    const server = route.connectToServer();
    sockets.set(route, server);
    server.onClose((code, reason) => {
      sockets.delete(route);
      route.close({ code, reason });
    });
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const proof = { injected: false, workers: 0, successfulWrites: 0, connections: [] };
    window.__offlineProof = proof;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.storage = String(url).includes('browser-worker');
        this.writes = new Set();
        if (this.storage) proof.workers++;
        this.addEventListener('message', ({ data }) => {
          if (this.writes.delete(data.id) && data.ok) proof.successfulWrites++;
        });
      }
      postMessage(request, ...args) {
        if (this.storage && ['putQuery', 'mergeRows'].includes(request.operation)) {
          if (!proof.injected) {
            proof.injected = true;
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: {
                    id: request.id,
                    ok: false,
                    fatal: true,
                    resultCode: 10,
                    message: 'Proof: SQLITE_IOERR',
                  },
                }),
              ),
            );
            return;
          }
          this.writes.add(request.id);
        }
        super.postMessage(request, ...args);
      }
    };
  });
  await page.bringToFront();
  await page.goto(`${origin}/#runs?tab=all`, { waitUntil: 'domcontentloaded' });
  const recovered = await until(async () => {
    const state = await receipt();
    return (
      state.connection === 'connected' &&
      state.fault?.injected &&
      state.fault.successfulWrites > 0 &&
      !state.storeNotice &&
      state.runsStatus === 'ready' &&
      state.sync === 'Synced' &&
      state
    );
  });
  assert.equal(recovered.fault.workers, 2, 'Persistence recovery reused the failed worker');
  await page.screenshot({ path: path.join(output, 'recovered.png') });
  offline = true;
  // Drop the server side only: the proxy must forward the transport close to the client.
  for (const server of sockets.values()) server.close({ code: 1001, reason: 'Offline proof' });
  const cached = await until(async () => {
    const state = await receipt();
    return state.connection !== 'connected' && state.sync?.startsWith('Cached from ') && state;
  });
  assert.deepEqual(cached.runIds, recovered.runIds, 'Disconnect lost held runs');
  assert.equal(cached.runsStatus, 'stale');
  await page.screenshot({ path: path.join(output, 'cached.png') });
  offline = false;
  await page.evaluate(async () => (await import('/src/gateway-client.ts')).gateway.reconnect());
  const reconnected = await until(async () => {
    const state = await receipt();
    return (
      state.connection === 'connected' &&
      state.runsStatus === 'ready' &&
      state.sync === 'Synced' &&
      state.observedAt > cached.observedAt &&
      state
    );
  });
  const current = await page.evaluate(async () => {
    const { gateway } = await import('/src/gateway-client.ts');
    const { runHistoryQuery } = await import('/src/state.ts');
    const { getResourceCache } = await import('/src/resource-cache.ts');
    const fresh = await getResourceCache().retryAfterPending(runHistoryQuery);
    const live = await gateway.request('run.list', { versions: true }, { timeout: 120000 });
    return {
      cachedIds: fresh.data.runs.map((run) => run.id).sort(),
      gatewayIds: live.versions.map((run) => run.id).sort(),
    };
  });
  assert.deepEqual(
    current.cachedIds,
    current.gatewayIds,
    'Resync retained a run absent from the gateway',
  );
  // Refresh has a new worker fault fixture and must independently recover and verify the gateway.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const refreshed = await until(async () => {
    const state = await receipt();
    return (
      state.connection === 'connected' &&
      state.runsStatus === 'ready' &&
      state.sync === 'Synced' &&
      state.fault.successfulWrites > 0 &&
      !state.storeNotice &&
      state
    );
  });
  await page.screenshot({ path: path.join(output, 'refreshed.png') });
  await page.evaluate(() => {
    location.hash = '#native';
  });
  const native = await until(async () => {
    const state = await receipt();
    return (
      state.sync === 'Synced' && state.primary.every((read) => read.status === 'ready') && state
    );
  });
  await page
    .locator('farm-resource-store-notice')
    .screenshot({ path: path.join(output, 'native-synced.png') });
  offline = true;
  for (const [client, server] of sockets) {
    client.close({ code: 1001, reason: 'Offline native proof' });
    server.close({ code: 1001, reason: 'Offline native proof' });
  }
  const nativeCached = await until(async () => {
    const state = await receipt();
    return state.connection !== 'connected' && state.sync?.startsWith('Cached from ') && state;
  });
  await page
    .locator('farm-resource-store-notice')
    .screenshot({ path: path.join(output, 'native-cached.png') });
  offline = false;
  await page.evaluate(async () => (await import('/src/gateway-client.ts')).gateway.reconnect());
  await until(async () => {
    const state = await receipt();
    return state.connection === 'connected' && state.sync === 'Synced';
  });
  assert(refreshed.runIds.length >= 2, 'Comparison proof requires two retained gateway runs');
  await page.evaluate(
    ([a, b]) => {
      location.hash = `#runs/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
    },
    refreshed.runIds.slice(0, 2),
  );
  const compare = await until(async () => {
    const state = await receipt();
    return (
      state.sync === 'Synced' && state.primary.every((read) => read.status === 'ready') && state
    );
  });
  await page
    .locator('farm-resource-store-notice')
    .screenshot({ path: path.join(output, 'compare-synced.png') });
  const result = {
    recovered,
    cached,
    reconnected,
    current,
    refreshed,
    native,
    nativeCached,
    compare,
    consoleErrors: errors,
  };

  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ message: error.message, errors, state: await receipt() }, null, 2),
  );
  throw error;
} finally {
  await stopRouting?.();
  await page.close();
  await browser.close();
}
