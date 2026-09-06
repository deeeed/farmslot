import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  RuntimeCapabilityCatalogEntry,
  RuntimeCapabilityProofRequirement,
} from '@farmslot/protocol';

import {
  crossSlotTargetConflict,
  type DeviceHolder,
  deviceTargetExtraVars,
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

test('platform picks the provider when both accept the target shape', () => {
  const outcome = retargetProofRequirements(
    [requirement('ios-simulator'), requirement('android-device')],
    [IOS, ANDROID],
    { platform: 'android', adb_serial: 'emulator-5554' },
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value[1]?.parameters, {
    platform: 'android',
    adb_serial: 'emulator-5554',
  });
  assert.equal(outcome.value[0]?.parameters, undefined);
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
