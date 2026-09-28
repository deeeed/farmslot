import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const runId = process.env.FARMSLOT_OUTPUT_CLOSE_RUN_ID;
const route = process.env.FARMSLOT_OUTPUT_CLOSE_ROUTE;
assert.ok(
  runId && route && process.env.FARMSLOT_GATEWAY,
  'Set a disposable output run, browser route and isolated gateway',
);
const cdp = (...args) =>
  JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
const rpc = (method, params = { runId }) => cdp('gateway', method, JSON.stringify(params));
const before = rpc('run.get').run;
assert.equal(
  before.ticketOrPr,
  'disposable-partial-output-close',
  'Never close a real user run in this proof',
);
assert.equal(before.metrics.outcome, 'partial');
assert.equal(before.status, 'blocked');
assert.ok(before.output?.workerFinished && before.output.reportPath.endsWith('.html'));
let ready = false;
for (let i = 0; i < 40; i++) {
  ready = cdp(
    'eval',
    route,
    `const button=document.querySelector('run-detail')?.shadowRoot?.querySelector('[data-testid="close-run-output"]');return Boolean(button && !button.disabled);`,
  );
  if (ready) break;
  await delay(250);
}
assert.ok(ready, 'Close action must finish loading and become available');
cdp('click', route, 'run-detail >>> [data-testid="close-run-output"]');
let after;
for (let i = 0; i < 60; i++) {
  after = rpc('run.get').run;
  if (after.status === 'done' && !after.output.cleanupPending) break;
  await delay(250);
}
assert.equal(after.status, 'done');
assert.ok(after.output.closedAt);
assert.equal(after.output.closeError, undefined);
assert.deepEqual(after.metrics, before.metrics);
assert.deepEqual(after.steps, before.steps);
assert.equal(after.error, before.error);
assert.equal(after.output.manifestDigest, before.output.manifestDigest);
assert.ok(after.decisions.some((d) => d.resolvedAction === 'close-run'));
const ui = cdp(
  'eval',
  route,
  `const root=document.querySelector('run-detail').shadowRoot;return {copy:root.querySelector('[data-testid="run-results"]').textContent};`,
);
assert.match(ui.copy, /Execution closed/);
assert.match(ui.copy, /partial/);
const response = await fetch(
  new URL(
    `/api/run-artifact?runId=${runId}&path=${encodeURIComponent(after.output.reportPath)}`,
    process.env.FARMSLOT_GATEWAY.replace(/^ws/, 'http'),
  ),
);
assert.equal(response.status, 200);
assert.equal(response.headers.get('content-disposition'), 'attachment');
assert.ok((await response.text()).includes('PARTIAL'));
console.log(
  JSON.stringify({
    pass: true,
    status: after.status,
    outcome: after.metrics.outcome,
    stepsPreserved: true,
    reportRetained: true,
    closedAt: after.output.closedAt,
  }),
);
