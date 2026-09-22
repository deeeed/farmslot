// Seed --pagination before startup. Real RPC insertion plus real CDP form input.
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
const root = 'intelligence-incidents-panel >>> assessment-panel >>> ';
const panel = `document.querySelector('intelligence-incidents-panel')?.shadowRoot?.querySelector('assessment-panel')?.shadowRoot`;
async function waitFor(expression) {
  for (let i = 0; i < 80; i++) {
    if (cdp('eval', 'intelligence', `return Boolean(${expression})`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`UI condition failed: ${expression}`);
}
cdp('goto', 'intelligence?tab=assessments');
await waitFor(
  `${panel}?.querySelectorAll('article').length >= 50 && !${panel}?.querySelector('button[data-action=refresh]')?.disabled`,
);
const recent = rpc('assessment.list', { limit: 50 }).records.find(
  (r) => r.status === 'completed' && r.subject.pr?.repo === 'example/assessment-fixture',
);
assert.ok(recent);
const ref = `fixture:retained-draft-${Date.now()}`;
const selector = `article[id="${recent.id}"] form[data-question="risk"]`;
if (
  !cdp(
    'eval',
    'intelligence',
    `return ${panel}.querySelector('article[id="${recent.id}"] details').open`,
  )
)
  cdp('click', 'intelligence', `article[id="${recent.id}"] summary`);
cdp('fill', 'intelligence', root + selector + ' input[name=evidence]', ref);
// Retain only a DOM reference for an identity assertion. Never inject form values.
cdp(
  'eval',
  'intelligence',
  `window.assessmentProofForm=${panel}.querySelector(${JSON.stringify(selector)});return true;`,
);
rpc('assessment.test', { provider: 'missing-validation-provider' });
cdp('click', 'intelligence', 'button[data-action=refresh]');
await waitFor(`!${panel}?.querySelector('button[data-action=refresh]')?.disabled`);
const draft = cdp(
  'eval',
  'intelligence',
  `const f=${panel}.querySelector(${JSON.stringify(selector)});return {same:f===window.assessmentProofForm,value:f.querySelector('input[name=evidence]').value};`,
);
assert.equal(draft.same, true);
assert.equal(draft.value, ref);
cdp('click', 'intelligence', selector + ' button[type=submit]');
await waitFor(`!${panel}?.querySelector('button[data-action=refresh]')?.disabled`);
assert.ok(rpc('assessment.get', { id: recent.id }).feedback.some((f) => f.evidenceRef === ref));
const first = rpc('assessment.list', { limit: 50 });
assert.ok(first.nextCursor, 'Seed at least 55 startup rows');
const older = rpc('assessment.list', { limit: 50, before: first.nextCursor }).records.find(
  (r) => r.status === 'completed',
);
assert.ok(older);
if (
  !cdp(
    'eval',
    'intelligence',
    `return Boolean(${panel}?.querySelector('article[id="${older.id}"]'))`,
  )
)
  cdp('click', 'intelligence', 'button[data-action=older]');
await waitFor(`${panel}?.querySelector('article[id="${older.id}"]')`);
if (
  !cdp(
    'eval',
    'intelligence',
    `return ${panel}.querySelector('article[id="${older.id}"] details').open`,
  )
)
  cdp('click', 'intelligence', `article[id="${older.id}"] summary`);
for (const question of ['risk', 'visualReview']) {
  const form = `article[id="${older.id}"] form[data-question="${question}"]`;
  cdp('fill', 'intelligence', root + form + ' input[name=evidence]', `fixture:older-${question}`);
  cdp('click', 'intelligence', form + ' button[type=submit]');
  await waitFor(`!${panel}?.querySelector('button[data-action=refresh]')?.disabled`);
}
const saved = rpc('assessment.get', { id: older.id });
assert.equal(saved.feedback.length, older.feedback.length + 2);
const current = rpc('assessment.list', { limit: 100 }).records;
assert.equal(current.filter((r) => r.feedback.some((f) => f.evidenceRef === ref)).length, 1);
console.log(
  JSON.stringify({
    draftPreserved: true,
    correctRecord: recent.id,
    olderRevision: saved.feedback.length,
    twoOlderSaves: true,
  }),
);
