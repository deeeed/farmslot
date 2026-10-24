import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

import { withOwnedGatewayOffline } from './owned-gateway-outage.mjs';

const execute = promisify(execFile);
const [action, sourceId = 'offline-proof', ref = 'test-branch'] = process.argv.slice(2);
assert(['pin', 'unpin', 'sync', 'browser-offline'].includes(action));
assert(
  process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE,
  'Select the isolated home and test profile',
);
assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''), 'Select the isolated browser CDP port');
const profile = await automationGatewayTarget();
const gateway = new URL(profile.url);
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(gateway.hostname),
  'The offline proof owns a loopback gateway',
);
const cdpPath = fileURLToPath(new URL('./cdp.mjs', import.meta.url));
const probePath = fileURLToPath(new URL('./probes/offline-sources.js', import.meta.url));
const route = process.env.FARMSLOT_SOURCE_ROUTE ?? 'config/settings?storage-proof=owner';
async function cdp(...args) {
  const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
    timeout: args[0] === 'gateway' ? 180000 : 60000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, FARMSLOT_RPC_TIMEOUT_MS: '120000' },
  });
  return JSON.parse(stdout);
}
async function snapshot() {
  return (await cdp('eval', route, '--file', probePath))[0];
}
async function until(operation, ready, timeout = 120000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await operation();
    if (ready(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`Sources proof did not settle: ${JSON.stringify(value)}`);
}
if (action === 'sync') {
  const nodeId = ref;
  assert(/^[a-zA-Z0-9._-]+$/.test(sourceId) && /^[a-zA-Z0-9._-]+$/.test(nodeId));
  const before = await until(snapshot, (value) => value?.freshness === 'ready');
  const detailsOpen = await cdp(
    'eval',
    route,
    "return document.querySelector('source-status-panel')?.shadowRoot.querySelector('details')?.open",
  );
  if (!detailsOpen) await cdp('click', route, 'source-status-panel >>> details summary');
  const current = await cdp('gateway', 'sources.status', JSON.stringify({ sourceId }));
  let reply;
  const observations = [];
  let previous = '';
  const startedAt = Date.now();
  const mutation = cdp(
    'gateway',
    'sources.sync',
    JSON.stringify({
      sourceId,
      nodeId,
      operationId: randomUUID(),
      expectedDeclarationRevision: current.declarationRevision,
    }),
  ).then((value) => {
    reply = value;
  });
  const watching = until(
    snapshot,
    (value) => {
      const row = value?.rows?.find((entry) => entry.sourceId === sourceId);
      const signature = JSON.stringify([value?.freshness, row?.materializations]);
      if (signature !== previous) {
        observations.push(value);
        previous = signature;
      }
      if (!reply || value?.freshness !== 'ready' || value.observedAt <= before.observedAt)
        return false;
      const lock = reply.locks.find(
        (entry) =>
          entry.context.nodeId === nodeId &&
          entry.entries.some((entry) => entry.sourceId === sourceId),
      );
      return (
        lock &&
        row?.materializations.some(
          (entry) =>
            entry.nodeId === nodeId &&
            entry.lockDigest === lock.digest &&
            Date.parse(entry.verifiedAt) >= startedAt &&
            !entry.drift.length,
        )
      );
    },
    180000,
  );
  const outcomes = await Promise.allSettled([mutation, watching]);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  assert.equal(reply.errors.length, 0, JSON.stringify(reply.errors));
  const panel = outcomes[1].value;
  const lock = reply.locks.find(
    (entry) =>
      entry.context.nodeId === nodeId && entry.entries.some((entry) => entry.sourceId === sourceId),
  );
  const target = {
    sourceId,
    nodeId,
    lockDigest: lock.digest,
    operationId: reply.operationId,
    startedAt,
  };
  if (process.env.FARMSLOT_SOURCE_SYNC_RECEIPT)
    await writeFile(process.env.FARMSLOT_SOURCE_SYNC_RECEIPT, JSON.stringify(target) + '\n', {
      mode: 0o600,
    });
  const visible = await cdp(
    'eval',
    route,
    "const details=document.querySelector('source-status-panel')?.shadowRoot.querySelector('details'); return {open:details?.open,text:details?.textContent}",
  );
  assert(
    visible.open &&
      visible.text.includes(`Node receipt ${nodeId}`) &&
      visible.text.includes(lock.digest),
  );
  console.log(JSON.stringify({ result: 'PASS', action, ...target, before, observations, panel }));
  process.exit(0);
}
if (action === 'pin' || action === 'unpin') {
  assert(/^[a-zA-Z0-9._-]+$/.test(sourceId));
  const current = await cdp('gateway', 'sources.status', JSON.stringify({ sourceId }));
  const reply = await cdp(
    'gateway',
    `sources.${action}`,
    JSON.stringify({
      sourceId,
      scope: 'farm',
      targetId: 'farm',
      ...(action === 'pin' ? { ref } : {}),
      operationId: randomUUID(),
      expectedDeclarationRevision: current.declarationRevision,
      expectedPinRevision: current.pinRevision,
    }),
  );
  const panel = await until(
    snapshot,
    (value) =>
      value?.freshness === 'ready' &&
      value.pinRevision >= reply.pinRevision &&
      value.rows?.some(
        (row) => row.sourceId === sourceId && row.ref === (action === 'pin' ? ref : 'main'),
      ),
  );
  console.log(JSON.stringify({ result: 'PASS', action, panel }));
  process.exit(0);
}

assert(process.env.FARMSLOT_UI_URL, 'Select the isolated browser UI');
await until(
  snapshot,
  (value) => value?.freshness === 'ready' && typeof value.observedAt === 'number',
);
const {
  stoppedPid,
  evidence: { stale, cold, aged },
} = await withOwnedGatewayOffline(async () => {
  const stale = await until(
    snapshot,
    (value) => value?.freshness === 'stale' && Boolean(value.line),
  );
  const before = await cdp('eval', route, 'return performance.timeOrigin');
  const url = new URL(process.env.FARMSLOT_UI_URL);
  url.searchParams.set('source-offline-proof', randomUUID());
  url.hash = route;
  await cdp('goto', url.href);
  await cdp('focus', route);
  assert.notEqual(await cdp('eval', route, 'return performance.timeOrigin'), before);
  const cold = await until(
    snapshot,
    (value) => value?.freshness === 'stale' && Boolean(value.line),
  );
  assert.equal(cold.line, stale.line);
  assert.deepEqual(cold.rows, stale.rows);
  assert.equal(
    cold.observedAt,
    stale.observedAt,
    'A new offline document must render the saved observation',
  );
  assert(cold.stale.includes('old'));
  assert.equal(cold.interactive, false);
  assert(cold.controls.length > 0 && cold.controls.every((control) => control.disabled));
  const aged = await until(
    snapshot,
    (value) =>
      value?.freshness === 'stale' &&
      value.observedAt === cold.observedAt &&
      value.stale &&
      value.stale !== cold.stale,
    70_000,
  );
  assert.deepEqual(aged.rows, cold.rows, 'Repainting age must keep the saved source facts');
  assert(aged.controls.every((control) => control.disabled));
  if (process.env.FARMSLOT_SOURCES_SCREENSHOT)
    await cdp('screenshot', route, process.env.FARMSLOT_SOURCES_SCREENSHOT);
  return { stale, cold, aged };
});
const recovered = await until(
  snapshot,
  (value) => value?.freshness === 'ready' && value.observedAt > cold.observedAt,
);
assert.equal(recovered.pinRevision, cold.pinRevision, 'Reconnect must not replay a mutation');
console.log(
  JSON.stringify({
    result: 'PASS',
    action,
    stale,
    cold,
    recovered,
    stoppedPid,
    age: { first: cold.stale, next: aged.stale, observedAt: aged.observedAt },
  }),
);
