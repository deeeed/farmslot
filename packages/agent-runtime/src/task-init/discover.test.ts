// Task-dir discovery is what every "which task is this checkout on" reader
// (status views, harness watch) relies on: the task written to last wins,
// whether by signal or by checklist, and nothing else under the root counts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverTaskDirs, latestTaskDir } from './discover.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function tasksRoot(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'farmslot-task-dirs-')), 'temp', 'tasks');
}

function taskDir(root: string, rel: string, files: Record<string, number>): string {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, atMs] of Object.entries(files)) {
    const file = path.join(dir, name);
    writeFileSync(file, '');
    utimesSync(file, new Date(atMs), new Date(atMs));
  }
  return dir;
}

test('discoverTaskDirs lists directories holding a signal or a checklist, and does not descend into them', () => {
  const tasks = tasksRoot();
  assert.deepEqual(discoverTaskDirs(tasks), [], 'a missing root discovers nothing');
  assert.equal(latestTaskDir(tasks), undefined);

  const older = taskDir(tasks, 'fix/older-0101', { 'SIGNAL.json': START, 'TASK.md': START });
  const grouped = taskDir(tasks, 'fix/deeper/newer', { 'SIGNAL.json': START + 60_000 });
  mkdirSync(path.join(tasks, 'fix/empty'), { recursive: true });
  // The artifact mirror copies task files under artifacts/; that is not a task.
  taskDir(tasks, 'fix/older-0101/artifacts/mirror', { 'TASK.md': START + 90_000 });

  const found = discoverTaskDirs(tasks)
    .map((entry) => entry.dir)
    .sort();
  assert.deepEqual(found, [grouped, older].sort());
  assert.equal(latestTaskDir(tasks), grouped);
});

test('latestTaskDir is the task written to last, by signal or by checklist', () => {
  const tasks = tasksRoot();
  const finished = taskDir(tasks, 'fix/finished', { 'SIGNAL.json': START + 60_000 });
  // Between `task init` and `mark start` the live task has a checklist and no signal.
  const started = taskDir(tasks, 'dev/just-initialised', { 'CHECKLIST.md': START + 120_000 });
  assert.equal(latestTaskDir(tasks), started);

  // Once it signals, its signal time is what counts.
  taskDir(tasks, 'dev/just-initialised', { 'SIGNAL.json': START + 180_000 });
  assert.equal(latestTaskDir(tasks), started);
  assert.notEqual(latestTaskDir(tasks), finished);
});

test('latestTaskDir breaks equal times by signal presence, then by path', () => {
  const tasks = tasksRoot();
  const b = taskDir(tasks, 'qa/b', { 'TASK.md': START + 1_000 });
  taskDir(tasks, 'qa/c', { 'TASK.md': START + 1_000 });
  assert.equal(latestTaskDir(tasks), b, 'equal times resolve to the lexically first path');

  const signalled = taskDir(tasks, 'qa/d', { 'SIGNAL.json': START + 1_000 });
  assert.equal(latestTaskDir(tasks), signalled, 'a signal outranks a checklist at the same time');
});
