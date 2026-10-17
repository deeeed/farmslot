import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

// The projects dir is read once, at import, so the override is set first.
const farm = mkdtempSync(path.join(tmpdir(), 'fleet-monitor-boot-scan-'));
const projects = path.join(farm, 'projects');
const locked = path.join(farm, 'locked');
after(() => {
  chmodSync(projects, 0o700);
  chmodSync(locked, 0o700);
  rmSync(farm, { recursive: true, force: true });
});
process.env.FARMSLOT_PROJECTS_DIR = projects;
// The monitor persists its state on stop; keep that out of the checkout.
const realFiles = await import('node:fs/promises');
mock.module('node:fs/promises', { namedExports: { ...realFiles, writeFile: async () => {} } });
const { startMonitor, stopMonitor } = await import('./fleet-monitor.js');

// A project with a pending decision, a link to itself and a link into a dir nobody can read.
const task = path.join(projects, 'app', 'tasks', 'qa', 'run-1');
mkdirSync(task, { recursive: true });
writeFileSync(
  path.join(task, '.pending_decision.json'),
  JSON.stringify({ id: 'decision-1', title: 'Blocked on a fixture', actions: [] }),
);
symlinkSync(path.join(projects, 'loop'), path.join(projects, 'loop'));
mkdirSync(path.join(locked, 'project'), { recursive: true });
symlinkSync(path.join(locked, 'project'), path.join(projects, 'private'));
chmodSync(locked, 0o000);

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
after(() => process.off('unhandledRejection', onUnhandled));

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
}

function monitor(decisions: PendingDecision[]) {
  startMonitor({
    onFleetUpdated: () => {},
    onDecisionNew: (decision) => decisions.push(decision),
    onViolation: () => {},
  });
}

test('the boot scan skips looping and unreadable project links and still finds decisions', async (t) => {
  const decisions: PendingDecision[] = [];
  t.after(stopMonitor);
  monitor(decisions);
  await until(() => decisions.length > 0);
  assert.deepEqual(
    decisions.map(({ id }) => id),
    ['decision-1'],
  );
  assert.deepEqual(unhandled, []);
});

test('an unreadable projects dir is logged by the boot scan, never an unhandled rejection', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  chmodSync(projects, 0o000);
  t.after(() => {
    stopMonitor();
    chmodSync(projects, 0o700);
  });
  monitor([]);
  await until(() => warn.mock.callCount() > 0);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /decision scan failed/);
  assert.deepEqual(unhandled, []);
});
