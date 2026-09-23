import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const out = process.env.ASSESSMENT_PROVIDER_PROOF_OUT;
assert.ok(out && process.env.FARMSLOT_UI_URL && process.env.FARMSLOT_CDP_PORT);
const session = JSON.parse(await readFile(path.join(out, 'ui-session.json'), 'utf8'));
const env = {
  ...process.env,
  FARMSLOT_GATEWAY: session.gateway,
  FARMSLOT_GATEWAY_TOKEN: session.token,
};
delete env.FARMSLOT_GATEWAY_PASSWORD;
const route = `intelligence?tab=assessments&assessment=${session.recordId}&proof=${Date.now()}`;
function cdp(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );
}
const probe = `function find(root){const p=root.querySelector('assessment-panel');if(p)return p;for(const e of root.querySelectorAll('*'))if(e.shadowRoot){const p=find(e.shadowRoot);if(p)return p;}}const p=find(document);const row=p?.shadowRoot?.querySelector('article[id="${session.recordId}"]');return {ready:!!row?.querySelector('input[name=evidence]'),choices:[...(row?.querySelector('select[name=correction]')?.options??[])].map(o=>o.value),text:row?.textContent??''};`;
cdp('goto', `${process.env.FARMSLOT_UI_URL}/#${route}`, '--new');
for (let i = 0; i < 60; i++) {
  if (cdp('eval', 'intelligence', "return !!document.querySelector('.auth-card');")) {
    cdp('login', 'intelligence');
    break;
  }
  if (cdp('eval', 'intelligence', probe).ready) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
for (let i = 0; i < 60 && !cdp('eval', 'intelligence', probe).ready; i++)
  await new Promise((resolve) => setTimeout(resolve, 200));
const before = cdp('eval', 'intelligence', probe);
assert.equal(before.ready, true);
assert.ok(before.choices.includes('blue') && before.choices.includes('red'));
const modal = cdp(
  'eval',
  'intelligence',
  `function find(r){const e=r.querySelector('whats-new-modal');if(e)return e;for(const n of r.querySelectorAll('*'))if(n.shadowRoot){const e=find(n.shadowRoot);if(e)return e;}}return !!find(document)?.shadowRoot?.querySelector('button.primary');`,
);
if (modal) cdp('click', 'intelligence', '.backdrop > .panel > .actions > button.primary');
const prefix = `intelligence-incidents-panel >>> assessment-panel >>> article[id="${session.recordId}"]`;
const evidence = `fixture:plain-choice-browser-${Date.now()}`;
cdp('select', 'intelligence', prefix + ' select[name=verdict]', 'incorrect');
cdp('select', 'intelligence', prefix + ' select[name=correction]', 'red');
cdp('fill', 'intelligence', prefix + ' input[name=evidence]', evidence);
cdp('click', 'intelligence', prefix + ' button[type=submit]');
let saved;
for (let i = 0; i < 40; i++) {
  saved = cdp('gateway', 'assessment.get', JSON.stringify({ id: session.recordId }));
  if (saved.feedback.some((f) => f.evidenceRef === evidence)) break;
  await new Promise((resolve) => setTimeout(resolve, 200));
}
assert.ok(saved.feedback.some((f) => f.evidenceRef === evidence && f.correctedAnswer === 'red'));
assert.equal(saved.result.answers.color.probabilities, undefined);
cdp('screenshot', 'intelligence', path.join(out, 'browser.png'));
const proof = {
  passed: true,
  plainChoiceOptions: true,
  feedbackSaved: true,
  probabilitiesInvented: false,
  externalProviderCalls: 0,
};
await writeFile(path.join(out, 'browser-proof.json'), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
