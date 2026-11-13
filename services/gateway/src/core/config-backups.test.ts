import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { backupConfigFile, CONFIG_BACKUPS_KEPT } from './config-backups.js';

interface BackupFixture {
  home: string;
  pool: string;
  file: string;
  backups: string;
}

async function fixture(t: { after: (fn: () => unknown) => void }): Promise<BackupFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'config-backups-'));
  const previous = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = path.join(root, 'home');
  t.after(async () => {
    if (previous === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  const pool = path.join(root, 'pool');
  await mkdir(pool, { recursive: true });
  const file = path.join(pool, 'node-a.json');
  await writeFile(file, '{"machine":"node-a"}\n');
  return {
    home: process.env.FARMSLOT_HOME,
    pool,
    file,
    backups: path.join(root, 'home', 'state', 'config-backups', 'pool', 'node-a.json'),
  };
}

test('a backup lands in the farm home state, outside the source directory', async (t) => {
  const { pool, file, backups } = await fixture(t);
  const backup = await backupConfigFile('pool', 'node-a.json', file);
  assert.equal(path.dirname(backup), backups);
  assert.match(path.basename(backup), /^node-a\.json\.bak\.\d{8}T\d{9}$/);
  assert.equal(await readFile(backup, 'utf8'), '{"machine":"node-a"}\n');
  assert.deepEqual(await readdir(pool), ['node-a.json']);
});

test('pool and project sources with the same basename keep separate backups', async (t) => {
  const { home, pool } = await fixture(t);
  const projectFile = path.join(pool, '..', 'projects', 'alpha', 'project.json');
  const otherFile = path.join(pool, '..', 'projects', 'beta', 'project.json');
  for (const file of [projectFile, otherFile]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ name: path.basename(path.dirname(file)) }));
  }
  const alpha = await backupConfigFile('project', 'alpha', projectFile);
  const beta = await backupConfigFile('project', 'beta', otherFile);
  assert.equal(path.dirname(alpha), path.join(home, 'state', 'config-backups', 'project', 'alpha'));
  assert.equal(path.dirname(beta), path.join(home, 'state', 'config-backups', 'project', 'beta'));
  assert.equal(JSON.parse(await readFile(beta, 'utf8')).name, 'beta');
});

test('two saves in the same millisecond keep two backups', async (t) => {
  const { file, backups } = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T12:00:00.123Z') });
  const first = await backupConfigFile('pool', 'node-a.json', file);
  await writeFile(file, '{"machine":"node-a","second":true}\n');
  const second = await backupConfigFile('pool', 'node-a.json', file);
  assert.notEqual(first, second);
  assert.equal((await readdir(backups)).length, 2);
  assert.equal(await readFile(first, 'utf8'), '{"machine":"node-a"}\n');
  assert.equal(await readFile(second, 'utf8'), '{"machine":"node-a","second":true}\n');
});

test('only the newest backups are kept and the oldest are pruned', async (t) => {
  const { file, backups } = await fixture(t);
  await mkdir(backups, { recursive: true });
  const stamp = '20261113T120000123';
  const seeded = [
    'node-a.json.bak.20250101T000000',
    'node-a.json.bak.20250101T000001123',
    'node-a.json.bak.20250101T000002123-1',
    `node-a.json.bak.${stamp}`,
    ...Array.from({ length: 11 }, (_, index) => `node-a.json.bak.${stamp}-${index + 1}`),
  ];
  for (const name of seeded) await writeFile(path.join(backups, name), 'old');
  // The same millisecond as the seeded copies: sequence numbers past 9 must sort as numbers.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-13T12:00:00.123Z') });
  const backup = await backupConfigFile('pool', 'node-a.json', file);
  assert.equal(path.basename(backup), `node-a.json.bak.${stamp}-12`);
  const kept = Array.from({ length: CONFIG_BACKUPS_KEPT }, (_, index) => {
    return `node-a.json.bak.${stamp}-${index + 3}`;
  });
  assert.deepEqual((await readdir(backups)).sort(), kept.sort());
});

test('legacy backups of the saved file move out; other backup names stay', async (t) => {
  const { pool, file, backups } = await fixture(t);
  const legacy = ['node-a.json.bak.20251111T101010', 'node-a.json.bak.20251111T101011'];
  const untouched = [
    'node-a.json.bak-pre-harness-0.96.13',
    'node-a.json.bak.goal',
    'node-a.json.bak.reliability-provider',
    'node-b.json.bak.20251111T101010',
    'node-a.json.bak.20251111T101010.extra',
  ];
  for (const name of [...legacy, ...untouched]) await writeFile(path.join(pool, name), name);
  const backup = await backupConfigFile('pool', 'node-a.json', file);
  assert.deepEqual((await readdir(pool)).sort(), ['node-a.json', ...untouched].sort());
  assert.deepEqual((await readdir(backups)).sort(), [...legacy, path.basename(backup)].sort());
  assert.equal(await readFile(path.join(backups, legacy[0]), 'utf8'), legacy[0]);
});

test('a failed backup copy fails the save', async (t) => {
  const { pool } = await fixture(t);
  await assert.rejects(
    backupConfigFile('pool', 'missing.json', path.join(pool, 'missing.json')),
    /ENOENT/,
  );
});
