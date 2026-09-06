import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityProofRequirement,
} from '@farmslot/protocol';

import {
  claimsDevice,
  crossSlotTargetConflict,
  type DeviceHolder,
  deviceIdentityOnly,
  deviceTargetExtraVars,
  displaceIdentity,
  retargetProofRequirements,
} from './device-target.js';

function entry(
  id: string,
  parameters?: Record<string, unknown>,
  options: { device?: boolean; dependencies?: string[] } = {},
): RuntimeCapabilityCatalogEntry {
  return {
    id,
    project: 'farmslot-farm',
    label: id,
    version: '1',
    sharePolicy: 'exclusive',
    cost: {
      class: 'high',
      // Declaring a device parameter is not the same as DRIVING a device; the
      // rewrite rule needs both, so the fixtures distinguish them.
      resources: options.device
        ? [{ id: `${id}-device`, access: 'exclusive', kind: 'device' }]
        : [],
    },
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(parameters ? { parameters } : {}),
    actions: {
      acquire: { kind: 'slot-action', actionId: `${id}.acquire` },
      health: { kind: 'slot-action', actionId: `${id}.health` },
      release: { kind: 'slot-action', actionId: `${id}.release` },
    },
    releaseEffects: [],
    provenance: { project: 'farmslot-farm', providerId: id, version: '1', digest: `d-${id}` },
    availability: { state: 'available' },
  };
}

const IOS = entry(
  'ios-simulator',
  {
    type: 'object',
    properties: {
      platform: { const: 'ios' },
      udid: { type: 'string' },
      simulator: { type: 'string' },
    },
  },
  { device: true },
);
const ANDROID = entry(
  'android-device',
  {
    type: 'object',
    properties: {
      platform: { const: 'android' },
      avd: { type: 'string' },
      adb_serial: { type: 'string' },
    },
  },
  { device: true },
);
const METRO = entry('companion-metro');

function requirement(capabilityId: string): RuntimeCapabilityProofRequirement {
  return { capabilityId, reason: `prove ${capabilityId}`, mode: 'state' };
}

test('device parameters become hook variables and non-device parameters do not', () => {
  const resolved = deviceTargetExtraVars({
    simulator: 'A1B2-C3',
    adb_serial: 'emulator-5554',
    verbosity: 'high',
  });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value, { simulator: 'A1B2-C3', adb_serial: 'emulator-5554' });
});

test('udid fills the simulator placeholder projects actually template', () => {
  const resolved = deviceTargetExtraVars({ udid: 'ABCD-1234' });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.deepEqual(resolved.value, { udid: 'ABCD-1234', simulator: 'ABCD-1234' });
});

test('udid and simulator naming different devices is refused, not silently merged', () => {
  const resolved = deviceTargetExtraVars({ udid: 'AAAA', simulator: 'BBBB' });
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.match(resolved.reason, /two different iOS simulators/);
});

test('a device identity outside the shell-safe charset never reaches a template', () => {
  const injections = [
    ["A'; ", 'rm', " -rf /tmp; echo '"].join(''),
    'a b',
    '$(whoami)',
    '`id`',
    'x&&y',
    'a|b',
    'a\nb',
  ];
  for (const value of injections) {
    const resolved = deviceTargetExtraVars({ simulator: value });
    assert.equal(resolved.ok, false, `expected '${value}' to be refused`);
    if (resolved.ok) return;
    assert.match(resolved.reason, /Device parameter 'simulator' must be a string matching/);
  }
});

test('a non-string device identity is refused', () => {
  const resolved = deviceTargetExtraVars({ simulator: 42 });
  assert.equal(resolved.ok, false);
});

test('no device parameters means no hook variables at all', () => {
  const resolved = deviceTargetExtraVars({ verbosity: 'high' });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.value, undefined);
});

test('a target on another slot device with a live lease is refused', () => {
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-2',
      machine: 'macwork',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{}, { simulator: 'SIM-2', platform: 'ios' }],
    },
  ];
  assert.equal(crossSlotTargetConflict({ simulator: 'SIM-1' }, holders, 'macwork'), null);
  const refused = crossSlotTargetConflict({ simulator: 'SIM-2' }, holders, 'macwork');
  assert.match(refused ?? '', /slot 'macwork-ff-2'/);
  assert.match(refused ?? '', /run-b/);
});

test('udid and simulator are one identity when checking another slot', () => {
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-2',
      machine: 'macwork',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{ udid: 'SIM-2' }],
    },
  ];
  assert.match(crossSlotTargetConflict({ simulator: 'SIM-2' }, holders, 'macwork') ?? '', /SIM-2/);
});

test('platform alone is not a device, so it never conflicts', () => {
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-2',
      machine: 'macwork',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{ platform: 'ios', simulator: 'SIM-2' }],
    },
  ];
  assert.equal(crossSlotTargetConflict({ platform: 'ios' }, holders, 'macwork'), null);
});

test('a target rewrites only the requirement whose provider declares it', () => {
  const outcome = retargetProofRequirements(
    [requirement('companion-metro'), requirement('ios-simulator')],
    [METRO, IOS],
    { simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value, [
    { capabilityId: 'companion-metro', reason: 'prove companion-metro', mode: 'state' },
    {
      capabilityId: 'ios-simulator',
      reason: 'prove ios-simulator',
      mode: 'state',
      parameters: { simulator: 'SIM-2' },
    },
  ]);
});

test('platform picks the provider but is never stored as a device parameter', () => {
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('android-device')],
    [IOS, ANDROID],
    { platform: 'android', adb_serial: 'emulator-5554' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // `platform` chose the provider; storing it would make a target that merely
  // restates the platform differ from the held lease and force a reboot.
  assert.deepEqual(outcome.value[1]?.parameters, { adb_serial: 'emulator-5554' });
  assert.equal(outcome.value[0]?.parameters, undefined);
});

test('a platform-only target is refused rather than silently doing nothing', () => {
  // It selects a provider and names no device, so there is nothing to re-target.
  // Returning ok left the operator with a rerun and no signal.
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { simulator: 'SIM-2' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { platform: 'ios' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /names only a platform, no device parameter/);
});

test('a second re-target REPLACES the previous device key instead of unioning with it', () => {
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { udid: 'AAAA-1111', simulator: 'AAAA-1111' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { simulator: 'BBBB-2222' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Unioning would leave udid=AAAA beside simulator=BBBB: a requirement naming
  // two different simulators, one of which the operator never sent.
  assert.deepEqual(outcome.value[0]?.parameters, { simulator: 'BBBB-2222' });
});

test('a re-target clears every stored device key, so the merge cannot contradict itself', () => {
  // The stored plan carries both spellings; the target names one device. Keeping
  // the other would produce a requirement naming two simulators, refused later —
  // after the posture had already released the held device.
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { udid: 'AAAA-1111', simulator: 'AAAA-1111', note: 'kept' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { simulator: 'BBBB-2222' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[0]?.parameters, { note: 'kept', simulator: 'BBBB-2222' });
  assert.equal(deviceTargetExtraVars(outcome.value[0]!.parameters!).ok, true);
});

test('a contradiction in the incoming target is refused too', () => {
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: {},
  };
  const outcome = retargetProofRequirements([held], [IOS], {
    udid: 'AAAA-1111',
    simulator: 'BBBB-2222',
  });
  assert.equal(outcome.ok, false);
});

test('a non-device parameter on the requirement survives a re-target', () => {
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { udid: 'AAAA-1111', note: 'kept' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { simulator: 'BBBB-2222' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[0]?.parameters, { note: 'kept', simulator: 'BBBB-2222' });
});

test('only parameters the provider declares are substituted into its hook command', () => {
  // The device allowlist is global, so a provider that names a parameter
  // `simulator` for its own purposes would otherwise have it rewritten into its
  // command line, and `platform` would shadow the slot's auto-injected one.
  const declaredNothing = deviceTargetExtraVars({ simulator: 'SIM-2', platform: 'ios' }, []);
  assert.equal(declaredNothing.ok, true);
  if (!declaredNothing.ok) return;
  assert.equal(declaredNothing.value, undefined);

  const declaredSimulator = deviceTargetExtraVars({ simulator: 'SIM-2', platform: 'ios' }, [
    'simulator',
  ]);
  assert.equal(declaredSimulator.ok, true);
  if (!declaredSimulator.ok) return;
  assert.deepEqual(declaredSimulator.value, { simulator: 'SIM-2' });
});

test('the charset is enforced even for a parameter the provider does not declare', () => {
  const refused = deviceTargetExtraVars({ simulator: '$(whoami)' }, []);
  assert.equal(refused.ok, false);
});

test('a contradiction is caught even when the provider declares only one of the keys', () => {
  const refused = deviceTargetExtraVars({ udid: 'AAAA', simulator: 'BBBB' }, ['simulator']);
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.match(refused.reason, /two different iOS simulators/);
});

test('a target no capability in the plan accepts is refused, not ignored', () => {
  const outcome = retargetProofRequirements([requirement('companion-metro')], [METRO], {
    simulator: 'SIM-2',
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /declares the device parameters this target names/);
});

test('a device target reaches every requirement that declares it', () => {
  // The simulator and the dev client installed onto it both drive one physical
  // device. Re-targeting only one left the other installing onto the simulator
  // the run had just left.
  const client = entry(
    'companion-native-client-ios',
    { type: 'object', properties: { platform: { const: 'ios' }, simulator: { type: 'string' } } },
    { device: true, dependencies: ['ios-simulator'] },
  );
  const outcome = retargetProofRequirements(
    [requirement('companion-metro'), requirement('ios-simulator'), requirement(client.id)],
    [METRO, IOS, client],
    { simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value[0]?.parameters, undefined, 'metro declares no device parameter');
  assert.deepEqual(outcome.value[1]?.parameters, { simulator: 'SIM-2' });
  assert.deepEqual(outcome.value[2]?.parameters, { simulator: 'SIM-2' });
});

test('a target still reaches only the providers that declare its key', () => {
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('android-device')],
    [IOS, ANDROID],
    { adb_serial: 'emulator-5554' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value[0]?.parameters, undefined, 'the iOS provider declares no adb_serial');
  assert.deepEqual(outcome.value[1]?.parameters, { adb_serial: 'emulator-5554' });
});

test('a target that fails the charset is refused before any plan is rewritten', () => {
  const outcome = retargetProofRequirements([requirement('ios-simulator')], [IOS], {
    simulator: 'a b',
  });
  assert.equal(outcome.ok, false);
});

test('only a provider that claims a device makes its slot a holder', () => {
  const browser = entry('browser-cdp');
  browser.cost = {
    class: 'high',
    resources: [
      { id: 'cdp-port', access: 'exclusive', kind: 'port' },
      { id: 'chrome', access: 'exclusive', kind: 'process' },
    ],
  };
  const simulator = entry('ios-simulator');
  simulator.cost = {
    class: 'high',
    resources: [{ id: 'ios-simulator', access: 'exclusive', kind: 'device' }],
  };
  const metro = entry('companion-metro');
  metro.cost = { class: 'high', resources: [{ id: 'metro', access: 'shared', kind: 'process' }] };

  assert.equal(claimsDevice(simulator), true);
  assert.equal(claimsDevice(browser), false, 'a browser lease must not reserve the slot simulator');
  assert.equal(claimsDevice(metro), false);
  assert.equal(claimsDevice({ cost: { class: 'low', resources: [] } }), false);
});

test('a leading dash is refused: shell-safe is not argument-safe', () => {
  // `-x` cannot break out of the command, but `simctl boot -x` and `adb -s -x`
  // still read it as a flag.
  for (const value of ['-x', '--udid', '-']) {
    assert.equal(deviceTargetExtraVars({ simulator: value }).ok, false, value);
  }
  assert.equal(deviceTargetExtraVars({ simulator: 'fs-4' }).ok, true);
  assert.equal(deviceTargetExtraVars({ simulator: 'A1B2-C3D4' }).ok, true);
});

test('deviceIdentityOnly drops platform and keeps real device keys', () => {
  assert.equal(deviceIdentityOnly({ platform: 'ios' }), undefined);
  assert.equal(deviceIdentityOnly({}), undefined);
  assert.deepEqual(deviceIdentityOnly({ platform: 'ios', simulator: 'SIM-2' }), {
    simulator: 'SIM-2',
  });
});

test("a foreign slot's lease displaces its configured device within the same group", () => {
  // The slot was configured with SIM-A but its lease re-targeted onto SIM-B, so
  // SIM-A is free and SIM-B is not. Counting both refused a legal target.
  // Across KEYS of one group, not just the same key: the slot is configured
  // through `simulator` and the lease re-targeted through `udid`, which is the
  // same identity spelled differently.
  const configured = { simulator: 'SIM-A', adb_serial: 'emulator-5554' };
  const displaced = displaceIdentity(configured, { udid: 'SIM-B' });
  assert.deepEqual(displaced, { adb_serial: 'emulator-5554', udid: 'SIM-B' });
  assert.equal(
    Object.keys(displaced).includes('simulator'),
    false,
    'the configured simulator is no longer in use',
  );

  const holders: DeviceHolder[] = [
    {
      slotId: 'slot-b',
      machine: 'macwork',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [displaced],
    },
  ];
  assert.equal(crossSlotTargetConflict({ simulator: 'SIM-A' }, holders, 'macwork'), null);
  assert.match(crossSlotTargetConflict({ simulator: 'SIM-B' }, holders, 'macwork') ?? '', /SIM-B/);
  // A group the lease says nothing about keeps the slot's own value.
  assert.match(
    crossSlotTargetConflict({ adb_serial: 'emulator-5554' }, holders, 'macwork') ?? '',
    /emulator-5554/,
  );
});

test('the same device name on two machines is not a conflict', () => {
  // The pool deliberately reuses `fs-1`, `emulator-5554` and avd names across
  // machines. Comparing identities fleet-wide refused an ordinary acquire on one
  // machine because another machine ran a same-named simulator.
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-1',
      machine: 'macwork',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{ simulator: 'fs-1' }],
    },
  ];
  // Same name, DIFFERENT machine: two physically distinct simulators.
  assert.equal(crossSlotTargetConflict({ simulator: 'fs-1' }, holders, 'macpro'), null);
  // Same name, same machine: still a conflict.
  assert.match(
    crossSlotTargetConflict({ simulator: 'fs-1' }, holders, 'macwork') ?? '',
    /macwork-ff-1' on macwork/,
  );
});

test('a provider that takes a simulator name but drives no device is left alone', () => {
  // Declaring the parameter makes the identity reach a provider's hooks; only a
  // device claim makes it drive the device. A report step that takes a simulator
  // name is not part of the physical device this target names.
  const report = entry('visual-report', {
    type: 'object',
    properties: { simulator: { type: 'string' } },
  });
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('visual-report')],
    [IOS, report],
    { simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[0]?.parameters, { simulator: 'SIM-2' });
  assert.equal(outcome.value[1]?.parameters, undefined, 'no dependency edge, no device claim');
});

test('two unconnected device groups cannot both be meant by one target', () => {
  const second = entry(
    'second-simulator',
    { type: 'object', properties: { simulator: { type: 'string' } } },
    { device: true },
  );
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('second-simulator')],
    [IOS, second],
    { simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /unconnected device groups/);
});

test('a declared platform on the requirement survives a device re-target', () => {
  // Only the device identity is replaced. A provider that declares `platform`
  // may need it in its hooks, so dropping it would change what it is told.
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { platform: 'ios', simulator: 'SIM-1' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { simulator: 'SIM-2' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[0]?.parameters, { platform: 'ios', simulator: 'SIM-2' });
});

test('the platform selects a whole device group, never individual members', () => {
  // The sibling declares `platform` as a free string, so its verdict is
  // undecided. Filtering members would keep ios-simulator and drop the sibling,
  // leaving it running against the device the run just left.
  const sibling = entry(
    'companion-native-client-ios',
    {
      type: 'object',
      properties: { platform: { type: 'string' }, simulator: { type: 'string' } },
    },
    { device: true, dependencies: ['ios-simulator'] },
  );
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('companion-native-client-ios')],
    [IOS, sibling],
    { platform: 'ios', simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[0]?.parameters, { simulator: 'SIM-2' });
  assert.deepEqual(
    outcome.value[1]?.parameters,
    { simulator: 'SIM-2' },
    'the connected sibling must move with its group, not be left behind',
  );
});

test('a platform that no group serves is still refused', () => {
  const outcome = retargetProofRequirements([requirement('ios-simulator')], [IOS], {
    platform: 'android',
    simulator: 'SIM-2',
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /serves platform 'android'/);
});
