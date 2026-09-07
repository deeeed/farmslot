import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deviceControlVerdict,
  deviceInventoryRefusal,
  groupConfiguredIdentities,
  nearestIdentities,
  parseAdbDevices,
  parseEmulatorAvds,
  parseSimctlDevices,
} from './device-inventory.js';
import { deviceIdentityForControl, reconcileFailedDeviceControl } from './resource-manager.js';

const SIMCTL_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
      {
        udid: '1111-AAAA',
        name: 'fs-4',
        state: 'Booted',
        isAvailable: true,
      },
      {
        udid: '2222-BBBB',
        name: 'playground-1',
        state: 'Shutdown',
        isAvailable: true,
      },
      {
        udid: '3333-CCCC',
        name: 'unavailable-runtime',
        state: 'Shutdown',
        isAvailable: false,
      },
    ],
  },
});

test('simctl JSON yields both spellings of one simulator identity', () => {
  const devices = parseSimctlDevices(SIMCTL_JSON);
  assert.deepEqual(
    devices.filter((device) => device.key === 'simulator').map((device) => device.identity),
    ['fs-4', 'playground-1'],
  );
  assert.deepEqual(
    devices.filter((device) => device.key === 'udid').map((device) => device.identity),
    ['1111-AAAA', '2222-BBBB'],
  );
  assert.equal(devices.find((device) => device.identity === 'fs-4')?.state, 'Booted');
});

test('a simulator whose runtime is not installed is never offered as a target', () => {
  const devices = parseSimctlDevices(SIMCTL_JSON);
  assert.equal(
    devices.some((device) => device.identity === 'unavailable-runtime'),
    false,
  );
});

test('simctl output that is not JSON throws rather than being read as an empty machine', () => {
  // The caller marks the source unread on a throw, which is what makes the rule
  // fail open. Returning [] here would say "this machine has no simulators" and
  // refuse every legitimate target.
  assert.throws(() => parseSimctlDevices('Command line invocation failed'));
});

test('adb device lines are read as serial, state, and its own key:value tokens', () => {
  const devices = parseAdbDevices(
    [
      '* daemon not running; starting now at tcp:5037',
      'List of devices attached',
      'emulator-5554         device product:sdk_gphone64 model:Pixel_7 device:emu64a',
      'R5CT30ABCDE           offline',
      '',
    ].join('\n'),
  );
  assert.deepEqual(devices, [
    {
      platform: 'android',
      key: 'adb_serial',
      identity: 'emulator-5554',
      name: 'Pixel_7',
      state: 'device',
    },
    {
      platform: 'android',
      key: 'adb_serial',
      identity: 'R5CT30ABCDE',
      name: 'R5CT30ABCDE',
      state: 'offline',
    },
  ]);
});

test('emulator avd names are listed as available, never as running', () => {
  const devices = parseEmulatorAvds(
    ['Pixel_7_API_34', 'INFO | Storing crashdata in a temporary file', 'Pixel_Tablet', ''].join(
      '\n',
    ),
  );
  assert.deepEqual(
    devices.map((device) => [device.identity, device.state]),
    [
      ['Pixel_7_API_34', 'available'],
      ['Pixel_Tablet', 'available'],
    ],
  );
});

const INVENTORY = {
  machine: 'macwork',
  devices: parseSimctlDevices(SIMCTL_JSON),
  sources: [{ tool: 'simctl' as const, ok: true }],
};

test('a target the machine does not have is refused, naming the machine and the nearest', () => {
  const refusal = deviceInventoryRefusal({ simulator: 'fs-5' }, INVENTORY);
  assert.equal(refusal?.code, 'device-not-in-inventory');
  assert.equal(refusal?.machine, 'macwork');
  assert.equal(refusal?.key, 'simulator');
  assert.deepEqual(refusal?.nearest, ['fs-4', 'playground-1']);
  assert.match(refusal!.reason, /macwork/);
  assert.match(refusal!.reason, /fs-4/);
});

test('a target the machine does have is not refused', () => {
  assert.equal(deviceInventoryRefusal({ simulator: 'fs-4' }, INVENTORY), null);
  assert.equal(deviceInventoryRefusal({ udid: '2222-BBBB' }, INVENTORY), null);
});

test('a key no source answered for is never refused — silence is not evidence', () => {
  // simctl answered, so it can refuse a simulator. Nothing answered for adb, so
  // an unknown serial falls through to the provider's own boot exactly as it did
  // before an inventory existed.
  assert.equal(deviceInventoryRefusal({ adb_serial: 'emulator-9999' }, INVENTORY), null);
  assert.equal(deviceInventoryRefusal({ avd: 'Nothing_Here' }, INVENTORY), null);
  assert.equal(
    deviceInventoryRefusal(
      { simulator: 'fs-5' },
      { ...INVENTORY, sources: [{ tool: 'simctl', ok: false, detail: 'xcrun: not found' }] },
    ),
    null,
  );
});

test('a platform alone names no device, so it can never be refused', () => {
  assert.equal(deviceInventoryRefusal({ platform: 'ios' }, INVENTORY), null);
});

test('nearest identities are closest first and capped', () => {
  const devices = [
    {
      platform: 'ios' as const,
      key: 'simulator' as const,
      identity: 'fs-1',
      name: 'fs-1',
      state: 'Shutdown',
    },
    {
      platform: 'ios' as const,
      key: 'simulator' as const,
      identity: 'fs-2',
      name: 'fs-2',
      state: 'Shutdown',
    },
    {
      platform: 'ios' as const,
      key: 'simulator' as const,
      identity: 'totally-other',
      name: 'x',
      state: 'Shutdown',
    },
  ];
  assert.deepEqual(nearestIdentities(devices, 'simulator', 'fs-3'), [
    'fs-1',
    'fs-2',
    'totally-other',
  ]);
  assert.deepEqual(nearestIdentities(devices, 'simulator', 'fs-3', 1), ['fs-1']);
});

// ── The structural replacement for the boot-failure regex (MANUAL-000124) ─────
//
// `executeResourceControl` used to turn any boot failure whose stderr matched
// `Unable to (shutdown|boot) device in current state` into success. These prove
// the device itself is now what decides.

function execStub(answers: Record<string, { stdout?: string; exitCode?: number }>) {
  return async (_slotId: string, _cwd: string, cmd: string) => {
    const answer = Object.entries(answers).find(([prefix]) => cmd.startsWith(prefix))?.[1];
    return {
      stdout: answer?.stdout ?? '',
      stderr: '',
      exitCode: answer?.exitCode ?? (answer ? 0 : 127),
    };
  };
}

test('a failed boot counts as running only when simctl says the device is Booted', async () => {
  const verdict = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'fs-4' },
    exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
  });
  assert.deepEqual(verdict, { ok: true, detail: 'simctl reports fs-4 is Booted' });
});

test('a failed boot on a device simctl reports Shutdown stays a failure', async () => {
  // The regression the regex hid: a device caught mid-transition printed the
  // matching message and was reported as already running.
  const verdict = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'playground-1' },
    exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
  });
  assert.deepEqual(verdict, { ok: false, detail: 'simctl reports playground-1 is Shutdown' });
});

test('a failed shutdown counts as stopped only when the device is no longer Booted', async () => {
  const stopped = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'shutdown',
    identity: { simulator: 'playground-1' },
    exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
  });
  assert.equal(stopped?.ok, true);
  const stillUp = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'shutdown',
    identity: { simulator: 'fs-4' },
    exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
  });
  assert.equal(stillUp?.ok, false);
});

test('no verdict when the tool does not answer, so the caller keeps the failure', async () => {
  const unanswered = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'fs-4' },
    exec: execStub({ 'xcrun simctl': { exitCode: 72 } }),
  });
  assert.equal(unanswered, null);
  const unknownDevice = await deviceControlVerdict({
    slotId: 'macwork-ff-4',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'never-heard-of-it' },
    exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
  });
  assert.equal(unknownDevice, null);
});

test('no verdict without an identity or on a platform with no device tool', async () => {
  const exec = execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } });
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'ios',
      action: 'boot',
      identity: {},
      exec,
    }),
    null,
  );
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'web',
      action: 'boot',
      identity: { simulator: 'fs-4' },
      exec,
    }),
    null,
  );
});

test('android asks adb for the serial state', async () => {
  const exec = execStub({ 'adb -s': { stdout: 'device\n' } });
  assert.deepEqual(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'android',
      action: 'boot',
      identity: { adb_serial: 'emulator-5554' },
      exec,
    }),
    { ok: true, detail: 'adb reports emulator-5554 is device' },
  );
  assert.deepEqual(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'android',
      action: 'shutdown',
      identity: { adb_serial: 'emulator-5554' },
      exec,
    }),
    { ok: false, detail: 'adb reports emulator-5554 is device' },
  );
});

test('the identity read back is the one the hook was expanded with', () => {
  assert.deepEqual(
    deviceIdentityForControl({ simulator: 'fs-4', adb_serial: 'slot-serial' }, undefined),
    { simulator: 'fs-4', adb_serial: 'slot-serial' },
  );
  assert.deepEqual(deviceIdentityForControl({ simulator: 'fs-4' }, { simulator: 'playground-1' }), {
    simulator: 'playground-1',
  });
});

test('a udid names the same device its simulator name does', async () => {
  assert.deepEqual(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'ios',
      action: 'boot',
      identity: { udid: '1111-AAAA' },
      exec: execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } }),
    }),
    { ok: true, detail: 'simctl reports 1111-AAAA is Booted' },
  );
});

test('a failed control keeps its own failure text, with what the device said appended', async () => {
  const exec = execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } });
  const refused = await reconcileFailedDeviceControl({
    slotId: 's',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'playground-1' },
    failure: 'Unable to boot device in current state: Booting',
    exec,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.detail ?? '', /Unable to boot device in current state: Booting/);
  assert.match(refused.detail ?? '', /simctl reports playground-1 is Shutdown/);
});

test('a relaunch is judged like a boot: it must end with the device running', async () => {
  const exec = execStub({ 'xcrun simctl': { stdout: SIMCTL_JSON } });
  const up = await reconcileFailedDeviceControl({
    slotId: 's',
    cwd: '/repo',
    platform: 'ios',
    action: 'relaunch',
    identity: { simulator: 'fs-4' },
    failure: 'Unable to shutdown device in current state: Shutdown',
    exec,
  });
  assert.equal(up.ok, true);
  const down = await reconcileFailedDeviceControl({
    slotId: 's',
    cwd: '/repo',
    platform: 'ios',
    action: 'relaunch',
    identity: { simulator: 'playground-1' },
    failure: 'Unable to shutdown device in current state: Shutdown',
    exec,
  });
  assert.equal(down.ok, false);
});

test('a control on a machine that cannot answer keeps the failure it already had', async () => {
  const kept = await reconcileFailedDeviceControl({
    slotId: 's',
    cwd: '/repo',
    platform: 'ios',
    action: 'boot',
    identity: { simulator: 'fs-4' },
    failure: 'exit 72',
    exec: execStub({ 'xcrun simctl': { exitCode: 72 } }),
  });
  assert.deepEqual(kept, { ok: false, detail: 'exit 72' });
});

test('a device two slots configure is labelled with both, so neither looks free', () => {
  // The real macwork case: one physical Pixel wired to macwork-ff-3 and
  // macwork-ff-4. Naming only the first would tell an operator the device is
  // free on the slot it hid.
  const owners = groupConfiguredIdentities([
    { slot: 'macwork-ff-3', resourceVars: { adb_serial: '21261FDF6001SP', simulator: 'fs-3' } },
    { slot: 'macwork-ff-4', resourceVars: { adb_serial: '21261FDF6001SP', simulator: 'fs-4' } },
  ]);
  assert.deepEqual(owners.get('adb_serial:21261FDF6001SP'), ['macwork-ff-3', 'macwork-ff-4']);
  assert.deepEqual(owners.get('simulator:fs-3'), ['macwork-ff-3']);
  assert.deepEqual(owners.get('simulator:fs-4'), ['macwork-ff-4']);
});

test('a slot listed twice is named once, and a platform never owns a device', () => {
  const owners = groupConfiguredIdentities([
    { slot: 'macwork-ff-3', resourceVars: { avd: 'mm-1', platform: 'android' } },
    { slot: 'macwork-ff-3', resourceVars: { avd: 'mm-1' } },
  ]);
  assert.deepEqual(owners.get('avd:mm-1'), ['macwork-ff-3']);
  assert.equal(owners.has('platform:android'), false);
});
