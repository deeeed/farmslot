import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const cdpPath = fileURLToPath(new URL('./cdp.mjs', import.meta.url));
const probePath = fileURLToPath(new URL('./probes/local-store.js', import.meta.url));
const phase = process.argv[2];
assert(['browser', 'http', 'desktop'].includes(phase), 'Select browser, http or desktop');
assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''), 'Select an isolated CDP port');

async function cdp(...args) {
  const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function diagnostics(route) {
  return cdp('eval', route, '--file', probePath);
}
async function proof(route, action) {
  return cdp(
    'eval',
    route,
    `return (await import('/src/dev/local-store-proof.ts')).localStoreProof(${JSON.stringify(action)})`,
  );
}
async function until(operation, ready) {
  const deadline = Date.now() + 10000;
  let value;
  do {
    value = await operation();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Storage proof did not settle: ${JSON.stringify(value)}`);
}

if (phase !== 'browser') {
  const receipt = await diagnostics('-');
  if (phase === 'http') {
    assert.equal(receipt.secure, false);
    assert.equal(receipt.storage, 'memory');
    assert(receipt.notice.includes('will not survive a restart'));
  } else {
    assert.equal(receipt.storage, 'opfs-sahpool');
    assert.equal(receipt.integrity, 'ok');
  }
  console.log(JSON.stringify({ result: 'PASS', phase, ...receipt }));
  process.exit(0);
}

assert(process.env.FARMSLOT_UI_URL, 'Select the isolated development UI');
const base = new URL(process.env.FARMSLOT_UI_URL);
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname),
  'Browser conformance uses a loopback development checkout',
);
const ownerRoute = 'config/settings?storage-proof=owner';
const secondRoute = 'config/settings?storage-proof=secondary';
const ownerUrl = new URL(base);
ownerUrl.hash = ownerRoute;
const secondUrl = new URL(base);
secondUrl.hash = secondRoute;
const tabs = await cdp('tabs');
if (tabs.some((tab) => tab.url?.includes(`#${secondRoute}`))) await cdp('close', secondRoute);
await cdp('goto', ownerUrl.href);
await cdp('focus', ownerRoute);
const owner = await diagnostics(ownerRoute);
assert.equal(owner.storage, 'opfs-sahpool');
const conformance = await proof(ownerRoute, 'conformance');
assert.equal(conformance.checks, 18);
assert.equal(conformance.diagnostics.storage, 'opfs-sahpool');
assert.equal(conformance.diagnostics.integrity, 'ok');
const seeded = await proof(ownerRoute, 'seed');
assert.equal(seeded.persistent, true);
const beforeReload = await cdp('eval', ownerRoute, 'return performance.timeOrigin');
// Navigating to an identical fragment can preserve the document. Change the search to force a reload.
ownerUrl.searchParams.set('storage-reload', crypto.randomUUID());
await cdp('goto', ownerUrl.href);
await cdp('focus', ownerRoute);
await until(
  () => cdp('eval', ownerRoute, 'return performance.timeOrigin'),
  (value) => value !== beforeReload,
);
const reloaded = await proof(ownerRoute, 'read');
assert.deepEqual(
  reloaded.entry,
  seeded.entry,
  'The worker database must preserve query bytes and age across reload',
);
await cdp('goto', secondUrl.href, '--new');
await cdp('focus', secondRoute);
const secondary = await diagnostics(secondRoute);
assert.equal(secondary.storage, 'memory');
assert(secondary.notice.includes('will not survive a restart'));
const memory = await proof(secondRoute, 'seed');
assert.equal(memory.persistent, false);
assert.deepEqual((await proof(ownerRoute, 'read')).entry, seeded.entry);
const revoked = await proof(secondRoute, 'delete');
assert.equal(revoked.deleted, true);
const deleted = await until(
  () => proof(ownerRoute, 'read'),
  (value) => value.deleted,
);
assert.equal(
  deleted.entry,
  undefined,
  'A deletion in the memory tab must revoke the owner immediately',
);
const late = await proof(ownerRoute, 'late-write');
assert.equal(late.entry, undefined);
ownerUrl.searchParams.set('storage-reload', crypto.randomUUID());
await cdp('goto', ownerUrl.href);
await cdp('focus', ownerRoute);
const reopened = await proof(ownerRoute, 'read');
assert.equal(
  reopened.entry,
  undefined,
  'Deleted rows and late writes must remain absent after reopening',
);
const integrity = await diagnostics(ownerRoute);
assert.equal(integrity.integrity, 'ok');
console.log(
  JSON.stringify({
    result: 'PASS',
    phase,
    owner,
    conformance,
    reload: 'preserved',
    secondary,
    deletion: 'cross-tab revoked; late write dropped; absent after reload',
    integrity,
  }),
);
