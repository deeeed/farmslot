// Requires the authenticated workspace.rpc.live.ts UI fixture and its real CC tab.
// Real clicks in the Fleet table: the bulk release releases exactly the ticked safe rows, a filter
// that hides the selection disables it, and a finished release clears the selection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = process.env.FARMSLOT_WORKSPACE_UI_PROOF_OUT;
assert.ok(output, 'Set the disposable UI fixture output');
const context = JSON.parse(fs.readFileSync(path.join(output, 'ui-context.json'), 'utf8'));
// Real Git is the release's ground truth: proof-slot, proof-slot-two and proof-unpublished.
const checkouts = {
  'proof-slot': context.repo,
  'proof-slot-two': context.secondRepo,
  'proof-unpublished': context.localRepo,
};
const branches = () =>
  Object.fromEntries(
    Object.entries(checkouts).map(([slot, repo]) => [
      slot,
      execFileSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
    ]),
  );
const cdp = fileURLToPath(new URL('../cdp.mjs', import.meta.url));
const route = process.env.FARMSLOT_WORKSPACE_PROOF_ROUTE ?? 'fleet?proof=fleet1490&view=list';
const browser = (...args) =>
  execFileSync(process.execPath, [cdp, ...args], { encoding: 'utf8', env: process.env });
const read = (body) =>
  JSON.parse(
    browser(
      'eval',
      route,
      `const deep=(s,r=document)=>[...r.querySelectorAll(s),...[...r.querySelectorAll('*')].flatMap(e=>e.shadowRoot?deep(s,e.shadowRoot):[])];${body}`,
    ),
  );
const poll = async (probe, predicate, label) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const value = await probe();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const trigger = () =>
  read(
    `const b=deep('.fleet-refresh-trigger')[0];const ticked=deep('.slot-row input[type=checkbox]').filter(e=>e.checked).map(e=>e.getAttribute('aria-label'));return {label:b?.textContent.trim(),title:b?.title,disabled:b?.disabled,ticked};`,
  );
const modal = () =>
  read(
    `const root=document.querySelector('fleet-canvas')?.shadowRoot.querySelector('fleet-refresh-modal')?.shadowRoot;const bulk=root?.querySelector('footer button');return {rows:[...(root?.querySelectorAll('article[data-slot]')??[])].map(e=>e.dataset.slot).sort(),checking:!!root?.textContent.includes('Checking current'),bulk:bulk?.textContent.trim(),bulkDisabled:bulk?.disabled};`,
  );

const dismiss = read(
  `const b=deep('button').find(e=>e.textContent.trim()==='Got it');if(b)b.click();return true;`,
);
assert.equal(dismiss, true);
await poll(
  () => read(`return deep('input[aria-label="Select proof-unpublished"]').length;`),
  (count) => count === 1,
  'the fixture rows in the Fleet table',
);
const idle = await poll(
  trigger,
  (value) => value.title === 'Select slots to release',
  'the current fleet read before selection',
);
assert.equal(idle.disabled, true, 'Nothing selected disables the bulk release');
assert.equal(idle.title, 'Select slots to release');

if (read(`return deep('whats-new-modal').some(e=>e.open);`))
  browser('click', route, 'whats-new-modal >>> button.primary');

// A narrow toolbar must retain its height when the disabled reason disappears.
browser('viewport', route, '390', '900');
const geometry = () =>
  read(`
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const box = selector => { const r = deep(selector)[0].getBoundingClientRect(); return {y:r.y,height:r.height}; };
  return {width:innerWidth,button:box('.fleet-refresh-trigger'),hint:box('.fleet-release-hint'),row:box('.slot-row')};
`);
const idleGeometry = geometry();
browser(
  'screenshot',
  route,
  path.join(output, 'fleet-narrow-unselected.png'),
  '--width',
  '390',
  '--height',
  '900',
);

// Run before the recovery node. Leave proof-slot-two for the later native bulk proof.
const before = branches();
assert.deepEqual(before, {
  'proof-slot': 'previous',
  'proof-slot-two': 'previous-two',
  'proof-unpublished': 'local-only',
});

// Tick one safe row and one with local work; proof-slot-two stays unselected.
for (const slot of ['proof-slot', 'proof-unpublished']) {
  await poll(
    () => {
      // Release notes may arrive after the first fleet rows. Dismiss the real overlay first.
      if (read(`return deep('whats-new-modal').some(e=>e.open);`))
        browser('click', route, 'whats-new-modal >>> button.primary');
      const selector = `input[aria-label="Select ${slot}"]`;
      if (!read(`return deep('${selector}')[0]?.checked;`)) browser('click', route, selector);
      return read(`return deep('${selector}')[0]?.checked;`);
    },
    Boolean,
    `the selected ${slot} row`,
  );
}
const chosen = await poll(
  trigger,
  (value) => value.ticked.length === 2 && !value.disabled,
  'two ticked rows with a current fleet read',
);
assert.equal(chosen.label, 'Release and update to main (2 selected)');
assert.equal(chosen.disabled, false);

const chosenGeometry = geometry();
for (const part of ['button', 'hint', 'row']) {
  assert.ok(
    Math.abs(idleGeometry[part].y - chosenGeometry[part].y) < 1,
    `${part} moved after selection`,
  );
  assert.ok(
    Math.abs(idleGeometry[part].height - chosenGeometry[part].height) < 1,
    `${part} resized after selection`,
  );
}
browser(
  'screenshot',
  route,
  path.join(output, 'fleet-narrow-selected.png'),
  '--width',
  '390',
  '--height',
  '900',
);
browser('viewport', route, '1440', '900');

// A search that hides the selection disables the action; it never widens to proof-slot.
browser('fill', route, 'fleet-canvas >>> .toolbar input', 'no-such-slot');
const hidden = await poll(
  trigger,
  (value) => value.title === 'The selected slots are hidden by the current filters',
  'the hidden selection on a current fleet read',
);
assert.equal(hidden.title, 'The selected slots are hidden by the current filters');
browser('fill', route, 'fleet-canvas >>> .toolbar input', 'proof');
await poll(trigger, (value) => !value.disabled, 'the selection back in view');

browser('click', route, 'fleet-canvas >>> .fleet-refresh-trigger');
const review = await poll(
  modal,
  (value) => value.rows.length > 0 && !value.checking && value.bulkDisabled === false,
  'the inspected release review',
);
assert.deepEqual(review.rows, ['proof-slot', 'proof-unpublished']);
assert.equal(review.bulk, 'Release idle slots (1)');
browser('click', route, 'fleet-canvas >>> fleet-refresh-modal >>> footer button');
const finished = await poll(
  () =>
    read(
      `const root=document.querySelector('fleet-canvas')?.shadowRoot.querySelector('fleet-refresh-modal')?.shadowRoot;return {summary:[...root.querySelectorAll('footer [role=status]')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).find(t=>t.includes('ready'))??'',rows:Object.fromEntries([...root.querySelectorAll('article[data-slot]')].map(e=>[e.dataset.slot,e.querySelector('.detail')?.textContent.trim().split(' ')[0]??'idle']))};`,
    ),
  (value) => value.summary !== '',
  'the bulk release summary',
);
assert.equal(finished.summary, '1 ready · 0 failed · 0 skipped');
assert.deepEqual(finished.rows, { 'proof-slot': 'refreshed', 'proof-unpublished': 'idle' });
const after = branches();
assert.deepEqual(
  after,
  { 'proof-slot': 'main', 'proof-slot-two': 'previous-two', 'proof-unpublished': 'local-only' },
  'Only the ticked safe row returned to main; the unticked and the unsafe rows are untouched',
);
browser('screenshot', route, path.join(output, 'fleet-selection-released.png'));

browser('click', route, 'fleet-canvas >>> fleet-refresh-modal >>> button[aria-label="Close"]');
const cleared = await poll(trigger, (value) => value.ticked.length === 0, 'the cleared selection');
assert.equal(cleared.disabled, true);
fs.writeFileSync(
  path.join(output, 'fleet-selection-release.json'),
  JSON.stringify(
    {
      pass: true,
      idle,
      chosen,
      idleGeometry,
      chosenGeometry,
      hidden,
      review,
      before,
      finished,
      after,
      cleared,
    },
    null,
    2,
  ),
);
console.log('Fleet selection release proof PASS');
