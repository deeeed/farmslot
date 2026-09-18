#!/usr/bin/env node
// Task-dir discovery is what every "which task is this checkout on" reader
// (status views, harness watch) relies on: newest signal wins, a checklist-only
// task is the fallback, nothing else under the root counts.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { discoverTaskDirs, latestTaskDir } from '../dist/index.js';

const START = Date.parse('2026-01-01T00:00:00.000Z');

function taskDir(root, rel, files) {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, atMs] of Object.entries(files)) {
    const file = path.join(dir, name);
    writeFileSync(file, '');
    utimesSync(file, new Date(atMs), new Date(atMs));
  }
  return dir;
}

const root = mkdtempSync(path.join(tmpdir(), 'farmslot-task-dirs-'));
const tasks = path.join(root, 'temp', 'tasks');

assert.deepEqual(discoverTaskDirs(tasks), [], 'a missing root discovers nothing');
assert.equal(latestTaskDir(tasks), undefined);

const checklistOnly = taskDir(tasks, 'dev/checklist-only', { 'CHECKLIST.md': START + 500_000 });
const older = taskDir(tasks, 'fix/older', { 'SIGNAL.json': START, 'TASK.md': START });
const newer = taskDir(tasks, 'fix/deeper/newer', { 'SIGNAL.json': START + 60_000 });
mkdirSync(path.join(tasks, 'fix/empty'), { recursive: true });

const found = discoverTaskDirs(tasks)
  .map((entry) => entry.dir)
  .sort();
assert.deepEqual(
  found,
  [checklistOnly, newer, older].sort(),
  'only dirs with a signal or checklist',
);

// A signalled task always beats a checklist that was merely touched later.
assert.equal(latestTaskDir(tasks), newer);

// Without any signal, the most recently touched checklist is the task.
taskDir(tasks, 'qa/quiet', { 'CHECKLIST.md': START + 10_000 });
const noSignal = mkdtempSync(path.join(tmpdir(), 'farmslot-task-dirs-'));
const quietRoot = path.join(noSignal, 'temp', 'tasks');
const quietA = taskDir(quietRoot, 'qa/a', { 'CHECKLIST.md': START });
const quietB = taskDir(quietRoot, 'qa/b', { 'TASK.md': START + 1_000 });
assert.equal(latestTaskDir(quietRoot), quietB);
assert.notEqual(latestTaskDir(quietRoot), quietA);

console.log('task-dir-discovery: ok');
