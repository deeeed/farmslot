// Live foundation proof. Select an isolated FARMSLOT_HOME, gateway profile and device explicitly.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [action, sourceId, ref] = process.argv.slice(2);
const metro = process.env.METRO_PORT;
assert(/^\d+$/.test(metro ?? ''), 'Select the isolated METRO_PORT');
async function observe(action) {
  const timeout = action === 'credential-refusal' || action === 'offline-sign-out' ? 15000 : 3000;
  const response = await fetch(`http://127.0.0.1:${metro}/farmslot-recipe/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'observeUi',
      nodeId: 'offline-store-foundation',
      payload: { refs: [`offline-store-foundation:${action}`] },
      timeout_ms: timeout,
    }),
    signal: AbortSignal.timeout(timeout + 2000),
  });
  assert(response.ok, `Recipe relay HTTP ${response.status}`);
  const reply = await response.json();
  assert(reply.ok, reply.error);
  return reply.observations.offlineStoreFoundation;
}
function rpc(method, params) {
  assert(
    process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE,
    'Select the isolated home and authenticated proof profile',
  );
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['../command-center/scripts/cdp.mjs', 'gateway', method, JSON.stringify(params)],
      { encoding: 'utf8' },
    ),
  );
}
let before;
let minimumRevision = 0;
if (action === 'credential-refusal' || action === 'offline-sign-out') {
  const proof = await observe(action);
  assert.equal(proof.result, 'PASS', JSON.stringify(proof));
  assert.equal(proof.storeDeleted, true);
  console.log(JSON.stringify(proof));
  process.exit(0);
}
if (action === 'start') {
  await observe('stop');
  const device = process.env.IOS_SIMULATOR;
  assert(device, 'Select the isolated IOS_SIMULATOR');
  execFileSync('xcrun', ['simctl', 'openurl', device, 'farmslot-development:///settings']);
  await observe('start');
} else if (action === 'pin' || action === 'unpin') {
  assert(/^[a-zA-Z0-9._-]+$/.test(sourceId ?? ''), 'Select a declared proof source');
  const current = rpc('sources.status', { sourceId });
  const result = rpc(`sources.${action}`, {
    sourceId,
    scope: 'farm',
    targetId: 'farm',
    ...(action === 'pin' ? { ref } : {}),
    operationId: randomUUID(),
    expectedDeclarationRevision: current.declarationRevision,
    expectedPinRevision: current.pinRevision,
  });
  minimumRevision = result.pinRevision;
} else if (action === 'reconnect') {
  before = await observe('snapshot');
  await observe('reconnect');
} else if (action === 'stop') {
  await observe('stop');
  console.log(JSON.stringify({ result: 'PASS', action }));
  process.exit(0);
} else throw new Error(`Unknown foundation proof action: ${action}`);

const deadline = Date.now() + 30000;
let state;
while (Date.now() < deadline) {
  state = await observe('snapshot');
  const selection = state.selections?.find((entry) => entry.sourceId === sourceId);
  if (
    state.status === 'ready' &&
    state.generation === 0 &&
    state.pinRevision >= minimumRevision &&
    (!sourceId || selection?.effectiveRef === (action === 'unpin' ? 'main' : ref)) &&
    (!before || state.reads > before.reads)
  ) {
    if (before)
      assert.equal(
        state.epoch,
        before.epoch,
        'This proof reconnects without restarting the gateway',
      );
    console.log(JSON.stringify({ result: 'PASS', action, ...state }));
    process.exit(0);
  }
  await delay(50);
}
throw new Error(`Shared cache did not cover the live change: ${JSON.stringify(state)}`);
