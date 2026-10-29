// Real source writes, selector input and a recoverable private filesystem error. No UI injection.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.FARMSLOT_ANALYTICS_OBSERVATION_PROOF, '1');
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).hostname, '127.0.0.1');
assert.equal(new URL(target.url).port, '7913');
const setup = JSON.parse(await readFile(process.env.FARMSLOT_TRIAGE_PROOF_SETUP, 'utf8'));
assert.equal(setup.home, process.env.FARMSLOT_HOME);
assert(setup.analytics && setup.runId && setup.setupOnly);
const artifacts = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_ARTIFACTS);
assert.equal(path.dirname(artifacts), path.dirname(process.env.FARMSLOT_TRIAGE_PROOF_SETUP));
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
const cdp = async (...args) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [path.join(root, 'apps/command-center/scripts/cdp.mjs'), ...args],
        { timeout: 65000, maxBuffer: 8 * 1024 * 1024 },
      )
    ).stdout,
  );
const rpc = (method, params = {}) => cdp('gateway', method, JSON.stringify(params));
const proxyStatus = async () => (await fetch('http://127.0.0.1:7915/planning-race-status')).json();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const claims = {};
const evidence = {};
const errors = [];
let tab;
let sinkHeld = false;
let faultFile = false;
const sink = setup.analytics.directory;
assert.equal(await realpath(sink), sink);
const heldSink = sink + '-held-' + setup.runId;
const faultBytes = Buffer.from(`Owned analytics read fault ${setup.runId}\n`);
async function restoreSink() {
  if (faultFile) {
    assert((await readFile(sink)).equals(faultBytes), 'Refuse removal of a foreign fault file');
    await unlink(sink);
    faultFile = false;
  }
  if (sinkHeld) {
    await rename(heldSink, sink);
    sinkHeld = false;
  }
}
async function until(read, accepts, message, timeout = 12000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(60);
  } while (Date.now() < end);
  assert.fail(`${message}: ${JSON.stringify(value)}`);
}
const inspect = () =>
  cdp(
    'eval',
    tab,
    `
 function find(root){const panel=root.querySelector('analytics-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot);if(found)return found;}}
 const panel=find(document);if(!panel)return {mounted:false};
 const url=(suffix)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(suffix)).at(-1);
 const {gateway}=await import(url('/src/gateway-client.ts'));const {getResourceCache}=await import(url('/src/resource-cache.ts'));
 const controller=Reflect.get(panel,'query'),query=Reflect.get(controller,'query'),state=controller.state;
 if(!controller.belongsToWorkspace||getResourceCache()?.read(query)!==state)throw Error('Inspect the actual canonical analytics query');
 const buttons=[...panel.shadowRoot.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {action:b.dataset.action,window:b.dataset.window,label:b.textContent.trim(),disabled:b.disabled,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};});
 return {mounted:true,ready:controller.ready,status:state.status,error:state.error,observedAt:state.observedAt,data:state.data,resourceState:state.resourceState,query:{id:query.id,params:query.params,persisted:query.persisted},connectionId:gateway.resourceConnectionId,timeOrigin:performance.timeOrigin,buttons,text:panel.shadowRoot.textContent};
`,
  );
const analyticsRevision = (view) =>
  view.resourceState.dependencies.find(({ key }) => key.family === 'analytics').revision;
try {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  url.searchParams.set('analytics-observations', path.basename(path.dirname(artifacts)));
  url.hash = `analytics?project=${encodeURIComponent(setup.project)}`;
  tab = '@' + (await cdp('goto', url.href, '--new')).id;
  const login = await until(
    () =>
      cdp(
        'eval',
        tab,
        "return {auth:Boolean(document.querySelector('.auth-card')),connected:document.querySelector('farm-app')?.connection==='connected'}",
      ),
    (v) => v.auth || v.connected,
    'Actual private analytics sign-in',
  );
  if (login.auth) assert((await cdp('login', tab)).authenticated);
  evidence.warm = await until(inspect, (v) => v.ready && v.data, 'Current analytics');
  assert.equal(evidence.warm.query.params.project, setup.project);
  assert(
    !evidence.warm.buttons.some((b) =>
      ['Refresh', 'Retry', 'Update time window'].includes(b.label),
    ),
  );
  await cdp('screenshot', tab, path.join(artifacts, 'all-time-before.png'));
  const before = await proxyStatus();
  evidence.delete = await rpc('run.delete', { runId: setup.runId });
  assert(evidence.delete.ok);
  evidence.updated = await until(
    inspect,
    (v) =>
      v.ready &&
      v.data.matchedRuns === evidence.warm.data.matchedRuns + 1 &&
      analyticsRevision(v) > analyticsRevision(evidence.warm),
    'Actual terminal run deletion must append analytics and update the mounted query',
  );
  assert.equal(evidence.updated.connectionId, evidence.warm.connectionId);
  assert.equal(evidence.updated.timeOrigin, evidence.warm.timeOrigin);
  const after = await proxyStatus();
  assert(after.observedReads['analytics.query'] > before.observedReads['analytics.query']);
  evidence.sourceEvent = after.events.find((event) =>
    event.changes.some(
      (r) => r.key.family === 'analytics' && r.revision === analyticsRevision(evidence.updated),
    ),
  );
  assert(evidence.sourceEvent, 'Require the actual owning append notification');
  const source = path.join(sink, `events-${new Date().toISOString().slice(0, 7)}.ndjson`);
  const bytes = await readFile(source);
  const rows = bytes
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    rows.filter((row) => row.runId === setup.runId && row.project === setup.project).length,
    1,
  );
  evidence.source = {
    file: source,
    sha256: digest(bytes),
    mode: (await stat(source)).mode & 0o777,
    runId: setup.runId,
  };
  await cdp('screenshot', tab, path.join(artifacts, 'all-time-after.png'));
  claims.sourceUpdates = true;

  await cdp('click', tab, '[data-window="24h"]');
  evidence.relative = await until(
    inspect,
    (v) => v.ready && v.query.params.since && v.query.id !== evidence.updated.query.id,
    'Actual relative selector',
  );
  assert.equal(evidence.relative.data.matchedRuns, evidence.updated.data.matchedRuns);
  assert(
    evidence.relative.buttons.some((b) => b.action === 'update-window' && !b.disabled && b.visible),
  );
  const lower = Date.now() - 86_400_000;
  await cdp('click', tab, '[data-action="update-window"]');
  evidence.advanced = await until(
    inspect,
    (v) =>
      v.ready &&
      Date.parse(v.query.params.since) > Date.parse(evidence.relative.query.params.since),
    'Update time window must change the actual lower bound',
  );
  assert(Date.parse(evidence.advanced.query.params.since) >= lower);
  assert(Date.parse(evidence.advanced.query.params.since) <= Date.now() - 86_400_000);
  assert.equal(evidence.advanced.query.params.project, setup.project);
  assert(!evidence.advanced.buttons.some((b) => ['Refresh', 'Retry'].includes(b.label)));
  await cdp('screenshot', tab, path.join(artifacts, 'relative-window-advanced.png'));
  claims.relativeWindow = true;

  await rename(sink, heldSink);
  sinkHeld = true;
  await writeFile(sink, faultBytes, { flag: 'wx', mode: 0o600 });
  faultFile = true;
  await cdp('click', tab, '[data-window="7d"]');
  evidence.failed = await until(
    inspect,
    (v) => v.error && v.buttons.some((b) => b.action === 'retry' && b.visible && !b.disabled),
    'Real analytics read error must expose Retry',
  );
  assert(evidence.failed.buttons.some((b) => b.label === 'Backfill from runs' && b.disabled));
  const failedProxy = await proxyStatus();
  assert(
    failedProxy.analyticsReplies.some((reply) => !reply.ok),
    'A real gateway read must fail',
  );
  await cdp('screenshot', tab, path.join(artifacts, 'read-error-retry.png'));
  await restoreSink();
  assert.equal(digest(await readFile(source)), evidence.source.sha256);
  await cdp('click', tab, '[data-action="retry"]');
  evidence.recovered = await until(
    inspect,
    (v) => v.ready && !v.error && v.query.id === evidence.failed.query.id,
    'Actual Retry must recover the same selected query',
  );
  const finalProxy = await proxyStatus();
  assert(
    finalProxy.observedReads['analytics.query'] > failedProxy.observedReads['analytics.query'],
  );
  assert(!evidence.recovered.buttons.some((b) => ['Refresh', 'Retry'].includes(b.label)));
  assert.equal(evidence.recovered.data.matchedRuns, evidence.updated.data.matchedRuns);
  assert.equal(evidence.recovered.connectionId, evidence.warm.connectionId);
  assert.equal(evidence.recovered.timeOrigin, evidence.warm.timeOrigin);
  assert(!finalProxy.failure && !finalProxy.stopped);
  assert(Object.values(finalProxy.commands).every((n) => n === 0));
  evidence.proxy = finalProxy;
  await cdp('screenshot', tab, path.join(artifacts, 'same-query-recovered.png'));
  claims.contextualRetry = true;
} catch (error) {
  errors.push(error);
  if (tab) {
    try {
      evidence.failureView = await inspect();
      await cdp('screenshot', tab, path.join(artifacts, 'first-failure.png'));
    } catch (capture) {
      errors.push(capture);
    }
  }
} finally {
  try {
    await restoreSink();
    evidence.sourceFaultRestored = !sinkHeld && !faultFile;
  } catch (error) {
    errors.push(error);
  }
  if (tab) {
    try {
      await cdp('click', tab, '[data-testid="account-menu"]');
      await until(
        () =>
          cdp(
            'eval',
            tab,
            "return Boolean(document.querySelector('[data-testid=account-menu]')?.closest('details')?.open)",
          ),
        Boolean,
        'Account menu',
      );
      await cdp('click', tab, '[data-testid="account-sign-out"]');
      await until(
        () =>
          cdp(
            'eval',
            tab,
            "return Boolean(document.querySelector('[data-testid=account-sign-out-confirmation]')?.open)",
          ),
        Boolean,
        'Sign-out confirmation',
      );
      await cdp('click', tab, '[data-testid="account-sign-out-confirm"]');
      await until(
        () => cdp('eval', tab, "return Boolean(document.querySelector('.auth-card'))"),
        Boolean,
        'Normal sign-out',
      );
      evidence.normalSignOut = true;
    } catch (error) {
      errors.push(error);
    }
    try {
      await cdp('close', tab);
      evidence.ownedTabClosed = true;
    } catch (error) {
      errors.push(error);
    }
  }
  await writeFile(
    path.join(artifacts, 'analytics-observation-proof.json'),
    JSON.stringify({ claims, evidence, failures: errors.map((e) => e.message) }, null, 2) + '\n',
    { mode: 0o600 },
  );
}
if (errors.length) throw new AggregateError(errors, 'Analytics observation proof failed');
console.log(JSON.stringify(claims));
