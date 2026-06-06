import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResourceDefinition, SlotStatus } from '@farmslot/protocol';

import {
  buildBrowserNodeWatchCommand,
  buildBrowserPidFileCapturableCommand,
  buildBrowserPidRecoveryCommand,
  isSimulatorDeviceProbe,
  shouldProbeResourceForSlot,
  slotHasActiveRun,
} from './resource-manager.js';

const iosSimResource = {
  type: 'device',
  platform: 'ios',
  watch: {
    type: 'process-poll',
    cmd: "xcrun simctl list devices booted | grep -q '{{simulator}}'",
  },
  hooks: { health: "xcrun simctl list devices booted | grep -q '{{simulator}}'" },
} as ResourceDefinition;

const metroResource = {
  type: 'dev-server',
  watch: { type: 'port-listen', port: '{{port}}' },
  hooks: { health: 'lsof -i :{{port}} >/dev/null 2>&1' },
} as ResourceDefinition;

function slot(
  currentRunId: string | null,
  lifecycle: SlotStatus['lifecycle'] = 'busy',
): Pick<SlotStatus, 'currentRunId' | 'lifecycle'> {
  return { currentRunId, lifecycle };
}

test('slotHasActiveRun requires an active slot lifecycle', () => {
  assert.equal(slotHasActiveRun(slot('run-1', 'busy')), true);
  assert.equal(slotHasActiveRun(slot('run-1', 'held')), true);
  assert.equal(slotHasActiveRun(slot('run-1', 'ready')), false);
  assert.equal(slotHasActiveRun(slot(null, 'busy')), false);
});

test('isSimulatorDeviceProbe only matches iOS simctl device probes', () => {
  assert.equal(isSimulatorDeviceProbe(iosSimResource), true);
  assert.equal(isSimulatorDeviceProbe(metroResource), false);
});

test('shouldProbeResourceForSlot suppresses simulator probes without an active run', () => {
  assert.equal(shouldProbeResourceForSlot(slot('run-1', 'busy'), iosSimResource), true);
  assert.equal(shouldProbeResourceForSlot(slot('run-1', 'ready'), iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(slot(null, 'busy'), iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(undefined, iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(slot(null, 'ready'), metroResource), true);
});

test('buildBrowserPidRecoveryCommand rewrites browser pid files from CDP listener', () => {
  const cmd = buildBrowserPidRecoveryCommand(7666, '/tmp/slot runtime');
  assert.match(cmd, /tcp:7666/);
  assert.match(cmd, /browser\.pid/);
  assert.match(cmd, /chromium\.pid/);
  assert.match(cmd, /capture-helper resolve --pid/);
  assert.match(cmd, /'\/tmp\/slot runtime'/);
});

test('buildBrowserPidFileCapturableCommand verifies capture-helper can resolve the pid', () => {
  const cmd = buildBrowserPidFileCapturableCommand('/tmp/runtime/browser.pid');
  assert.match(cmd, /cat \"\$pid_file\"/);
  assert.match(cmd, /capture-helper resolve --pid/);
});

test('buildBrowserNodeWatchCommand requires stream-capturable browser status', () => {
  const recover = buildBrowserNodeWatchCommand('/tmp/runtime/browser.pid', '7666');
  assert.match(recover, /pid_file='\/tmp\/runtime\/browser\.pid'/);
  assert.match(recover, /exit 0/);
  assert.match(recover, /tcp:7666/);
  assert.match(recover, /capture-helper resolve --pid/);
  assert.ok(recover.indexOf('pid_file=') < recover.indexOf('tcp:7666'));

  const pidFileOnly = buildBrowserNodeWatchCommand('/tmp/runtime/browser.pid');
  assert.match(pidFileOnly, /cat \"\$pid_file\"/);
  assert.match(pidFileOnly, /capture-helper resolve --pid/);
  assert.match(pidFileOnly, /exit 1/);
});
