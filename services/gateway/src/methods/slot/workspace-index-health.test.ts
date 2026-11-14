import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isRecord } from '@farmslot/protocol/recipe';

import { execLocal } from '../../core/exec.js';

import { workspaceMetadataCommand } from './workspace-metadata-program.js';

test('Doctor index check accepts native v2/v3/v4 indexes and loose/packed trees, flags broken linked indexes', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'index-health-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-C',
        repo,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    ).trim();
  git('init', '-q', '-b', 'main');
  await mkdir(path.join(repo, 'nested'));
  await writeFile(path.join(repo, 'nested/one'), 'one\n');
  await writeFile(path.join(repo, 'nested/two'), 'two\n');
  git('add', '.');
  git('commit', '-qm', 'test: fixture');
  const roots = [{ slotId: 'fixture', machine: 'fixture', repo, defaultBranch: 'main' }];
  const inspect = async (enabled = true) => {
    const result = await execLocal('ulimit -n 32; ' + workspaceMetadataCommand(roots, enabled), {
      timeout: 5000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const rows: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(rows) && isRecord(rows[0]));
    return rows[0];
  };
  const index = path.join(repo, '.git/index');
  for (const version of [2, 3, 4]) {
    if (version === 3) git('update-index', '--skip-worktree', 'nested/one');
    git('update-index', `--index-version=${version}`);
    git('write-tree');
    assert.equal((await readFile(index)).readUInt32BE(4), version);
    const row = await inspect();
    assert.deepEqual(row.indexErrors, [], `index version ${version}`);
    assert.deepEqual(row.indexWarnings, [], `index version ${version}`);
  }
  git('repack', '-a', '-d');
  git('prune-packed');
  assert.deepEqual((await inspect()).indexErrors, [], 'packed tree lookup');
  const packDir = path.join(repo, '.git/objects/pack');
  const packFiles = await readdir(packDir);
  for (let i = 0; i < 40; i++) {
    for (const file of packFiles) {
      await copyFile(
        path.join(packDir, file),
        path.join(packDir, `extra-${i}${path.extname(file)}`),
      );
    }
  }
  const tree = git('write-tree');
  const bytes = await readFile(index);
  const broken = Buffer.from(bytes);
  const treeOffset = broken.indexOf(Buffer.from(tree, 'hex'));
  assert.ok(treeOffset > 12);
  broken.fill(0xbb, treeOffset, treeOffset + 20);
  createHash('sha1')
    .update(broken.subarray(0, -20))
    .digest()
    .copy(broken, broken.length - 20);
  const linkedIndex = path.join(repo, '.git/worktrees/retired/index');
  await mkdir(path.dirname(linkedIndex), { recursive: true });
  await writeFile(linkedIndex, broken);
  const failed = await inspect();
  assert.deepEqual(
    failed.indexWarnings,
    [],
    'pack index descriptors are closed under a low fd limit',
  );
  assert.ok(Array.isArray(failed.indexErrors));
  assert.match(
    failed.indexErrors.join('\n'),
    /worktrees\/retired\/index: missing cache-tree object b{40}/,
  );
  assert.equal(
    (await inspect(false)).indexErrors,
    undefined,
    'passive polling does not inspect indexes',
  );
  await writeFile(linkedIndex, bytes);
  assert.deepEqual((await inspect()).indexErrors, []);
  broken[0] = 0;
  await writeFile(linkedIndex, broken);
  const invalid = await inspect();
  assert.ok(Array.isArray(invalid.indexWarnings));
  assert.match(invalid.indexWarnings.join('\n'), /retired\/index: invalid index header/);
});
