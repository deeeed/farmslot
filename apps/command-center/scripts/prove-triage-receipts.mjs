import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
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
const artifacts = process.env.FARMSLOT_TRIAGE_PROOF_ARTIFACTS;
assert.equal(path.dirname(artifacts), path.dirname(process.env.FARMSLOT_TRIAGE_PROOF_SETUP));
await mkdir(artifacts, { recursive: true });
const proxy = JSON.parse(
  await readFile(
    path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
    'utf8',
  ),
);
assert.equal(proxy.method, 'intelligence.triage.get');
assert.equal(setup.home, process.env.FARMSLOT_HOME);
assert(!process.env.TYPESAFE_API_KEY, 'Read-only proof requires no provider credential');
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
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = { writes: [] };
const claims = {};
const errors = [];
let tab;
async function until(read, accepts, label) {
  const end = Date.now() + 12000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(50);
  } while (Date.now() < end);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const inspect = () =>
  cdp(
    'eval',
    tab,
    `
 function find(root){const panel=root.querySelector('failure-triage-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const found=find(child.shadowRoot);if(found)return found;}}
 const panel=find(document);if(!panel)return {mounted:false};
 const url=(suffix)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(suffix)).at(-1);
 const {gateway}=await import(url('/src/gateway-client.ts'));const {getResourceCache}=await import(url('/src/resource-cache.ts'));
 const controller=Reflect.get(panel,'observation'),query=Reflect.get(controller,'query'),state=controller.state;
 if(controller.belongsToWorkspace&&getResourceCache()?.read(query)!==state)throw Error('Inspect the canonical triage query');
 const r=panel.shadowRoot;return {mounted:true,runId:panel.runId,timeOrigin:performance.timeOrigin,connectionId:gateway.resourceConnectionId,ready:controller.ready,status:state.status,error:state.error,queryId:query?.id,persisted:query?.persisted,observedAt:state.observedAt,resourceState:state.resourceState,view:state.data,text:r?.textContent,analyzeDisabled:r?.querySelector('[data-triage-action=analyze]')?.disabled,buttons:[...r.querySelectorAll('button')].map(b=>b.textContent.trim())};
`,
  );
const revision = (view) =>
  view.resourceState.dependencies.find(
    ({ key }) => key.family === 'assessment' && key.scope === 'farm',
  ).revision;
async function settled() {
  let previous;
  let stable = Date.now();
  return until(
    inspect,
    (view) => {
      const signature = view.ready ? `${revision(view)}:${view.observedAt}` : 'pending';
      if (signature !== previous) stable = Date.now();
      previous = signature;
      return view.ready && Date.now() - stable >= 250;
    },
    'Wait for the actual source notifications to settle',
  );
}
async function visible(expected, previous, label) {
  const view = await until(
    inspect,
    (value) =>
      value.runId === setup.runId &&
      value.ready &&
      value.view?.availability === expected &&
      (!previous || revision(value) > revision(previous)),
    label,
  );
  assert(view.analyzeDisabled);
  assert.equal(view.persisted, false);
  assert(
    !view.buttons.includes('Refresh'),
    'Source observation replaces the always-visible Refresh',
  );
  return view;
}
async function replace(file, bytes) {
  assert(setup.receipts.some((directory) => path.dirname(file) === directory));
  const before = await readFile(file);
  const temporary = file + '.proof-replacement';
  await writeFile(temporary, bytes, { flag: 'wx' });
  assert.equal(hash(await readFile(file)), hash(before));
  await rename(temporary, file);
  evidence.writes.push({ file, before: hash(before), after: hash(bytes), at: Date.now() });
}
try {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert.equal(url.origin, 'http://127.0.0.1:5195');
  url.searchParams.set('triage-receipts', path.basename(path.dirname(artifacts)));
  url.hash = `run/${setup.runId}?projects=${setup.project}`;
  tab = '@' + (await cdp('goto', url.href, '--new')).id;
  const login = await until(
    () =>
      cdp(
        'eval',
        tab,
        "return {auth:Boolean(document.querySelector('.auth-card')),connected:document.querySelector('farm-app')?.connection==='connected'}",
      ),
    (s) => s.auth || s.connected,
    'Actual triage login state',
  );
  if (login.auth) assert((await cdp('login', tab)).authenticated);
  await until(
    inspect,
    (view) => view.mounted && view.runId === setup.runId,
    'Actual failed-run triage panel',
  );
  await cdp('click', tab, '#failure-triage-summary');
  evidence.initial = await visible(
    'missing-key',
    undefined,
    'Approved receipts must reach the actual credential prerequisite',
  );
  const selected = path.join(setup.receipts[0], 'evaluation.json');
  const original = await readFile(selected);
  await replace(selected, Buffer.from('{}\n'));
  evidence.corrupt = await visible(
    'unavailable',
    evidence.initial,
    'Editing admitted receipt bytes must update mounted triage without Refresh',
  );
  assert(evidence.corrupt.view.reason.includes('receipts are missing or changed'));
  await cdp('screenshot', tab, path.join(artifacts, 'receipt-change-visible.png'));
  await replace(selected, original);
  evidence.restored = await visible(
    'missing-key',
    evidence.corrupt,
    'Restoring exact receipt bytes must recover without Refresh',
  );
  claims.receiptChangeAndRecovery = true;
  const candidate = path.join(setup.receipts[0], 'candidate-results.json');
  const candidateBytes = await readFile(candidate);
  await unlink(candidate);
  evidence.missing = await visible(
    'unavailable',
    evidence.restored,
    'A removed admitted receipt must invalidate the mounted view',
  );
  await writeFile(candidate, candidateBytes, { flag: 'wx' });
  evidence.recreated = await visible(
    'missing-key',
    evidence.missing,
    'A recreated admitted receipt must recover',
  );
  claims.receiptRemovalAndRecreation = true;
  const beforeSwitch = await settled();
  const second = path.join(setup.receipts[1], 'evaluation.json');
  const secondBytes = await readFile(second);
  await replace(second, Buffer.from('{}\n'));
  await delay(150);
  const unchanged = await inspect();
  assert.equal(
    revision(unchanged),
    revision(beforeSwitch),
    'Unselected receipts cannot invalidate this view',
  );
  assert.equal(unchanged.view.availability, 'missing-key');
  const policy = Buffer.from(
    JSON.stringify({ ...setup.policy, receiptDirectory: setup.receipts[1] }) + '\n',
  );
  assert(setup.allowedPolicyHashes.includes(hash(policy)));
  await writeFile(setup.policyFile, policy);
  evidence.switched = await visible(
    'unavailable',
    unchanged,
    'A real policy switch must select its new evidence source',
  );
  await replace(second, secondBytes);
  evidence.newSelectedRestored = await visible(
    'missing-key',
    evidence.switched,
    'The new selected directory must recover',
  );
  const beforeRetired = await settled();
  await replace(selected, Buffer.from('{}\n'));
  await delay(150);
  evidence.retiredUnchanged = await inspect();
  assert.equal(revision(evidence.retiredUnchanged), revision(beforeRetired));
  assert.equal(evidence.retiredUnchanged.view.availability, 'missing-key');
  claims.policySwitchRetiresOldSource = true;
  assert.equal(evidence.initial.timeOrigin, evidence.retiredUnchanged.timeOrigin);
  assert.equal(evidence.initial.connectionId, evidence.retiredUnchanged.connectionId);
  const status = await (await fetch('http://127.0.0.1:7915/planning-race-status')).json();
  assert.equal(status.startId, proxy.startId);
  assert(!status.failure && !status.stopped);
  assert(Object.values(status.commands).every((count) => count === 0));
  assert(status.requests.filter((row) => row.observed).length >= 6);
  evidence.proxy = status;
  claims.readOnlyNoProviderCommands = true;
  await cdp('screenshot', tab, path.join(artifacts, 'new-selected-source-recovered.png'));
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
        'Actual account menu',
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
        'Actual sign-out dialog',
      );
      await cdp('click', tab, '[data-testid="account-sign-out-confirm"]');
      await until(
        () => cdp('eval', tab, "return Boolean(document.querySelector('.auth-card'))"),
        Boolean,
        'Normal sign-out',
      );
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
    path.join(artifacts, 'triage-receipt-proof.json'),
    JSON.stringify({ claims, evidence, failures: errors.map((e) => e.message) }, null, 2) + '\n',
    { mode: 0o600 },
  );
}
if (errors.length) throw new AggregateError(errors, 'Triage receipt source proof failed');
console.log(JSON.stringify(claims));
