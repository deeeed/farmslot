import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { nativeWorkspaceChanges, nativeWorkspaceList } from './workspace.js';

test('a non-git native cwd has an explicit empty changes state and still lists files', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-no-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'notes.txt'), 'kept');
  assert.deepEqual(await nativeWorkspaceChanges(cwd), { files: [], repository: false });
  assert.deepEqual(
    (await nativeWorkspaceList(cwd, '.')).entries.map((e) => e.name),
    ['notes.txt'],
  );
});

test('git native cwd still lists dirty files and a broken repository stays an error', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'native-has-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  await writeFile(join(cwd, 'notes.txt'), 'kept');
  assert.deepEqual((await nativeWorkspaceChanges(cwd)).files, [
    { path: 'notes.txt', status: '??' },
  ]);
  const broken = join(cwd, 'broken');
  await mkdir(broken);
  await writeFile(join(broken, '.git'), 'invalid git file');
  await assert.rejects(nativeWorkspaceChanges(broken), /invalid gitfile format/);
  await writeFile(join(broken, '.git'), 'gitdir: /nonexistent/native-approval-missing-gitdir\n');
  await assert.rejects(nativeWorkspaceChanges(broken), /not a git repository:/);
});
