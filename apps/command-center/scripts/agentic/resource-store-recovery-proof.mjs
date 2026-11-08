import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const source = process.env.FARMSLOT_PROOF_SOURCE_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
assert(origin && source && endpoint && output && browserModule);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const before = process.argv.includes('--expect-stuck');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const errors = [];
let stopRouting;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await mkdir(output, { recursive: true });
async function until(read) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Browser recovery proof deadline');
}
try {
  if (process.env.FARMSLOT_PROOF_TOUCH === '1')
    await page.setViewportSize({ width: 390, height: 844 });
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
  await page.addInitScript(() => {
    // Fail one real store I/O request at the worker boundary. Never inject UI/cache state.
    const WorkerClass = window.Worker;
    const result = { injected: false, successfulWrites: 0 };
    window.__resourceStoreProof = result;
    window.Worker = class extends WorkerClass {
      constructor(url, options) {
        super(url, options);
        this.storage = String(url).includes('browser-worker');
        this.writes = new Set();
        this.addEventListener('message', ({ data }) => {
          if (this.writes.delete(data.id) && data.ok) result.successfulWrites++;
        });
      }
      postMessage(request, ...args) {
        if (this.storage && ['putQuery', 'mergeRows'].includes(request.operation)) {
          if (!result.injected) {
            result.injected = true;
            queueMicrotask(() =>
              this.dispatchEvent(
                new MessageEvent('message', {
                  data: { id: request.id, ok: false, message: 'Proof: temporary store I/O error' },
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
  await page.goto(`${origin}/#fleet`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('farm-resource-store-notice', { state: 'attached', timeout: 120_000 });
  await until(() => page.evaluate(() => window.__resourceStoreProof?.injected));
  const read = () =>
    page.evaluate(async () => {
      const api = await import('/src/resource-cache.ts');
      const notice = document.querySelector('farm-resource-store-notice');
      const panel = notice?.shadowRoot?.querySelector('[role=status]');
      const nav = document.body.getBoundingClientRect();
      return {
        notice: api.getResourceStoreNotice() ?? null,
        rendered: panel?.textContent.trim() ?? null,
        noticeFits: !panel || panel.getBoundingClientRect().right <= innerWidth,
        diagnostics: await notice?.resourceStoreDiagnostics(),
        writes: window.__resourceStoreProof.successfulWrites,
        appBounds: nav ? { x: nav.x, y: nav.y, width: nav.width, height: nav.height } : null,
      };
    });
  await until(() =>
    page.evaluate(async () =>
      (await import('/src/resource-cache.ts')).getResourceStoreNotice()?.includes('Proof:'),
    ),
  );
  const failed = await read();
  await page.screenshot({ path: path.join(output, 'failure.png') });
  assert.equal(failed.diagnostics.storage, 'opfs-sahpool');
  assert.equal(failed.diagnostics.integrity, 'ok');
  // Exercise the shipped client reconnect; no gateway or node is stopped for this proof.
  await page.evaluate(async () => (await import('/src/gateway-client.ts')).gateway.reconnect());
  await until(() =>
    page.evaluate(
      async () => (await import('/src/gateway-client.ts')).gateway.connectionState === 'connected',
    ),
  );
  if (!before) {
    await until(() =>
      page.evaluate(
        async () =>
          !(await import('/src/resource-cache.ts')).getResourceStoreNotice() &&
          window.__resourceStoreProof.successfulWrites > 0,
      ),
    );
  }
  const reconnected = await read();
  await page.screenshot({ path: path.join(output, 'reconnected.png') });
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        before,
        failed,
        reconnected,
        consoleErrors: errors,
      },
      null,
      2,
    ),
  );
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.deepEqual(reconnected.appBounds, failed.appBounds, 'Storage status moved the app');
  if (before) {
    assert.notEqual(failed.rendered, failed.notice);
    assert.equal(reconnected.notice, failed.notice);
  } else {
    assert.equal(failed.rendered, failed.notice);
    assert(failed.noticeFits, 'The failure reason extends outside the viewport');
    assert.equal(reconnected.notice, null);
    assert.equal(reconnected.rendered, null);
    assert(reconnected.writes > 0, 'The recovered cache never wrote to OPFS');
  }
} catch (error) {
  await writeFile(
    path.join(output, 'failed-proof.json'),
    JSON.stringify(
      {
        message: error.message,
        consoleErrors: errors,
        state: await page.evaluate(async () => ({
          text: document.body.innerText.slice(-400),
          fault: window.__resourceStoreProof,
          diagnostics: await document
            .querySelector('farm-resource-store-notice')
            ?.resourceStoreDiagnostics(),
          notice: (await import('/src/resource-cache.ts')).getResourceStoreNotice() ?? null,
        })),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await stopRouting?.();
  await page.close();
  await browser.close();
}
