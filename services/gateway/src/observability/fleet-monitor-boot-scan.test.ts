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
// A scan can be held after it read one decision file, as a slow walk is in production.
let holdAfterRead: { file: string; released: Promise<void> } | undefined;
mock.module('node:fs/promises', {
  namedExports: {
    ...realFiles,
    writeFile: async () => {},
    readFile: async (...args: Parameters<typeof realFiles.readFile>) => {
      const content = await realFiles.readFile(...args);
      const hold = holdAfterRead;
      if (hold && args[0] === hold.file) {
        holdAfterRead = undefined;
        await hold.released;
      }
      return content;
    },
  },
});
const { loadPendingDecisions, resolveFileDecision, scanDecisions, startMonitor, stopMonitor } =
  await import('./fleet-monitor.js');

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

test('while the monitor polls, reads serve its last scan instead of walking the tree (F366)', async (t) => {
  // Production decision.list walked every task root on each read: 0.27-0.7 s idle, seconds under load.
  t.after(stopMonitor);
  monitor([]);
  await scanDecisions();
  const later = path.join(projects, 'app', 'tasks', 'qa', 'run-2');
  mkdirSync(later, { recursive: true });
  t.after(() => rmSync(later, { recursive: true, force: true }));
  writeFileSync(
    path.join(later, '.pending_decision.json'),
    JSON.stringify({ id: 'decision-2', title: 'Written after the scan', actions: [] }),
  );
  assert.deepEqual(
    (await loadPendingDecisions()).map(({ id }) => id),
    ['decision-1'],
  );
  await scanDecisions();
  assert.deepEqual((await loadPendingDecisions()).map(({ id }) => id).sort(), [
    'decision-1',
    'decision-2',
  ]);
});

test('a decision resolved while a scan is in flight stays resolved (F366)', async (t) => {
  t.after(stopMonitor);
  monitor([]);
  await scanDecisions();
  const task = path.join(projects, 'app', 'tasks', 'qa', 'run-3');
  mkdirSync(task, { recursive: true });
  t.after(() => rmSync(task, { recursive: true, force: true }));
  const file = path.join(task, '.pending_decision.json');
  writeFileSync(
    file,
    JSON.stringify({
      id: 'decision-3',
      title: 'Answered mid-scan',
      actions: [{ id: 'ack', label: 'Ack' }],
    }),
  );
  let release!: () => void;
  holdAfterRead = { file, released: new Promise((resolve) => (release = resolve)) };
  const scan = scanDecisions();
  await until(() => holdAfterRead === undefined);
  await resolveFileDecision('decision-3', 'ack');
  release();
  await scan;
  assert.equal(
    (await loadPendingDecisions()).some(({ id }) => id === 'decision-3'),
    false,
  );
});
