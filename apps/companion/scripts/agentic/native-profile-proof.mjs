import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Methods, NativeSessionEventTypes } from '@farmslot/protocol';

import { ROOT } from '../../../../scripts/runner-validation/lib/common.mjs';
import {
  rpc,
  wait,
} from '../../../../scripts/runner-validation/scenarios/native-worker-lifecycle.mjs';

const PHASES = Object.freeze({
  SIGNED_OUT: 'signed-out',
  AUTHENTICATED: 'authenticated',
  RECONNECT: 'reconnect',
  REPLACE: 'replace',
  STALE: 'stale',
  ADOPT: 'adopt',
  REMEMBERED: 'remembered',
  CLOSE: 'close',
  RESUMED: 'resumed',
  RECALLED: 'recalled',
  CLEANUP: 'cleanup',
  AVAILABILITY_COLLAPSED: 'availability-collapsed',
  AVAILABILITY_EXPANDED: 'availability-expanded',
});
const phase = process.argv[2];
assert.ok(Object.values(PHASES).includes(phase));
const statePath = process.env.NATIVE_COMPANION_PROFILE_STATE;
assert.ok(
  statePath &&
    path.resolve(statePath).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
assert.equal(process.env.FARMSLOT_GATEWAY, 'ws://127.0.0.1:18777');
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const controls = () =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/companion/scripts/agentic/cdp-eval.mjs'),
        '--file',
        path.join(ROOT, 'apps/companion/scripts/agentic/probes/native-profile-controls.js'),
      ],
      { encoding: 'utf8', timeout: 30000 },
    ),
  );
const read = () =>
  rpc(Methods.NATIVE_SESSION_READ, { sessionId: state.sessionId, executionNodeId: 'local' });
const proofSessions = () =>
  rpc(Methods.NATIVE_SESSION_LIST, { executionNodeId: 'local' }).sessions.filter(
    (s) => !s.workerManaged && s.cwd === state.cwd,
  );
const authenticatedSelection = async () => {
  const mobile = await wait(
    controls,
    (m) =>
      m.controls.some(
        (c) => c.id === 'companion-native-profile-status' && c.text.includes('authenticated'),
      ),
    30000,
  );
  assert.ok(
    mobile.controls.some(
      (c) => c.id === `companion-native-runner-profile-${state.profile.id}` && c.selected === true,
    ),
  );
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-create' && c.disabled === false),
  );
  return mobile;
};
const observedSession = () => {
  const mobile = controls();
  assert.equal(mobile.connection.gatewayUrl, process.env.FARMSLOT_GATEWAY);
  assert.equal(mobile.connection.principalId, 'native-owner');
  assert.equal(mobile.route.pathname, '/native');
  assert.ok(mobile.route.params.sessionId);
  return {
    mobile,
    page: rpc(Methods.NATIVE_SESSION_READ, {
      sessionId: mobile.route.params.sessionId,
      executionNodeId: 'local',
    }),
  };
};
if (phase === PHASES.AVAILABILITY_COLLAPSED || phase === PHASES.AVAILABILITY_EXPANDED) {
  const unavailable = rpc(Methods.NATIVE_SESSION_LIST, {}).unavailableExecutionNodes ?? [];
  assert.ok(
    unavailable.length > 0,
    'This proof requires the existing unavailable validation nodes',
  );
  const expanded = phase === PHASES.AVAILABILITY_EXPANDED;
  const mobile = await wait(
    controls,
    (m) =>
      m.controls.some(
        (c) => c.id === 'companion-native-unavailable-toggle' && c.expanded === expanded,
      ),
    10000,
  );
  const toggle = mobile.controls.find((c) => c.id === 'companion-native-unavailable-toggle');
  assert.ok(toggle.text.includes(`(${unavailable.length})`));
  const details = mobile.controls.filter((c) =>
    c.id.startsWith('companion-native-unavailable-detail-'),
  );
  if (expanded) {
    const messages = new Set(details.map((c) => c.text));
    assert.deepEqual(
      messages,
      new Set(unavailable.map((node) => `${node.executionNodeId}: ${node.message}`)),
    );
  } else {
    assert.equal(details.length, 0, 'Unrelated node failures must be collapsed by default');
  }
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-create' && c.disabled === false),
    'Healthy local conversation creation remains available',
  );
  assert.equal(proofSessions().length, state.sessionCount);
} else if (phase === PHASES.SIGNED_OUT) {
  const mobile = await wait(
    controls,
    (m) =>
      m.controls.some(
        (c) => c.id === 'companion-native-profile-status' && c.text.includes('signed-out'),
      ),
    30000,
  );
  const buttons = mobile.controls.filter(
    (c) => c.id === 'companion-native-create' && c.disabled !== undefined,
  );
  assert.ok(buttons.length && buttons.every((c) => c.disabled));
  assert.equal(proofSessions().length, state.sessionCount);
} else if (phase === PHASES.AUTHENTICATED) {
  await authenticatedSelection();
} else if (phase === PHASES.RECONNECT) {
  await authenticatedSelection();
  const reconnect = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/companion/scripts/agentic/cdp-eval.mjs'),
        '--file',
        path.join(ROOT, 'apps/companion/scripts/agentic/probes/native-profile-reconnect.js'),
      ],
      { encoding: 'utf8', timeout: 30000 },
    ),
  );
  assert.ok(reconnect.transitions.some((t) => t.status === 'disconnected'));
  assert.equal(reconnect.transitions.at(-1).status, 'connected');
  await authenticatedSelection();
  assert.equal(proofSessions().length, state.sessionCount);
  state.reconnect = reconnect;
  save();
} else if (phase === PHASES.REPLACE) {
  const previous = state.profile;
  assert.equal(
    previous.id,
    'existing-claude',
    'Only replace the isolated gateway fixture registration',
  );
  rpc(Methods.NATIVE_PROFILE_REMOVE, {
    profileId: previous.id,
    accountContextId: previous.accountContextId,
  });
  state.profile = rpc(Methods.NATIVE_PROFILE_ADD, {
    profileId: previous.id,
    runner: previous.runner,
    directory: previous.directory,
  }).profile;
  assert.notEqual(state.profile.accountContextId, previous.accountContextId);
  assert.equal(state.profile.directory, previous.directory);
  save();
} else if (phase === PHASES.STALE) {
  const mobile = await wait(
    controls,
    (m) =>
      m.controls.some(
        (c) => c.id === 'companion-native-profile-error' && c.text.includes('registration changed'),
      ),
    30000,
  );
  assert.ok(mobile.controls.some((c) => c.id === 'companion-native-create' && c.disabled === true));
  assert.ok(
    mobile.controls.some(
      (c) =>
        c.id === `companion-native-runner-profile-${state.profile.id}` &&
        c.selected === false &&
        c.text.includes('Use updated profile'),
    ),
  );
  assert.equal(proofSessions().length, state.sessionCount);
} else if (phase === PHASES.ADOPT) {
  const { page } = observedSession();
  state.sessionId = page.session.id;
  save();
  assert.equal(page.session.profileId, state.profile.id);
  assert.equal(page.session.accountContextId, state.profile.accountContextId);
  assert.equal(page.session.runner, 'claude');
  assert.equal(page.session.model, 'sonnet');
  assert.equal(page.session.cwd, state.cwd);
  assert.equal(page.commands.length, 0);
  state.nativeSessionId = page.session.nativeSessionId;
  state.generation = page.session.generation;
  save();
} else if (phase === PHASES.REMEMBERED || phase === PHASES.RECALLED) {
  const expected = phase === PHASES.REMEMBERED ? 1 : 2;
  const page = await wait(
    read,
    (p) =>
      p.commands.length === expected &&
      p.commands.every((c) => c.accepted && c.outcome === 'completed') &&
      p.session.state === 'idle',
    120000,
  );
  const command = page.commands.at(-1);
  assert.ok(
    page.events
      .filter(
        (e) => e.commandId === command.commandId && e.type === NativeSessionEventTypes.TEXT_DELTA,
      )
      .map((e) => e.text ?? '')
      .join('')
      .includes(state.word),
  );
} else if (phase === PHASES.CLOSE) {
  const mobile = controls();
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-draft' && c.value === state.draft),
  );
  rpc(Methods.NATIVE_SESSION_CLOSE, { sessionId: state.sessionId });
  assert.equal(read().session.processStopped, true);
} else if (phase === PHASES.RESUMED) {
  const { mobile, page } = await wait(
    observedSession,
    ({ page }) => page.session.generation !== state.generation && page.session.state === 'idle',
    30000,
  );
  state.sessionId = page.session.id;
  save();
  assert.equal(page.session.nativeSessionId, state.nativeSessionId);
  assert.notEqual(page.session.generation, state.generation);
  assert.equal(page.session.profileId, state.profile.id);
  assert.equal(page.session.accountContextId, state.profile.accountContextId);
  assert.equal(page.commands.length, 1, 'Resume replayed a command');
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-draft' && c.value === state.draft),
    'Unsent draft was lost',
  );
} else if (phase === PHASES.CLEANUP) {
  if (!state.sessionId) {
    const ids = new Set(state.beforeIds);
    const created = proofSessions().filter((s) => !ids.has(s.id));
    assert.ok(created.length <= 1, 'Inspect unexpected sessions before cleanup');
    state.sessionId = created[0]?.id;
    save();
  }
  if (state.sessionId) {
    rpc(Methods.NATIVE_SESSION_CLOSE, { sessionId: state.sessionId });
    assert.equal(read().session.processStopped, true);
  }
}
console.log(JSON.stringify({ phase, pass: true, sessionId: state.sessionId }));
