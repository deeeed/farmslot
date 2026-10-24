import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.GATEWAY_PORT, '7913');
assert.equal(process.env.VITE_PORT, '5195');
const directory = path.resolve(process.env.FARMSLOT_PLANNING_RACE_ARTIFACTS);
assert(!directory.startsWith(root + '/'));
await mkdir(directory, { recursive: true });
const ready = JSON.parse(
  await readFile(
    path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
    'utf8',
  ),
);
assert.equal(ready.port, 7915);
assert.equal(new URL(ready.upstream).port, '7913');
const execute = promisify(execFile);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
        {
          timeout: 65000,
          maxBuffer: 8 * 1024 * 1024,
        },
      )
    ).stdout,
  );
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence = {};
const claims = {};
const failures = [];
const proxyStatus = async () => {
  const response = await fetch('http://127.0.0.1:7915/planning-race-status', {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const result = await response.json();
  assert.equal(result.startId, ready.startId);
  assert(!result.failure && !result.stopped, 'The exact proxy must remain healthy');
  return result;
};
async function control(action) {
  const response = await fetch('http://127.0.0.1:7915/api/planning-race-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proof-owner': ready.owner },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok, `Owned ${action} control failed`);
  assert.equal((await response.json()).startId, ready.startId);
}
async function until(read, accepts, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let result;
  do {
    result = await read();
    if (accepts(result)) return result;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(result)}`);
}
const probe = path.join(root, 'apps/command-center/scripts/probes/offline-planning.js');
let tab;
let item;
let trace;
let traceResult;
let signedIn = false;
try {
  const original = await rpc('backlog.list', { includeArchived: true });
  evidence.originalItemsHash = hash(original.items);
  const title = `Planning race ${randomUUID()}`;
  const labels = { before: title, held: title + ' A', middle: title + ' B', latest: title + ' C' };
  item = (
    await rpc('backlog.create', {
      project: process.env.FARMSLOT_PLANNING_RACE_PROJECT,
      title,
      sourceKind: 'manual',
      flowType: 'dev',
    })
  ).item;
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  url.searchParams.set('planning-race', path.basename(directory));
  url.hash = `backlog?projects=${item.project}&item=${item.id}`;
  const opened = await cdp('goto', url.href, '--new');
  tab = `@${opened.id}`;
  const inspect = () => cdp('eval', tab, '--file', probe);
  const session = await cdp(
    'eval',
    tab,
    `const deadline=Date.now()+12000;while(!document.querySelector('.auth-card')&&!document.querySelector('backlog-panel')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));return {auth:Boolean(document.querySelector('.auth-card'))};`,
  );
  if (session.auth) assert((await cdp('login', tab)).authenticated);
  signedIn = true;
  evidence.warm = await until(
    inspect,
    (view) =>
      view.observations?.['backlog.list']?.ready &&
      view.observations['backlog.list'].rows.some(
        (row) => row.id === item.id && row.title === title,
      ) &&
      view.renderedRows.some((row) => row.id === item.id && row.text.includes(title)),
    'Warm the real mounted backlog and canonical query',
  );
  const query = evidence.warm.observations['backlog.list'];
  evidence.warmProxy = await proxyStatus();
  const paramsHash = hash(query.params);
  assert(
    evidence.warmProxy.requests.some((row) => row.paramsSha256 === paramsHash && row.observed),
  );
  // This observer records actual production-cache transitions. It never changes state or replies.
  const expression = `
    const moduleUrl=(pathname)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(pathname)).at(-1);
    const {getResourceCache}=await import(moduleUrl('/src/resource-cache.ts'));
    const {resourceQuery}=await import(moduleUrl('/packages/protocol/src/client-cache/index.ts'));
    const cache=getResourceCache();if(!cache)throw Error('Actual cache missing');
    const query=resourceQuery('backlog.list',${JSON.stringify(query.params)});
    const records=[];let stop;let timer;
    try{const observed=new Promise(resolve=>{
      const finish=(status,message)=>{clearTimeout(timer);resolve({status,message,queryId:query.id,records});};
      timer=setTimeout(()=>finish('fail','Held-read trace deadline'),20000);
      stop=cache.observe(query,state=>{
        const row=state.data?.items?.find(item=>item.id===${JSON.stringify(item.id)});
        records.push({sequence:records.length,status:state.status,title:row?.title,observedAt:state.observedAt,resourceState:state.resourceState,at:Date.now()});
        if(state.status==='ready'&&row?.title===${JSON.stringify(labels.held)})finish('fail','An obsolete held planning reply became ready');
        if(state.status==='ready'&&row?.title===${JSON.stringify(labels.latest)})finish('pass','Current source reached the canonical cache');
        if(records.length>100)finish('fail','Bounded cache transition count exceeded');
      });
    });const ack=await fetch('/api/planning-race-control',{method:'POST',headers:{'Content-Type':'application/json','x-proof-owner':${JSON.stringify(ready.owner)}},body:JSON.stringify({action:'trace-ready'})});if(!ack.ok)throw Error('Observer readiness receipt refused');return await observed;}finally{stop?.();if(timer)clearTimeout(timer);}
  `;
  trace = cdp('eval', tab, expression).then(
    (result) => ({ result }),
    (error) => ({ error }),
  );
  await Promise.race([
    until(
      proxyStatus,
      (state) => state.controls.some((row) => row.action === 'trace-ready'),
      'The actual cache observer must attach before any write',
    ),
    trace.then((settled) => {
      throw settled.error ?? new Error('The cache trace ended before its readiness receipt');
    }),
  ]);
  await control('arm');
  evidence.writerA = await rpc('backlog.update', { itemId: item.id, title: labels.held });
  const held = await until(
    proxyStatus,
    (state) => Boolean(state.held),
    'Hold the actual observed A reply',
  );
  evidence.held = held;
  assert.equal(held.held.paramsSha256, paramsHash);
  const revision = Math.max(
    ...held.held.resourceState.dependencies
      .filter(({ key }) => key.family === 'planning' && key.collection === 'backlog')
      .map(({ revision }) => revision),
  );
  assert(Number.isSafeInteger(revision));
  evidence.sourceAtHold = await rpc('backlog.list', query.params);
  assert.equal(hash(evidence.sourceAtHold), held.held.payloadSha256);
  assert.equal(evidence.sourceAtHold.items.find((row) => row.id === item.id).title, labels.held);
  evidence.writerB = await rpc('backlog.update', { itemId: item.id, title: labels.middle });
  evidence.writerC = await rpc('backlog.update', { itemId: item.id, title: labels.latest });
  const hasNewer = (state) =>
    state.events.some(
      (event) =>
        event.epoch === held.held.resourceState.epoch &&
        event.connection === held.held.connection &&
        event.changes.some((change) => change.revision >= revision + 2),
    );
  evidence.newerNotices = await until(proxyStatus, hasNewer, 'Deliver both newer owning writes');
  await control('duplicate');
  evidence.beforeRelease = await proxyStatus();
  assert.equal(
    evidence.beforeRelease.requests.length,
    held.requests.length,
    'One shared in-flight backlog read',
  );
  assert.equal(evidence.beforeRelease.duplicates.length, 1);
  assert(
    evidence.beforeRelease.events.some(
      (event) => event.frameSha256 === evidence.beforeRelease.duplicates[0].frameSha256,
    ),
    'Duplicate the exact real notification bytes',
  );
  evidence.stale = await inspect();
  assert.equal(
    evidence.stale.connectionId,
    evidence.warm.connectionId,
    'Do not substitute a reconnect',
  );
  assert.equal(evidence.stale.observations['backlog.list'].status, 'stale');
  await cdp('screenshot', tab, path.join(directory, 'held-read-stale.png'));
  await control('release');
  const settled = await trace;
  if (settled.error) throw settled.error;
  traceResult = settled.result;
  evidence.trace = traceResult;
  await writeFile(
    path.join(directory, 'cache-transition-trace.json'),
    JSON.stringify(traceResult, null, 2) + '\n',
  );
  assert.equal(traceResult.status, 'pass', traceResult.message);
  assert(
    traceResult.records.some((row) => row.status === 'stale' && row.title === labels.held),
    'The old reply must actually reach the cache and be labeled stale',
  );
  claims.oldReplyNeverReady = true;
  evidence.current = await until(
    inspect,
    (view) =>
      view.observations?.['backlog.list']?.ready &&
      view.observations['backlog.list'].rows.some(
        (row) => row.id === item.id && row.title === labels.latest,
      ) &&
      view.renderedRows.some((row) => row.id === item.id && row.text.includes(labels.latest)),
    'The mounted panel must render the latest actual source',
  );
  evidence.afterRelease = await proxyStatus();
  assert.equal(
    evidence.afterRelease.requests.length,
    held.requests.length + 1,
    'One follow-up read after coalesced invalidations',
  );
  assert.equal(evidence.afterRelease.held.frameSha256, held.held.frameSha256);
  assert(evidence.afterRelease.held.releasedAt);
  assert.equal(evidence.current.connectionId, evidence.warm.connectionId);
  claims.duplicateNoticesCoalesce = true;
  await cdp('screenshot', tab, path.join(directory, 'latest-source-rendered.png'));
} catch (error) {
  failures.push(error);
  if (tab) {
    try {
      evidence.failureView = await cdp('eval', tab, '--file', probe);
      await cdp('screenshot', tab, path.join(directory, 'first-failure.png'));
    } catch (captureError) {
      failures.push(captureError);
    }
  }
} finally {
  if (trace && !traceResult) {
    const settled = await trace;
    if (settled.result) evidence.trace = settled.result;
    else failures.push(settled.error);
  }
  let signOutComplete = !signedIn;
  let tabClosed = !tab;
  let itemRemoved = !item;
  try {
    if (signedIn) {
      const menuOpen = () =>
        cdp(
          'eval',
          tab,
          "return Boolean(document.querySelector('[data-testid=account-menu]')?.closest('details')?.open)",
        );
      if (!(await menuOpen())) await cdp('click', tab, '[data-testid="account-menu"]');
      await until(menuOpen, Boolean, 'Wait for the actual account menu before its next click');
      await cdp('click', tab, '[data-testid="account-sign-out"]');
      await until(
        () =>
          cdp(
            'eval',
            tab,
            "return Boolean(document.querySelector('[data-testid=account-sign-out-confirmation]')?.open)",
          ),
        Boolean,
        'Wait for the real sign-out dialog before confirming it',
      );
      await cdp('click', tab, '[data-testid="account-sign-out-confirm"]');
      await until(
        () => cdp('eval', tab, "return Boolean(document.querySelector('.auth-card'))"),
        Boolean,
        'Normal sign-out clears the disposable browser-origin session',
      );
      signOutComplete = true;
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    if (tab) await cdp('close', tab);
    tabClosed = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    if (item) await rpc('backlog.delete', { itemId: item.id });
    const remaining = (await rpc('backlog.list', { includeArchived: true })).items;
    if (evidence.originalItemsHash) assert.equal(hash(remaining), evidence.originalItemsHash);
    itemRemoved = true;
  } catch (error) {
    failures.push(error);
  }
  evidence.cleanup = { signOutComplete, tabClosed, itemRemoved };
  claims.ownedFixtureRemoved = signOutComplete && tabClosed && itemRemoved;
  await writeFile(
    path.join(directory, 'planning-race-receipt.json'),
    JSON.stringify(
      { claims, evidence, failures: failures.map((error) => error.message) },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}
if (failures.length) throw new AggregateError(failures, 'Planning race or cleanup failed');
console.log(JSON.stringify(claims));
