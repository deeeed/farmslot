import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createAgentDeviceClient } from 'agent-device';

import { Methods } from '@farmslot/protocol';

import { ROOT } from '../../../../scripts/runner-validation/lib/common.mjs';
import { wait } from '../../../../scripts/runner-validation/scenarios/native-worker-lifecycle.mjs';

const PHASES = Object.freeze({
  ARM_STATUS: 'arm-status',
  ARM_LIST: 'arm-list',
  HELD: 'held',
  CHOICES_PENDING: 'choices-pending',
  OTHER_SELECTED: 'other-selected',
  RELEASE_STATUS: 'release-status',
  RELEASE_LIST: 'release-list',
  CLEANUP: 'cleanup',
});
const phase = process.argv[2];
assert.ok(Object.values(PHASES).includes(phase));
const statePath = process.env.NATIVE_COMPANION_PROFILE_STATE;
const fault = process.env.FARMSLOT_NATIVE_PROFILE_REPLY_FAULT;
const gatewayPid = Number(process.env.FARMSLOT_NATIVE_PROFILE_REPLY_PID);
for (const file of [statePath, fault])
  assert.ok(
    file && path.resolve(file).startsWith(path.join(ROOT, 'temp/native-validation') + path.sep),
  );
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
const device = createAgentDeviceClient({ stateDir: process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR });
const controls = async () => {
  const sessions = (await device.sessions.list()).filter(
    (s) => s.device.ios?.udid === process.env.IOS_SIMULATOR && s.name.startsWith('farmslot-'),
  );
  assert.equal(sessions.length, 1);
  const snapshot = await device.capture.snapshot({
    session: sessions[0].name,
    platform: 'ios',
    target: 'mobile',
    udid: process.env.IOS_SIMULATOR,
    interactiveOnly: false,
    forceFull: true,
  });
  return {
    controls: snapshot.nodes
      .filter((n) => n.identifier?.startsWith('companion-native-'))
      .map((n) => ({
        id: n.identifier,
        text: String(n.label ?? n.value ?? ''),
        disabled: n.enabled === false,
        selected: n.selected === true || n.label?.startsWith('✓ '),
      })),
  };
};
const archive = (label) => {
  const directory = path.join(
    path.dirname(statePath),
    'evidence',
    path.basename(statePath, '.json'),
    `reply-${label}`,
  );
  fs.mkdirSync(directory, { recursive: true });
  for (const suffix of ['', '.held', '.release', '.released'])
    if (fs.existsSync(fault + suffix))
      fs.renameSync(fault + suffix, path.join(directory, path.basename(fault + suffix)));
  delete state.reply;
  save();
};
if (phase === PHASES.ARM_STATUS || phase === PHASES.ARM_LIST) {
  assert.ok(fs.existsSync(`${fault}.${gatewayPid}.loaded`));
  assert.equal(fs.existsSync(fault), false);
  const ready = JSON.parse(fs.readFileSync(`${fault}.companion-ready`, 'utf8'));
  assert.equal(ready.principalId, 'native-owner');
  assert.equal(ready.gatewayPid, gatewayPid);
  const method =
    phase === PHASES.ARM_STATUS ? Methods.NATIVE_PROFILE_STATUS : Methods.NATIVE_PROFILE_LIST;
  state.reply = { method };
  save();
  fs.writeFileSync(
    fault,
    JSON.stringify({
      gatewayPid,
      method,
      clientKind: 'companion',
      executionNodeId: 'local',
      ...(phase === PHASES.ARM_STATUS ? { profileId: state.profile.id } : {}),
    }),
    { mode: 0o600 },
  );
} else if (phase === PHASES.CHOICES_PENDING) {
  const mobile = await controls();
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-a'),
    'Pending login must keep the other profile choices available',
  );
} else if (phase === PHASES.OTHER_SELECTED) {
  const mobile = await controls();
  assert.ok(
    mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-a' && c.selected),
    'Pending login must allow choosing another profile',
  );
} else if (phase === PHASES.HELD) {
  await wait(() => fs.existsSync(`${fault}.held`), Boolean, 10000);
  state.reply.receipt = JSON.parse(fs.readFileSync(`${fault}.held`, 'utf8'));
  save();
} else if (phase === PHASES.RELEASE_STATUS || phase === PHASES.RELEASE_LIST) {
  await wait(
    controls,
    (mobile) =>
      phase === PHASES.RELEASE_STATUS
        ? mobile.controls.some(
            (c) => c.id === 'companion-native-profile-status' && c.text.includes('signed-out'),
          )
        : mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-codex'),
    10000,
  );
  assert.ok(
    Date.now() - state.reply.receipt.requestedAt < 10000,
    'The delayed response must precede the mobile request timeout',
  );
  fs.writeFileSync(`${fault}.release`, 'release\n');
  await wait(() => fs.existsSync(`${fault}.released`), Boolean, 10000);
  const receipt = JSON.parse(fs.readFileSync(`${fault}.released`, 'utf8'));
  assert.ok(
    receipt.requested && receipt.delivered,
    'The real mobile response must be delivered on explicit release',
  );
  // Allow native rendering to settle, then read the actual accessibility tree.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const mobile = await controls();
  if (phase === PHASES.RELEASE_STATUS) {
    assert.ok(
      mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-a' && c.selected),
      'Late mobile login reply changed the selected profile',
    );
    assert.ok(
      mobile.controls.some(
        (c) => c.id === 'companion-native-profile-status' && c.text.includes('signed-out'),
      ),
      'Late mobile login reply discarded the current status',
    );
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'apps/companion/scripts/agentic/native-profile-reveal.mjs'),
        'companion-native-create',
      ],
      { timeout: 30000 },
    );
    const create = (await controls()).controls.find((c) => c.id === 'companion-native-create');
    assert.ok(create, 'The native start control must be observable after scrolling');
    assert.equal(create.disabled, true, 'Late mobile login reply enabled the signed-out profile');
    archive('status');
  } else {
    assert.ok(mobile.controls.some((c) => c.id === 'companion-native-runner-codex' && c.selected));
    assert.ok(
      mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-codex'),
      'Late mobile inventory discarded the new runner choices',
    );
    assert.equal(
      mobile.controls.some((c) => c.id === 'companion-native-runner-profile-empty-a'),
      false,
      'Late mobile inventory restored the prior runner choices',
    );
    archive('list');
  }
} else if (phase === PHASES.CLEANUP && fs.existsSync(fault)) {
  assert.equal(JSON.parse(fs.readFileSync(fault, 'utf8')).clientKind, 'companion');
  fs.writeFileSync(`${fault}.release`, 'release\n');
  if (fs.existsSync(`${fault}.held`))
    await wait(() => fs.existsSync(`${fault}.released`), Boolean, 15000);
  archive('cleanup');
}
console.log(JSON.stringify({ phase, pass: true }));
