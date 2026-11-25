import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildTempScrubCommand,
  buildTempSurveyCommand,
  parseTempScrubOutput,
  parseTempSurveyOutput,
} from './temp-scrub.js';

const execFileAsync = promisify(execFile);

async function slotWith(files: string[]) {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'farmslot-temp-scrub-')));
  const repo = path.join(parent, 'slot');
  for (const rel of files) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), 'answer');
  }
  await mkdir(path.join(repo, 'temp'), { recursive: true });
  return { parent, repo };
}

const run = async (command: string) => (await execFileAsync('/bin/sh', ['-c', command])).stdout;
const scrub = async (repo: string, keep: string[]) =>
  parseTempScrubOutput(await run(buildTempScrubCommand({ repo, keep, taskRoot: 'temp/tasks' })));
const survey = async (repo: string, keep: string[]) =>
  parseTempSurveyOutput(await run(buildTempSurveyCommand({ repo, keep, taskRoot: 'temp/tasks' })));

test('temp/ is cleared of every run leftover except farm state and the kept task dirs', async (t) => {
  const { parent, repo } = await slotWith([
    'temp/farmslot/deps.lock-hash',
    'temp/recipe/harness/state.json',
    'temp/recipe/runtime/terminal/browser.pid',
    'temp/recipe/runs/tat-4505/trace.json',
    'temp/tasks/feat/tat-4752-1123-101010/TASK.md',
    'temp/tasks/fix/tat-4591-1111-173307/TASK.md',
    'temp/tasks/feat/current-1125-090000/TASK.md',
    'temp/scratch-tat4752/fix-notes.md',
    'temp/LEAD-STEER-4505-core.md',
    'outside/secret.md',
  ]);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await symlink(path.join(repo, 'outside'), path.join(repo, 'temp/linked-outside'));

  const result = await scrub(repo, [
    'temp/farmslot',
    'temp/recipe/harness',
    'temp/recipe/runtime/terminal',
    'temp/tasks/feat/current-1125-090000',
  ]);

  assert.deepEqual(result.refused, []);
  for (const kept of [
    'temp/farmslot/deps.lock-hash',
    'temp/recipe/harness/state.json',
    'temp/recipe/runtime/terminal/browser.pid',
    'temp/tasks/feat/current-1125-090000/TASK.md',
    'outside/secret.md',
  ])
    assert.equal(existsSync(path.join(repo, kept)), true, kept);
  for (const gone of [
    'temp/recipe/runs',
    'temp/tasks/feat/tat-4752-1123-101010',
    'temp/tasks/fix',
    'temp/scratch-tat4752',
    'temp/LEAD-STEER-4505-core.md',
  ])
    assert.equal(existsSync(path.join(repo, gone)), false, gone);
  assert.throws(() => lstatSync(path.join(repo, 'temp/linked-outside')), 'the link is unlinked');
  const removed = result.removed.map(({ path: p }) => p);
  assert.ok(removed.includes('temp/tasks/fix/tat-4591-1111-173307'), 'each task dir is named');
  assert.ok(removed.includes('temp/tasks/fix'), 'an emptied flow folder goes too');
  assert.equal(result.removed.find(({ path: p }) => p === 'temp/linked-outside')?.kind, 'link');
});

test('every checkout is found before anything is entered, and the scrub never deletes one', async (t) => {
  const { parent, repo } = await slotWith([
    'temp/tasks/feat/tat-4800/TASK.md',
    'temp/tasks/goal3-clone/src/answer.ts',
    'temp/scratch-x/notes.md',
  ]);
  t.after(() => rm(parent, { recursive: true, force: true }));
  // A checkout directly under the task root: its src/ must not be cleared before it is seen.
  await execFileAsync('git', [
    'init',
    '-q',
    '-b',
    'main',
    path.join(repo, 'temp/tasks/goal3-clone'),
  ]);
  await execFileAsync('git', ['init', '-q', '--bare', path.join(repo, 'temp/scratch-x/bare.git')]);

  const found = await survey(repo, []);

  assert.deepEqual(found.refused, []);
  assert.deepEqual(found.checkouts.map(({ path: p, bare, linked }) => [p, bare, linked]).sort(), [
    ['temp/scratch-x/bare.git', true, false],
    ['temp/tasks/goal3-clone', false, false],
  ]);
  assert.deepEqual(found.taskDirs, ['temp/tasks/feat/tat-4800']);

  const result = await scrub(repo, []);
  assert.deepEqual(result.refused.map(({ path: p }) => p).sort(), [
    'temp/scratch-x/bare.git',
    'temp/tasks/goal3-clone',
  ]);
  assert.equal(existsSync(path.join(repo, 'temp/tasks/goal3-clone/src/answer.ts')), true);
  assert.equal(existsSync(path.join(repo, 'temp/scratch-x/bare.git/HEAD')), true);
  assert.equal(existsSync(path.join(repo, 'temp/tasks/feat/tat-4800')), false);
});

test('a symlinked ancestor of a kept path is left, and a symlinked temp/ is refused', async (t) => {
  const { parent, repo } = await slotWith(['elsewhere/runtime/terminal/browser.pid']);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await symlink(path.join(repo, 'elsewhere'), path.join(repo, 'temp/recipe'));

  const kept = await scrub(repo, ['temp/recipe/runtime/terminal']);
  assert.deepEqual(kept.removed, []);
  assert.deepEqual(kept.kept, [{ path: 'temp/recipe', reason: 'a symlink holding a kept path' }]);
  assert.equal(existsSync(path.join(repo, 'temp/recipe/runtime/terminal/browser.pid')), true);

  await rm(path.join(repo, 'temp'), { recursive: true });
  await symlink(path.join(repo, 'elsewhere'), path.join(repo, 'temp'));
  const refused = await scrub(repo, []);
  assert.equal(refused.refused.length, 1);
  assert.match(refused.refused[0]!.reason, /not a plain directory/);
  assert.equal(existsSync(path.join(repo, 'elsewhere/runtime/terminal/browser.pid')), true);
});
