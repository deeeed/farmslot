import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
assert.equal(process.env.FARMSLOT_ASSESSMENT_VALIDATION, '1');
assert.ok(
  process.env.FARMSLOT_GATEWAY && process.env.FARMSLOT_UI_URL && process.env.FARMSLOT_CDP_PORT,
);
function cdp(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
}
function rpc(method, params = {}) {
  return cdp('gateway', method, JSON.stringify(params));
}
const record = rpc('assessment.list').records.find(
  (r) => r.subject.pr?.repo === 'example/assessment-fixture' && r.status === 'completed',
);
assert.ok(record);
cdp('goto', `intelligence?tab=assessments&assessment=${record.id}`);
const inspect = `function find(root){const p=root.querySelector('assessment-panel');if(p)return p;for(const e of root.querySelectorAll('*'))if(e.shadowRoot){const r=find(e.shadowRoot);if(r)return r}}const p=find(document);return {ready:!!p?.shadowRoot?.querySelector('article[id="${record.id}"] input[name=evidence]'),text:p?.shadowRoot?.textContent ?? ''};`;
for (let i = 0; i < 50; i++) {
  if (cdp('eval', 'intelligence', inspect).ready) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(cdp('eval', 'intelligence', inspect).ready, 'Detail must render real gateway data');
const reference = `fixture:browser-${Date.now()}`;
cdp(
  'fill',
  'intelligence',
  'intelligence-incidents-panel >>> assessment-panel >>> input[name=evidence]',
  reference,
);
cdp('click', 'intelligence', 'button[type=submit]');
let saved;
for (let i = 0; i < 30; i++) {
  saved = rpc('assessment.get', { id: record.id });
  if (saved.feedback.some((f) => f.evidenceRef === reference)) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
assert.ok(
  saved.feedback.some((f) => f.evidenceRef === reference),
  'Browser feedback must persist through RPC',
);
assert.match(cdp('eval', 'intelligence', inspect).text, /needs-review/);
console.log(
  JSON.stringify({
    browserFeedbackSaved: true,
    recordId: record.id,
    revision: saved.feedback.length,
  }),
);

const smoke = rpc('assessment.test', { provider: 'missing-validation-provider' });
assert.ok(smoke.assessmentId, 'Synthetic smoke attempt must be recorded');
const nonReview = rpc('assessment.get', { id: smoke.assessmentId });
{
  cdp('goto', `intelligence?tab=assessments&assessment=${nonReview.id}`);
  let disabled = false;
  for (let i = 0; i < 40; i++) {
    disabled = cdp(
      'eval',
      'intelligence',
      `function find(root){const p=root.querySelector('assessment-panel');if(p)return p;for(const e of root.querySelectorAll('*'))if(e.shadowRoot){const r=find(e.shadowRoot);if(r)return r}}const p=find(document);return Boolean(p?.shadowRoot?.querySelector('article[id="${nonReview.id}"]') && p.shadowRoot.querySelector('button[data-action=export]')?.disabled);`,
    );
    if (disabled) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(disabled, true, 'A smoke test cannot export a PR comparison case');
  console.log(JSON.stringify({ invalidCaseExportDisabled: true }));
}
