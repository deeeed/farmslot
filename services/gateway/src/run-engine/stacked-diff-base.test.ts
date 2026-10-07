import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { settleStackedDiffBase } from './diff-artifacts.js';

const execFileAsync = promisify(execFile);
const gitEnv = ['-c', 'user.name=Farmslot Test', '-c', 'user.email=farmslot-test@example.invalid'];

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...gitEnv, ...args]);
  return stdout.trim();
}

async function commitFile(repo: string, file: string, content: string, message: string) {
  await writeFile(path.join(repo, file), content);
  await git(repo, 'add', file);
  await git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

test('a stacked diff keeps its branch point until the checkout merges the default branch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-stacked-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const slot = path.join(root, 'slot');
  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['init', '-q', '--initial-branch=main', author]);
  await commitFile(author, 'README.md', 'base\n', 'base');
  await git(author, 'remote', 'add', 'origin', origin);
  await git(author, 'push', '-q', 'origin', 'main');
  // Upstream A on its own branch; B stacks on A's head.
  await git(author, 'checkout', '-q', '-b', 'feat/a');
  const branchPoint = await commitFile(author, 'a.txt', 'A\n', 'A');
  await git(author, 'push', '-q', 'origin', 'feat/a');
  await execFileAsync('git', ['clone', '-q', '-b', 'feat/a', origin, slot]);
  await git(slot, 'checkout', '-q', '-b', 'feat/b');
  await commitFile(slot, 'b.txt', 'B\n', 'B');
  // A squash-merges: main gets A's content as a new commit.
  await git(author, 'checkout', '-q', 'main');
  await git(author, 'merge', '-q', '--squash', 'feat/a');
  await git(author, 'commit', '-q', '-m', 'A (squash)');
  await git(author, 'push', '-q', 'origin', 'main');

  const exec = async (command: string) => {
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd: slot });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
    }
  };
  const stacked = { baseRef: 'stack:feat/a', commitish: branchPoint };

  assert.deepEqual(
    await settleStackedDiffBase(exec, 'main', stacked),
    stacked,
    'retargeted but not integrated: origin/main would count a.txt as B',
  );

  await git(slot, 'merge', '-q', '--no-edit', 'origin/main');
  assert.deepEqual(await settleStackedDiffBase(exec, 'main', stacked), {
    baseRef: 'origin/main',
    commitish: 'origin/main',
  });
  assert.deepEqual(
    (
      await git(
        slot,
        'diff',
        '--name-only',
        `${await git(slot, 'merge-base', 'HEAD', 'origin/main')}..HEAD`,
      )
    ).split('\n'),
    ['b.txt'],
    'after integration the default branch isolates B',
  );

  const plain = { baseRef: 'origin/main', commitish: 'origin/main' };
  assert.equal(await settleStackedDiffBase(exec, 'main', plain), plain, 'non-stacked: untouched');
});
