import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { type SourceCommand, SourceGitStore } from './git.js';
import { sourceTreeIdentity } from './materialization.js';

const execute = promisify(execFile);

test('exact Git objects survive branch movement without running hooks or filters', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-git-test-'));
  const remote = path.join(root, 'remote');
  const local = async (args: string[]) =>
    (await execute('git', args, { encoding: 'buffer' })).stdout;
  try {
    await local(['init', '-b', 'main', remote]);
    await writeFile(path.join(remote, 'helper.mjs'), 'export const value = 1;\n');
    await symlink('helper.mjs', path.join(remote, 'alias.mjs'));
    await local(['-C', remote, 'add', '.']);
    await local([
      '-C',
      remote,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ]);
    const requests: string[][] = [];
    const command: SourceCommand = async (program, args) => {
      assert.equal(program, 'git');
      requests.push(args);
      const result = await execute(
        program,
        args.map((arg) => (arg === 'https://example.test/owner/helpers' ? remote : arg)),
        { encoding: 'buffer', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } },
      );
      return result.stdout;
    };
    const store = new SourceGitStore(path.join(root, 'cache'), command);
    const declaration = {
      id: 'helpers',
      kind: 'helper' as const,
      repo: 'https://example.test/owner/helpers',
    };
    const first = await store.resolve(declaration);
    await writeFile(path.join(remote, 'helper.mjs'), 'export const value = 2;\n');
    await local(['-C', remote, 'add', '.']);
    await local([
      '-C',
      remote,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'advance',
    ]);
    const next = await store.resolve(declaration);
    assert.notEqual(next.commit, first.commit);
    const before = requests.length;
    const retained = await store.retain(declaration.repo, first.commit, first.objectFormat);
    assert.equal(retained.treeDigest, first.treeDigest);
    assert.equal(
      requests.slice(before).some((args) => args.includes('fetch')),
      false,
    );
    const exported = path.join(root, 'exported');
    await store.export(declaration.repo, first, exported);
    assert.equal(await sourceTreeIdentity(exported, first.objectFormat), first.treeDigest);
    assert.ok(requests.every((args) => !args.includes('checkout') && !args.includes('submodule')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
