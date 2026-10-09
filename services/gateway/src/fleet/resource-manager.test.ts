import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ResourceDefinition, SlotStatus } from '@farmslot/protocol';

import {
  buildBrowserNodeWatchCommand,
  buildBrowserPidFileOwnsCdpCommand,
  buildBrowserPidRecoveryCommand,
  inferSharedProcessPollProvider,
  isEmptyIosSimulatorProbe,
  isSimulatorDeviceProbe,
  isSlotResourceConfigured,
  purgeRemovedSlotWarnings,
  resourceControlTimeoutMs,
  resourceStatusFromHealth,
  shouldProbeResourceForSlot,
  slotHasActiveRun,
} from './resource-manager.js';

test('purgeRemovedSlotWarnings drops warnings for slots removed from the fleet', () => {
  const warnings = new Map([
    ['active-slot', 'metro'],
    ['removed-slot', 'browser'],
  ]);
  purgeRemovedSlotWarnings(warnings, new Set(['active-slot']));
  assert.deepEqual([...warnings], [['active-slot', 'metro']]);
});

test('isSlotResourceConfigured only accepts resources declared by the slot', () => {
  const resources = { 'ios-sim': { simulator: 'mmdev-1' }, 'dev-server': { port: 8061 } };
  assert.equal(isSlotResourceConfigured(resources, 'ios-sim'), true);
  assert.equal(isSlotResourceConfigured(resources, 'android-emu'), false);
  assert.equal(isSlotResourceConfigured(undefined, 'ios-sim'), false);
});

test('resource control allows cold device boots without extending other hooks', () => {
  assert.equal(resourceControlTimeoutMs('device', 'boot'), 120_000);
  assert.equal(resourceControlTimeoutMs('device', 'shutdown'), 30_000);
  assert.equal(resourceControlTimeoutMs('dev-server', 'boot'), 30_000);
});

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

test('shared process-poll provider is explicit for new configs and inferred for legacy iOS probes', () => {
  assert.equal(
    inferSharedProcessPollProvider(
      iosSimResource,
      "xcrun simctl list devices booted 2>/dev/null | grep -q 'mm-1'",
      'mm-1',
    ),
    'ios-simulator-inventory',
  );
  assert.equal(
    inferSharedProcessPollProvider(
      iosSimResource,
      "xcrun simctl list devices booted 2>/dev/null | grep -q 'different-sim'",
      'mm-1',
    ),
    undefined,
  );
  assert.equal(
    inferSharedProcessPollProvider(
      iosSimResource,
      "xcrun simctl list devices booted 2>/dev/null | grep -q 'mm-1' && test -f ready",
      'mm-1',
    ),
    undefined,
  );
  assert.equal(inferSharedProcessPollProvider(metroResource, 'lsof -i :8061', 'mm-1'), undefined);
  assert.equal(
    inferSharedProcessPollProvider(
      {
        ...metroResource,
        watch: {
          type: 'process-poll',
          provider: 'ios-simulator-inventory',
        },
      },
      'custom legacy fallback',
      'mm-1',
    ),
    undefined,
  );
  assert.equal(
    inferSharedProcessPollProvider(
      {
        ...iosSimResource,
        watch: {
          type: 'process-poll',
          provider: 'ios-simulator-inventory',
        },
      },
      'custom legacy fallback',
      'mm-1',
    ),
    'ios-simulator-inventory',
  );
});

test('empty iOS simulator selectors are skipped instead of becoming always-true probes', () => {
  assert.equal(
    isEmptyIosSimulatorProbe(
      iosSimResource,
      "xcrun simctl list devices booted 2>/dev/null | grep -q ''",
    ),
    true,
  );
  assert.equal(
    isEmptyIosSimulatorProbe(
      iosSimResource,
      "xcrun simctl list devices booted 2>/dev/null | grep -q 'mm-1'",
    ),
    false,
  );
  assert.equal(isEmptyIosSimulatorProbe(metroResource, "grep -q ''"), false);
});

test('shouldProbeResourceForSlot suppresses simulator probes without an active run', () => {
  assert.equal(shouldProbeResourceForSlot(slot('run-1', 'busy'), iosSimResource), true);
  assert.equal(shouldProbeResourceForSlot(slot('run-1', 'ready'), iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(slot(null, 'busy'), iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(undefined, iosSimResource), false);
  assert.equal(shouldProbeResourceForSlot(slot(null, 'ready'), metroResource), true);
});

// Runs a generated browser probe with fake `lsof` (printing `listeners`) and
// `capture-helper` (recording that it ran) first on PATH.
function runBrowserProbe(
  build: (dir: string) => string,
  {
    pidFile,
    listeners,
    shell = ['/bin/sh', '-c'],
    pidDir = '.',
  }: { pidFile?: string; listeners: number[]; shell?: string[]; pidDir?: string },
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'browser-probe-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, 'lsof'),
      `#!/bin/sh\nprintf '%s\\n' ${listeners.map(String).join(' ')}\n`,
    );
    writeFileSync(
      path.join(bin, 'capture-helper'),
      `#!/bin/sh\ntouch '${dir}/capture-helper-ran'\n`,
    );
    chmodSync(path.join(bin, 'lsof'), 0o755);
    chmodSync(path.join(bin, 'capture-helper'), 0o755);
    if (pidFile !== undefined) writeFileSync(path.join(dir, 'browser.pid'), pidFile);
    const result = spawnSync(shell[0], [...shell.slice(1), build(dir)], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    const read = (name: string) => {
      const file = path.join(dir, pidDir, name);
      return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    };
    return {
      status: result.status,
      browserPid: read('browser.pid'),
      chromiumPid: read('chromium.pid'),
      captureHelperRan: existsSync(path.join(dir, 'capture-helper-ran')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const livePid = process.pid;
// Above any macOS or Linux pid_max, so `kill -0` always fails.
const deadPid = 99_999_999;

test('browser probes never run capture-helper', () => {
  for (const command of [
    buildBrowserNodeWatchCommand('/tmp/runtime/browser.pid', '7666'),
    buildBrowserNodeWatchCommand('/tmp/runtime/browser.pid'),
    buildBrowserPidRecoveryCommand(7666, '/tmp/runtime'),
    buildBrowserPidFileOwnsCdpCommand('/tmp/runtime/browser.pid', 7666),
  ]) {
    assert.doesNotMatch(command, /capture-helper|capture_helper/);
  }
  const probe = runBrowserProbe(
    (dir) => buildBrowserNodeWatchCommand(path.join(dir, 'browser.pid'), '7666'),
    { pidFile: String(livePid), listeners: [livePid] },
  );
  assert.equal(probe.status, 0);
  assert.equal(probe.captureHelperRan, false);
});

test('buildBrowserPidFileOwnsCdpCommand accepts only the live CDP listener', () => {
  const check = (pidFile: string, listeners: number[], port: number | null = 7666) =>
    runBrowserProbe(
      (dir) => buildBrowserPidFileOwnsCdpCommand(path.join(dir, 'browser.pid'), port),
      { pidFile, listeners },
    ).status;
  assert.equal(check(String(livePid), [livePid]), 0);
  assert.notEqual(check(String(livePid), [livePid + 1]), 0);
  assert.notEqual(check(String(livePid), []), 0);
  assert.notEqual(check(String(livePid), [livePid, livePid + 1]), 0);
  assert.notEqual(check(String(deadPid), [deadPid]), 0);
  // Without a CDP port only liveness can be proven.
  assert.equal(check(String(livePid), [], null), 0);
  assert.notEqual(check(String(deadPid), [], null), 0);
});

test('buildBrowserPidRecoveryCommand rewrites browser pid files from the CDP listener', () => {
  // The same pid twice is an IPv4 and an IPv6 listener of one browser.
  const recovered = runBrowserProbe(
    (dir) => buildBrowserPidRecoveryCommand(7666, `${dir}/slot runtime`),
    { listeners: [livePid, livePid], pidDir: 'slot runtime' },
  );
  assert.equal(recovered.status, 0);
  assert.equal(recovered.browserPid, String(livePid));
  assert.equal(recovered.chromiumPid, String(livePid));

  const command = buildBrowserPidRecoveryCommand(7666, '/tmp/slot runtime');
  assert.match(command, /-iTCP:7666 -sTCP:LISTEN/);
  assert.match(command, /'\/tmp\/slot runtime'/);

  for (const listeners of [[], [deadPid], [livePid, livePid + 1]]) {
    assert.notEqual(
      runBrowserProbe((dir) => buildBrowserPidRecoveryCommand(7666, dir), { listeners }).status,
      0,
    );
  }
});

test('buildBrowserNodeWatchCommand keeps an owning pid file and repairs a stale one', () => {
  const watch = (dir: string) =>
    buildBrowserNodeWatchCommand(path.join(dir, 'browser.pid'), '7666');

  const kept = runBrowserProbe(watch, { pidFile: String(livePid), listeners: [livePid] });
  assert.equal(kept.status, 0);
  assert.equal(kept.browserPid, String(livePid));
  assert.equal(kept.chromiumPid, null);

  const repaired = runBrowserProbe(watch, { pidFile: String(deadPid), listeners: [livePid] });
  assert.equal(repaired.status, 0);
  assert.equal(repaired.browserPid, String(livePid));
  assert.equal(repaired.chromiumPid, String(livePid));

  // The node runs watch commands with `zsh -f -c`.
  if (existsSync('/bin/zsh')) {
    const underZsh = runBrowserProbe(watch, {
      pidFile: String(deadPid),
      listeners: [livePid],
      shell: ['/bin/zsh', '-f', '-c'],
    });
    assert.equal(underZsh.status, 0);
    assert.equal(underZsh.browserPid, String(livePid));
  }

  const missing = runBrowserProbe(watch, { listeners: [livePid] });
  assert.equal(missing.status, 0);
  assert.equal(missing.browserPid, String(livePid));

  assert.notEqual(runBrowserProbe(watch, { pidFile: String(deadPid), listeners: [] }).status, 0);

  const pidFileOnly = (dir: string) => buildBrowserNodeWatchCommand(path.join(dir, 'browser.pid'));
  assert.equal(runBrowserProbe(pidFileOnly, { pidFile: String(livePid), listeners: [] }).status, 0);
  assert.notEqual(
    runBrowserProbe(pidFileOnly, { pidFile: String(deadPid), listeners: [] }).status,
    0,
  );
});

test('a resource with no health hook is unknown, never running', () => {
  // The rule a re-targeted capability lease is judged by is the same one the
  // slot-wide poll uses. Trusting the health hook's exit code directly would
  // have called a provider with no health hook healthy.
  const withHook = { hooks: { health: 'true' } };
  assert.equal(resourceStatusFromHealth(withHook, { ok: true }), 'running');
  assert.equal(resourceStatusFromHealth(withHook, { ok: false }), 'stopped');
  assert.equal(resourceStatusFromHealth(withHook, undefined), 'error');
  assert.equal(resourceStatusFromHealth({ hooks: {} }, { ok: true }), 'unknown');
  assert.equal(resourceStatusFromHealth(undefined, { ok: true }), 'unknown');
});
