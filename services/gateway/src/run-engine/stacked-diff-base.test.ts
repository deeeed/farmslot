import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { type DiffBaseSpec, settleStackedDiffBase } from './diff-artifacts.js';

const execFileAsync = promisify(execFile);
const gitEnv = ['-c', 'user.name=Farmslot Test', '-c', 'user.email=farmslot-test@example.invalid'];

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...gitEnv, ...args]);
  return stdout.trim();
}

async function commitFile(repo: string, file: string, message: string) {
  await writeFile(path.join(repo, file), `${message}\n`);
  await git(repo, 'add', file);
  await git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * origin/main at O; upstream A (a.txt) on feat/a; the slot's B (b.txt) stacked
 * on A's head. `author` stands in for other slots and GitHub.
 */
async function fixture(t: import('node:test').TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-stacked-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const slot = path.join(root, 'slot');
  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['init', '-q', '--initial-branch=main', author]);
  await commitFile(author, 'README.md', 'base');
  await git(author, 'remote', 'add', 'origin', origin);
  await git(author, 'push', '-q', 'origin', 'main');
  await git(author, 'checkout', '-q', '-b', 'feat/a');
  const branchPoint = await commitFile(author, 'a.txt', 'A');
  await git(author, 'push', '-q', 'origin', 'feat/a');
  await git(author, 'checkout', '-q', 'main');
  await execFileAsync('git', ['clone', '-q', '-b', 'feat/a', origin, slot]);
  await git(slot, 'checkout', '-q', '-b', 'feat/b');
  await commitFile(slot, 'b.txt', 'B');

  const exec = async (command: string) => {
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd: slot });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
    }
  };
  const stacked: DiffBaseSpec = { baseRef: 'stack:feat/a', commitish: branchPoint };
  // What captureRunDiffSnapshot diffs for a settled base.
  const contribution = async () => {
    const base = await settleStackedDiffBase(exec, 'main', stacked);
    const from =
      base.useMergeBase === false
        ? base.commitish
        : await git(slot, 'merge-base', base.commitish, 'HEAD');
    return (await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n').sort();
  };
  const onMain = async (step: () => Promise<void>) => {
    await git(author, 'checkout', '-q', 'main');
    await git(author, 'pull', '-q', 'origin', 'main');
    await step();
    await git(author, 'push', '-q', 'origin', 'main');
  };
  return { author, exec, slot, stacked, contribution, onMain };
}

test('a stacked contribution never counts the upstream or default-branch work', async (t) => {
  const { author, slot, stacked, exec, contribution, onMain } = await fixture(t);

  assert.deepEqual(await settleStackedDiffBase(exec, 'main', stacked), stacked);
  assert.deepEqual(await contribution(), ['b.txt'], 'plain stack');

  // B merges unrelated default-branch work while A is still open.
  await onMain(async () => {
    await commitFile(author, 'x.txt', 'X');
  });
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'merge', '-q', '--no-edit', 'origin/main');
  assert.deepEqual(await contribution(), ['b.txt'], 'neither a.txt nor x.txt is B');

  // A squash-merges; B is retargeted but has not integrated it yet.
  await onMain(async () => {
    await git(author, 'merge', '-q', '--squash', 'origin/feat/a');
    await git(author, 'commit', '-q', '-m', 'A (squash)');
  });
  assert.deepEqual(await contribution(), ['b.txt'], 'squash not yet integrated');

  // B integrates the squash and more unrelated work.
  await onMain(async () => {
    await commitFile(author, 'y.txt', 'Y');
  });
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'merge', '-q', '--no-edit', 'origin/main');
  assert.deepEqual(await contribution(), ['b.txt'], 'after integration');

  // Origin unreachable: the local remote-tracking ref still holds what B merged.
  await git(slot, 'remote', 'set-url', 'origin', path.join(author, 'missing.git'));
  assert.deepEqual(await contribution(), ['b.txt'], 'fetch failed');

  const plain: DiffBaseSpec = { baseRef: 'origin/main', commitish: 'origin/main' };
  assert.equal(await settleStackedDiffBase(exec, 'main', plain), plain, 'non-stacked: untouched');
});
