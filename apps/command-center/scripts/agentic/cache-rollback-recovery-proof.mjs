import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openLiveBrowserProof, until } from './live-browser-proof.mjs';

const baseline = process.argv.includes('--expect-masked');
const negativeReload = process.argv.includes('--negative-reload');
const artifactGapAccepted = process.argv.includes('--accept-artifact-gap');
const negativePartial = process.argv.includes('--negative-partial-outage');
const negativeLaterPage = process.argv.includes('--negative-later-page');
const laterPageOutage = process.argv.includes('--later-page-outage') || negativeLaterPage;
const partialOutage =
  process.argv.includes('--partial-outage') || negativePartial || laterPageOutage;
const faultMode = process.env.FARMSLOT_PROOF_FAULT ?? 'transaction-abort';
const proofDatabase = '/rollback-recovery-proof.sqlite';
assert(['transaction-abort', 'opfs-io'].includes(faultMode));
function transformSource({ url, body }) {
  if (laterPageOutage && url.pathname.endsWith('/client-cache/run-list-versions.ts')) {
    const requestBoundary = 'this.options.request({ ids: ask }, signal)';
    assert(body.toString().includes(requestBoundary), 'Paged request boundary changed');
    // Ask for real supported 50-ID pages; never trim or fabricate gateway replies.
    body = Buffer.from(
      body
        .toString()
        .replace(requestBoundary, 'this.options.request({ ids: ask.slice(0, 50) }, signal)'),
    );
  }
  if (negativeLaterPage && url.pathname.endsWith('/client-cache/cache.ts')) {
    const pageCommit = '() => writingStore.mergeRows(RUN_LIST_COLLECTION_ID, merge)';
    assert(body.toString().includes(pageCommit), 'Negative page-confirm boundary changed');
    body = Buffer.from(
      body
        .toString()
        .replace(
          pageCommit,
          'async () => { await writingStore.mergeRows(RUN_LIST_COLLECTION_ID, merge); if(current()) confirmPersistentWrite(writingStore, RUN_LIST_COLLECTION_ID); }',
        ),
    );
  }

  if (negativePartial && url.pathname.endsWith('/client-cache/cache.ts')) {
    const boundary = 'else await write();';
    assert(body.toString().includes(boundary), 'Negative cache boundary changed');
    body = Buffer.from(
      body.toString().replace(
        boundary,
        `${boundary}
      if(target === store && target.persistent && current()) recoveryAttempted=false;`,
      ),
    );
  }
  if (url.pathname.includes('/wasm-driver.ts') && faultMode === 'transaction-abort') {
    const original = 'database.exec({ sql, bind: params });';
    assert(body.toString().includes(original), 'Driver fault boundary changed');
    body = Buffer.from(
      body.toString().replace(
        original,
        `
        if(globalThis.__rollbackProofArmed && sql.includes('INSERT INTO resource_rows')) {
          globalThis.__rollbackProofArmed=false;
          database.exec("CREATE TEMP TRIGGER rollback_proof BEFORE INSERT ON resource_rows BEGIN SELECT RAISE(ROLLBACK, 'Proof: automatic transaction abort'); END");
          try { ${original} } finally { database.exec('DROP TRIGGER IF EXISTS rollback_proof'); }
          return;
        }
        ${original}`,
      ),
    );
  }
  if (url.pathname.includes('/browser-worker.ts')) {
    const lockBoundary = 'await pool.unpauseVfs();';
    assert(body.toString().includes(lockBoundary), 'Pool proof cleanup boundary changed');
    body = Buffer.from(
      body.toString().replace(
        lockBoundary,
        `${lockBoundary}
        if(request.proofCleanOwnedFiles) {
          for(const file of pool.getFileNames()) {
            if(file.startsWith('/rollback-recovery-proof-') || file === '/rollback-recovery-proof.sqlite') pool.unlink(file);
          }
        }
      `,
      ),
    );
    // Actual OPFS page I/O failure inside the production SQLite transaction.
    // The next worker is healthy. No request replies or UI/cache values are forged.
    assert(body.toString().includes('pool.pauseVfs();'), 'Pool proof teardown boundary changed');
    body = Buffer.from(
      body.toString().replace(
        'pool.pauseVfs();',
        `
        if(request.proofRemoveOwnedFiles) {
          const removed=[];
          for(const file of pool.getFileNames()) if(file === '/rollback-recovery-proof.sqlite') { pool.unlink(file); removed.push(file); }
          self.postMessage({proofCleanup:{removed,remaining:pool.getFileNames().filter(file=>file === '/rollback-recovery-proof.sqlite')}});
        }
        pool.pauseVfs();`,
      ),
    );
    body = Buffer.from(`
        let failPageWrite = false;
        self.addEventListener('message', ({data}) => { if(data.proofRollbackFault) { failPageWrite=true; globalThis.__rollbackProofArmed=true; } });
        const originalWrite = FileSystemSyncAccessHandle.prototype.write;
        FileSystemSyncAccessHandle.prototype.write = function(...args) {
          if(${JSON.stringify(faultMode)} === 'opfs-io' && failPageWrite && args[1]?.at >= 4096) { failPageWrite=false; throw new DOMException('Rollback proof: OPFS page write failed','UnknownError'); }
          return originalWrite.apply(this,args);
        };
        ${body.toString()}`);
  }
  return body;
}
const { page, origin, output, errors, pageErrors, failedResponses, close } =
  await openLiveBrowserProof({
    transformSource,
  });
let completedProof;
let teardown;
let firstIdentity;
const subsequentNavigations = [];
await page.exposeBinding('__recordRollbackIdentity', ({ frame }, identity) => {
  assert.equal(frame, page.mainFrame());
  assert.equal(typeof identity.timeOrigin, 'number');
  assert.equal(typeof identity.connectionId, 'number');
  firstIdentity ??= Object.freeze({ ...identity });
});
page.on('framenavigated', (frame) => {
  if (firstIdentity && frame === page.mainFrame()) subsequentNavigations.push(frame.url());
});
function assertSameDocumentAndConnection(state) {
  assert(firstIdentity, 'First pre-fault identity was not recorded');
  assert.equal(state.timeOrigin, firstIdentity.timeOrigin, 'Page reloaded during recovery');
  assert.equal(
    state.connectionId,
    firstIdentity.connectionId,
    'Gateway reconnected during recovery',
  );
  assert.deepEqual(subsequentNavigations, [], 'Main frame navigated after the first fault');
}
async function receipt() {
  return page.evaluate(async () => {
    const notice = document.querySelector('farm-resource-store-notice');
    const { getState, runHistoryQuery } = await import('/src/state.ts');
    const { getResourceCache, getResourceStoreNotice } = await import('/src/resource-cache.ts');
    const read = getResourceCache()?.read(runHistoryQuery);
    const { gateway } = await import('/src/gateway-client.ts');
    let diagnostics;
    try {
      diagnostics = await notice?.resourceStoreDiagnostics();
    } catch (error) {
      diagnostics = { storage: 'recovering', pendingReadError: error.message };
    }
    return {
      fault: window.__rollbackProof,
      timeOrigin: performance.timeOrigin,
      connectionId: gateway.resourceConnectionId,
      dataSaver: navigator.connection?.saveData,
      notice: getResourceStoreNotice() ?? null,
      sync: notice?.shadowRoot
        ?.querySelector('[data-testid=resource-sync-status]')
        ?.textContent.trim(),
      runsStatus: read?.status,
      observedAt: read?.observedAt,
      runIds: getState()
        .runs.map((run) => run.id)
        .sort(),
      diagnostics,
    };
  });
}
try {
  // Emulate the browser's data-saver preference before startup. Foreground
  // cache reads still use the live gateway. Gate metadata can still prefetch;
  // any accepted missing-artifact gap remains recorded in raw errors/responses.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDataSaverOverride', { dataSaverEnabled: true });
  await page.addInitScript(
    ({ databaseName, partialOutage, laterPageOutage }) => {
      const NativeWorker = window.Worker;
      const proof = { workers: 0, retired: 0, injected: false, failures: [], successfulMerges: 0 };
      window.__rollbackProof = proof;
      window.Worker = class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          this.storage = String(url).includes('browser-worker');
          this.merges = new Set();
          this.completedMerges = 0;
          this.pageSizes = new Map();
          this.writes = new Set();
          this.cleanOwnedFiles = this.storage && proof.workers === 0;
          if (this.storage) proof.workers++;
          this.addEventListener('message', ({ data }) => {
            if (data.proofCleanup) proof.cleanup = data.proofCleanup;
            if (data.ok === false) proof.failures.push(data);
            if (this.merges.delete(data.id) && data.ok) {
              proof.successfulMerges++;
              this.completedMerges++;
              (proof.completedPageRows ??= []).push(this.pageSizes.get(data.id));
            }
            this.pageSizes.delete(data.id);
            if (this.writes.delete(data.id) && data.ok)
              proof.healthyWrites = (proof.healthyWrites ?? 0) + 1;
          });
        }
        postMessage(request, ...args) {
          if (this.storage && ['open', 'deleteScope', 'diagnostics'].includes(request.operation))
            request = { ...request, databaseName };
          if (this.storage && request.operation === 'diagnostics' && proof.removeFiles)
            request = { ...request, proofRemoveOwnedFiles: true };
          if (this.storage && request.operation === 'open' && this.cleanOwnedFiles) {
            this.cleanOwnedFiles = false;
            request = { ...request, proofCleanOwnedFiles: true };
          }
          if (this.storage && request.operation === 'putQuery') this.writes.add(request.id);
          if (this.storage && request.operation === 'mergeRows') {
            this.merges.add(request.id);
            this.pageSizes.set(request.id, request.merge.upserts.length);
            const failMerge = laterPageOutage
              ? this.completedMerges > 0
              : !proof.injected || proof.repeatArmed || partialOutage;
            if (failMerge) {
              proof.injected = true;
              proof.repeatArmed = false;
              proof.injections = (proof.injections ?? 0) + 1;
              request = { ...request, proofRollbackFault: true };
              return import('/src/gateway-client.ts').then(async ({ gateway }) => {
                proof.before ??= {
                  timeOrigin: performance.timeOrigin,
                  connectionId: gateway.resourceConnectionId,
                };
                await window.__recordRollbackIdentity(proof.before);
                return super.postMessage(request, ...args);
              });
            }
          }
          return super.postMessage(request, ...args);
        }
        terminate() {
          if (this.storage) proof.retired++;
          return super.terminate();
        }
      };
    },
    { databaseName: proofDatabase, partialOutage, laterPageOutage },
  );
  await page.bringToFront();
  await page.goto(`${origin}/#runs?tab=all`, { waitUntil: 'domcontentloaded' });
  const failed = await until(async () => {
    const r = await receipt();
    return r.fault?.failures.length && r;
  });
  await writeFile(path.join(output, 'failure-observed.json'), JSON.stringify(failed, null, 2));
  await page.screenshot({ path: path.join(output, 'failure.png') });
  if (negativeReload) await page.reload({ waitUntil: 'domcontentloaded' });
  let recovered;
  if (baseline) {
    assert(
      failed.fault.failures.some((x) =>
        /cannot rollback - no transaction is active/.test(x.message),
      ),
      "Baseline must reproduce Arthur's exact error",
    );
    assert(
      failed.fault.failures.some((x) => !x.fatal),
      'Masked primary failure must fail to retire baseline worker',
    );
    recovered = await receipt();
  } else {
    if (partialOutage) {
      recovered = await until(async () => {
        const r = await receipt();
        assert(r.fault.workers <= 2, 'Partial outage caused an unbounded reopen');
        return (
          r.fault.workers === 2 &&
          r.fault.retired === 2 &&
          r.fault.injections === 2 &&
          r.notice &&
          r.sync === 'Synced' &&
          r.runsStatus === 'ready' &&
          r
        );
      });
      assert(
        recovered.fault.healthyWrites > 0,
        'Partial outage needs healthy query writes alongside the failing merge',
      );
      assert.equal(recovered.diagnostics.storage, 'memory');
      if (laterPageOutage)
        assert(
          recovered.fault.completedPageRows.filter((rows) => rows > 0).length >= 2,
          'Each attempt must commit a page before a later page fails',
        );
      assertSameDocumentAndConnection(recovered);
      await page.screenshot({ path: path.join(output, 'partial-outage.png') });
    } else {
      recovered = await until(async () => {
        const r = await receipt();
        return (
          r.fault.workers >= 2 &&
          r.fault.retired >= 1 &&
          r.fault.successfulMerges > 0 &&
          !r.notice &&
          r.sync === 'Synced' &&
          r.runsStatus === 'ready' &&
          r
        );
      });
      assertSameDocumentAndConnection(recovered);
      assert(
        recovered.fault.failures.some(
          (x) => x.fatal && (x.resultCode & 255) === (faultMode === 'opfs-io' ? 10 : 19),
        ),
        'Primary SQLite error must survive transaction cleanup',
      );
      assert.equal(recovered.diagnostics.integrity, 'ok');
      assert.equal(recovered.diagnostics.storage, 'opfs-sahpool');
      await page.screenshot({ path: path.join(output, 'recovered.png') });
      await page.evaluate(() => {
        window.__rollbackProof.repeatArmed = true;
      });
      recovered = await until(async () => {
        const r = await receipt();
        return (
          r.fault.injections === 2 &&
          r.fault.retired === 2 &&
          r.fault.workers === 3 &&
          !r.notice &&
          r.sync === 'Synced' &&
          r.runsStatus === 'ready' &&
          r
        );
      });
      assertSameDocumentAndConnection(recovered);
      assert.equal(recovered.dataSaver, true, 'Data-saver setup failed');
      await page.screenshot({ path: path.join(output, 'recovered-twice.png') });
    }
    const snapshot = await page.evaluate(async () => {
      const { runHistoryQuery, getState } = await import('/src/state.ts');
      const { gateway } = await import('/src/gateway-client.ts');
      const current = await gateway.request('run.list', runHistoryQuery.params);
      return {
        gatewayIds: current.runs.map((x) => x.id).sort(),
        gatewayFacts: current.runs
          .map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        visibleIds: getState()
          .runs.map((x) => x.id)
          .sort(),
        visibleFacts: getState()
          .runs.map(({ id, status, updatedAt }) => ({ id, status, updatedAt }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    });
    assert.deepEqual(
      snapshot.visibleIds,
      snapshot.gatewayIds,
      'Recovered run IDs differ from a fresh gateway read',
    );
    assert.deepEqual(
      snapshot.visibleFacts,
      snapshot.gatewayFacts,
      'Recovered run status/timestamps differ from live gateway',
    );
    recovered.gatewayMatches = true;
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    if (faultMode === 'transaction-abort') {
      if (artifactGapAccepted && errors.length) {
        assert(
          failedResponses.length > 0 &&
            failedResponses.every(
              (r) => r.status === 404 && new URL(r.url).pathname === '/api/run-artifact',
            ),
          'Accepted gap only covers missing retained run artifacts',
        );
        assert(
          errors.length <= failedResponses.length &&
            errors.every(
              (error) =>
                error ===
                'Failed to load resource: the server responded with a status of 404 (Not Found)',
            ),
          errors.join('\n'),
        );
      } else assert.equal(errors.length, 0, errors.join('\n'));
    } else
      assert(
        errors.every((x) => x.includes('Rollback proof: OPFS page write failed')),
        errors.join('\n'),
      );
  }
  completedProof = {
    baseline,
    partialOutage,
    laterPageOutage,
    pageSize: laterPageOutage ? 50 : undefined,
    faultMode,
    artifactGapAccepted,
    pageErrors,
    failed,
    recovered,
    consoleErrors: errors,
    failedResponses,
    firstIdentity,
    subsequentNavigations,
    noReloadOrReconnect:
      recovered.timeOrigin === firstIdentity.timeOrigin &&
      recovered.connectionId === firstIdentity.connectionId &&
      subsequentNavigations.length === 0,
  };
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      {
        message: error.message,
        consoleErrors: errors,
        failedResponses,
        firstIdentity,
        subsequentNavigations,
        state: await receipt(),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  try {
    const storeModule = `/@fs${new URL('../../../../packages/local-store/src/browser.ts', import.meta.url).pathname}`;
    teardown = await page.evaluate(
      async ({ storeModule, proofDatabase }) => {
        const { disposeResourceCache, getResourceStoreMetadata } =
          await import('/src/resource-cache.ts');
        const metadata = getResourceStoreMetadata();
        await disposeResourceCache();
        if (!metadata) throw new Error('Missing proof store identity for cleanup');
        const api = await import(storeModule);
        const cleanupStore = await api.createBrowserSqliteResourceStore({
          scope: metadata.scope,
          databaseName: proofDatabase,
        });
        try {
          await cleanupStore.close();
          window.__rollbackProof.removeFiles = true;
          await api.browserResourceStoreDiagnostics(proofDatabase);
          const result = window.__rollbackProof.cleanup;
          if (!result || !result.removed.includes(proofDatabase) || result.remaining.length)
            throw new Error('Proof database was not removed');
          return result;
        } finally {
          api.closeBrowserResourceStores();
        }
      },
      { storeModule, proofDatabase },
    );
    await writeFile(path.join(output, 'teardown.json'), JSON.stringify(teardown, null, 2));
  } finally {
    await close();
  }
}

if (completedProof)
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ ...completedProof, teardown }, null, 2),
  );
