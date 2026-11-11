import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openLiveBrowserProof, until } from './live-browser-proof.mjs';

const baseline = process.argv.includes('--expect-masked');
const faultMode = process.env.FARMSLOT_PROOF_FAULT ?? 'transaction-abort';
const proofDatabase = '/rollback-recovery-proof.sqlite';
assert(['transaction-abort', 'opfs-io'].includes(faultMode));
function transformSource({ url, body }) {
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
const { page, origin, output, errors, failedResponses, close } = await openLiveBrowserProof({
  transformSource,
});
let completedProof;
let teardown;
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
  // cache reads still use the live gateway; unrelated artifact prefetch is paused.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDataSaverOverride', { dataSaverEnabled: true });
  await page.addInitScript((databaseName) => {
    const NativeWorker = window.Worker;
    const proof = { workers: 0, retired: 0, injected: false, failures: [], successfulMerges: 0 };
    window.__rollbackProof = proof;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.storage = String(url).includes('browser-worker');
        this.merges = new Set();
        this.cleanOwnedFiles = this.storage && proof.workers === 0;
        if (this.storage) proof.workers++;
        this.addEventListener('message', ({ data }) => {
          if (data.proofCleanup) proof.cleanup = data.proofCleanup;
          if (data.ok === false) proof.failures.push(data);
          if (this.merges.delete(data.id) && data.ok) proof.successfulMerges++;
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
        if (this.storage && request.operation === 'mergeRows') {
          this.merges.add(request.id);
          if (!proof.injected || proof.repeatArmed) {
            proof.injected = true;
            proof.repeatArmed = false;
            proof.injections = (proof.injections ?? 0) + 1;
            request = { ...request, proofRollbackFault: true };
            return import('/src/gateway-client.ts').then(({ gateway }) => {
              proof.before ??= {
                timeOrigin: performance.timeOrigin,
                connectionId: gateway.resourceConnectionId,
              };
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
  }, proofDatabase);
  await page.bringToFront();
  await page.goto(`${origin}/#runs?tab=all`, { waitUntil: 'domcontentloaded' });
  const failed = await until(async () => {
    const r = await receipt();
    return r.fault?.failures.length && r;
  });
  await writeFile(path.join(output, 'failure-observed.json'), JSON.stringify(failed, null, 2));
  await page.screenshot({ path: path.join(output, 'failure.png') });
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
    assert.equal(
      recovered.timeOrigin,
      recovered.fault.before.timeOrigin,
      'Page reloaded during recovery',
    );
    assert.equal(
      recovered.connectionId,
      recovered.fault.before.connectionId,
      'Gateway reconnected during recovery',
    );
    assert.equal(recovered.dataSaver, true, 'Data-saver setup failed');
    await page.screenshot({ path: path.join(output, 'recovered-twice.png') });
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
    if (faultMode === 'transaction-abort') assert.equal(errors.length, 0, errors.join('\n'));
    else
      assert(
        errors.every((x) => x.includes('Rollback proof: OPFS page write failed')),
        errors.join('\n'),
      );
  }
  completedProof = {
    baseline,
    faultMode,
    failed,
    recovered,
    consoleErrors: errors,
    failedResponses,
    noReloadOrReconnect:
      recovered.timeOrigin === recovered.fault.before.timeOrigin &&
      recovered.connectionId === recovered.fault.before.connectionId,
  };
} catch (error) {
  await writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify(
      { message: error.message, consoleErrors: errors, failedResponses, state: await receipt() },
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
  } finally {
    await close();
  }
}

if (completedProof)
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify({ ...completedProof, teardown }, null, 2),
  );
