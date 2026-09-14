#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const statePath = process.env.NATIVE_COMPANION_DRAFT_STATE;
assert(statePath && process.env.NATIVE_COMPANION_TOKEN_FILE);
process.env.FARMSLOT_GATEWAY = 'ws://127.0.0.1:18777';
process.env.FARMSLOT_GATEWAY_TOKEN = fs
  .readFileSync(process.env.NATIVE_COMPANION_TOKEN_FILE, 'utf8')
  .trim();
const { rpc } = await import(
  path.join(root, 'scripts/runner-validation/scenarios/native-worker-lifecycle.mjs')
);
const phase = process.argv[2];
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () =>
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
const evidence = (name, value) => {
  fs.mkdirSync(`${statePath}.evidence`, { recursive: true });
  fs.writeFileSync(`${statePath}.evidence/${name}.json`, JSON.stringify(value, null, 2) + '\n');
};
const read = () => rpc('native.session.read', { sessionId: state.sessionId, limit: 500 });
if (phase === 'setup') {
  assert(!fs.existsSync(statePath), 'Use a fresh proof state path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'farmslot-native-draft-'));
  execFileSync('git', ['init', '--quiet', cwd]);
  const { session } = rpc('native.session.create', { runner: 'codex', model: 'gpt-6-astra', cwd });
  state = { cwd, sessionId: session.id, nativeSessionId: session.nativeSessionId };
  save();
  evidence('before', read());
} else if (phase === 'open') {
  assert(process.env.IOS_SIMULATOR, 'Set the private simulator ID');
  execFileSync('xcrun', [
    'simctl',
    'openurl',
    process.env.IOS_SIMULATOR,
    `farmslot-development:///native?sessionId=${encodeURIComponent(state.sessionId)}&executionNodeId=local`,
  ]);
} else if (phase === 'drop-focused') {
  assert(process.env.NATIVE_COMPANION_DRAFT, 'Set the exact typed proof draft');
  const expression = `
    const module = (suffix) => {
      const entry = Array.from(__r.getModules()).find(([, m]) => m.verboseName?.endsWith(suffix));
      if (!entry) throw new Error('Missing module ' + suffix);
      return __r(entry[0]);
    };
    const store = module('/store/connection.ts').useConnectionStore;
    const initial = store.getState();
    if (initial.gatewayUrl !== 'ws://127.0.0.1:18777' || initial.status !== 'connected')
      throw new Error('Expected the connected private gateway');
    const route = module('global-state/router-store.js').store.getRouteInfo();
    if (route.params.sessionId !== ${JSON.stringify(state.sessionId)}) throw new Error('Wrong proof session');
    const focused = module('/TextInput/TextInputState.js').default.currentlyFocusedInput();
    const props = focused?.__internalInstanceHandle?.memoizedProps;
    if (props?.testID !== 'companion-native-draft' || props.text !== ${JSON.stringify(process.env.NATIVE_COMPANION_DRAFT)})
      throw new Error('The exact unsent draft must still be focused before disconnect');
    const client = initial.client;
    const generation = client.connectionGeneration;
    const transitions = [];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('Reconnect timeout')); }, 20000);
      const unsubscribe = store.subscribe((current) => {
        transitions.push({ status: current.status, generation: current.client?.connectionGeneration });
        if (current.status === 'connected' && current.client?.connectionGeneration > generation && transitions.some(t => t.status === 'disconnected')) {
          clearTimeout(timer); unsubscribe(); resolve();
        }
      });
      // Close only the real device transport. No controller/store state is injected.
      client.ws.close(4000, 'private focused draft reconnect proof');
    });
    return { focusedDraft: true, sessionId: route.params.sessionId, transitions };
  `;
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(root, 'apps/companion/scripts/agentic/cdp-eval.mjs'), expression],
      { encoding: 'utf8', timeout: 30000 },
    ),
  );
  assert.equal(result?.focusedDraft, true, 'CDP must return a settled focused-draft observation');
  assert.equal(result.sessionId, state.sessionId);
  assert.ok(result.transitions.some((entry) => entry.status === 'disconnected'));
  assert.equal(result.transitions.at(-1)?.status, 'connected');
  evidence('focused-disconnect-reconnect', result);
} else if (phase === 'verify-unsent') {
  const before = JSON.parse(fs.readFileSync(`${statePath}.evidence/before.json`, 'utf8'));
  const after = read();
  assert.equal(after.session.nativeSessionId, state.nativeSessionId);
  assert.deepEqual(after.commands, before.commands, 'Reconnection must not send the saved draft');
  assert.deepEqual(
    after.pendingRequests,
    before.pendingRequests,
    'Reconnection must not answer requests',
  );
  assert.deepEqual(after.events, before.events, 'Draft edits must not emit runner events');
  evidence('unsent-after-reconnect', after);
} else if (phase === 'cleanup') {
  rpc('native.session.close', { sessionId: state.sessionId });
  const page = read();
  assert.equal(page.session.state, 'closed');
  assert.equal(page.session.processStopped, true);
  evidence('cleanup', page);
} else throw new Error(`Unknown phase ${phase}`);
console.log(JSON.stringify({ phase, sessionId: state.sessionId, pass: true }));
