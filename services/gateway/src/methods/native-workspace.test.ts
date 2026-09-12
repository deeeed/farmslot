import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readWorkspaceText, WORKSPACE_TEXT_LIMIT, workspacePath } from '../core/workspace-files.js';

import {
  nativeWorkspaceChanges,
  nativeWorkspaceDiff,
  nativeWorkspaceList,
} from './native-workspace.js';

test('workspace reads reject traversal, symlinks, directories, binary and oversized files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-files-'));
  try {
    await writeFile(path.join(root, 'safe.txt'), 'safe');
    await mkdir(path.join(root, 'nested'));
    await symlink(path.join(root, 'safe.txt'), path.join(root, 'link'));
    await symlink(tmpdir(), path.join(root, 'outside'));
    assert.equal(await readWorkspaceText(root, 'safe.txt'), 'safe');
    for (const relative of [
      '../safe.txt',
      '/tmp/a',
      '.git/config',
      '.GiT/config',
      'nested/../../safe.txt',
      'link',
      'outside/test',
    ])
      await assert.rejects(workspacePath(root, relative));
    await assert.rejects(readWorkspaceText(root, 'nested'), /regular file/);
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(readWorkspaceText(root, 'binary'), /Binary/);
    await writeFile(path.join(root, 'large'), Buffer.alloc(WORKSPACE_TEXT_LIMIT + 1, 'x'));
    await assert.rejects(readWorkspaceText(root, 'large'), /viewer limit/);
    assert.equal(
      (await nativeWorkspaceList(root, '.')).entries.some(
        (entry) => entry.name === 'outside' || entry.name === 'link',
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git changes remain scoped to session subdirectory and use literal filenames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'native-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'outside.ts'), 'outside\n');
    await writeFile(path.join(root, 'nested', 'one.ts'), 'before\n');
    await writeFile(path.join(root, 'nested', '*.ts'), 'literal before\n');
    git('init');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      'fixture',
    );
    await writeFile(path.join(root, 'outside.ts'), 'outside changed\n');
    await writeFile(path.join(root, 'nested', 'one.ts'), 'after\n');
    await writeFile(path.join(root, 'nested', '*.ts'), 'literal after\n');
    await writeFile(path.join(root, 'nested', ':new.ts'), 'new file\n');
    const cwd = path.join(root, 'nested');
    const changes = await nativeWorkspaceChanges(cwd);
    assert.deepEqual(changes.files.map((entry) => entry.path).sort(), [
      '*.ts',
      ':new.ts',
      'one.ts',
    ]);
    const literal = await nativeWorkspaceDiff(cwd, '*.ts');
    assert.match(literal, /literal after/);
    assert.doesNotMatch(literal, /one.ts|outside/);
    assert.match(await nativeWorkspaceDiff(cwd, ':new.ts'), /\+new file/);
    await assert.rejects(nativeWorkspaceDiff(cwd, '../outside.ts'));
    assert.equal(await nativeWorkspaceDiff(cwd, ':(glob)*'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
