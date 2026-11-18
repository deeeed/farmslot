import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { FleetStatus } from '@farmslot/protocol';

const root = mkdtempSync(path.join(os.tmpdir(), 'fleet-storage-warning-'));
process.env.FARMSLOT_ROOT = root;
process.env.FARMSLOT_HOME = path.join(root, 'home');
process.env.FARMSLOT_PROJECTS_DIR = path.join(root, 'projects');
for (const dir of ['home', 'projects']) mkdirSync(path.join(root, dir));
for (const file of ['CLAUDE.md', 'scripts/dev.sh', 'services/gateway/package.json']) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), file.endsWith('.json') ? '{}' : '');
}
after(() => rmSync(root, { recursive: true, force: true }));
await import('../runtime/mock-pty.test-support.js');
const storage = await import('../core/storage-volume.js');
let unavailable = false;
const warning = 'Storage unavailable: /Volumes/fixture-bundles is not mounted.';
mock.module('../core/storage-volume.js', {
  namedExports: { ...storage, gatewayStorageVolumeErrors: () => (unavailable ? [warning] : []) },
});
const observer = await import('../chat/copilot-observer.js');
const alerts: Array<{ type: string; summary: string; severity: string }> = [];
mock.module('../chat/copilot-observer.js', {
  namedExports: {
    ...observer,
    reportGatewayWarning(type: string, summary: string, severity: string) {
      alerts.push({ type, summary, severity });
    },
  },
});
const fleet = await import('../methods/fleet.js');
const emptyFleet: FleetStatus = {
  checkedAt: new Date().toISOString(),
  slots: [],
  summary: {
    total: 0,
    ready: 0,
    busy: 0,
    held: 0,
    disabled: 0,
    manual: 0,
    blocked: 0,
    warmCount: 0,
  },
};
let readFleet = async (): Promise<{ fleet: FleetStatus }> => ({ fleet: emptyFleet });
mock.module('../methods/fleet.js', {
  namedExports: { ...fleet, fleetMonitorStatus: () => readFleet() },
});
const background = await import('../host-services/background/client.js');
mock.method(background.backgroundHost, 'request', async (operation: string) => {
  assert.equal(operation, 'decisions.scan');
  return [];
});
const { startMonitor, stopMonitor } = await import('./fleet-monitor.js');

test('fleet storage alerts survive a stalled fleet read, dedupe, and rearm after remount', async (t) => {
  const timer = setInterval(() => {}, 60_000);
  timer.unref();
  t.after(() => {
    stopMonitor();
    clearInterval(timer);
  });
  let tick: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, 'setInterval', (callback: () => unknown) => {
    tick ??= async () => {
      await callback();
    };
    return timer;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  readFleet = async () => {
    await held;
    return { fleet: emptyFleet };
  };
  startMonitor({
    onFleetUpdated() {},
    onDecisionNew() {},
    onViolation() {},
    onPublicationGateStall() {},
  });
  assert(tick);
  const pending = tick();
  unavailable = true;
  await tick();
  assert.deepEqual(alerts, [{ type: 'storage.unavailable', summary: warning, severity: 'error' }]);
  await tick();
  assert.equal(alerts.length, 1);
  unavailable = false;
  await tick();
  unavailable = true;
  await tick();
  assert.equal(alerts.length, 2, 'a new outage alerts again');
  release();
  await pending;
});

test('starting the monitor with unavailable bundle storage alerts immediately', (t) => {
  unavailable = true;
  const before = alerts.length;
  t.after(stopMonitor);
  startMonitor({
    onFleetUpdated() {},
    onDecisionNew() {},
    onViolation() {},
    onPublicationGateStall() {},
  });
  assert.equal(alerts.length, before + 1);
  assert.equal(alerts.at(-1)?.type, 'storage.unavailable');
});
