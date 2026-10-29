import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createServer } from 'vite';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';
import { createRunReplyProxy } from '../../../services/gateway/scripts/visual-reply-proxy.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
assert(process.env.FARMSLOT_HOME && process.env.FARMSLOT_GATEWAY_PROFILE);
assert(/^\d+$/.test(process.env.FARMSLOT_CDP_PORT ?? ''));
const home = await realpath(process.env.FARMSLOT_HOME);
const target = await automationGatewayTarget();
const backend = new URL(target.url);
assert(['localhost', '127.0.0.1', '[::1]'].includes(backend.hostname));
assert.equal(Number(backend.port), Number(process.env.GATEWAY_PORT));
const listener = await execute('lsof', ['-nP', '-t', `-iTCP:${backend.port}`, '-sTCP:LISTEN']);
assert(/^\d+\s*$/.test(listener.stdout));
const cwd = await execute('lsof', ['-a', '-p', listener.stdout.trim(), '-d', 'cwd', '-Fn']);
assert(
  cwd.stdout.split('\n').includes(`n${root}/services/gateway`),
  'Use the isolated checkout gateway',
);
assert(process.env.FARMSLOT_AUTHORITY_RUN_ARTIFACTS, 'Select a fresh private artifact directory');
const artifacts = path.resolve(process.env.FARMSLOT_AUTHORITY_RUN_ARTIFACTS);
assert(
  path.relative(root, artifacts).startsWith(`..${path.sep}`),
  'Keep temporary credentials and proof artifacts outside the checkout',
);
await mkdir(artifacts, { recursive: true });
const nonce = randomUUID();
await writeFile(
  path.join(artifacts, 'owner.json'),
  JSON.stringify({ nonce, home, backend: target.url }),
  { flag: 'wx', mode: 0o600 },
);
const cliHome = path.join(artifacts, 'cli-home');
await mkdir(cliHome, { mode: 0o700 });
const port = Number(process.env.FARMSLOT_AUTHORITY_UI_PORT ?? '5194');
assert(Number.isSafeInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const admin = 'closed-run-admin';
const actorProfile = 'closed-run-actor';
const template = JSON.parse(await readFile(path.join(home, 'gateways.json'), 'utf8'));
const profiles = {
  ...template,
  active: admin,
  gateways: { [admin]: { url: target.url, authMode: 'token', secret: target.credential.token } },
};
const profileFile = path.join(cliHome, 'gateways.json');
await writeFile(profileFile, JSON.stringify(profiles), { flag: 'wx', mode: 0o600 });
const env = {
  ...process.env,
  FARMSLOT_HOME: cliHome,
  FARMSLOT_GATEWAY_PROFILE: admin,
  FARMSLOT_GATEWAY: target.url,
  FARMSLOT_UI_URL: origin,
};
const cdpPath = path.join(root, 'apps/command-center/scripts/cdp.mjs');
async function cdp(profile, ...args) {
  const result = await execute(process.execPath, [cdpPath, ...args], {
    cwd: root,
    env: { ...env, FARMSLOT_GATEWAY_PROFILE: profile },
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}
const rpc = (method, params = {}) => cdp(admin, 'gateway', method, JSON.stringify(params));
const tabs = async () =>
  (await cdp(admin, 'tabs')).filter(
    (tab) => tab.type === 'page' && tab.url?.startsWith(`${origin}/`),
  );
let actor;
let issued;
let server;
let proxy;
let failure;
const cleanupErrors = [];
let before;
let after;
let traffic;
async function until(read, accepts, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Closed-role authority did not settle: ${JSON.stringify(value)}`);
}
async function inspect(id, scope, storage) {
  return cdp(
    admin,
    'eval',
    `@${id}`,
    `
    const urls=performance.getEntriesByType('resource').map(({name})=>name);
    const stateUrl=urls.filter(name=>new URL(name).pathname==='/src/state.ts').at(-1);
    const gatewayUrl=urls.filter(name=>new URL(name).pathname==='/src/gateway-client.ts').at(-1);
    const ownerUrl=urls.filter(name=>new URL(name).pathname==='/src/resource-cache.ts').at(-1);
    if(!stateUrl||!gatewayUrl||!ownerUrl)return {loading:true};
    const state=await import(stateUrl);const {gateway}=await import(gatewayUrl);const owner=await import(ownerUrl);
    const view=document.querySelector('run-list');await view?.updateComplete;
    const rendered=[...(view?.shadowRoot?.querySelectorAll('[data-row-id]')??[])].filter(row=>row.getClientRects().length).map(row=>row.getAttribute('data-row-id'));
    const base={connection:gateway.connectionState,principalId:gateway.authenticatedPrincipalId,renderAccess:owner.getResourceWorkspaceAccess(),stateRunCount:state.getState().runs.length,renderedRunIds:rendered,queryParams:state.runHistoryQuery.params};
    if(!${JSON.stringify(storage)})return base;
    const detail=await (await import('/src/dev/resource-authority-proof.ts')).inspectResourceAuthority(${JSON.stringify(scope) ?? 'undefined'},state.runHistoryQuery);
    return {...base,...detail};
  `,
  );
}
try {
  actor = (
    await rpc('principal.create', {
      subject: { type: 'service', displayName: `Offline authority runs ${nonce}` },
      roles: [{ role: 'admin', scope: { kind: 'global' } }],
    })
  ).principal;
  issued = await rpc('credential.issue', {
    principalId: actor.id,
    displayName: 'Owned closed-run role proof',
  });
  profiles.gateways[actorProfile] = { url: target.url, authMode: 'token', secret: issued.secret };
  await writeFile(profileFile, JSON.stringify(profiles), { mode: 0o600 });
  proxy = await createRunReplyProxy({
    upstreamPort: Number(backend.port),
    method: 'run.list',
    params: {},
    armed: false,
  });
  process.env.GATEWAY_PORT = String(proxy.port);
  server = await createServer({
    root: path.join(root, 'apps/command-center/ui'),
    cacheDir: path.join(artifacts, 'vite-cache'),
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  const url = `${origin}/?closed-role=${nonce}#runs?tab=history`;
  const opened = await cdp(actorProfile, 'goto', url, '--new');
  await cdp(actorProfile, 'focus', `@${opened.id}`);
  await until(
    () =>
      cdp(
        actorProfile,
        'eval',
        `@${opened.id}`,
        'return {login:!!document.querySelector(".auth-card"),connection:document.querySelector("farm-app")?.connection}',
      ),
    (value) => value.login || value.connection === 'connected',
  );
  const authentication = await cdp(actorProfile, 'login', `@${opened.id}`);
  assert(authentication.authenticated);
  const updateNotice = await cdp(
    actorProfile,
    'eval',
    `@${opened.id}`,
    "return {open:Boolean(document.querySelector('whats-new-modal')?.shadowRoot?.querySelector('.backdrop'))}",
  );
  if (updateNotice.open)
    await cdp(actorProfile, 'click', `@${opened.id}`, 'whats-new-modal >>> button.primary');
  before = await until(
    () => inspect(opened.id, undefined, true),
    (value) =>
      value.principalId === actor.id &&
      value.cacheStatus === 'ready' &&
      value.cacheHasData &&
      value.persistent &&
      value.storedObservedAt === value.cacheObservedAt &&
      value.renderedRunIds.length > 0,
  );
  assert(before.queryParams?.limit > 0 && before.queryParams.active !== true);
  const forbiddenQueries = before.storedQueryIds.filter((id) =>
    ['run.list:', 'run.get:', 'decision.list:'].some((prefix) => id.startsWith(prefix)),
  );
  assert(forbiddenQueries.length > 0, 'The disposable actor must have actual persisted run data');
  await cdp(
    actorProfile,
    'screenshot',
    `@${opened.id}`,
    path.join(artifacts, 'runs-before-close.png'),
  );
  for (const tab of await tabs()) await cdp(actorProfile, 'close', `@${tab.id}`);
  assert.equal(
    (await tabs()).length,
    0,
    'Close every document for the disposable principal before revoking its role',
  );
  await rpc('principal.revokeRole', {
    principalId: actor.id,
    role: 'admin',
    scope: { kind: 'global' },
  });
  const updated = (await rpc('principal.list')).principals.find((entry) => entry.id === actor.id);
  assert.equal(updated.generation ?? 0, actor.generation ?? 0);
  assert.equal(updated.roles.length, 0);
  proxy.arm({ params: before.queryParams });
  const stage = await cdp(actorProfile, 'goto', url, '--new');
  await cdp(actorProfile, 'focus', `@${stage.id}`);
  // Observe only metadata until connect has applied the new authority; do not open SQLite during bootstrap.
  await until(
    () => inspect(stage.id, undefined, false),
    (value) =>
      value.connection === 'connected' &&
      value.principalId === actor.id &&
      value.renderAccess !== 'farm',
    12000,
  );
  after = await until(
    () => inspect(stage.id, before.inspectedScope, true),
    (value) =>
      value.connection === 'connected' &&
      value.principalId === actor.id &&
      value.renderAccess !== 'farm' &&
      !value.cacheHasData &&
      value.stateRunCount === 0 &&
      value.renderedRunIds.length === 0 &&
      value.persistent &&
      value.storedObservedAt === undefined &&
      !value.storedQueryIds.some((id) => forbiddenQueries.includes(id)),
    5000,
  );
  traffic = proxy.state();
  assert(
    !traffic.released && !traffic.expired,
    'A history read refusal must not mask failed connect-time deletion',
  );
  await cdp(
    actorProfile,
    'screenshot',
    `@${stage.id}`,
    path.join(artifacts, 'runs-role-revoked.png'),
  );
} catch (error) {
  failure = error;
} finally {
  try {
    for (const tab of await tabs()) await cdp(admin, 'close', `@${tab.id}`);
  } catch (error) {
    cleanupErrors.push(`Owned documents: ${error.message}`);
  }
  try {
    await server?.close();
  } catch (error) {
    cleanupErrors.push(`Owned Vite: ${error.message}`);
  }
  try {
    await proxy?.close();
  } catch (error) {
    cleanupErrors.push(`Owned response proxy: ${error.message}`);
  }
  process.env.GATEWAY_PORT = backend.port;
  if (issued) {
    try {
      await rpc('credential.revoke', { credentialId: issued.credential.id });
    } catch (error) {
      cleanupErrors.push(`Credential: ${error.message}`);
    }
  }
  if (actor) {
    try {
      await rpc('principal.retire', { principalIds: [actor.id] });
    } catch (error) {
      cleanupErrors.push(`Principal: ${error.message}`);
    }
  }
  try {
    await rm(cliHome, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(`Temporary CLI profile: ${error.message}`);
  }
}
try {
  await writeFile(
    path.join(artifacts, 'result.json'),
    JSON.stringify(
      {
        result: failure || cleanupErrors.length ? 'FAIL' : 'PASS',
        claim: 'closedRoleRunEviction',
        actorId: actor?.id,
        before,
        after,
        traffic,
        failure: failure?.message,
        cleanupErrors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  cleanupErrors.push(`Proof receipt: ${error.message}`);
}
if (failure || cleanupErrors.length)
  throw new AggregateError(
    [...(failure ? [failure] : []), ...cleanupErrors.map((message) => new Error(message))],
    'Closed-role run authority proof failed',
  );
console.log(
  JSON.stringify({
    result: 'PASS',
    closedRoleRunEviction: true,
    noHistoryReplyReleased: !traffic.released && !traffic.expired,
    renderedRunsCleared: after.stateRunCount === 0,
    storedRunsEvicted: after.storedObservedAt === undefined,
    artifacts,
  }),
);
