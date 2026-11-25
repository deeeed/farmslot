import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { buildTempScrubCommand, parseTempScrubOutput } from './temp-scrub.js';

const execFileAsync = promisify(execFile);

async function slotWith(files: string[]) {
  const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'farmslot-temp-scrub-')));
  for (const rel of files) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), 'answer');
  }
  return repo;
}

const scrub = async (repo: string, keep: string[]) =>
  parseTempScrubOutput(
    (await execFileAsync('/bin/sh', ['-c', buildTempScrubCommand({ repo, keep })])).stdout,
  );

test('temp/ is cleared of every run leftover except farm state and the kept task dirs', async (t) => {
  const repo = await slotWith([
    'temp/farmslot/deps.lock-hash',
    'temp/farmslot/next-dev.log',
    'temp/recipe/harness/state.json',
    'temp/recipe/runs/tat-4505/trace.json',
    'temp/tasks/feat/tat-4752-1123-101010/TASK.md',
    'temp/tasks/feat/current-1125-090000/TASK.md',
    'temp/tasks/fix/scratch-tat4555-pc23/answer.json',
    'temp/scratch-tat4752/fix-notes.md',
    'temp/tat4626-sol-baseline-20261120/out.json',
    'temp/LEAD-STEER-4505-core.md',
    'outside/secret.md',
  ]);
  t.after(() => rm(repo, { recursive: true, force: true }));
  await symlink(path.join(repo, 'outside'), path.join(repo, 'temp/linked-outside'));

  const result = await scrub(repo, [
    'temp/farmslot',
    'temp/recipe/harness',
    'temp/tasks/feat/current-1125-090000',
  ]);

  assert.deepEqual(result.refused, []);
  for (const kept of [
    'temp/farmslot/deps.lock-hash',
    'temp/farmslot/next-dev.log',
    'temp/recipe/harness/state.json',
    'temp/tasks/feat/current-1125-090000/TASK.md',
    'outside/secret.md',
  ])
    assert.equal(existsSync(path.join(repo, kept)), true, kept);
  for (const gone of [
    'temp/recipe/runs',
    'temp/tasks/feat/tat-4752-1123-101010',
    'temp/tasks/fix/scratch-tat4555-pc23',
    'temp/scratch-tat4752',
    'temp/tat4626-sol-baseline-20261120',
    'temp/LEAD-STEER-4505-core.md',
  ])
    assert.equal(existsSync(path.join(repo, gone)), false, gone);
  assert.throws(() => lstatSync(path.join(repo, 'temp/linked-outside')), 'the link is unlinked');
  assert.equal(
    result.removed.find(({ path: p }) => p.endsWith('linked-outside'))?.kind,
    'link',
    'a symlink is unlinked, not followed',
  );
});

test('a dir holding a nested Git checkout is refused, not deleted, and named', async (t) => {
  const repo = await slotWith([
    'temp/tasks/feat/tat-4800/TASK.md',
    'temp/tasks/feat/tat-4800/clone/.git/HEAD',
    'temp/tasks/feat/tat-4800/clone/fix.ts',
  ]);
  t.after(() => rm(repo, { recursive: true, force: true }));

  const result = await scrub(repo, ['temp/farmslot']);

  assert.deepEqual(result.refused, [
    { path: path.join(repo, 'temp/tasks/feat/tat-4800'), reason: 'holds a nested Git checkout' },
  ]);
  assert.equal(existsSync(path.join(repo, 'temp/tasks/feat/tat-4800/clone/fix.ts')), true);
});

test('a temp/ that is a symlink is refused whole', async (t) => {
  const repo = await slotWith(['elsewhere/notes.md']);
  t.after(() => rm(repo, { recursive: true, force: true }));
  await symlink(path.join(repo, 'elsewhere'), path.join(repo, 'temp'));

  const result = await scrub(repo, []);

  assert.equal(result.refused.length, 1);
  assert.match(result.refused[0]!.reason, /not a plain directory/);
  assert.equal(existsSync(path.join(repo, 'elsewhere/notes.md')), true);
});
