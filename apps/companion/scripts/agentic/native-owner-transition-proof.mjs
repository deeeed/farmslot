import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';
import WebSocket from 'ws';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../../../../scripts/runner-validation/lib/common.mjs';
import { connect } from '../../../../scripts/runner-validation/scenarios/native-node-broker-smoke.mjs';

// Keep one inspector connection for synchronous observations. Repeated debugger attachment
// is unstable in the installed Hermes build; this proof does not claim to fix the debugger.
assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
assert.equal(process.env.METRO_PORT, '18782');
assert.equal(process.env.IOS_SIMULATOR, '842A0B52-C423-4C61-B6ED-5011E29C021E');
const output = process.env.NATIVE_OWNER_TRANSITION_EVIDENCE;
assert.ok(
  output && path.resolve(output).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
);
fs.mkdirSync(output, { recursive: true });
const report = { pass: false, checks: [] };
const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
const selection = {
  session: 'farmslot-owner-transition',
  platform: 'ios',
  target: 'mobile',
  udid: process.env.IOS_SIMULATOR,
};
const admin = await connect(process.env.FARMSLOT_NATIVE_DENIAL_ADMIN_TOKEN, 'ui');
const ok = async (method, params = {}) => {
  const result = await admin.request(method, params, 30000);
  assert.equal(result.ok, true, `${method}: ${result.error?.message ?? 'request refused'}`);
  return result.payload;
};
let inspector;
let sequence = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(`Inspector ${method} timed out`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    inspector.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (body) => {
  const result = await call('Runtime.evaluate', {
    expression: `(() => {
      const module = suffix => { const entry = Array.from(__r.getModules()).find(([,m]) => m.verboseName?.endsWith(suffix)); if (!entry) throw Error('Missing loaded module '+suffix); return __r(entry[0]); };
      ${body}
    })()`,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const inspect = () =>
  evaluate(`
  const c=module('/store/connection.ts').useConnectionStore.getState();
  const fleet=module('/store/fleet.ts').useFleetStore.getState();
  const runs=module('/store/runs.ts').useRunStore.getState();
  const decisions=module('/store/decisions.ts').useDecisionStore.getState();
  const prs=module('/store/prs.ts').usePRStore.getState();
  const filters=module('/store/filters.ts').useFilterStore.getState();
  const route=module('global-state/router-store.js').store.getRouteInfo();
  return {status:c.status,owner:c.principalId,access:c.workspaceAccess,gateway:c.gatewayUrl,route:route.pathname,params:route.params,slots:fleet.fleet?.slots.length??0,runs:runs.runs.length,decisions:decisions.decisions.length,prs:prs.prs.length,filters:filters.filters,sources:filters.availableSources.length,profiles:c.profiles.map((p,index)=>({id:p.id,name:p.name,index})),activeProfileId:c.activeProfileId};
`);
const wait = async (fn, predicate, label) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const state = await fn();
    if (predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(`Timed out waiting for ${label}`);
};
const snapshot = () =>
  device.capture.snapshot({ ...selection, interactiveOnly: false, forceFull: true });
const control = async (id) => {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'apps/companion/scripts/agentic/native-profile-reveal.mjs'),
      id,
      /profile-\d+$|profile-name$|open-workspace$/.test(id) ? 'up' : 'down',
    ],
    { env: process.env, stdio: 'pipe', timeout: 30000 },
  );
  const s = await snapshot();
  const n = s.nodes.find((n) => n.identifier === id && n.rect);
  assert.ok(n, `Missing ${id}`);
  return { ...selection, x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 };
};
const press = async (id) => {
  await device.interactions.press(await control(id));
};
const open = async (route) => {
  await device.command.keyboard({ ...selection, action: 'dismiss' });
  await snapshot();
  execFileSync('xcrun', ['simctl', 'openurl', selection.udid, `farmslot-development://${route}`], {
    stdio: 'pipe',
  });
  await new Promise((r) => setTimeout(r, 200));
};
const emptyFarm = (state) => {
  for (const key of ['slots', 'runs', 'decisions', 'prs', 'sources'])
    assert.equal(state[key], 0, key);
  assert.deepEqual(state.filters, { projects: [], machines: [] });
};
let changed = false;
const fixturePath = process.env.NATIVE_OWNER_TRANSITION_FIXTURE;
assert.ok(
  fixturePath &&
    path.resolve(fixturePath).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
assert.equal(fixture.gateway, process.env.FARMSLOT_GATEWAY);
assert.ok(fixture.credentialId && fixture.principalId && fixture.profileId);
let credentialRevoked = false;
let originalProfile;
try {
  const principals = (await ok(Methods.PRINCIPAL_LIST)).principals;
  assert.equal(admin.principalId, 'native-other');
  assert.deepEqual(principals.find((p) => p.id === 'native-owner').roles, [
    { role: 'admin', scope: { kind: 'global' } },
  ]);
  await device.apps.open({ ...selection, app: 'net.siteed.farmslot.development', noRecord: true });
  const target = await wait(
    async () => {
      const targets = await (await fetch('http://127.0.0.1:18782/json/list')).json();
      return targets.find((item) => item.appId === 'net.siteed.farmslot.development');
    },
    Boolean,
    'private app Metro target',
  );
  inspector = new WebSocket(target.webSocketDebuggerUrl, {
    headers: { Origin: 'http://127.0.0.1:18782' },
  });
  const fail = (error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  inspector.on('error', fail);
  inspector.on('close', () => fail(Error('Private app inspector closed')));
  inspector.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    const p = pending.get(message.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(message.id);
    if (message.error) p.reject(Error(message.error.message));
    else p.resolve(message.result);
  });
  await new Promise((resolve, reject) => {
    inspector.once('open', resolve);
    inspector.once('error', reject);
  });
  await call('Runtime.enable');
  const before = await wait(
    inspect,
    (s) => s.status === 'connected' && s.owner === 'native-owner' && s.access === 'farm',
    'original farm connection',
  );
  assert.equal(before.gateway, process.env.FARMSLOT_GATEWAY);
  await evaluate(`
    if(globalThis.__nativeOwnerTransitionProof)throw Error('An owner observer is already installed');
    const prototype=module('/lib/gateway-client.ts').GatewayClient.prototype;
    const proof={request:prototype.request,handleEvent:prototype.handleEvent,calls:[],events:[]};
    prototype.request=function(method,...args){proof.calls.push({principalId:this.authenticatedPrincipal?.id,access:this.workspaceAccess,method});return proof.request.call(this,method,...args);};
    prototype.handleEvent=function(frame){proof.events.push({principalId:this.authenticatedPrincipal?.id,access:this.workspaceAccess,event:frame.event});return proof.handleEvent.call(this,frame);};
    globalThis.__nativeOwnerTransitionProof=proof;
    return {observing:true};
  `);
  originalProfile = before.activeProfileId;
  report.initial = { slots: before.slots, runs: before.runs, route: before.route };
  await open('/runs');
  const historyControl = await wait(
    snapshot,
    (s) => s.nodes.some((n) => n.label === 'History' && n.rect),
    'History control',
  );
  const historyNode = historyControl.nodes.find((n) => n.label === 'History' && n.rect);
  await device.interactions.press({
    ...selection,
    x: historyNode.rect.x + historyNode.rect.width / 2,
    y: historyNode.rect.y + historyNode.rect.height / 2,
  });
  const hydrated = await wait(inspect, (s) => s.slots > 0 && s.runs > 0, 'actual farm bootstrap');
  report.before = { slots: hydrated.slots, runs: hydrated.runs, decisions: hydrated.decisions };
  changed = true;
  await ok(Methods.PRINCIPAL_REVOKE_ROLE, {
    principalId: 'native-owner',
    role: 'admin',
    scope: { kind: 'global' },
  });
  const native = await wait(
    inspect,
    (s) => s.status === 'connected' && s.owner === 'native-owner' && s.access === 'native',
    'native-only reconnect',
  );
  emptyFarm(native);
  report.checks.push('Removing admin clears populated Companion farm state');
  await open('/native');
  await wait(inspect, (s) => s.route === '/native', 'native workspace');
  const inventory = await evaluate(
    `const c=module('/store/connection.ts').useConnectionStore.getState(); return {owner:c.principalId};`,
  );
  assert.equal(inventory.owner, 'native-owner');
  // Opening a known real history through a deep link uses the same route and gateway read as a saved-session row.
  const sessionId = process.env.NATIVE_OWNER_TRANSITION_SESSION_ID;
  const nodeId = process.env.NATIVE_OWNER_TRANSITION_NODE_ID;
  assert.ok(sessionId && nodeId);
  await open(
    `/native?sessionId=${encodeURIComponent(sessionId)}&executionNodeId=${encodeURIComponent(nodeId)}`,
  );
  await wait(
    snapshot,
    (s) =>
      s.nodes.some(
        (n) => n.identifier === 'companion-native-identity' && n.label?.includes(sessionId),
      ),
    'actual native conversation',
  );
  report.checks.push('Native-only owner opens its real saved conversation');
  await open('/connection');
  const currentProfiles = (await inspect()).profiles;
  const ownerIndex = currentProfiles.findIndex((profile) => profile.id === fixture.profileId);
  assert.ok(ownerIndex >= 0, 'Provision the saved owner profile before launching the proof');
  await press(`companion-native-profile-${ownerIndex}`);
  const switched = await wait(
    inspect,
    (s) => s.status === 'connected' && s.owner === fixture.principalId && s.access === 'native',
    'second owner authentication',
  );
  emptyFarm(switched);
  await press('companion-native-open-workspace');
  await wait(
    inspect,
    (s) => s.route === '/native' && !s.params.sessionId,
    'second owner native workspace',
  );
  const clean = await snapshot();
  assert.ok(!clean.nodes.some((n) => n.identifier === 'companion-native-identity'));
  report.checks.push('Switching saved gateway accounts removes the previous native conversation');
  await open('/workspace/run/' + process.env.FARMSLOT_NATIVE_DENIAL_RUN_ID + '/timeline');
  const denied = await wait(inspect, (s) => s.route === '/native', 'protected route refusal');
  emptyFarm(denied);
  report.checks.push('A native-only account cannot open a farm run deep link');
  execFileSync(
    'xcrun',
    ['simctl', 'io', selection.udid, 'screenshot', path.join(output, 'native-owner.png')],
    { stdio: 'pipe' },
  );
  await ok(Methods.CREDENTIAL_REVOKE, { credentialId: fixture.credentialId });
  credentialRevoked = true;
  const revoked = await wait(
    inspect,
    (s) =>
      s.status === 'disconnected' &&
      s.access === 'none' &&
      s.owner === null &&
      s.route === '/connection',
    'credential revocation',
  );
  emptyFarm(revoked);
  assert.notEqual(revoked.route, '/native');
  report.checks.push('Revoking the credential removes the native workspace and old farm state');
  const observed = await evaluate(
    `const proof=globalThis.__nativeOwnerTransitionProof;return {calls:proof.calls.filter(item=>item.access!=='farm'),events:proof.events.filter(item=>item.access!=='farm')};`,
  );
  const allowed = new Set([
    Methods.AUTH_CONNECT,
    Methods.GATEWAY_PING,
    Methods.NATIVE_SESSION_CATALOG,
    Methods.NATIVE_SESSION_LIST,
    Methods.NATIVE_SESSION_READ,
    Methods.NATIVE_PROFILE_LIST,
    Methods.NATIVE_PROFILE_STATUS,
  ]);
  assert.ok(
    observed.calls.some(
      (item) =>
        item.principalId === fixture.principalId && item.method === Methods.NATIVE_SESSION_CATALOG,
    ),
  );
  for (const item of observed.calls)
    assert.ok(allowed.has(item.method), `Unexpected non-farm request ${item.method}`);
  assert.deepEqual(observed.events, [], 'A non-farm connection received a global event');
  report.observed = observed;
  report.checks.push(
    'Native account transitions issue only permitted bootstrap/read requests and receive no global events',
  );
  report.pass = true;
} catch (error) {
  report.error = error.message;
} finally {
  try {
    if (changed)
      await ok(Methods.PRINCIPAL_GRANT, {
        principalId: 'native-owner',
        role: 'admin',
        scope: { kind: 'global' },
      });
    if (!credentialRevoked)
      await ok(Methods.CREDENTIAL_REVOKE, { credentialId: fixture.credentialId });
    if (inspector?.readyState === WebSocket.OPEN)
      await evaluate(
        `const proof=globalThis.__nativeOwnerTransitionProof;if(proof){const prototype=module('/lib/gateway-client.ts').GatewayClient.prototype;prototype.request=proof.request;prototype.handleEvent=proof.handleEvent;delete globalThis.__nativeOwnerTransitionProof;}return {observerRemoved:true};`,
      );
    if (originalProfile && inspector?.readyState === WebSocket.OPEN) {
      await open('/connection');
      const state = await inspect();
      const index = state.profiles.findIndex((p) => p.id === originalProfile);
      assert.ok(index >= 0);
      if (state.activeProfileId !== originalProfile)
        await press(`companion-native-profile-${index}`);
      await wait(
        inspect,
        (s) => s.status === 'connected' && s.owner === 'native-owner' && s.access === 'farm',
        'restored original account',
      );
      report.restored = true;
    }
  } catch (error) {
    report.pass = false;
    report.cleanupError = error.message;
  }
  inspector?.close();
  admin.ws.close();
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report));
process.exitCode = report.pass ? 0 : 1;
