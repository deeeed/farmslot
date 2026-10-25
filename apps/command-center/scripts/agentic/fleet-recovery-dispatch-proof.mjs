// Requires the authenticated workspace.rpc.live.ts UI fixture and its real CC tab.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GatewayClient } from '../../../../packages/cli/src/gateway-client.ts';

const output = process.env.FARMSLOT_WORKSPACE_UI_PROOF_OUT;
assert.ok(output, 'Set the disposable UI fixture output');
const context = JSON.parse(fs.readFileSync(path.join(output, 'ui-context.json'), 'utf8'));
assert.ok(
  fs
    .realpathSync(context.root)
    .startsWith(path.join(fs.realpathSync(os.tmpdir()), 'workspace-recovery-')),
);
const profile = JSON.parse(fs.readFileSync(path.join(context.home, 'gateways.json'), 'utf8'));
const grant = await new GatewayClient({ url: context.gatewayUrl, timeout: 30_000 }).call(
  'auth.session.exchange',
  {
    credential: profile.gateways[profile.active].secret,
    deviceName: 'Disposable fleet proof',
    deviceKind: 'cli',
  },
);
const client = new GatewayClient({
  url: context.gatewayUrl,
  timeout: 300_000,
  credential: { token: grant.accessToken },
});
const connection = await client.connect();
const created = [];
const cdp = fileURLToPath(new URL('../cdp.mjs', import.meta.url));
const route = process.env.FARMSLOT_WORKSPACE_PROOF_ROUTE ?? 'fleet?proof=fleet1490';
const browser = (...args) =>
  execFileSync(process.execPath, [cdp, ...args], { encoding: 'utf8', env: process.env });
const poll = async (read, predicate, label) => {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};
const run = async (suffix) => {
  const result = await connection.call('run.create', {
    flowType: 'dev',
    project: 'proof',
    ticketOrPr: suffix === 'BEFORE' ? 'PROOF-1' : 'PROOF-2',
    mode: 'validation',
    runner: 'scripted',
    scripted: { mode: 'command', commandRef: 'proof' },
    taskFile: path.join(context.root, 'proof-task.md'),
    ticketData: {
      key: `PROOF-${suffix}`,
      title: 'Fleet recovery scoring proof',
      description: 'Engineering fixture only. No model or product work.',
      acceptanceCriteria: [],
      screenshots: [],
      source: 'manual',
      affectedArea: 'fleet',
      stepsToReproduce: [],
      labels: [],
    },
  });
  created.push(result.run.id);
  return result.run.id;
};
const readRun = async (runId) => (await connection.call('run.get', { runId })).run;
const cleanupRun = async (runId) => {
  const value = await readRun(runId);
  if (!['done', 'failed', 'cancelled'].includes(value.status))
    await connection.call('run.cancel', { runId, reason: 'Engineering selection proof complete' });
  await connection.call('run.archive', { runId });
  created.splice(created.indexOf(runId), 1);
};
try {
  fs.writeFileSync(
    path.join(context.root, 'proof-task.md'),
    '# Fleet recovery scoring proof\nNo product or model work.\n',
  );
  const beforeId = await run('BEFORE');
  const before = await poll(
    () => readRun(beforeId),
    (value) => value.decisions.some((decision) => decision.payload?.reason === 'all_stale'),
    'all-stale decision',
  );
  fs.writeFileSync(path.join(output, 'scoring-before.json'), JSON.stringify(before, null, 2));
  await cleanupRun(beforeId);
  browser(
    'eval',
    route,
    `
    const deep=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].flatMap(e=>e.shadowRoot?deep(selector,e.shadowRoot):[])];
    const dismiss=deep('button').find(e=>e.textContent.trim()==='Got it'); if(dismiss) dismiss.click();
    const card=deep('slot-card').find(e=>e.slotData?.slot==='proof-slot');
    if(!card) throw Error('Proof slot is absent from the real fleet');
    const button=card.shadowRoot.querySelector('.recovery-action');
    if(button.disabled) throw Error('Proof recovery action is disabled'); button.click(); return true;
  `,
  );
  const ready = await poll(
    () => connection.call('fleet.status'),
    (value) =>
      value.fleet.slots.some(
        (slot) =>
          slot.slot === 'proof-slot' &&
          slot.lifecycle === 'ready' &&
          slot.branch === 'main' &&
          slot.health.fixtures === 'OK' &&
          !slot.currentRunId,
      ),
    'CC recovery readback',
  );
  browser('screenshot', route, path.join(output, 'cc-recovery-complete.png'));
  const afterId = await run('AFTER');
  const after = await poll(
    () => readRun(afterId),
    (value) => value.steps.some((step) => step.name === 'find-slot' && step.status === 'done'),
    'unrestricted scored selection',
  );
  const selection = after.steps.find((step) => step.name === 'find-slot').outputs;
  assert.equal(selection.selectionMethod, 'scored');
  assert.equal(selection.selectedSlot, 'proof-slot');
  assert.equal(after.slotId, 'proof-slot');
  assert.equal(after.allowedSlots, null);
  assert.equal(
    after.decisions.some((decision) => decision.type === 'engine_no_suitable_slot'),
    false,
  );
  fs.writeFileSync(path.join(output, 'scoring-after.json'), JSON.stringify(after, null, 2));
  fs.writeFileSync(
    path.join(output, 'cc-scored-selection.json'),
    JSON.stringify(
      {
        pass: true,
        beforeRunId: beforeId,
        afterRunId: afterId,
        beforeReason: 'all_stale',
        selection,
        unrestricted: true,
        recovered: ready.fleet.slots.find((slot) => slot.slot === 'proof-slot'),
        claim:
          'CC recovery followed by unrestricted scored selection. No model execution or full product-run claim.',
      },
      null,
      2,
    ),
  );
  await poll(
    () => readRun(afterId),
    (value) => ['done', 'failed', 'blocked', 'cancelled'].includes(value.status),
    'fixture downstream settlement',
  );
  await cleanupRun(afterId);
  console.log('CC recovery -> unrestricted scored selection PASS');
} finally {
  for (const id of [...created]) await cleanupRun(id);
  await connection.call('auth.session.revoke', { sessionId: grant.session.id });
  connection.close();
}
