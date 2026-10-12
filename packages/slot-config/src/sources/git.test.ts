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
    await writeFile(path.join(remote, '[id].tsx'), 'export const route = 1;\n');
    await writeFile(path.join(remote, '(tabs).tsx'), 'export const tabs = 1;\n');
    await writeFile(path.join(remote, 'localized name.ts'), 'export const title = 1;\n');
    for (let index = 0; index < 130; index++)
      await writeFile(path.join(remote, `binary-${index}.dat`), Buffer.from([0, 10, 255, index]));
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
    const command: SourceCommand = async (program, args, input) => {
      assert.equal(program, 'git');
      requests.push(args);
      const operation = execute(
        program,
        args.map((arg) => (arg === 'https://example.test/owner/helpers' ? remote : arg)),
        { encoding: 'buffer', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } },
      );
      if (input) operation.child.stdin!.end(input);
      return (await operation).stdout;
    };
    const store = new SourceGitStore(path.join(root, 'cache'), command);
    const declaration = {
      id: 'helpers',
      kind: 'helper' as const,
      repo: 'https://example.test/owner/helpers',
    };
    const first = await store.resolve(declaration);
    assert.ok(first.files.some((file) => file.path === '[id].tsx'));
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

test('source trees refuse traversal, metadata and control-character filenames before export', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'source-unsafe-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of [
    '/outside',
    '../escape',
    'nested/../escape',
    '.git/hooks/run',
    '.GIT/hooks/run',
    'line\nbreak',
    'windows\\escape',
  ]) {
    const command: SourceCommand = async (_program, args) => {
      if (args.includes('--show-object-format')) return Buffer.from('sha1\n');
      if (args.includes('ls-tree')) return Buffer.from(`100644 blob ${'a'.repeat(40)}\t${entry}\0`);
      return Buffer.alloc(0);
    };
    const store = new SourceGitStore(root, command);
    await assert.rejects(
      store.retain('https://example.test/owner/demo', 'a'.repeat(40), 'sha1'),
      /unsafe source tree entry/,
    );
  }
});
