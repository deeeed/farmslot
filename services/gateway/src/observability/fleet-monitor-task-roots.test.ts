import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// The projects dir is read once, at import, so the override is set first.
const projects = mkdtempSync(path.join(tmpdir(), 'fleet-monitor-task-roots-'));
after(() => rmSync(projects, { recursive: true, force: true }));
process.env.FARMSLOT_PROJECTS_DIR = projects;
const { loadPendingDecisions } = await import('./fleet-monitor.js');

test('pending decisions are found in task folders under FARMSLOT_PROJECTS_DIR', async () => {
  const task = path.join(projects, 'demo', 'tasks', 'qa', 'run-1');
  mkdirSync(task, { recursive: true });
  writeFileSync(
    path.join(task, '.pending_decision.json'),
    JSON.stringify({ id: 'decision-1', title: 'Blocked on a fixture', actions: [] }),
  );
  const decisions = await loadPendingDecisions();
  assert.deepEqual(
    decisions.map(({ id, title }) => ({ id, title })),
    [{ id: 'decision-1', title: 'Blocked on a fixture' }],
  );
});
