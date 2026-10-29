import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.FARMSLOT_ASSESSMENT_HISTORY_PROOF, '1');
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).hostname, '127.0.0.1');
assert.equal(new URL(target.url).port, '7913');
const execute = promisify(execFile);
const listener = await execute('lsof', ['-nP', '-t', '-iTCP:7913', '-sTCP:LISTEN']);
const pid = Number(listener.stdout.trim());
assert(Number.isSafeInteger(pid) && pid > 0);
const cwd = await execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
assert(cwd.stdout.split('\n').includes(`n${root}/services/gateway`));
const setup = JSON.parse(await readFile(process.env.FARMSLOT_TRIAGE_PROOF_SETUP, 'utf8'));
assert(setup.assessmentSeededBeforeUi && setup.assessments.length === 2);
assert.equal(setup.home, process.env.FARMSLOT_HOME);
const artifacts = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_ARTIFACTS);
assert.equal(path.dirname(artifacts), path.dirname(process.env.FARMSLOT_TRIAGE_PROOF_SETUP));
await mkdir(artifacts, { recursive: true });
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
const evidence = {};
const claims = {};
const errors = [];
let tab;
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
 function find(root){const panel=root.querySelector('assessment-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot);if(found)return found;}}
 const panel=find(document);if(!panel)return {mounted:false};
 const url=(suffix)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(suffix)).at(-1);
 const {gateway}=await import(url('/src/gateway-client.ts'));const {getResourceCache}=await import(url('/src/resource-cache.ts'));
 const canonical=(controller)=>{if(!controller)return;const query=Reflect.get(controller,'query'),state=controller.state;if(controller.belongsToWorkspace&&getResourceCache()?.read(query)!==state)throw Error('Inspect actual canonical assessment/run data');return {ready:controller.ready,status:state.status,error:state.error,queryId:query?.id,persisted:query?.persisted,data:state.data,resourceState:state.resourceState,observedAt:state.observedAt};};
 const r=panel.shadowRoot;const retry=r.querySelector('[data-action=retry-outcome]'),rect=retry?.getBoundingClientRect();const retryVisible=Boolean(rect&&rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=innerHeight);return {outcomeRetryVisible:retryVisible,mounted:true,timeOrigin:performance.timeOrigin,connectionId:gateway.resourceConnectionId,selectedId:Reflect.get(panel,'selectedId'),historyReady:Reflect.get(panel,'historyReady'),records:Reflect.get(panel,'records'),summary:canonical(Reflect.get(panel,'assessmentSummary')),outcomes:[...(Reflect.get(panel,'outcomeResources')??new Map())].map(([id,controller])=>({id,...canonical(controller)})),text:r.textContent,refresh:r.querySelector('[data-action=refresh]')!==null,historyRetry:r.querySelector('[data-action=retry]')!==null,outcomeRetry:r.querySelector('[data-action=retry-outcome]')!==null,buttons:[...r.querySelectorAll('button')].map(b=>({action:b.dataset.action,text:b.textContent.trim(),disabled:b.disabled}))};
`,
  );
const assessmentRevision = (view) =>
  view.summary.resourceState.dependencies.find(({ key }) => key.family === 'assessment').revision;
const settled = async () => {
  let previous;
  let stable = Date.now();
  return until(
    proxyStatus,
    (state) => {
      const signature = JSON.stringify(state.observedReads);
      if (signature !== previous) stable = Date.now();
      previous = signature;
      return Date.now() - stable >= 350;
    },
    'Source reads must settle',
  );
};
try {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  url.searchParams.set('assessment-observations', path.basename(path.dirname(artifacts)));
  url.hash = `intelligence?tab=assessments&assessment=${setup.assessmentId}&projects=${encodeURIComponent(setup.project)}`;
  tab = '@' + (await cdp('goto', url.href, '--new')).id;
  const login = await until(
    () =>
      cdp(
        'eval',
        tab,
        "return {auth:Boolean(document.querySelector('.auth-card')),connected:document.querySelector('farm-app')?.connection==='connected'}",
      ),
    (s) => s.auth || s.connected,
    'Real assessment sign-in',
  );
  if (login.auth) assert((await cdp('login', tab)).authenticated);
  evidence.warm = await until(
    inspect,
    (v) =>
      v.historyReady &&
      v.summary?.ready &&
      v.selectedId === setup.assessmentId &&
      v.records?.[0]?.id === setup.assessmentId &&
      v.outcomes?.some(
        (o) => o.id === setup.assessmentId && o.ready && o.data?.run?.id === setup.runId,
      ) &&
      v.text.includes('No chosen action associated with this advice'),
    'The actual mounted assessment must observe its run outcome',
  );
  assert(!evidence.warm.refresh && !evidence.warm.historyRetry);
  assert.equal(evidence.warm.summary.persisted, false);
  const question = evidence.warm.records[0];
  evidence.feedbackCommand = await rpc('assessment.feedback', {
    id: setup.assessmentId,
    expectedRevision: question.feedback.length,
    questionId: 'cause',
    verdict: 'correct',
    adviceUsed: false,
    adviceShown: true,
    evidenceRef: 'Synthetic pre-client D07 assessment fixture; no provider result claimed',
  });
  evidence.feedback = await until(
    inspect,
    (v) =>
      v.historyReady &&
      v.summary?.ready &&
      assessmentRevision(v) > assessmentRevision(evidence.warm) &&
      v.records?.[0]?.feedback.length === evidence.feedbackCommand.feedback.length &&
      v.text.replace(/\s+/g, ' ').includes('1 operator-labeled questions'),
    'An actual independent feedback writer must update the mounted history and summary',
  );
  const file = setup.assessments.find((r) => r.kind === 'outcome').file;
  const source = await readFile(file);
  assert.equal(JSON.parse(source).feedback.length, evidence.feedbackCommand.feedback.length);
  evidence.feedbackSource = { sha256: digest(source), record: JSON.parse(source) };
  await cdp('screenshot', tab, path.join(artifacts, 'feedback-current.png'));
  claims.feedbackWithoutPolling = true;
  const beforeDelete = await settled();
  evidence.deleteCommand = await rpc('run.delete', { runId: setup.runId });
  assert(evidence.deleteCommand.ok);
  evidence.deleted = await until(
    inspect,
    (v) =>
      v.outcomes?.some(
        (o) => o.id === setup.assessmentId && o.error?.code === 'RUN_NOT_FOUND' && !o.data,
      ) &&
      v.outcomeRetry &&
      v.text.includes('Could not load run outcome'),
    'Deleting the actual run must update its displayed outcome without an assessment write',
  );
  await cdp(
    'eval',
    tab,
    `
    function find(root){const panel=root.querySelector('assessment-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot);if(found)return found;}}
    const target=find(document)?.shadowRoot.querySelector('[data-action=retry-outcome]');if(!target)throw Error('Actual outcome Retry must exist');target.scrollIntoView({block:'center'});return true;
  `,
  );
  evidence.visibleOutcomeError = await until(
    inspect,
    (v) =>
      v.outcomeRetryVisible &&
      v.outcomes.some((o) => o.id === setup.assessmentId && o.error?.code === 'RUN_NOT_FOUND'),
    'The actual outcome error and Retry must be visible',
  );
  const afterDelete = await settled();
  assert(
    (afterDelete.observedReads['run.get'] ?? 0) > (beforeDelete.observedReads['run.get'] ?? 0),
  );
  assert.equal(evidence.deleted.connectionId, evidence.warm.connectionId);
  assert.equal(evidence.deleted.timeOrigin, evidence.warm.timeOrigin);
  evidence.runReadCounters = {
    before: beforeDelete.observedReads,
    after: afterDelete.observedReads,
  };
  await cdp('screenshot', tab, path.join(artifacts, 'run-outcome-not-found.png'));
  claims.independentRunOutcome = true;
  const retrySelector = `article[id="${setup.assessmentId}"] [data-action="retry-outcome"]`;
  evidence.retryTarget = await cdp(
    'eval',
    tab,
    `
    function find(root, selector){const target=root.querySelector(selector);if(target)return target;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot,selector);if(found)return found;}}
    const target=find(document,${JSON.stringify(retrySelector)});if(!target)throw Error('Actual scoped Retry selector must resolve');const r=target.getBoundingClientRect();return {assessmentId:target.closest('article')?.id,label:target.textContent.trim(),disabled:target.disabled,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};
  `,
  );
  assert.equal(evidence.retryTarget.assessmentId, setup.assessmentId);
  assert.equal(evidence.retryTarget.label, 'Retry');
  assert(!evidence.retryTarget.disabled && evidence.retryTarget.visible);
  await cdp('click', tab, retrySelector);
  evidence.outcomeRetry = await until(
    proxyStatus,
    (s) => s.observedReads['run.get'] > afterDelete.observedReads['run.get'],
    'The contextual outcome Retry must use the real query',
  );
  claims.contextualRetry = true;
  await cdp(
    'eval',
    tab,
    "location.hash='intelligence?tab=assessments';return {hash:location.hash}",
  );
  evidence.all = await until(
    inspect,
    (v) =>
      !v.selectedId &&
      v.historyReady &&
      v.summary?.ready &&
      v.records?.some((r) => r.id === setup.expiringAssessmentId) &&
      v.outcomes?.length === 0,
    'The actual complete history must show the pre-client expiring record and release collapsed outcome observers',
  );
  assert(!evidence.all.refresh && !evidence.all.historyRetry);
  const quiet = await settled();
  assert(
    Date.now() + 16500 < setup.expiryAt,
    'The idle interval must finish before the separate expiry event',
  );
  const idleStarted = Date.now();
  while (Date.now() - idleStarted < 16000) {
    const current = await proxyStatus();
    assert.deepEqual(
      current.observedReads,
      quiet.observedReads,
      'An idle mounted assessment panel must not poll',
    );
    await delay(80);
  }
  evidence.idle = { startedAt: idleStarted, endedAt: Date.now(), reads: quiet.observedReads };
  claims.idleNoPeriodicReads = true;
  evidence.expired = await until(
    inspect,
    (v) =>
      v.historyReady &&
      v.summary?.ready &&
      assessmentRevision(v) > assessmentRevision(evidence.all) &&
      !v.records?.some((r) => r.id === setup.expiringAssessmentId) &&
      v.summary.data.calls === evidence.all.summary.data.calls - 1,
    'The owning expiry deadline must update actual mounted history and summary without a write',
    Math.max(12000, setup.expiryAt - Date.now() + 12000),
  );
  const expiringFile = setup.assessments.find((r) => r.kind === 'expiry').file;
  assert.equal(
    digest(await readFile(expiringFile)),
    setup.expiringFileSha256,
    'Clock invalidation must not rewrite or prune the fixture source',
  );
  assert(Date.now() >= setup.expiryAt);
  assert.equal(evidence.expired.connectionId, evidence.warm.connectionId);
  assert.equal(evidence.expired.timeOrigin, evidence.warm.timeOrigin);
  evidence.proxy = await proxyStatus();
  assert(!evidence.proxy.failure && !evidence.proxy.stopped);
  assert(Object.values(evidence.proxy.commands).every((n) => n === 0));
  await cdp('screenshot', tab, path.join(artifacts, 'history-expired-without-write.png'));
  claims.historyExpiry = true;
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
        'Open actual account menu',
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
        'Actual sign-out confirmation',
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
    path.join(artifacts, 'assessment-observation-proof.json'),
    JSON.stringify({ claims, evidence, failures: errors.map((e) => e.message) }, null, 2) + '\n',
    { mode: 0o600 },
  );
}
if (errors.length) throw new AggregateError(errors, 'Assessment observation proof failed');
console.log(JSON.stringify(claims));
