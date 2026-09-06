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

function entry(id: string, parameters?: Record<string, unknown>): RuntimeCapabilityCatalogEntry {
  return {
    id,
    project: 'farmslot-farm',
    label: id,
    version: '1',
    sharePolicy: 'exclusive',
    cost: { class: 'high', resources: [] },
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

const IOS = entry('ios-simulator', {
  type: 'object',
  properties: {
    platform: { const: 'ios' },
    udid: { type: 'string' },
    simulator: { type: 'string' },
  },
});
const ANDROID = entry('android-device', {
  type: 'object',
  properties: {
    platform: { const: 'android' },
    avd: { type: 'string' },
    adb_serial: { type: 'string' },
  },
});
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
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{}, { simulator: 'SIM-2', platform: 'ios' }],
    },
  ];
  assert.equal(crossSlotTargetConflict({ simulator: 'SIM-1' }, holders), null);
  const refused = crossSlotTargetConflict({ simulator: 'SIM-2' }, holders);
  assert.match(refused ?? '', /slot 'macwork-ff-2'/);
  assert.match(refused ?? '', /run-b/);
});

test('udid and simulator are one identity when checking another slot', () => {
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-2',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{ udid: 'SIM-2' }],
    },
  ];
  assert.match(crossSlotTargetConflict({ simulator: 'SIM-2' }, holders) ?? '', /SIM-2/);
});

test('platform alone is not a device, so it never conflicts', () => {
  const holders: DeviceHolder[] = [
    {
      slotId: 'macwork-ff-2',
      capabilityId: 'ios-simulator',
      runId: 'run-b',
      identities: [{ platform: 'ios', simulator: 'SIM-2' }],
    },
  ];
  assert.equal(crossSlotTargetConflict({ platform: 'ios' }, holders), null);
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

test('a target that only restates the platform changes no stored parameter', () => {
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { simulator: 'SIM-2' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { platform: 'ios' });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.value[0]?.parameters,
    { simulator: 'SIM-2' },
    'restating the platform must not force a release and reboot of the same device',
  );
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

test('a contradiction already in the STORED plan is refused before anything is released', () => {
  // A plan written before the replacement rule, or by a direct
  // `runtime.capability.acquire` caller that passed both keys. A platform-only
  // target names no device, so the stored identity is carried forward — and
  // carrying a contradiction forward would release the held device and only
  // then refuse at acquire. The merged plan is validated here instead.
  const held = {
    capabilityId: 'ios-simulator',
    reason: 'device',
    mode: 'visual' as const,
    parameters: { udid: 'AAAA-1111', simulator: 'BBBB-2222' },
  };
  const outcome = retargetProofRequirements([held], [IOS], { platform: 'ios' });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /two different iOS simulators/);
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

test('an ambiguous target is refused rather than re-targeting a guess', () => {
  const both = entry('both-devices', {
    type: 'object',
    properties: { simulator: { type: 'string' } },
  });
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('both-devices')],
    [IOS, both],
    { simulator: 'SIM-2' },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.reason, /ambiguous/);
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
    { slotId: 'slot-b', capabilityId: 'ios-simulator', runId: 'run-b', identities: [displaced] },
  ];
  assert.equal(crossSlotTargetConflict({ simulator: 'SIM-A' }, holders), null);
  assert.match(crossSlotTargetConflict({ simulator: 'SIM-B' }, holders) ?? '', /SIM-B/);
  // A group the lease says nothing about keeps the slot's own value.
  assert.match(
    crossSlotTargetConflict({ adb_serial: 'emulator-5554' }, holders) ?? '',
    /emulator-5554/,
  );
});
