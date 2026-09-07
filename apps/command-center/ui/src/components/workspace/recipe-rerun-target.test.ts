import assert from 'node:assert/strict';
import test from 'node:test';

import type { DeviceInventoryEntry } from '@farmslot/protocol';

import { deviceTargetChoices, recipeRerunTarget } from './recipe-rerun-target.js';

test('an empty device field replays on the slot configured device', () => {
  assert.deepEqual(recipeRerunTarget('simulator', ''), {});
  assert.deepEqual(recipeRerunTarget('simulator', '   '), {});
});

test('a device identity becomes the rerun target under the chosen key', () => {
  assert.deepEqual(recipeRerunTarget('simulator', ' SIM-2 '), { target: { simulator: 'SIM-2' } });
  assert.deepEqual(recipeRerunTarget('adb_serial', 'emulator-5554'), {
    target: { adb_serial: 'emulator-5554' },
  });
});

test('a device identity the Gateway would refuse is refused in the client too', () => {
  const refused = recipeRerunTarget('simulator', '$(whoami)');
  assert.equal(refused.target, undefined);
  assert.match(refused.error ?? '', /Device identity must match/);
});

test('a key that is not a device identity parameter is refused', () => {
  const refused = recipeRerunTarget('recordVideo', 'true');
  assert.equal(refused.target, undefined);
  assert.match(refused.error ?? '', /is not a device identity parameter/);
});

test('a platform rides along with the device it selects a provider for', () => {
  assert.deepEqual(recipeRerunTarget('simulator', 'fs-4', 'ios'), {
    target: { simulator: 'fs-4', platform: 'ios' },
  });
});

test('a platform with no device is refused in the client, as the Gateway would', () => {
  const refused = recipeRerunTarget('simulator', '', 'android');
  assert.equal(refused.target, undefined);
  assert.match(refused.error ?? '', /choose a device too/);
});

test('no platform and no device still means the slot configured device', () => {
  assert.deepEqual(recipeRerunTarget('simulator', '', ''), {});
});

const inventory: DeviceInventoryEntry[] = [
  {
    platform: 'ios',
    key: 'simulator',
    identity: 'playground-1',
    name: 'playground-1',
    state: 'Shutdown',
  },
  {
    platform: 'ios',
    key: 'simulator',
    identity: 'fs-4',
    name: 'fs-4',
    state: 'Booted',
    configuredForSlots: ['macwork-ff-4'],
  },
  { platform: 'ios', key: 'udid', identity: 'AAAA-1', name: 'fs-4', state: 'Booted' },
  {
    platform: 'android',
    key: 'adb_serial',
    identity: 'emulator-5554',
    name: 'Pixel',
    state: 'device',
    configuredForSlots: ['macwork-ff-3', 'macwork-ff-4'],
  },
];

test('the picker offers only the identities of the selected key, sorted', () => {
  const choices = deviceTargetChoices(inventory, 'simulator');
  assert.deepEqual(
    choices.map((choice) => choice.identity),
    ['fs-4', 'playground-1'],
  );
  assert.match(choices[0]!.label, /fs-4/);
  assert.match(choices[0]!.label, /Booted/);
  assert.match(choices[0]!.label, /macwork-ff-4/);
});

test('a udid choice names the device it belongs to, which its identity does not', () => {
  const choices = deviceTargetChoices(inventory, 'udid');
  assert.deepEqual(
    choices.map((choice) => choice.identity),
    ['AAAA-1'],
  );
  assert.match(choices[0]!.label, /\(fs-4\)/);
});

test('a device two slots configure names both, so neither looks free', () => {
  const choices = deviceTargetChoices(inventory, 'adb_serial');
  assert.match(choices[0]!.label, /macwork-ff-3, macwork-ff-4/);
});

test('a key the machine listed nothing for has no choices, so the field falls back', () => {
  assert.deepEqual(deviceTargetChoices(inventory, 'avd'), []);
  assert.deepEqual(deviceTargetChoices([], 'simulator'), []);
});
