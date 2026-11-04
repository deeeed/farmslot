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
const moduleUrl = `/@fs${fileURLToPath(new URL('../../../../packages/local-store/src/browser.ts', import.meta.url))}`;
await fs.mkdir(output, { recursive: true });
async function tab(principal = scope.principalId) {
  const page = await browser.contexts()[0].newPage();
  pages.push(page);
  await page.bringToFront();
  await page.goto(`${origin}/#fleet`, { waitUntil: 'domcontentloaded' });
  const handle = await page.evaluateHandle(
    async ({ moduleUrl, scope }) => {
      const api = await import(moduleUrl);
      const notices = [];
      const store = await api.createBrowserSqliteResourceStore({
        scope,
        onNotice: (notice) => notices.push(notice),
      });
      return { api, store, notices };
    },
    { moduleUrl, scope: { ...scope, principalId: principal } },
  );
  return { page, handle };
}
const query = (id, value) => ({ id, data: { value }, observedAt: Date.now(), bytes: 32 });
try {
  const first = await tab();
  await first.handle.evaluate(({ store }, entry) => store.putQuery(entry), query('from-first', 1));
  const second = await tab();
  assert.equal(await second.handle.evaluate(({ store }) => store.persistent), true);
  assert.deepEqual(await second.handle.evaluate(({ notices }) => notices), []);
  assert.equal(
    await second.handle.evaluate(
      async ({ store }) => (await store.getQuery('from-first'))?.data.value,
    ),
    1,
  );
  await second.handle.evaluate(
    ({ store }, entry) => store.putQuery(entry),
    query('from-second', 2),
  );
  assert.equal(
    await first.handle.evaluate(
      async ({ store }) => (await store.getQuery('from-second'))?.data.value,
    ),
    2,
  );

  const blob = await first.handle.evaluate(async ({ store }) => {
    const data = Uint8Array.from({ length: 65536 }, (_, index) => index % 251);
    const id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const key = { kind: 'blob', id };
    await store.putContent({
      ...key,
      data,
      bytes: data.byteLength,
      origin: 'prefetch',
      cohort: 'run',
      accessedAt: Date.now(),
    });
    await store.putContentAlias('shared-proof-blob', key);
    return { id, bytes: data.byteLength };
  });
  const sharedBlob = await second.handle.evaluate(async ({ store }) => {
    const content = await store.getContentByAlias('shared-proof-blob');
    return {
      id: content?.id,
      bytes: content?.data.byteLength,
      digest: content
        ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', content.data))]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        : null,
    };
  });
  assert.deepEqual(sharedBlob, { ...blob, digest: blob.id });

  const started = Date.now();
  await Promise.all(
    Array.from({ length: 12 }, (_, index) => {
      const { handle } = index % 2 ? first : second;
      return handle.evaluate(
        ({ store }, entry) => store.putQuery(entry),
        query(`parallel-${index}`, index),
      );
    }),
  );
  const parallelMs = Date.now() - started;
  assert.equal((await second.handle.evaluate(({ store }) => store.listQueries())).length, 14);

  const other = await tab(`${scope.principalId}-other`);
  assert.equal(await other.handle.evaluate(({ store }) => store.getQuery('from-first')), undefined);
  await other.handle.evaluate(({ store }, entry) => store.putQuery(entry), query('other-scope', 3));

  await second.handle.evaluate(({ store }) => store.close());
  await second.page.reload({ waitUntil: 'domcontentloaded' });
  const reloaded = await second.page.evaluateHandle(
    async ({ moduleUrl, scope }) => {
      const api = await import(moduleUrl);
      const notices = [];
      const store = await api.createBrowserSqliteResourceStore({
        scope,
        onNotice: (notice) => notices.push(notice),
      });
      return { api, store, notices };
    },
    { moduleUrl, scope },
  );
  assert.equal(
    await reloaded.evaluate(async ({ store }) => (await store.getQuery('from-second'))?.data.value),
    2,
  );
  assert.deepEqual(await reloaded.evaluate(({ notices }) => notices), []);
  assert.equal(
    await reloaded.evaluate(
      async ({ store }) => (await store.getContentByAlias('shared-proof-blob'))?.bytes,
    ),
    blob.bytes,
  );

  const interrupted = first.handle
    .evaluate(({ store }) =>
      Promise.all(
        Array.from({ length: 128 }, (_, index) =>
          store.putQuery({
            id: `closing-${index}`,
            data: { index },
            observedAt: Date.now(),
            bytes: 32,
          }),
        ),
      ),
    )
    .then(
      () => null,
      (error) => error,
    );
  await first.page.close();
  const closed = await interrupted;
  if (closed) assert.match(closed.message, /closed|destroyed/i);

  await reloaded.evaluate(
    ({ store }, entry) => store.putQuery(entry),
    query('after-first-closes', 4),
  );
  assert.equal(
    await reloaded.evaluate(async ({ store }) => (await store.getQuery('from-first'))?.data.value),
    1,
  );

  const third = await tab();
  await reloaded.evaluate(({ store }) => store.deleteAll());
  await third.handle.evaluate(async ({ store }) => {
    const deadline = Date.now() + 2000;
    while (!store.deleted) {
      if (Date.now() > deadline) throw new Error('Cross-tab deletion did not seal the old handle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  await third.handle.evaluate(({ store }, entry) => store.putQuery(entry), query('late-write', 5));
  const fresh = await tab();
  assert.deepEqual(await fresh.handle.evaluate(({ store }) => store.listQueries()), []);
  assert.equal(
    await fresh.handle.evaluate(({ store }) => store.getContentByAlias('shared-proof-blob')),
    undefined,
  );
  assert.deepEqual(await fresh.handle.evaluate(({ store }) => store.byteTotals()), {
    queries: 0,
    content: 0,
  });
  assert.equal(
    await other.handle.evaluate(
      async ({ store }) => (await store.getQuery('other-scope'))?.data.value,
    ),
    3,
  );
  const diagnostics = await fresh.handle.evaluate(({ api }) =>
    api.browserResourceStoreDiagnostics(),
  );
  assert.equal(diagnostics.storage, 'opfs-sahpool');
  assert.equal(diagnostics.integrity, 'ok');
  await other.handle.evaluate(({ store }) => store.deleteAll());
  await fresh.handle.evaluate(({ store }) => store.deleteAll());
  const conformanceModule = `/@fs${fileURLToPath(new URL('../../../../packages/protocol/src/client-cache/conformance.ts', import.meta.url))}`;
  const conformance = await fresh.handle.evaluate(async ({ api }, moduleUrl) => {
    const { runResourceStoreConformance } = await import(moduleUrl);
    return runResourceStoreConformance((scope) => api.createBrowserSqliteResourceStore({ scope }));
  }, conformanceModule);
  assert.equal(conformance.length, 22);
  const applicationTabs = [];
  if (process.env.FARMSLOT_PROOF_APP_ORIGIN) {
    for (let index = 0; index < 2; index++) {
      const page = await browser.contexts()[0].newPage();
      pages.push(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.bringToFront();
      await page.goto(`${process.env.FARMSLOT_PROOF_APP_ORIGIN}/#fleet`, {
        waitUntil: 'domcontentloaded',
      });
      const notice = page.locator('farm-resource-store-notice');
      await notice.waitFor({ state: 'attached' });
      const deadline = Date.now() + 45000;
      let observation;
      let ready = false;
      do {
        const connected = await page.evaluate(
          async () =>
            (await import('/src/gateway-client.ts')).gateway.connectionState === 'connected',
        );
        observation = await notice.evaluate(async (view) => ({
          diagnostics: await view.resourceStoreDiagnostics(),
          queries: (await view.resourceStoreQueryMetadata()).length,
        }));
        ready =
          connected &&
          observation.diagnostics.storage === 'opfs-sahpool' &&
          observation.queries > 0;
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
      } while (!ready && Date.now() < deadline);
      assert(ready, 'The existing QA session must connect with a durable cache');
      assert.equal(await page.locator('[data-testid="resource-store-notice"]').count(), 0);
      await page.screenshot({ path: path.join(output, `application-tab-${index + 1}.png`) });
      applicationTabs.push(observation);
    }
  }
  const result = {
    status: 'PASS',
    applicationTabs,
    sharedReadsAndWrites: true,
    binaryContent: blob.bytes,
    conformance,
    parallelWrites: 12,
    parallelMs,
    reloadPersists: true,
    firstTabClosePersists: true,
    scopedDeletion: true,
    isolation: true,
    notices: [],
    diagnostics,
  };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
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
