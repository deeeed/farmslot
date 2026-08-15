import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildSlotStorageCleanupCommand,
  normalizeTaskRelativeDir,
  parseSlotStorageCleanupOutput,
} from './slot-storage-cleanup.js';

const execFileAsync = promisify(execFile);

async function touchOld(dir: string): Promise<void> {
  await touchMinutesAgo(dir, 2 * 60);
}

async function touchMinutesAgo(dir: string, minutesAgo: number): Promise<void> {
  const old = new Date(Date.now() - minutesAgo * 60 * 1000);
  await execFileAsync('touch', ['-t', timestampForTouch(old), dir]);
}

function timestampForTouch(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

test('task paths normalize relative to their configured task root', () => {
  assert.equal(normalizeTaskRelativeDir('.task/fix/active/TASK.md', '.task'), 'fix/active');
  assert.equal(
    normalizeTaskRelativeDir('temp/tasks/fix/active/TASK.md', 'temp/tasks'),
    'fix/active',
  );
  assert.equal(normalizeTaskRelativeDir('fix/active/TASK.md', '.task'), 'fix/active');
});

test('slot storage cleanup prunes old worker task/runtime caches but preserves active and recent data', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-'));
  const oldTask = path.join(repo, '.task/fix/old');
  const activeTask = path.join(repo, '.task/fix/active');
  const recentTask = path.join(repo, '.task/fix/recent');
  const oldRuntime = path.join(repo, '.agent/artifacts/old-run');
  const recentRuntime = path.join(repo, '.agent/artifacts/recent-run');
  const oldProfile = path.join(repo, '.agent/chrome-profile-old');
  await Promise.all(
    [oldTask, activeTask, recentTask, oldRuntime, recentRuntime, oldProfile].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await Promise.all([oldTask, activeTask, oldRuntime, oldProfile].map(touchOld));

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: '.task',
    artifactDirName: '.task',
    runtimeDirName: '.agent',
    activeTaskRel: '.task/fix/active/TASK.md',
    includeBrowserProfiles: false,
    retentionHours: 0.5,
  });
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
  const parsed = parseSlotStorageCleanupOutput(stdout);

  assert.equal(await exists(oldTask), false);
  assert.equal(await exists(activeTask), true);
  assert.equal(await exists(recentTask), true);
  assert.equal(await exists(oldRuntime), true, 'active task preserves shared runtime caches');
  assert.equal(await exists(recentRuntime), true);
  assert.equal(await exists(oldProfile), true);
  assert.ok(parsed.deleted.some((entry) => entry.path === oldTask));
  assert.ok(
    parsed.skipped.some(
      (entry) =>
        entry.path === path.join(repo, '.agent/artifacts') && entry.reason === 'active task',
    ),
  );
});

test('slot storage cleanup prunes expired runtime caches when the slot has no active task', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-runtime-'));
  const oldRuntime = path.join(repo, '.agent/artifacts/old-run');
  await mkdir(oldRuntime, { recursive: true });
  await touchOld(oldRuntime);

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: '.task',
    artifactDirName: '.task',
    runtimeDirName: '.agent',
    retentionHours: 0.5,
  });
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
  const parsed = parseSlotStorageCleanupOutput(stdout);

  assert.equal(await exists(oldRuntime), false);
  assert.ok(parsed.deleted.some((entry) => entry.path === oldRuntime));
});

test('slot storage cleanup preserves active task and artifact directories when roots differ', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-split-roots-'));
  const activeTask = path.join(repo, '.task/fix/active');
  const activeArtifacts = path.join(repo, '.artifacts/fix/active');
  const oldTask = path.join(repo, '.task/fix/old');
  const oldArtifacts = path.join(repo, '.artifacts/fix/old');
  await Promise.all(
    [activeTask, activeArtifacts, oldTask, oldArtifacts].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await Promise.all([activeTask, activeArtifacts, oldTask, oldArtifacts].map(touchOld));

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: '.task',
    artifactDirName: '.artifacts',
    runtimeDirName: '.agent',
    activeTaskRel: 'fix/active/TASK.md',
    retentionHours: 0.5,
  });
  await execFileAsync('/bin/sh', ['-c', command]);

  assert.equal(await exists(activeTask), true);
  assert.equal(await exists(activeArtifacts), true);
  assert.equal(await exists(oldTask), false);
  assert.equal(await exists(oldArtifacts), false);
});

test('slot storage cleanup preserves an active task directory containing dots', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-dotted-task-'));
  const activeTask = path.join(repo, '.task/fix/review.v2');
  await mkdir(activeTask, { recursive: true });
  await touchOld(activeTask);

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: '.task',
    artifactDirName: '.task',
    runtimeDirName: '.agent',
    activeTaskRel: 'fix/review.v2',
    retentionHours: 0.5,
  });
  await execFileAsync('/bin/sh', ['-c', command]);

  assert.equal(await exists(activeTask), true);
});

test('slot storage cleanup removes old browser profiles only when explicit cleanup includes them', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-profile-'));
  const oldProfile = path.join(repo, 'temp/runtime/adr58-chrome-profile-6665-open');
  await mkdir(oldProfile, { recursive: true });
  await touchOld(oldProfile);

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: 'temp/tasks',
    artifactDirName: 'temp/tasks',
    runtimeDirName: 'temp/runtime',
    includeBrowserProfiles: true,
    retentionHours: 0.5,
  });
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
  const parsed = parseSlotStorageCleanupOutput(stdout);

  assert.equal(await exists(oldProfile), false);
  assert.deepEqual(parsed.deleted, [{ label: 'browser-profile', path: oldProfile }]);
});

test('slot storage cleanup keeps every task inside the retention window', async () => {
  const repo = await mkdtemp(path.join(tmpdir(), 'farmslot-storage-cleanup-count-'));
  const taskDirs = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'].map((name) =>
    path.join(repo, '.task/fix', name),
  );
  await Promise.all(taskDirs.map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all(taskDirs.map((dir, index) => touchMinutesAgo(dir, 10 - index * 2)));

  const command = buildSlotStorageCleanupCommand({
    repo,
    taskDirName: '.task',
    artifactDirName: '.task',
    runtimeDirName: '.agent',
    activeTaskRel: 'fix/run-1',
    retentionHours: 999,
  });
  const { stdout } = await execFileAsync('/bin/sh', ['-c', command]);
  const parsed = parseSlotStorageCleanupOutput(stdout);

  assert.equal(await exists(taskDirs[0]), true, 'active task is preserved beyond count cap');
  assert.equal(await exists(taskDirs[1]), true, 'recent completed task is kept');
  assert.equal(await exists(taskDirs[2]), true, 'recent completed task is kept');
  assert.equal(await exists(taskDirs[3]), true, 'second newest completed task is preserved');
  assert.equal(await exists(taskDirs[4]), true, 'newest completed task is preserved');
  assert.deepEqual(parsed.deleted, []);
});
