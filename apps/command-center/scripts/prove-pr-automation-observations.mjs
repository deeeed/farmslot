// Mounted PR observations, external rule writes and error-only Retry on a private stack.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert.equal(process.env.FARMSLOT_PR_AUTOMATION_PROOF, '1');
const target = await automationGatewayTarget();
assert.equal(new URL(target.url).origin, 'ws://127.0.0.1:7913');
const output = process.env.FARMSLOT_TRIAGE_PROOF_SETUP;
const setup = JSON.parse(await readFile(output, 'utf8'));
assert.equal(setup.home, process.env.FARMSLOT_HOME);
const fixture = setup.prFixture;
assert(fixture.seededBeforeUi && fixture.ruleId && fixture.ownerId);
assert.equal(fixture.farm, process.env.FARMSLOT_ROOT);
const artifacts = path.resolve(process.env.FARMSLOT_TRIAGE_PROOF_ARTIFACTS);
assert.equal(path.dirname(artifacts), path.dirname(output));
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
const checkpoint = () => writeFile(output, JSON.stringify(setup) + '\n', { mode: 0o600 });
const rulesFile = path.join(fixture.farm, '.pr-rules.json');
const pushFile = path.join(fixture.farm, '.pr-push.json');
const claims = {};
const evidence = {};
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
async function remember(name) {
  const bytes = await readFile(path.join(fixture.farm, name));
  const sha256 = digest(bytes);
  fixture.allowedHashes[name].push(sha256);
  await checkpoint();
  return { file: path.join(fixture.farm, name), sha256 };
}
async function replaceRules(bytes) {
  fixture.allowedHashes['.pr-rules.json'].push(digest(bytes));
  const temporary = path.join(fixture.farm, '.pr-rules.d07-' + randomUUID());
  fixture.temporaries.push({ file: temporary, sha256: digest(bytes) });
  await checkpoint();
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, rulesFile);
}
const inspect = () =>
  cdp(
    'eval',
    tab,
    `
 function find(root){const panel=root.querySelector('pr-automation-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot);if(found)return found;}}
 const panel=find(document);if(!panel)return {mounted:false};
 const url=(suffix)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(suffix)).at(-1);
 const {gateway}=await import(url('/src/gateway-client.ts'));const {getResourceCache}=await import(url('/src/resource-cache.ts'));
 const controller=Reflect.get(panel,'controller');
 const observers=['watchResources','ruleResources','pushResources'].map(name=>{const observer=Reflect.get(controller,name),query=Reflect.get(observer,'query'),state=observer.state;if(!observer.belongsToWorkspace||getResourceCache()?.read(query)!==state)throw Error('Inspect actual canonical PR observations');return {name,method:query.method,queryId:query.id,ready:observer.ready,status:state.status,error:state.error,data:state.data,resourceState:state.resourceState};});
 const buttons=[...panel.shadowRoot.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {testid:b.dataset.testid,label:b.textContent.trim(),disabled:b.disabled,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};});
 return {mounted:true,connected:controller.connected,canRetry:controller.canRetryRead,error:controller.error,mode:panel.mode,tab:Reflect.get(panel,'tab'),observers,buttons,text:panel.shadowRoot.textContent,connectionId:gateway.resourceConnectionId,timeOrigin:performance.timeOrigin};
`,
  );
const observation = (view, method) => view.observers.find((value) => value.method === method);
const revision = (view, method) =>
  observation(view, method).resourceState.dependencies.find(
    ({ key }) => key.family === 'pr-automation',
  ).revision;
async function settled() {
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
    'PR reads must settle',
  );
}
try {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  url.searchParams.set('pr-observations', path.basename(path.dirname(artifacts)));
  url.hash = 'prs?prSection=automation&prTab=rules';
  tab = '@' + (await cdp('goto', url.href, '--new')).id;
  const login = await until(
    () =>
      cdp(
        'eval',
        tab,
        "return {auth:Boolean(document.querySelector('.auth-card')),connected:document.querySelector('farm-app')?.connection==='connected'}",
      ),
    (v) => v.auth || v.connected,
    'Actual private sign-in',
  );
  if (login.auth) assert((await cdp('login', tab)).authenticated);
  evidence.warm = await until(
    inspect,
    (v) => v.connected && v.mode === 'management' && v.text.includes(fixture.ruleName),
    'Actual current automation rules',
  );
  assert(
    !evidence.warm.buttons.some((b) =>
      ['Refresh configuration', 'Retry configuration'].includes(b.label),
    ),
  );
  await cdp('screenshot', tab, path.join(artifacts, 'healthy-no-refresh.png'));
  const source = JSON.parse(await readFile(rulesFile, 'utf8'));
  const rule = source.rules.find((r) => r.id === fixture.ruleId);
  assert(rule && rule.ownerId === fixture.ownerId);
  const name = 'External observed rule ' + randomUUID();
  rule.config.name = name;
  const validBytes = Buffer.from(JSON.stringify(source) + '\n');
  await replaceRules(validBytes);
  evidence.rule = await until(
    inspect,
    (v) =>
      v.connected &&
      v.text.includes(name) &&
      observation(v, 'prRules.list').data.rules.some(
        (r) => r.id === fixture.ruleId && r.config.name === name,
      ) &&
      revision(v, 'prRules.list') > revision(evidence.warm, 'prRules.list'),
    'External rule replacement must update the mounted rule without Refresh',
  );
  evidence.ruleSource = await remember('.pr-rules.json');
  await cdp('screenshot', tab, path.join(artifacts, 'rule-updated.png'));
  claims.ruleSourceUpdates = true;

  await cdp('click', tab, '[data-testid="pr-automation-tab-attention"]');
  evidence.attention = await until(
    inspect,
    (v) => v.connected && v.tab === 'attention',
    'Actual Notifications panel',
  );
  const registration = {
    installationId: fixture.installationId,
    token: `ExpoPushToken[D07Fixture_${fixture.installationId}]`,
    platform: 'ios',
    profileId: fixture.profileId,
    enabled: false,
    sound: false,
  };
  evidence.register = await rpc('prPush.register', registration);
  assert(evidence.register.device && !evidence.register.device.enabled);
  evidence.pushSource = await remember('.pr-push.json');
  evidence.push = await until(
    inspect,
    (v) =>
      v.connected &&
      v.text.includes(fixture.profileId) &&
      v.text.includes('Push disabled') &&
      observation(v, 'prPush.list').data.devices.some(
        (d) => d.installationId === fixture.installationId && !d.enabled,
      ) &&
      revision(v, 'prPush.list') > revision(evidence.attention, 'prPush.list'),
    'Actual disabled registration must update the mounted notification inventory',
  );
  assert(
    !JSON.stringify(observation(evidence.push, 'prPush.list').data).includes(registration.token),
    'The observation must not expose its registration token',
  );
  assert.equal(
    JSON.parse(await readFile(pushFile, 'utf8')).devices.find(
      (d) => d.installationId === fixture.installationId,
    ).enabled,
    false,
  );
  await cdp('screenshot', tab, path.join(artifacts, 'disabled-registration-observed.png'));
  claims.pushSourceUpdates = true;

  await cdp('click', tab, '[data-testid="pr-automation-tab-rules"]');
  await until(inspect, (v) => v.connected && v.tab === 'rules', 'Return to actual rules');
  await replaceRules(Buffer.from('{broken d07 private rule fixture'));
  evidence.failed = await until(
    inspect,
    (v) =>
      !v.connected &&
      observation(v, 'prRules.list').error?.code === 'SOURCE_UNAVAILABLE' &&
      v.text.includes(name) &&
      v.buttons.some((b) => b.testid === 'pr-automation-read-retry' && !b.disabled && b.visible),
    'A failed live read must expose enabled Retry even though mutation readiness is false',
  );
  await cdp('screenshot', tab, path.join(artifacts, 'source-error-enabled-retry.png'));
  const beforeRetry = await settled();
  const failedMethods = evidence.failed.observers.filter((o) => o.error).map((o) => o.method);
  evidence.retryMethods = failedMethods;
  await cdp('click', tab, '[data-testid="pr-automation-read-retry"]');
  evidence.retry = await until(
    proxyStatus,
    (v) =>
      failedMethods.every(
        (method) => (v.observedReads[method] ?? 0) > (beforeRetry.observedReads[method] ?? 0),
      ),
    'Actual Retry must reread every failed query',
  );
  for (const method of evidence.failed.observers.filter((o) => !o.error).map((o) => o.method))
    assert.equal(
      evidence.retry.observedReads[method],
      beforeRetry.observedReads[method],
      'Retry must not reread healthy configuration',
    );
  assert(
    evidence.retry.prReplies.some(
      (reply) =>
        reply.method === 'prRules.list' &&
        !reply.ok &&
        reply.requestAt > beforeRetry.prReplies.at(-1).requestAt,
    ),
  );
  await cdp(
    'eval',
    tab,
    "location.hash='prs?prSection=prs&prScope=monitored&prPane=monitoring&repo=proof%2Foffline-store&pr=1&view=detail&layout=list';return {hash:location.hash}",
  );
  evidence.context = await until(
    inspect,
    (v) =>
      v.mode === 'context' &&
      !v.connected &&
      v.buttons.some((b) => b.testid === 'pr-automation-read-retry' && !b.disabled && b.visible),
    'The per-PR context must also expose enabled read-error Retry',
  );
  await cdp('screenshot', tab, path.join(artifacts, 'context-read-error-retry.png'));
  const beforeContextRetry = await settled();
  await cdp('click', tab, '[data-testid="pr-automation-read-retry"]');
  evidence.contextRetry = await until(
    proxyStatus,
    (v) =>
      failedMethods.every(
        (method) =>
          (v.observedReads[method] ?? 0) > (beforeContextRetry.observedReads[method] ?? 0),
      ),
    'Actual per-PR Retry must reread failed queries',
  );
  await cdp(
    'eval',
    tab,
    "location.hash='prs?prSection=automation&prTab=rules';return {hash:location.hash}",
  );
  await until(inspect, (v) => v.mode === 'management', 'Return to management');
  await replaceRules(validBytes);
  evidence.recovered = await until(
    inspect,
    (v) =>
      v.connected &&
      !v.error &&
      v.text.includes(name) &&
      !v.buttons.some((b) => b.testid === 'pr-automation-read-retry'),
    'Repaired source must recover the mounted observations and remove Retry',
  );
  assert.deepEqual(
    evidence.recovered.observers.map((o) => o.queryId),
    evidence.failed.observers.map((o) => o.queryId),
  );
  evidence.finalPushSource = await remember('.pr-push.json');
  for (const key of ['rule', 'push', 'failed', 'context', 'recovered']) {
    assert.equal(evidence[key].connectionId, evidence.warm.connectionId);
    assert.equal(evidence[key].timeOrigin, evidence.warm.timeOrigin);
  }
  evidence.proxy = await proxyStatus();
  assert(!evidence.proxy.failure && !evidence.proxy.stopped);
  assert(Object.values(evidence.proxy.commands).every((n) => n === 0));
  await cdp('screenshot', tab, path.join(artifacts, 'recovered-no-refresh-or-retry.png'));
  claims.errorOnlyRetry = true;
} catch (error) {
  errors.push(error);
  if (tab) {
    try {
      evidence.failureView = await inspect();
    } catch (capture) {
      errors.push(capture);
    }
    try {
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
    path.join(artifacts, 'pr-automation-observation-proof.json'),
    JSON.stringify({ claims, evidence, failures: errors.map((e) => e.message) }, null, 2) + '\n',
    { mode: 0o600 },
  );
}
if (errors.length) throw new AggregateError(errors, 'PR automation observation proof failed');
console.log(JSON.stringify(claims));
