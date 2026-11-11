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
const baseline = process.argv.includes('--expect-stuck');
const faultMode = process.env.FARMSLOT_PROOF_FAULT ?? 'transaction-abort';
const proofDatabase = '/rollback-recovery-proof.sqlite';
assert(['transaction-abort', 'opfs-io'].includes(faultMode));
const { chromium } = await import(pathToFileURL(browserModule).href);
const browser = await chromium.connectOverCDP(endpoint);
const page = await browser.contexts()[0].newPage();
const errors = [];
const failedResponses = [];
page.on('response', (response) => {
  if (response.status() >= 400)
    failedResponses.push({ url: response.url(), status: response.status() });
});
let stopRouting;
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
await mkdir(output, { recursive: true });
async function until(read, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Rollback recovery proof deadline');
}
async function receipt() {
  return page.evaluate(async () => {
    const notice = document.querySelector('farm-resource-store-notice');
    const { getState, runHistoryQuery } = await import('/src/state.ts');
    const { getResourceCache, getResourceStoreNotice } = await import('/src/resource-cache.ts');
    const read = getResourceCache()?.read(runHistoryQuery);
    let diagnostics;
    try {
      diagnostics = await notice?.resourceStoreDiagnostics();
    } catch (error) {
      diagnostics = { storage: 'recovering', pendingReadError: error.message };
    }
    return {
      fault: window.__rollbackProof,
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
  const proxy = async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/' || url.pathname.startsWith('/api/') || url.pathname === '/ws')
      return route.continue();
    if (url.pathname === '/@vite/client')
      return route.fulfill({
        contentType: 'text/javascript',
        body: 'const styles=new Map();export const createHotContext=()=>({on(){},accept(){},prune(){},dispose(){},data:{}});export const injectQuery=(u)=>u;export function updateStyle(id,css){let s=styles.get(id);if(!s){s=document.createElement("style");document.head.append(s);styles.set(id,s)}s.textContent=css}export function removeStyle(id){styles.get(id)?.remove();styles.delete(id)}',
      });
    const response = await fetch(new URL(url.pathname + url.search, source));
    let body = Buffer.from(await response.arrayBuffer());
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
          for(const file of pool.getFileNames()) if(file === '/rollback-recovery-proof.sqlite') pool.unlink(file);
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
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(
        [...response.headers].filter(
          ([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k),
        ),
      ),
      body,
    });
  };
  await page.route(`${origin}/**`, proxy);
  await browser.contexts()[0].route(`${origin}/@fs/**`, proxy);
  stopRouting = () => browser.contexts()[0].unroute(`${origin}/@fs/**`, proxy);
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
          if (!proof.injected) {
            proof.injected = true;
            request = { ...request, proofRollbackFault: true };
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
    recovered = await until(async () => {
      const r = await receipt();
      return r.notice?.includes('cannot rollback - no transaction is active') && r;
    });
    assert.equal(recovered.fault.retired, 0);
    await page.screenshot({ path: path.join(output, 'stuck.png') });
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
      'Primary I/O error must survive transaction cleanup',
    );
    assert.equal(recovered.diagnostics.integrity, 'ok');
    assert.equal(recovered.diagnostics.storage, 'opfs-sahpool');
    await page.screenshot({ path: path.join(output, 'recovered.png') });
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
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        baseline,
        faultMode,
        failed,
        recovered,
        consoleErrors: errors,
        failedResponses,
        noReloadOrReconnect: true,
      },
      null,
      2,
    ),
  );
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
    await page.evaluate(async () => {
      const { disposeResourceCache } = await import('/src/resource-cache.ts');
      await disposeResourceCache();
      window.__rollbackProof.removeFiles = true;
      await document.querySelector('farm-resource-store-notice')?.resourceStoreDiagnostics();
    });
  } finally {
    await stopRouting?.();
    await page.close();
    await browser.close();
  }
}
