import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { register } from 'tsx/esm/api';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'));
assert(fixture.setupComplete && fixture.farm !== root);
const artifacts = path.resolve(process.env.FARMSLOT_DOMAIN_PROOF_ARTIFACTS);
await mkdir(artifacts, { recursive: true });
const loader = register({
  namespace: 'planning-proof-profiles',
  tsconfig: path.join(root, 'packages/cli/tsconfig.json'),
});
let profilesApi;
try {
  profilesApi = await loader.import(
    '../../../packages/cli/src/gateway-profiles.ts',
    import.meta.url,
  );
} finally {
  await loader.unregister();
}
const originalProfile = process.env.FARMSLOT_GATEWAY_PROFILE;
const profileHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalProfileHash = profileHash(profilesApi.loadProfiles().gateways[originalProfile]);
const cdpFile = path.join(root, 'apps/command-center/scripts/cdp.mjs');
const cdp = async (args, profile = originalProfile) =>
  JSON.parse(
    (
      await execute(process.execPath, [cdpFile, ...args], {
        timeout: 65000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, FARMSLOT_GATEWAY_PROFILE: profile },
      })
    ).stdout,
  );
const rpc = (method, params = {}) => cdp(['gateway', method, JSON.stringify(params)]);
const probe = path.join(root, 'apps/command-center/scripts/probes/offline-planning.js');
const evidence = {};
const claims = {};
const owned = {};
let tab;
let actor;
let actorSecret;
let restoreBrowser = false;
async function navigate(hash) {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, process.env.VITE_PORT);
  url.searchParams.set('authority-proof', path.basename(path.dirname(artifacts)));
  url.hash = hash;
  await cdp(['goto', url.href]);
  const tabs = (await cdp(['tabs'])).filter(
    (t) =>
      t.type === 'page' &&
      t.url.startsWith(url.origin) &&
      new URL(t.url).searchParams.get('authority-proof') ===
        url.searchParams.get('authority-proof'),
  );
  assert.equal(tabs.length, 1, 'Pin exactly one owned proof tab');
  if (tab) assert.equal(tab, `@${tabs[0].id}`);
  tab = `@${tabs[0].id}`;
}
const inspectView = () => cdp(['eval', tab, '--file', probe]);
async function until(read, accepts, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(80);
  } while (Date.now() < deadline);
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}
const screenshot = (name) => cdp(['screenshot', tab, path.join(artifacts, `${name}.png`)]);
const authState = () =>
  cdp([
    'eval',
    tab,
    `const url=performance.getEntriesByType('resource').map(({name})=>name).filter(name=>new URL(name).pathname.endsWith('/src/gateway-client.ts')).at(-1); if(!url)return {};const {gateway}=await import(url);return {principalId:gateway.authenticatedPrincipalId,connection:gateway.connectionState,authForm:Boolean(document.querySelector('.auth-card'))};`,
  ]);
async function signOut() {
  const state = await authState();
  if (state.authForm) return;
  await cdp(['click', tab, '[data-testid="account-menu"]']);
  await cdp(['click', tab, '[data-testid="account-sign-out"]']);
  await cdp(['click', tab, '[data-testid="account-sign-out-confirm"]']);
  await until(
    authState,
    (s) => s.authForm && !s.principalId,
    'The actual sign-out flow must clear authentication',
  );
}
const reconnect = () =>
  cdp([
    'eval',
    tab,
    "return (await import('/src/dev/resource-authority-proof.ts')).requestResourceReconnect()",
  ]);
const views = () => [
  [
    'backlog.list',
    `backlog?projects=${fixture.project}&item=${owned.backlog.id}`,
    owned.backlog.id,
  ],
  [
    'roadmap.list',
    `roadmap?projects=${fixture.project}&item=${owned.roadmap.id}`,
    owned.roadmap.id,
  ],
  [
    'workGraph.list',
    `work-graphs?projects=${fixture.project}&graph=${owned.graph.id}`,
    owned.graph.id,
  ],
  ['dispatch.queue.list', `dispatch?projects=${fixture.project}`, owned.queue.id],
  ['config.projects', `config/project/${fixture.project}`, fixture.project],
];
const queries = {};
async function inspectAll(scope) {
  return cdp([
    'eval',
    tab,
    `const url=performance.getEntriesByType('resource').map(({name})=>name).filter(name=>new URL(name).pathname.endsWith('/packages/protocol/src/client-cache/index.ts')).at(-1);if(!url)throw Error('Use the app registry');const {resourceQuery}=await import(url);const {inspectResourceAuthority}=await import('/src/dev/resource-authority-proof.ts');const result={};for(const [method,params]of Object.entries(${JSON.stringify(queries)}))result[method]=await inspectResourceAuthority(${JSON.stringify(scope) ?? 'undefined'},resourceQuery(method,params));return result;`,
  ]);
}
async function warm(ownerId) {
  for (const [method, hash, id] of views()) {
    await navigate(hash);
    const view = await until(
      inspectView,
      (v) =>
        v.principalId === ownerId &&
        v.observations?.[method]?.ready &&
        v.observations[method].rows.some((r) => r.id === id),
      `Render the actual ${method} list for the current principal`,
    );
    evidence.viewReadbacks ??= [];
    evidence.viewReadbacks.push({ ownerId, method, view });
    const changedSource = evidence.recoverySources?.[method];
    if (changedSource)
      assert(
        view.renderedRows.some((row) => row.text.includes(changedSource.title)),
        `${method} must render the source change made while access was revoked`,
      );
    queries[method] = view.observations[method].params;
  }
  return until(
    () => inspectAll(),
    (result) =>
      Object.values(result).every(
        (s) =>
          s.persistent &&
          s.cacheHasData &&
          s.storedObservedAt !== undefined &&
          s.storedObservedAt === s.cacheObservedAt &&
          s.storedDataSha256 === s.cacheDataSha256,
      ),
    'All five legitimately observed collections must be saved in SQLite',
  );
}
const failures = [];
try {
  const principals = (await rpc('principal.list')).principals;
  evidence.originalPrincipal = principals.find((p) => p.id === fixture.ownerId);
  assert(evidence.originalPrincipal?.roles.some((r) => r.role === 'admin'));
  owned.backlog = (
    await rpc('backlog.create', {
      project: fixture.project,
      title: `Authority ${randomUUID()}`,
      sourceKind: 'manual',
      flowType: 'dev',
    })
  ).item;
  owned.roadmap = (
    await rpc('roadmap.save', {
      item: {
        project: fixture.project,
        title: `Authority ${randomUUID()}`,
        body: 'Owned authority proof.',
      },
    })
  ).item;
  owned.graph = (
    await rpc('workGraph.create', { project: fixture.project, title: `Authority ${randomUUID()}` })
  ).graph.graph;
  owned.queue = (
    await rpc('dispatch.queue.add', {
      project: fixture.project,
      flowType: 'dev',
      ticketOrPr: owned.backlog.sourceRef,
      priority: 7,
    })
  ).item;
  const graphFile = path.join(
    process.env.FARMSLOT_WORK_GRAPH_DIR ?? path.join(fixture.farm, '.work-graphs'),
    `${owned.graph.id}.json`,
  );
  assert.equal(JSON.parse(await readFile(graphFile, 'utf8')).graph.id, owned.graph.id);
  fixture.created.push(graphFile);
  await writeFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, JSON.stringify(fixture, null, 2), {
    mode: 0o600,
  });
  evidence.originalSaved = await warm(fixture.ownerId);
  const originalScope = evidence.originalSaved['roadmap.list'].inspectedScope;
  const created = await rpc('principal.create', {
    subject: { type: 'service', displayName: `Offline authority ${randomUUID()}` },
    roles: [{ role: 'admin', scope: { kind: 'global' } }],
  });
  actor = { principalId: created.principal.id, profile: `authority-${randomUUID()}` };
  const issued = await rpc('credential.issue', {
    principalId: actor.principalId,
    displayName: 'Disposable planning proof',
  });
  actor.credentialId = issued.credential.id;
  actorSecret = issued.secret;
  const profiles = profilesApi.loadProfiles();
  profiles.gateways[actor.profile] = {
    url: profiles.gateways[originalProfile].url,
    authMode: 'token',
    secret: actorSecret,
  };
  profilesApi.saveProfiles(profiles);
  restoreBrowser = true;
  await signOut();
  await cdp(['login', tab], actor.profile);
  await until(
    authState,
    (s) => s.principalId === actor.principalId && s.connection === 'connected',
    'Use the actual sign-in form for the disposable actor',
  );
  evidence.oldScopeAfterSwitch = await inspectAll(originalScope);
  assert(
    Object.values(evidence.oldScopeAfterSwitch).every(
      (s) => s.principalId === actor.principalId && s.storedQueryIds.length === 0,
    ),
    'Switching principals must delete all old saved planning rows',
  );
  claims.principalSwitchClearsFive = true;
  evidence.actorSaved = await warm(actor.principalId);
  const actorScope = evidence.actorSaved['roadmap.list'].inspectedScope;
  await screenshot('five-collections-before-revocation');
  await rpc('principal.revokeRole', {
    principalId: actor.principalId,
    role: 'admin',
    scope: { kind: 'global' },
  });
  await reconnect();
  evidence.revoked = await until(
    () => inspectAll(actorScope),
    (result) =>
      Object.values(result).every(
        (s) =>
          s.connection === 'connected' &&
          s.principalId === actor.principalId &&
          !s.cacheHasData &&
          s.storedObservedAt === undefined &&
          s.storedQueryIds.length === 0 &&
          s.renderAccess === 'none',
      ),
    'Reported revoked authority must clear all five persisted and cached planning collections',
  );
  await screenshot('five-collections-authority-revoked');
  claims.revokedRoleClearsFive = true;
  const backlogTitle = `Changed while revoked ${randomUUID()}`;
  const roadmapTitle = `Changed while revoked ${randomUUID()}`;
  const changedBacklog = await rpc('backlog.update', {
    itemId: owned.backlog.id,
    title: backlogTitle,
  });
  const currentRoadmap = (await rpc('roadmap.get', { itemId: owned.roadmap.id })).item;
  const changedRoadmap = await rpc('roadmap.save', {
    item: {
      id: currentRoadmap.id,
      project: fixture.project,
      title: roadmapTitle,
      body: currentRoadmap.body,
    },
    expectedHash: currentRoadmap.fileHash,
  });
  assert.equal(changedBacklog.item.title, backlogTitle);
  assert.equal(changedRoadmap.item.title, roadmapTitle);
  evidence.recoverySources = {
    'backlog.list': { id: owned.backlog.id, title: backlogTitle },
    'roadmap.list': { id: owned.roadmap.id, title: roadmapTitle },
  };
  await rpc('principal.grant', {
    principalId: actor.principalId,
    role: 'admin',
    scope: { kind: 'global' },
  });
  await reconnect();
  evidence.recovered = await warm(actor.principalId);
  for (const method of Object.keys(queries))
    assert(
      evidence.recovered[method].cacheObservedAt > evidence.actorSaved[method].cacheObservedAt,
      `${method} requires a fresh authorized read`,
    );
  claims.authorityRecoveryRefetchesFive = true;
  await screenshot('five-collections-authority-restored');
} catch (error) {
  failures.push(error);
} finally {
  if (actor) {
    try {
      if (restoreBrowser) {
        await rpc('principal.grant', {
          principalId: actor.principalId,
          role: 'admin',
          scope: { kind: 'global' },
        });
        await reconnect();
        await until(
          authState,
          (s) => s.connection === 'connected',
          'Recover the disposable session for normal sign-out',
        );
        await signOut();
        await cdp(['login', tab]);
        await until(
          authState,
          (s) => s.principalId === fixture.ownerId && s.connection === 'connected',
          'Restore the original browser account through its sign-in form',
        );
      }
      if (actor.credentialId) await rpc('credential.revoke', { credentialId: actor.credentialId });
      await rpc('principal.retire', { principalIds: [actor.principalId] });
      const profiles = profilesApi.loadProfiles();
      if (profiles.gateways[actor.profile]) {
        assert(
          profiles.gateways[actor.profile].secret === actorSecret,
          'Only remove this proof credential',
        );
        delete profiles.gateways[actor.profile];
        profilesApi.saveProfiles(profiles);
      }
      assert.equal(
        profileHash(profilesApi.loadProfiles().gateways[originalProfile]),
        originalProfileHash,
      );
      const original = (await rpc('principal.list')).principals.find(
        (p) => p.id === fixture.ownerId,
      );
      const remaining = (await rpc('principal.list')).principals;
      assert(
        !remaining.some((p) => p.id === actor.principalId),
        'The disposable principal must actually be retired',
      );
      const credentials = (await rpc('credential.list', { includeRevoked: true })).credentials;
      assert(
        credentials
          .filter((entry) => entry.principalId === actor.principalId)
          .every((entry) => entry.revokedAt !== null),
        'No active test credential may remain',
      );
      assert(!profilesApi.loadProfiles().gateways[actor.profile], 'Remove the temporary profile');
      assert.deepEqual(
        original,
        evidence.originalPrincipal,
        'Never alter the original account roles or identity',
      );
      evidence.actorCleanup = {
        principalRetired: true,
        credentialRevoked: true,
        temporaryProfileRemoved: true,
        originalPrincipalUnchanged: true,
      };
      claims.originalAccountRestored = true;
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    if (owned.queue) await rpc('dispatch.queue.remove', { itemId: owned.queue.id });
    if (owned.backlog) await rpc('backlog.delete', { itemId: owned.backlog.id });
    if (owned.roadmap) {
      const item = (await rpc('roadmap.get', { itemId: owned.roadmap.id })).item;
      await rpc('roadmap.delete', { itemId: item.id, expectedHash: item.fileHash });
    }
  } catch (error) {
    failures.push(error);
  }
  await writeFile(
    path.join(artifacts, 'planning-authority-receipt.json'),
    JSON.stringify({ claims, evidence, actor, failures: failures.map((e) => e.message) }, null, 2),
  );
}
if (failures.length)
  throw new AggregateError(failures, 'Planning authority proof or cleanup failed');
console.log(JSON.stringify(claims));
