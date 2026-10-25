import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { register } from 'tsx/esm/api';

import { automationGatewayTarget } from '../../../scripts/lib/gateway-profile.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
assert.equal(process.cwd(), root);
assert.equal(process.env.FARMSLOT_OFFLINE_PROOF, '1');
assert.equal(process.env.FARMSLOT_DISABLE_ORCHESTRATION, '1');
const heldReply = process.argv[2] === 'held-reply';
const prAuthority = process.argv[2] === 'pr-authority';
assert(!process.argv[2] || heldReply || prAuthority);
const target = await automationGatewayTarget();
assert(['127.0.0.1', 'localhost'].includes(new URL(target.url).hostname));
assert.equal(new URL(target.url).port, process.env.GATEWAY_PORT);
assert.equal(process.env.GATEWAY_PORT, '7913');
const listener = await execute('lsof', ['-nP', '-t', '-iTCP:7913', '-sTCP:LISTEN']);
const backendPid = Number(listener.stdout.trim());
assert(Number.isSafeInteger(backendPid) && backendPid > 0);
const cwd = await execute('lsof', ['-a', '-p', String(backendPid), '-d', 'cwd', '-Fn']);
assert(cwd.stdout.split('\n').includes(`n${root}/services/gateway`));
const fixture = JSON.parse(await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'));
assert(fixture.setupComplete && fixture.farm !== root);
assert.equal(fixture.farm, process.env.FARMSLOT_ROOT);
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
const lateProxy = heldReply
  ? JSON.parse(
      await readFile(
        path.join(process.env.FARMSLOT_PLANNING_RACE_PROXY_DIR, 'proxy-ready.json'),
        'utf8',
      ),
    )
  : undefined;
if (lateProxy) {
  assert.equal(lateProxy.method, 'roadmap.list');
  assert.equal(lateProxy.port, 7915);
}
async function proxyStatus() {
  const response = await fetch('http://127.0.0.1:7915/planning-race-status', {
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok);
  const state = await response.json();
  assert.equal(state.startId, lateProxy.startId);
  assert(!state.failure && !state.stopped);
  return state;
}
async function proxyControl(action) {
  const response = await fetch('http://127.0.0.1:7915/api/planning-race-control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-proof-owner': lateProxy.owner },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(3000),
  });
  assert(response.ok, `Owned ${action} control failed`);
  assert.equal((await response.json()).startId, lateProxy.startId);
}
async function navigate(hash) {
  const url = new URL(process.env.FARMSLOT_UI_URL);
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, process.env.VITE_PORT);
  url.searchParams.set('authority-proof', path.basename(path.dirname(artifacts)));
  url.hash = hash;
  await cdp(['goto', url.href, ...(!tab && heldReply ? ['--new'] : [])]);
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
    `const url=performance.getEntriesByType('resource').map(({name})=>name).filter(name=>new URL(name).pathname.endsWith('/src/gateway-client.ts')).at(-1); if(!url)return {};const {gateway}=await import(url);return {principalId:gateway.authenticatedPrincipalId,connection:gateway.connectionState,workspaceAccess:gateway.workspaceAccess,roles:gateway.authenticatedConnection?.principal?.roles,authForm:Boolean(document.querySelector('.auth-card'))};`,
  ]);
async function signOut() {
  const state = await authState();
  if (state.authForm) return;
  const menuOpen = () =>
    cdp([
      'eval',
      tab,
      "return Boolean(document.querySelector('[data-testid=account-menu]')?.closest('details')?.open)",
    ]);
  if (!(await menuOpen())) await cdp(['click', tab, '[data-testid="account-menu"]']);
  await until(menuOpen, Boolean, 'Wait for the real account menu');
  await cdp(['click', tab, '[data-testid="account-sign-out"]']);
  await until(
    () =>
      cdp([
        'eval',
        tab,
        "return Boolean(document.querySelector('[data-testid=account-sign-out-confirmation]')?.open)",
      ]),
    Boolean,
    'Wait for the real sign-out confirmation',
  );
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
const inspectPR = () =>
  cdp([
    'eval',
    tab,
    `
function find(root){const panel=root.querySelector('pr-automation-panel');if(panel)return panel;for(const child of root.querySelectorAll('*'))if(child.shadowRoot){const panel=find(child.shadowRoot);if(panel)return panel;}}
const panel=find(document);if(!panel)return {mounted:false};
const url=(suffix)=>performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith(suffix)).at(-1);
const {gateway}=await import(url('/src/gateway-client.ts'));const {getResourceCache}=await import(url('/src/resource-cache.ts'));
const controller=Reflect.get(panel,'controller');
const observations=['watchResources','ruleResources','pushResources'].map(name=>{
 const observer=Reflect.get(controller,name),query=Reflect.get(observer,'query'),state=observer.state;
 if(observer.belongsToWorkspace&&getResourceCache()?.read(query)!==state)throw Error('Inspect actual canonical PR state');
 return {method:query.method,persisted:query.persisted,ready:observer.ready,status:state.status,error:state.error,observedAt:state.observedAt,dataPresent:state.data!==undefined,canonicalDataPresent:getResourceCache()?.read(query)?.data!==undefined};
});
return {mounted:true,principalId:gateway.authenticatedPrincipalId,workspaceAccess:gateway.workspaceAccess,connectionId:gateway.resourceConnectionId,timeOrigin:performance.timeOrigin,observations,rules:controller.reviews.rules.map(r=>({id:r.id,name:r.config.name})),text:panel.shadowRoot.textContent};
`,
  ]);
async function warmPR() {
  await navigate(
    `prs?prSection=automation&prTab=rules&projects=${encodeURIComponent(fixture.project)}`,
  );
  const view = await until(
    inspectPR,
    (value) =>
      value.principalId === actor.principalId &&
      value.observations?.every((row) => row.ready && !row.persisted) &&
      value.rules.some(
        (row) => row.id === fixture.prFixture.ruleId && row.name === fixture.prFixture.ruleName,
      ) &&
      value.text.includes(fixture.prFixture.ruleName),
    "Render the disposable actor's actual memory-only PR rule",
  );
  await screenshot('private-pr-authorized');
  return view;
}
async function deniedPR() {
  const view = await until(
    inspectPR,
    (value) =>
      value.principalId === actor.principalId &&
      value.workspaceAccess === 'farm' &&
      value.observations?.every(
        (row) => !row.ready && !!row.error && !row.dataPresent && !row.canonicalDataPresent,
      ) &&
      value.rules.length === 0 &&
      !value.text.includes(fixture.prFixture.ruleName),
    'Operator authority must clear the actual PR projections and forbidden canonical data',
  );
  assert.equal(view.timeOrigin, evidence.prWarm.timeOrigin);
  await screenshot('private-pr-forbidden');
  return view;
}
async function seedPR() {
  const seeded = await execute(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/command-center/scripts/pr-automation-observation-fixture.mjs',
      'seed',
    ],
    { timeout: 30000, env: { ...process.env, FARMSLOT_GATEWAY_PROFILE: actor.profile } },
  );
  fixture.prFixture = JSON.parse(
    await readFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, 'utf8'),
  ).prFixture;
  assert.equal(fixture.prFixture.ownerId, actor.principalId);
  assert.equal(fixture.prFixture.seededBeforeUi, false);
  assert(fixture.prFixture.seededBeforeOwnerPRView);
  evidence.prSourceSetup = JSON.parse(seeded.stdout);
  await until(
    () => cdp(['gateway', 'prRules.list', '{}'], actor.profile),
    (value) => value.rules.some((row) => row.id === fixture.prFixture.ruleId),
    'The actual gateway file watcher must admit the owning private PR source before its view opens',
  );
}
async function changePRWhileRevoked() {
  const file = path.join(fixture.farm, '.pr-rules.json');
  const source = JSON.parse(await readFile(file, 'utf8'));
  const rule = source.rules.find((row) => row.id === fixture.prFixture.ruleId);
  assert.equal(rule.ownerId, actor.principalId);
  rule.config.name = `Changed while PR authority revoked ${randomUUID()}`;
  fixture.prFixture.ruleName = rule.config.name;
  const bytes = Buffer.from(JSON.stringify(source) + '\n');
  const temporary = path.join(fixture.farm, '.pr-rules.d07-' + randomUUID());
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  fixture.prFixture.allowedHashes['.pr-rules.json'].push(sha256);
  fixture.prFixture.temporaries.push({ file: temporary, sha256 });
  await writeFile(process.env.FARMSLOT_DOMAIN_PROOF_SETUP, JSON.stringify(fixture), {
    mode: 0o600,
  });
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
  evidence.prChangedSource = {
    id: rule.id,
    name: rule.config.name,
    sha256,
    committedAt: Date.now(),
  };
}
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

async function prepareHeldReply() {
  await navigate(views().find(([method]) => method === 'roadmap.list')[1]);
  const before = await until(
    inspectView,
    (view) => view.observations?.['roadmap.list']?.ready,
    'Hold a reply for the actual mounted roadmap collection',
  );
  await proxyControl('arm');
  const current = (await rpc('roadmap.get', { itemId: owned.roadmap.id })).item;
  const title = `Held private roadmap ${randomUUID()}`;
  owned.roadmap = (
    await rpc('roadmap.save', {
      expectedHash: current.fileHash,
      item: { id: current.id, project: fixture.project, body: current.body, title },
    })
  ).item;
  const captured = await until(
    proxyStatus,
    (value) => !!value.held,
    'Capture the real admin reply',
  );
  assert.equal(captured.held.paramsSha256, profileHash(before.observations['roadmap.list'].params));
  assert.equal(captured.held.authentication.principalId, actor.principalId);
  assert(captured.held.authentication.roleNames.includes('admin'));
  const actual = await rpc('roadmap.list', queries['roadmap.list']);
  assert(actual.items.some((row) => row.id === owned.roadmap.id && row.title === title));
  evidence.heldAdminReply = captured;
  evidence.heldSource = { id: owned.roadmap.id, title };
}

async function replayAfterRoleChange(scope) {
  const connectionBefore = (await inspectView()).connectionId;
  const oldRequestId = evidence.heldAdminReply.held.id;
  const retiredRequest = () =>
    cdp([
      'eval',
      tab,
      `const url=performance.getEntriesByType('resource').map(x=>x.name).filter(name=>new URL(name).pathname.endsWith('/src/gateway-client.ts')).at(-1);const {gateway}=await import(url);const pending=Reflect.get(gateway,'pending');if(!pending||typeof pending.has!=='function')throw Error('Inspect the actual transport pending map');return {oldRequestPending:pending.has(${JSON.stringify(oldRequestId)}),principalId:gateway.authenticatedPrincipalId,connectionId:gateway.resourceConnectionId};`,
    ]);
  const beforeDelivery = await retiredRequest();
  await proxyControl('release-after-authority-change');
  const replay = await proxyStatus();
  const old = evidence.heldAdminReply.held;
  assert.equal(replay.held.frameSha256, old.frameSha256, 'Do not modify old IDs, data or stamps');
  assert.notEqual(replay.held.deliveredConnection, old.connection);
  assert.equal(replay.held.destinationAuthentication.principalId, actor.principalId);
  assert.deepEqual(replay.held.destinationAuthentication.roleNames, ['operator']);
  evidence.lateReplay = { replay, beforeDelivery };
  const title = `After authority boundary ${randomUUID()}`;
  const written = await rpc('backlog.update', { itemId: owned.backlog.id, title });
  assert.equal(written.item.title, title);
  await navigate(views().find(([method]) => method === 'backlog.list')[1]);
  const barrierView = await until(
    inspectView,
    (view) =>
      view.observations?.['backlog.list']?.ready &&
      view.observations['backlog.list'].rows.some(
        (row) => row.id === owned.backlog.id && row.title === title,
      ) &&
      view.renderedRows.some((row) => row.id === owned.backlog.id && row.text.includes(title)),
    'An actual permitted reply must be processed after the old frame on the new connection',
  );
  assert.equal(barrierView.connectionId, connectionBefore);
  const wire = await until(
    proxyStatus,
    (value) =>
      value.barrierReplies.some(
        (row) =>
          row.connection === replay.held.deliveredConnection &&
          row.requestAt > replay.held.replayedAt &&
          JSON.stringify(row.resourceState) ===
            JSON.stringify(barrierView.observations['backlog.list'].resourceState),
      ),
    'Bind the browser barrier to its actual new-connection response stamp',
  );
  const persisted = await until(
    () => inspectAll(scope),
    (states) =>
      ['roadmap.list', 'config.projects'].every(
        (method) =>
          !states[method].cacheHasData &&
          states[method].storedObservedAt === undefined &&
          !states[method].storedQueryIds.some((id) => id.startsWith(`${method}:`)),
      ) &&
      states['backlog.list'].storedObservedAt === states['backlog.list'].cacheObservedAt &&
      states['backlog.list'].storedDataSha256 === states['backlog.list'].cacheDataSha256,
    'Old private data must remain absent from actual cache and SQLite after delivery',
  );
  const auth = await authState();
  assert.equal(auth.principalId, actor.principalId);
  assert.deepEqual(
    auth.roles.map((row) => row.role),
    ['operator'],
  );
  await navigate(views().find(([method]) => method === 'roadmap.list')[1]);
  const denied = await until(
    inspectView,
    (view) =>
      !!view.observations?.['roadmap.list']?.error &&
      !view.observations['roadmap.list'].dataPresent &&
      !view.renderedRows.some((row) => row.id === owned.roadmap.id) &&
      view.editorTitle !== owned.roadmap.title,
    'The actual forbidden roadmap must not render the delivered old data',
  );
  assert.equal(denied.connectionId, connectionBefore);
  const afterDelivery = await retiredRequest();
  evidence.lateReplay = {
    ...evidence.lateReplay,
    wire,
    written,
    barrierView,
    persisted,
    auth,
    denied,
    afterDelivery,
  };
  assert(
    !beforeDelivery.oldRequestPending && !afterDelivery.oldRequestPending,
    'The old admin request must be retired from the current transport',
  );
  await screenshot('old-admin-reply-after-role-revocation');
  claims.heldReplyCannotCrossAuthority = true;
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
  await navigate(views()[0][1]);
  const initialLogin = await until(
    authState,
    (state) => state.authForm || state.connection === 'connected',
    'Wait for the actual initial authentication state',
  );
  if (initialLogin.authForm) assert((await cdp(['login', tab])).authenticated);
  evidence.initialAuthentication = await until(
    authState,
    (state) => state.connection === 'connected' && state.principalId === fixture.ownerId,
    'Sign in the selected original account through its real form',
  );
  evidence.originalSaved = await warm(fixture.ownerId);
  const originalScope = evidence.originalSaved['roadmap.list'].inspectedScope;
  const created = await rpc('principal.create', {
    subject: { type: 'service', displayName: `Offline authority ${randomUUID()}` },
    roles: [
      { role: 'admin', scope: { kind: 'global' } },
      { role: 'operator', scope: { kind: 'global' } },
    ],
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
  if (prAuthority) await seedPR();
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
  if (prAuthority) evidence.prWarm = await warmPR();
  const actorScope = evidence.actorSaved['roadmap.list'].inspectedScope;
  await screenshot('five-collections-before-revocation');
  if (heldReply) await prepareHeldReply();
  await rpc('principal.revokeRole', {
    principalId: actor.principalId,
    role: 'admin',
    scope: { kind: 'global' },
  });
  await reconnect();
  evidence.operatorAuthentication = await until(
    authState,
    (s) =>
      s.principalId === actor.principalId &&
      s.connection === 'connected' &&
      s.workspaceAccess === 'farm' &&
      s.roles?.length === 1 &&
      s.roles[0].role === 'operator',
    'A real role downgrade keeps farm access while removing admin authority',
  );
  if (prAuthority) {
    evidence.prDenied = await deniedPR();
    claims.prAuthorityClearsProjection = true;
  }
  if (heldReply) await replayAfterRoleChange(actorScope);
  const operatorMethods = ['backlog.list', 'workGraph.list', 'dispatch.queue.list'];
  evidence.operatorViews = [];
  for (const [method, hash, id] of views()) {
    if (!operatorMethods.includes(method)) continue;
    await navigate(hash);
    const view = await until(
      inspectView,
      (v) =>
        v.principalId === actor.principalId &&
        v.observations?.[method]?.ready &&
        v.observations[method].observedAt > evidence.actorSaved[method].cacheObservedAt &&
        v.observations[method].rows.some((r) => r.id === id),
      `Read permitted ${method} afresh through its actual view after the role downgrade`,
    );
    evidence.operatorViews.push({ method, view });
  }
  evidence.operatorSaved = await until(
    () => inspectAll(actorScope),
    (result) =>
      Object.entries(result).every(([method, state]) =>
        operatorMethods.includes(method)
          ? state.cacheStatus === 'ready' &&
            state.cacheObservedAt > evidence.actorSaved[method].cacheObservedAt &&
            state.storedDataSha256 === state.cacheDataSha256
          : !state.cacheHasData &&
            state.storedObservedAt === undefined &&
            !state.storedQueryIds.some((id) => id.startsWith(`${method}:`)),
      ),
    'Partial authority must save only freshly authorized lists and clear every forbidden collection',
  );
  for (const [method, hash, id] of views()) {
    if (operatorMethods.includes(method)) continue;
    await navigate(hash);
    const view = await until(
      inspectView,
      (v) =>
        v.mounted &&
        v.principalId === actor.principalId &&
        !!v.observations?.[method]?.error &&
        !v.observations[method].dataPresent &&
        !v.renderedRows.some((row) => row.id === id) &&
        (method === 'config.projects'
          ? !v.configuration?.labels.includes(fixture.project) && v.configuration?.info.length === 0
          : v.editorTitle !== owned.roadmap.title),
      `The actual ${method} view cannot retain forbidden facts after a role downgrade`,
    );
    evidence.operatorViews.push({ method, view });
  }
  claims.partialRoleRefetchesAllowed = true;
  await screenshot('operator-forbidden-configuration-cleared');
  await rpc('principal.revokeRole', {
    principalId: actor.principalId,
    role: 'operator',
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
  if (prAuthority) await changePRWhileRevoked();
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
  if (prAuthority) {
    evidence.prRecovered = await warmPR();
    assert(
      evidence.prRecovered.observations.every(
        (row) => row.observedAt > evidence.prChangedSource.committedAt,
      ),
    );
    assert.equal(evidence.prRecovered.timeOrigin, evidence.prWarm.timeOrigin);
    claims.prAuthorityRecoveryReadsNewSource = true;
  }
  await screenshot('five-collections-authority-restored');
} catch (error) {
  failures.push(error);
  if (tab) {
    try {
      evidence.failureView = await inspectView();
      if (prAuthority && fixture.prFixture) evidence.prFailureView = await inspectPR();
      await screenshot('first-failure');
    } catch (captureError) {
      failures.push(captureError);
    }
  }
} finally {
  if (actor) {
    try {
      if (restoreBrowser) {
        const currentActor = (await rpc('principal.list')).principals.find(
          (principal) => principal.id === actor.principalId,
        );
        if (
          currentActor?.roles.some(
            (binding) => binding.role === 'operator' && binding.scope.kind === 'global',
          )
        )
          await rpc('principal.revokeRole', {
            principalId: actor.principalId,
            role: 'operator',
            scope: { kind: 'global' },
          });
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
      if (evidence.actorSaved) {
        evidence.retiredScope = await inspectAll(
          evidence.actorSaved['roadmap.list'].inspectedScope,
        );
        assert(
          Object.values(evidence.retiredScope).every((state) => state.storedQueryIds.length === 0),
          'Normal sign-out must remove every saved row of the retired test account',
        );
      }
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
  if (heldReply && tab) {
    try {
      const current = await authState();
      if (!current.authForm) {
        assert.equal(
          current.principalId,
          fixture.ownerId,
          'Restore the original account before closing',
        );
        await signOut();
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      await cdp(['close', tab]);
      evidence.ownedTabClosed = true;
    } catch (error) {
      failures.push(error);
    }
  }
  await writeFile(
    path.join(artifacts, 'planning-authority-receipt.json'),
    JSON.stringify({ claims, evidence, actor, failures: failures.map((e) => e.message) }, null, 2),
  );
}
if (failures.length)
  throw new AggregateError(failures, 'Planning authority proof or cleanup failed');
console.log(JSON.stringify(claims));
