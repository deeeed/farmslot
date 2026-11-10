import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = process.env.FARMSLOT_PROOF_OUT;
const browserModule = process.env.FARMSLOT_PROOF_BROWSER_MODULE;
const origin = process.env.FARMSLOT_PROOF_UI_ORIGIN;
const endpoint = process.env.FARMSLOT_CDP_ENDPOINT;
assert(output && browserModule && origin && endpoint);
assert.equal(new URL(endpoint).hostname, '127.0.0.1');
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const pages = [];
const scope = {
  gatewayUrl: 'ws://shared-browser-store-proof.invalid/',
  principalId: `proof-${crypto.randomUUID()}`,
  principalGeneration: 0,
};
const moduleUrl =
  process.env.FARMSLOT_PROOF_STORE_MODULE ??
  `/@fs${fileURLToPath(new URL('../../../../packages/local-store/src/browser.ts', import.meta.url))}`;
await fs.mkdir(output, { recursive: true });
async function tab(principal = scope.principalId, databaseName, schemaVersion) {
  const page = await browser.contexts()[0].newPage();
  pages.push(page);
  await page.bringToFront();
  await page.goto(`${origin}/#fleet`, { waitUntil: 'domcontentloaded' });
  const handle = await page.evaluateHandle(
    async ({ moduleUrl, scope, databaseName, schemaVersion }) => {
      const api = await import(moduleUrl);
      const notices = [];
      const store = await api.createBrowserSqliteResourceStore({
        scope,
        databaseName,
        schemaVersion,
        onNotice: (notice) => notices.push(notice),
      });
      return { api, store, notices, scope };
    },
    { moduleUrl, scope: { ...scope, principalId: principal }, databaseName, schemaVersion },
  );
  return { page, handle };
}
const query = (id, value) => ({ id, data: { value }, observedAt: Date.now(), bytes: 32 });
try {
  if (process.env.FARMSLOT_PROOF_SCENARIO === 'vfs-io') {
    const page = await browser.contexts()[0].newPage();
    pages.push(page);
    await page.route(`${origin}/`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Isolated OPFS I/O recovery proof</p>' }),
    );
    await page.route('**/browser-worker.ts?*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      await route.fulfill({
        response,
        body: `
        let proofArmed = false;
        const proofWrite = FileSystemSyncAccessHandle.prototype.write;
        FileSystemSyncAccessHandle.prototype.write = function(...args) {
          if (proofArmed && args[1]?.at >= 4096) { proofArmed = false; throw new DOMException('Forced OPFS write failure', 'UnknownError'); }
          return proofWrite.apply(this, args);
        };
        self.addEventListener('message', ({data}) => { if (data.proofFailWrite) proofArmed = true; });
        ${source}`,
      });
    });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const result = { failures: [], injected: false, workers: 0, retired: 0 };
      window.__vfsProof = result;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          result.workers++;
          this.addEventListener('message', ({ data }) => {
            if (data.ok === false) result.failures.push(data);
          });
        }
        postMessage(request, ...args) {
          if (request.operation === 'putQuery' && !result.injected) {
            result.injected = true;
            return super.postMessage({ ...request, proofFailWrite: true }, ...args);
          }
          return super.postMessage(request, ...args);
        }
        terminate() {
          result.retired++;
          return super.terminate();
        }
      };
    });
    await page.bringToFront();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(
      async ({ moduleUrl, scope }) => {
        const api = await import(moduleUrl);
        const options = { scope, databaseName: '/offline-cache-io-proof.sqlite' };
        const first = await api.createBrowserSqliteResourceStore(options);
        if (!first.persistent) throw new Error('The I/O proof requires OPFS persistence');
        let failure;
        try {
          await first.putQuery({ id: 'proof', data: 'first', observedAt: 1, bytes: 5 });
        } catch (error) {
          failure = error.message;
        }
        await first.close();
        const second = await api.createBrowserSqliteResourceStore(options);
        await second.putQuery({ id: 'proof', data: 'recovered', observedAt: 2, bytes: 9 });
        const saved = await second.getQuery('proof');
        const diagnostics = await api.browserResourceStoreDiagnostics(options.databaseName);
        await second.deleteAll();
        await second.close();
        api.closeBrowserResourceStores();
        return { failure, saved, diagnostics, ...window.__vfsProof };
      },
      { moduleUrl, scope },
    );
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    assert.match(result.failure, /SQLITE_IOERR/);
    assert(result.failures.some((error) => error.resultCode % 256 === 10 && error.fatal));
    assert.equal(result.workers, 2);
    assert.equal(result.saved?.data, 'recovered');
    assert.equal(result.diagnostics.integrity, 'ok');
    console.log(JSON.stringify(result));
  } else if (process.env.FARMSLOT_PROOF_SCENARIO === 'schema-fence') {
    const databaseName = '/offline-cache-schema-proof.sqlite';
    const first = await tab(`${scope.principalId}-old`, databaseName, 73);
    await first.handle.evaluate(
      ({ store }, entry) => store.putQuery(entry),
      query('same-key', 'old'),
    );
    const second = await tab(`${scope.principalId}-new`, databaseName, 74);
    await second.handle.evaluate(
      ({ store }, entry) => store.putQuery(entry),
      query('same-key', 'foreign'),
    );
    try {
      const stale = await first.handle.evaluate(async ({ store }) => ({
        data: (await store.getQuery('same-key'))?.data,
        deleted: store.deleted,
      }));
      assert.equal(stale.data, undefined, 'An old OPFS handle must not read a replacement scope');
      assert.equal(stale.deleted, true);
      await first.handle.evaluate(({ store }) => store.deleteAll());
      const kept = await second.handle.evaluate(
        async ({ store }) => (await store.getQuery('same-key'))?.data,
      );
      assert.deepEqual(kept, { value: 'foreign' });
      const result = {
        status: 'PASS',
        scenario: 'schema-fence',
        isolatedDatabase: databaseName,
        moduleUrl,
      };
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result));
    } finally {
      await first.handle.evaluate(({ store }) => store.close());
      await second.handle.evaluate(async ({ store }) => {
        await store.deleteAll();
        await store.close();
      });
    }
  } else {
    throw new Error('Set FARMSLOT_PROOF_SCENARIO to schema-fence or vfs-io');
  }
} catch (error) {
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ message: error.message }, null, 2),
  );
  throw error;
} finally {
  for (const page of pages) if (!page.isClosed()) await page.close();
  await browser.close();
}
