import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = process.env.TRIAGE_PILOT_PROOF_OUT;
assert.ok(
  out && process.env.FARMSLOT_UI_URL && process.env.FARMSLOT_CDP_PORT,
  'Use a kept gateway proof, its configured UI and an owned CDP browser',
);
const gatewayProof = JSON.parse(await readFile(path.join(out, 'proof.json'), 'utf8'));
assert.equal(gatewayProof.mode, 'simulated');
const recoverNoCall = process.argv.includes('--recover-no-call');
assert.ok(process.argv.slice(2).every((a) => a === '--recover-no-call'));
if (!recoverNoCall) {
  const policyFile = path.join(out, 'home/triage-policy.json');
  const policy = JSON.parse(await readFile(policyFile, 'utf8'));
  const sourceFile = path.join(out, 'root/.omx/logs/validation/failure.log');
  const source =
    (await readFile(sourceFile, 'utf8')) + 'Fresh browser observation: ' + Date.now() + '\n';
  await writeFile(sourceFile, source);
  policy.approvals[0].sources[0].digest = createHash('sha256').update(source).digest('hex');
  await writeFile(policyFile, JSON.stringify(policy));
}
const session = JSON.parse(await readFile(path.join(out, 'ui-session.json'), 'utf8'));
const route = `run/${session.runId}?step=validation&proof=triage-browser-${Date.now()}`;
const env = {
  ...process.env,
  FARMSLOT_GATEWAY: session.gateway,
  FARMSLOT_GATEWAY_TOKEN: session.token,
};
delete env.FARMSLOT_GATEWAY_PASSWORD;
function cdp(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}
const probe = `
  function find(root, selector) { const e=root.querySelector(selector);if(e)return e;for(const n of root.querySelectorAll('*'))if(n.shadowRoot){const found=find(n.shadowRoot,selector);if(found)return found;} }
  const p=find(document,'failure-triage-panel');const d=p?.shadowRoot?.querySelector('details');
  const text=d?.textContent ?? '';
  return { found:!!p, open:!!d?.open, state:p?.shadowRoot?.querySelector('[data-triage-state]')?.textContent?.trim(),
    noCall:text.includes('No provider call was made'), savedAdvice:text.includes('Saved advice;'),
    button:p?.shadowRoot?.querySelector('[data-triage-action=analyze]')?.textContent?.trim(),
    feedback:text.includes('Saved feedback: correct'), corrected:text.includes('corrected cause: test_harness'), redacted:text.includes('[REDACTED]'),
    canaryAbsent:!text.includes('triage-canary-private'), approvedModel:text.includes('Returned model: jev-1.13.0'),
    inputVisible:!!p?.shadowRoot?.querySelector('pre') };
`;
async function waitFor(predicate) {
  for (let i = 0; i < 60; i++) {
    const result = cdp('eval', route, probe);
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Browser did not reach the expected triage state');
}
const count = async () =>
  (await readFile(path.join(out, 'requests.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
    .length;
cdp('goto', `${process.env.FARMSLOT_UI_URL.replace(/\/$/, '')}/#${route}`, '--new');
for (let i = 0; i < 60; i++) {
  if (cdp('eval', route, "return !!document.querySelector('.auth-card');")) {
    cdp('login', route);
    break;
  }
  if (cdp('eval', route, probe).found) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const modal = cdp(
  'eval',
  route,
  `function find(r){const e=r.querySelector('whats-new-modal');if(e)return e;for(const n of r.querySelectorAll('*'))if(n.shadowRoot){const e=find(n.shadowRoot);if(e)return e;}}return !!find(document)?.shadowRoot?.querySelector('button.primary');`,
);
if (modal) cdp('click', route, '.backdrop > .panel > .actions > button.primary');
await waitFor((r) => r.found && !['loading', 'loading configuration'].includes(r.state));
cdp('click', route, '#failure-triage-summary');
const before = await waitFor((r) => r.open);
if (recoverNoCall) {
  assert.equal(before.state, 'not assessed');
  assert.equal(before.noCall, true);
  assert.equal(before.savedAdvice, false);
  assert.equal(before.button, 'Retry advice once');
} else assert.equal(before.button, 'Analyze once');
const requestsBefore = await count();
cdp('click', route, '[data-triage-action="analyze"]');
const completed = await waitFor((r) => r.state === 'completed');
assert.equal(completed.approvedModel, true, 'Browser must show returned model identity');
assert.equal(await count(), requestsBefore + 1);
cdp(
  'select',
  route,
  'run-detail >>> failure-triage-panel >>> #failure-triage-correction',
  'test_harness',
);
cdp('click', route, '[data-triage-feedback="incorrect"]');
await waitFor((r) => r.state === 'completed' && r.corrected);
cdp('click', route, '[data-triage-feedback="correct"]');
await waitFor((r) => r.feedback && r.state === 'completed');
cdp('click', route, '[data-triage-action="evidence"]');
const final = await waitFor((r) => r.inputVisible && r.state === 'completed');
assert.equal(final.canaryAbsent, true);
assert.equal(final.redacted, true);
assert.equal(final.approvedModel, true);
const cachedCount = await count();
cdp('click', route, '[data-triage-action="analyze"]');
await waitFor((r) => r.state === 'completed');
assert.equal(await count(), cachedCount, 'Cached UI advice triggered another request');
cdp('screenshot', route, path.join(out, 'browser.png'));
await writeFile(
  path.join(out, 'browser-proof.json'),
  JSON.stringify(
    {
      passed: true,
      ...final,
      requestsBefore,
      requestsAfter: cachedCount,
      externalProviderCalls: 0,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    passed: true,
    route,
    screenshot: path.join(out, 'browser.png'),
    externalProviderCalls: 0,
  }),
);

const saved = cdp('gateway', 'intelligence.triage.get', JSON.stringify({ runId: session.runId }));
const auditRoute = `intelligence?tab=assessments&assessment=${saved.record.id}`;
cdp('goto', `${process.env.FARMSLOT_UI_URL.replace(/\/$/, '')}/#${auditRoute}`);
const auditProbe = `function find(r){const p=r.querySelector('assessment-panel');if(p)return p;for(const e of r.querySelectorAll('*'))if(e.shadowRoot){const p=find(e.shadowRoot);if(p)return p;}}const p=find(document);return {detail:!!p?.shadowRoot?.querySelector('article[id="${saved.record.id}"]'),text:p?.shadowRoot?.textContent??''};`;
let audit;
for (let i = 0; i < 60; i++) {
  audit = cdp('eval', 'intelligence', auditProbe);
  if (audit.detail) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(audit?.detail, 'Triage record must appear in shared assessment history');
assert.match(audit.text, /failure-triage/);
assert.match(audit.text, /confirmed provider attempts/);
assert.match(audit.text, /unknown charges/);
assert.match(audit.text, /Workflow savings:/);
assert.ok(audit.text.includes(session.runId));
assert.equal(await count(), cachedCount, 'Monitoring must not invoke the provider');
cdp('screenshot', 'intelligence', path.join(out, 'monitoring.png'));
console.log(JSON.stringify({ monitoringPassed: true, providerCallsAdded: 0 }));
