import assert from 'node:assert/strict';
import test from 'node:test';

import { deviceInventoryCovers } from '@farmslot/protocol';

import {
  assertTargetInInventory,
  clearDeviceInventoryCache,
  DEVICE_INVENTORY_TTL_MS,
  deviceControlVerdict,
  deviceInventoryRefusal,
  groupConfiguredIdentities,
  isEmulatorTransport,
  nearestIdentities,
  parseAdbDevices,
  parseEmulatorAvds,
  parseSimctlDevices,
  readDeviceInventory,
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
  // simctl answered, so it can refuse a simulator. Nothing answered for adb or
  // emulator, so those keys fall through to the provider's own boot exactly as
  // they did before an inventory existed.
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

test('an adb serial adb did not list is NEVER refused, even when adb answered', () => {
  // `adb devices -l` reports connected TRANSPORTS, not devices that exist. An
  // unbooted emulator and an unplugged phone are both absent from a successful
  // run of it, and booting one is exactly what the provider acquire does next.
  const withAdb = {
    machine: 'macwork',
    devices: parseAdbDevices('List of devices attached\nemulator-5554	device\n'),
    sources: [{ tool: 'adb' as const, ok: true }],
  };
  assert.equal(deviceInventoryRefusal({ adb_serial: 'emulator-5556' }, withAdb), null);
  assert.equal(deviceInventoryCovers(withAdb.sources, 'adb_serial'), false);
});

test('an avd emulator answered for and did not list IS refused — that tool lists what exists', () => {
  const withAvds = {
    machine: 'macwork',
    devices: parseEmulatorAvds('mm-1\nmm-2\n'),
    sources: [{ tool: 'emulator' as const, ok: true }],
  };
  const refusal = deviceInventoryRefusal({ avd: 'mm-9' }, withAvds);
  assert.equal(refusal?.key, 'avd');
  assert.deepEqual(refusal?.nearest, ['mm-1', 'mm-2']);
  assert.equal(deviceInventoryCovers(withAvds.sources, 'avd'), true);
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

const ADB_ONE_DEVICE = 'List of devices attached\nemulator-5554\tdevice\n';

test('android reads the transport list, so a live device confirms a boot and refuses a shutdown', async () => {
  const exec = execStub({ 'adb devices': { stdout: ADB_ONE_DEVICE } });
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

test('an emulator adb no longer lists is a settled shutdown, not an unanswerable one', async () => {
  // The verdict comes from a SUCCESSFUL `adb devices` that does not name the
  // transport, never from a non-zero `get-state`, which cannot tell a powered-off
  // emulator from a missing adb.
  const exec = execStub({ 'adb devices': { stdout: 'List of devices attached\n' } });
  assert.deepEqual(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'android',
      action: 'shutdown',
      identity: { adb_serial: 'emulator-5554' },
      exec,
    }),
    { ok: true, detail: 'adb no longer lists the emulator transport emulator-5554' },
  );
  // The same absence is not a boot.
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'android',
      action: 'boot',
      identity: { adb_serial: 'emulator-5554' },
      exec,
    }),
    null,
  );
});

test('an absent PHYSICAL serial is unplugged, which is not the same as powered off', async () => {
  const exec = execStub({ 'adb devices': { stdout: 'List of devices attached\n' } });
  assert.equal(isEmulatorTransport('21261FDF6001SP'), false);
  assert.equal(isEmulatorTransport('emulator-5554'), true);
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'android',
      action: 'shutdown',
      identity: { adb_serial: '21261FDF6001SP' },
      exec,
    }),
    null,
  );
});

test('adb failing to run at all is no verdict, whatever the action', async () => {
  const exec = execStub({ 'adb devices': { exitCode: 1 } });
  for (const action of ['boot', 'shutdown'] as const) {
    assert.equal(
      await deviceControlVerdict({
        slotId: 's',
        cwd: '/repo',
        platform: 'android',
        action,
        identity: { adb_serial: 'emulator-5554' },
        exec,
      }),
      null,
    );
  }
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

// ── readDeviceInventory: the cache, its TTL, refresh, and the slot labels ─────

function inventoryDeps(answers: Record<string, string>, clock: { ms: number }) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      exec: async (_slotId: string, cwd: string, cmd: string) => {
        calls.push(`${cwd}:${cmd}`);
        const key = Object.keys(answers).find((prefix) => cmd.startsWith(prefix));
        return key
          ? { stdout: answers[key]!, stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'not found', exitCode: 127 };
      },
      loadSlotVars: async (
        slotId: string,
      ): Promise<{ machine: string; repo: string; resourceVars: Record<string, string> }> => ({
        machine: 'macwork',
        repo: slotId === 'other-repo-slot' ? '/repo-b' : '/repo-a',
        resourceVars:
          slotId === 'macwork-ff-3'
            ? { simulator: 'fs-4', adb_serial: 'SERIAL-1' }
            : { simulator: 'fs-4' },
      }),
      loadFleetStatus: async () => ({
        slots: [
          { slot: 'macwork-ff-3', machine: 'macwork' },
          { slot: 'macwork-ff-4', machine: 'macwork' },
          { slot: 'mini-ff-1', machine: 'mini' },
        ],
      }),
      now: () => clock.ms,
    },
  };
}

const SIMCTL_ANSWER = { 'xcrun simctl': SIMCTL_JSON };

test('a second read inside the window is served from cache without re-running a tool', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const { calls, deps } = inventoryDeps(SIMCTL_ANSWER, clock);
  const first = await readDeviceInventory('macwork-ff-4', { deps });
  assert.equal(first.cached, false);
  const toolCalls = calls.length;
  assert.ok(toolCalls >= 3, 'three tools are consulted on a cold read');

  clock.ms += DEVICE_INVENTORY_TTL_MS - 1;
  const second = await readDeviceInventory('macwork-ff-4', { deps });
  assert.equal(second.cached, true);
  assert.equal(second.collectedAt, first.collectedAt);
  assert.equal(calls.length, toolCalls, 'no tool ran again');
});

test('the cache expires with the TTL, and refresh bypasses it before that', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const { calls, deps } = inventoryDeps(SIMCTL_ANSWER, clock);
  await readDeviceInventory('macwork-ff-4', { deps });
  const afterCold = calls.length;

  const forced = await readDeviceInventory('macwork-ff-4', { refresh: true, deps });
  assert.equal(forced.cached, false);
  assert.ok(calls.length > afterCold, 'refresh re-ran the tools inside the window');

  const afterForced = calls.length;
  clock.ms += DEVICE_INVENTORY_TTL_MS + 1;
  const expired = await readDeviceInventory('macwork-ff-4', { deps });
  assert.equal(expired.cached, false);
  assert.ok(calls.length > afterForced, 'an expired entry re-ran the tools');
});

test('two slots with different working directories do not share one answer', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const { calls, deps } = inventoryDeps(SIMCTL_ANSWER, clock);
  await readDeviceInventory('macwork-ff-4', { deps });
  const afterFirst = calls.length;
  // Same machine, different repo cwd: the tools run in that environment, so a
  // slot whose PATH cannot see a tool must not poison its sibling's picker.
  const other = await readDeviceInventory('other-repo-slot', { deps });
  assert.equal(other.cached, false);
  assert.ok(calls.some((call) => call.startsWith('/repo-b:')));
  assert.ok(calls.length > afterFirst);
});

test('the devices are labelled with the slots the fleet configures them for', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const { deps } = inventoryDeps(SIMCTL_ANSWER, clock);
  const inventory = await readDeviceInventory('macwork-ff-4', { deps });
  // Both fleet slots on this machine configure fs-4; the slot on `mini` is a
  // different machine and never reaches the labels.
  assert.deepEqual(
    inventory.devices.find((device) => device.identity === 'fs-4')?.configuredForSlots,
    ['macwork-ff-3', 'macwork-ff-4'],
  );
  assert.equal(
    inventory.devices.find((device) => device.identity === 'playground-1')?.configuredForSlots,
    undefined,
  );
});

test('a tool that did not answer leaves its source unread rather than failing the read', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const { deps } = inventoryDeps(SIMCTL_ANSWER, clock);
  const inventory = await readDeviceInventory('macwork-ff-4', { deps });
  assert.equal(inventory.sources.find((source) => source.tool === 'simctl')?.ok, true);
  assert.equal(inventory.sources.find((source) => source.tool === 'adb')?.ok, false);
  assert.equal(inventory.sources.find((source) => source.tool === 'emulator')?.ok, false);
});

test('the guard re-reads fresh before refusing, so a device created inside the TTL is not denied', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  // The machine gains `fs-9` after the first read. A cached snapshot would call
  // it nonexistent for the rest of the window.
  let answer = SIMCTL_JSON;
  const calls: string[] = [];
  const deps = {
    exec: async (_slotId: string, _cwd: string, cmd: string) => {
      calls.push(cmd);
      return cmd.startsWith('xcrun simctl')
        ? { stdout: answer, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'not found', exitCode: 127 };
    },
    loadSlotVars: async (): Promise<{
      machine: string;
      repo: string;
      resourceVars: Record<string, string>;
    }> => ({
      machine: 'macwork',
      repo: '/repo-a',
      resourceVars: { simulator: 'fs-4' },
    }),
    loadFleetStatus: async () => ({ slots: [] }),
    now: () => clock.ms,
  };

  await readDeviceInventory('macwork-ff-4', { deps });
  answer = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { udid: '9999-ZZZZ', name: 'fs-9', state: 'Shutdown', isAvailable: true },
      ],
    },
  });
  const refusal = await assertTargetInInventory('macwork-ff-4', { simulator: 'fs-9' }, { deps });
  assert.equal(refusal, null, 'the fresh re-read found the new simulator');
});

test('a fresh read that still does not have the device refuses', async () => {
  clearDeviceInventoryCache();
  const clock = { ms: 1_000 };
  const deps = {
    exec: async (_slotId: string, _cwd: string, cmd: string) =>
      cmd.startsWith('xcrun simctl')
        ? { stdout: SIMCTL_JSON, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'not found', exitCode: 127 },
    loadSlotVars: async (): Promise<{
      machine: string;
      repo: string;
      resourceVars: Record<string, string>;
    }> => ({
      machine: 'macwork',
      repo: '/repo-a',
      resourceVars: { simulator: 'fs-4' },
    }),
    loadFleetStatus: async () => ({ slots: [] }),
    now: () => clock.ms,
  };
  const refusal = await assertTargetInInventory('macwork-ff-4', { simulator: 'fs-9' }, { deps });
  assert.equal(refusal?.identity, 'fs-9');
  assert.equal(refusal?.machine, 'macwork');
});

test('adb prose on stdout is not read as a device row', () => {
  const devices = parseAdbDevices(
    [
      'adb server version (41) doesn’t match this client (39); killing...',
      'List of devices attached',
      'emulator-5554\tdevice',
    ].join('\n'),
  );
  assert.deepEqual(
    devices.map((device) => device.identity),
    ['emulator-5554'],
  );
});

test('a shutdown is confirmed only by a settled state, never mid-transition', async () => {
  const booting = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
        { udid: '4444-DDDD', name: 'fs-7', state: 'Booting', isAvailable: true },
      ],
    },
  });
  const exec = execStub({ 'xcrun simctl': { stdout: booting } });
  // `!Booted` used to read as stopped, which is the exact mid-transition pass
  // the removed regex gave.
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'ios',
      action: 'shutdown',
      identity: { simulator: 'fs-7' },
      exec,
    }),
    null,
  );
  assert.equal(
    await deviceControlVerdict({
      slotId: 's',
      cwd: '/repo',
      platform: 'ios',
      action: 'boot',
      identity: { simulator: 'fs-7' },
      exec,
    }),
    null,
  );
});

test('an offline or unauthorized android transport is attached, so it is not stopped', async () => {
  for (const state of ['offline', 'unauthorized']) {
    const exec = execStub({
      'adb devices': { stdout: `List of devices attached\nemulator-5554\t${state}\n` },
    });
    assert.equal(
      await deviceControlVerdict({
        slotId: 's',
        cwd: '/repo',
        platform: 'android',
        action: 'shutdown',
        identity: { adb_serial: 'emulator-5554' },
        exec,
      }),
      null,
      `${state} must not confirm a shutdown`,
    );
  }
});
