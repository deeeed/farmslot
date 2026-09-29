// Exercise a real task operation through gateway RPC and Command Center, without UI state injection.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const {
  FARMSLOT_OPERATION_RUN_ID: runId,
  FARMSLOT_OPERATION_SLOT_ID: slotId,
  FARMSLOT_OPERATION_ID: operationId,
  FARMSLOT_OPERATION_ROUTE: route,
} = process.env;
assert(runId && slotId && operationId && route, 'Set FARMSLOT_OPERATION_{RUN_ID,SLOT_ID,ID,ROUTE}');
const cdp = (command, ...args) =>
  JSON.parse(
    execFileSync(process.execPath, ['apps/command-center/scripts/cdp.mjs', command, ...args], {
      encoding: 'utf8',
    }),
  );
const progress = cdp('gateway', 'task.progress', JSON.stringify({ slotId, runId }));
const operation = progress.structured?.operations?.find((value) => value.id === operationId);
assert(
  operation?.stage && operation.status === 'running',
  'The gateway must project the emitted active operation and stage',
);
const walk = `function find(root, selector) { let result=[...root.querySelectorAll(selector)]; for(const element of root.querySelectorAll('*')) if(element.shadowRoot) result.push(...find(element.shadowRoot,selector)); return result; }`;
const panel = cdp(
  'eval',
  route,
  `${walk} return { text: find(document,'[data-testid=operation-panel]').map(e=>e.textContent).join('\\n') };`,
).text;
assert(
  panel.includes(operation.command) && panel.includes(operation.stage),
  'The real UI must show the projected command and stage',
);
assert(
  panel.includes('Last output:') && panel.includes('Status update:'),
  'Output freshness and status freshness must be distinct',
);
cdp('click', route, `[data-testid="operation-panel"] a[href*="${operationId}"]`);
const artifactRoute = `run/${runId}`;
const read = () =>
  cdp(
    'eval',
    artifactRoute,
    `${walk} const e=find(document,'media-lightbox').find(e=>e.open); const r=e?.shadowRoot; return { text:r?.querySelector('.ml-log-body .ml-json-content')?.textContent, following:r?.querySelector('[data-testid=operation-log-follow]')?.getAttribute('aria-pressed') };`,
  );
let before;
for (let attempt = 0; attempt < 30; attempt++) {
  before = read();
  if (before.text && before.following !== undefined) break;
  await delay(300);
}
assert(before?.text, 'The operation link must open the retained log');
if (before.following !== 'true')
  cdp('click', artifactRoute, '[data-testid="operation-log-follow"]');
let after;
for (let attempt = 0; attempt < 30; attempt++) {
  after = read();
  if (after.following === 'true' && after.text !== before.text) break;
  await delay(300);
}
assert.equal(after?.following, 'true');
assert.notEqual(
  after.text,
  before.text,
  'The fixture must keep writing and the viewer must follow new output',
);
assert(after.text.length <= 65538, 'The viewer must keep a bounded tail');
console.log(
  JSON.stringify({
    operationId,
    gatewayStage: operation.stage,
    panel: true,
    logOpened: true,
    followedNewOutput: true,
    boundedTail: true,
  }),
);
