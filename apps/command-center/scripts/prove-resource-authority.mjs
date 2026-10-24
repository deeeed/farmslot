import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const execute = promisify(execFile);
const action = process.argv[2];
assert(['inspect', 'reconnect', 'sign-out', 'role-change', 'credential-refusal'].includes(action));
assert(
  process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE,
  'Select the isolated home and profile',
);
assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''), 'Select the isolated browser');
assert(process.env.FARMSLOT_UI_URL, 'Select the isolated UI');
const profile = await automationGatewayTarget();
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(profile.url).hostname));
const cdpPath = fileURLToPath(new URL('./cdp.mjs', import.meta.url));
const route = process.env.FARMSLOT_SOURCE_ROUTE ?? 'config/settings?storage-proof=owner';
async function cdp(...args) {
  const { stdout } = await execute(process.execPath, [cdpPath, ...args], {
    timeout: 150000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}
const pages = (await cdp('tabs')).filter((tab) => tab.type === 'page');
const selected = pages.filter((tab) => tab.url.includes(`#${route}`));
assert.equal(selected.length, 1, 'Select one owned Sources tab');
const ownerId = selected[0].id;
assert.equal(new URL(selected[0].url).origin, new URL(process.env.FARMSLOT_UI_URL).origin);
async function target() {
  const tabs = (await cdp('tabs')).filter((tab) => tab.type === 'page');
  const tab = tabs.find((entry) => entry.id === ownerId);
  assert(tab, 'The owned tab closed');
  const url = new URL(tab.url);
  const hash = url.hash.slice(1);
  assert(
    hash && tabs.filter((entry) => entry.url.includes(`#${hash}`)).length === 1,
    'The owned route must uniquely select this tab',
  );
  return { url, hash };
}
async function inspect(scope) {
  const { hash } = await target();
  return cdp(
    'eval',
    hash,
    `return (await import('/src/dev/resource-authority-proof.ts')).inspectResourceAuthority(${JSON.stringify(scope) ?? ''})`,
  );
}
async function reconnect() {
  return cdp(
    'eval',
    (await target()).hash,
    "return (await import('/src/dev/resource-authority-proof.ts')).requestResourceReconnect()",
  );
}
async function restoreSelectedLogin() {
  const { hash } = await target();
  const state = await cdp(
    'eval',
    hash,
    "return {connection:document.querySelector('farm-app')?.connection}",
  );
  if (state.connection === 'auth_required') {
    const login = await cdp('login', hash);
    assert(login.authenticated, 'Restore the selected isolated login through the actual form');
  }
  const { url } = await target();
  url.hash = route;
  const navigated = await cdp('goto', url.href);
  assert.equal(navigated.id, ownerId, 'Restore only the original tab');
}
async function until(read, accepts) {
  const deadline = Date.now() + 60000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  assert.fail(`Authority proof did not settle: ${JSON.stringify(value)}`);
}
const before = await until(
  () => inspect(),
  (value) =>
    value.cacheStatus === 'ready' &&
    value.cacheHasData &&
    value.persistent &&
    value.storedObservedAt === value.cacheObservedAt,
);
if (action === 'inspect') {
  console.log(JSON.stringify({ result: 'PASS', action, before }));
  process.exit(0);
}
if (action === 'reconnect') {
  const { hash } = await target();
  const proof = await cdp(
    'eval',
    hash,
    "return (await import('/src/dev/resource-authority-proof.ts')).reconnectResourceAuthority()",
  );
  console.log(JSON.stringify({ ...proof, action }));
  process.exit(0);
}
if (action === 'role-change' || action === 'credential-refusal') {
  assert(process.env.FARMSLOT_AUTHORITY_ACTORS, 'Select disposable actors from isolated setup');
  const actors = JSON.parse(await readFile(process.env.FARMSLOT_AUTHORITY_ACTORS, 'utf8'));
  const actor = actors.find((entry) => entry.principalId === before.principalId);
  assert(actor, 'Never mutate the original operator principal');
  const { principals } = await cdp('gateway', 'principal.list', '{}');
  const principal = principals.find((entry) => entry.id === actor.principalId);
  assert(
    principal?.subject.type === 'service' &&
      principal.subject.displayName.startsWith('Offline authority '),
    'Use a disposable proof principal',
  );
  const { credentials } = await cdp('gateway', 'credential.list', '{}');
  assert(
    credentials.some(
      (entry) =>
        entry.id === actor.credentialId &&
        entry.principalId === actor.principalId &&
        !entry.revokedAt,
    ),
  );
  let after;
  if (action === 'role-change') {
    try {
      await cdp(
        'gateway',
        'principal.grant',
        JSON.stringify({
          principalId: actor.principalId,
          role: 'operator',
          scope: { kind: 'global' },
        }),
      );
      await cdp(
        'gateway',
        'principal.revokeRole',
        JSON.stringify({
          principalId: actor.principalId,
          role: 'admin',
          scope: { kind: 'global' },
        }),
      );
      await reconnect();
      after = await until(
        () => inspect(before.inspectedScope),
        (value) =>
          value.connection === 'connected' &&
          value.principalId === actor.principalId &&
          value.persistent &&
          !value.cacheHasData &&
          value.storedObservedAt === undefined &&
          value.identity?.metadata.authority.roles.some((role) => role.role === 'operator') &&
          !value.identity.metadata.authority.roles.some((role) => role.role === 'admin'),
      );
    } finally {
      await cdp(
        'gateway',
        'principal.grant',
        JSON.stringify({
          principalId: actor.principalId,
          role: 'admin',
          scope: { kind: 'global' },
        }),
      );
      await cdp(
        'gateway',
        'principal.revokeRole',
        JSON.stringify({
          principalId: actor.principalId,
          role: 'operator',
          scope: { kind: 'global' },
        }),
      );
      await reconnect();
    }
  } else {
    try {
      await cdp(
        'gateway',
        'credential.revoke',
        JSON.stringify({ credentialId: actor.credentialId }),
      );
      await reconnect();
      after = await until(
        () => inspect(before.inspectedScope),
        (value) =>
          value.connection === 'auth_required' &&
          !value.identity &&
          value.persistent &&
          !value.cacheHasData &&
          value.storedObservedAt === undefined &&
          value.renderAccess === 'none',
      );
    } finally {
      await restoreSelectedLogin();
    }
  }
  const restored = await until(
    () => inspect(),
    (value) =>
      value.cacheStatus === 'ready' &&
      value.persistent &&
      value.storedObservedAt === value.cacheObservedAt &&
      value.cacheObservedAt > before.cacheObservedAt,
  );
  console.log(JSON.stringify({ result: 'PASS', action, before, after, restored }));
  process.exit(0);
}
let after;
try {
  await cdp('click', (await target()).hash, '[data-testid="account-menu"]');
  await cdp('click', (await target()).hash, '[data-testid="account-sign-out"]');
  await cdp('click', (await target()).hash, '[data-testid="account-sign-out-confirm"]');
  after = await until(
    () => inspect(before.inspectedScope),
    (value) =>
      value.connection === 'auth_required' &&
      !value.identity &&
      value.persistent &&
      value.storedObservedAt === undefined &&
      !value.cacheHasData &&
      value.renderAccess === 'none',
  );
} finally {
  await restoreSelectedLogin();
}
const restored = await until(
  () => inspect(),
  (value) =>
    value.cacheStatus === 'ready' &&
    value.persistent &&
    value.storedObservedAt === value.cacheObservedAt &&
    value.cacheObservedAt > before.cacheObservedAt,
);
console.log(JSON.stringify({ result: 'PASS', action, before, after, restored }));
