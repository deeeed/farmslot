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
  const stacked: DiffBaseSpec = {
    baseRef: 'stack:feat/a',
    commitish: branchPoint,
    stackBranch: 'feat/a',
  };
  // What captureRunDiffSnapshot diffs for a settled base.
  const contribution = async () => {
    const base = await settleStackedDiffBase(exec, 'main', stacked);
    const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
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
  const settled = await settleStackedDiffBase(exec, 'main', stacked);
  assert.equal(
    settled.commitish,
    stacked.commitish,
    'the recorded base stays the branch point, which origin can serve for a replay',
  );
  assert.ok(settled.diffFrom && settled.diffFrom !== stacked.commitish);

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

  // Main reverts the squash and B rebases onto main, dropping A's commits:
  // B is an ordinary branch again.
  await git(slot, 'remote', 'set-url', 'origin', path.join(path.dirname(slot), 'origin.git'));
  await onMain(async () => {
    await git(author, 'revert', '--no-edit', 'HEAD~1');
  });
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'checkout', '-q', '-B', 'feat/b2', 'origin/main');
  await git(
    slot,
    'cherry-pick',
    (await git(slot, 'log', '--format=%H', '-1', 'feat/b', '--', 'b.txt')).trim(),
  );
  assert.deepEqual(await settleStackedDiffBase(exec, 'main', stacked), {
    baseRef: 'origin/main',
    commitish: 'origin/main',
  });
  assert.deepEqual(await contribution(), ['b.txt'], 'rebased off the stack: a plain diff');

  const plain: DiffBaseSpec = { baseRef: 'origin/main', commitish: 'origin/main' };
  assert.equal(await settleStackedDiffBase(exec, 'main', plain), plain, 'non-stacked: untouched');
});

test('once the checkout has the upstream merge, a later revert is not its work', async (t) => {
  const { author, slot, stacked, exec, onMain } = await fixture(t);
  let squash = '';
  await onMain(async () => {
    await git(author, 'merge', '-q', '--squash', 'origin/feat/a');
    await git(author, 'commit', '-q', '-m', 'A (squash)');
    squash = await git(author, 'rev-parse', 'HEAD');
  });
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'merge', '-q', '--no-edit', 'origin/main');
  await onMain(async () => {
    await git(author, 'revert', '--no-edit', squash);
  });
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'merge', '-q', '--no-edit', 'origin/main');

  const contribution = async (spec: DiffBaseSpec) => {
    const base = await settleStackedDiffBase(exec, 'main', spec);
    const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
    return (await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n').sort();
  };
  assert.deepEqual(
    await contribution({ ...stacked, upstreamMergeSha: squash }),
    ['b.txt'],
    'the revert of a.txt belongs to the default branch',
  );
  assert.deepEqual(
    await contribution(stacked),
    ['a.txt', 'b.txt'],
    'without the merge commit the synthetic base would restore a.txt',
  );
});

test('a conflict between upstream and default branch counts only the resolution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'farmslot-stacked-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const slot = path.join(root, 'slot');
  await execFileAsync('git', ['init', '-q', '--bare', '--initial-branch=main', origin]);
  await execFileAsync('git', ['init', '-q', '--initial-branch=main', author]);
  await commitFile(author, 'shared.txt', 'base');
  await git(author, 'remote', 'add', 'origin', origin);
  await git(author, 'push', '-q', 'origin', 'main');
  // A adds a.txt and changes shared.txt; main changes shared.txt another way.
  await git(author, 'checkout', '-q', '-b', 'feat/a');
  await commitFile(author, 'a.txt', 'A');
  const branchPoint = await commitFile(author, 'shared.txt', 'A version');
  await git(author, 'push', '-q', 'origin', 'feat/a');
  await git(author, 'checkout', '-q', 'main');
  await commitFile(author, 'shared.txt', 'main version');
  await git(author, 'push', '-q', 'origin', 'main');
  await execFileAsync('git', ['clone', '-q', '-b', 'feat/a', origin, slot]);
  await git(slot, 'checkout', '-q', '-b', 'feat/b');
  await commitFile(slot, 'b.txt', 'B');
  await git(slot, 'fetch', '-q', 'origin');
  await assert.rejects(git(slot, 'merge', '-q', '--no-edit', 'origin/main'));
  await writeFile(path.join(slot, 'shared.txt'), 'resolved by B\n');
  await git(slot, 'add', 'shared.txt');
  await git(slot, 'commit', '-q', '--no-edit');

  const exec = async (command: string) => {
    try {
      const { stdout, stderr } = await execFileAsync('sh', ['-c', command], { cwd: slot });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
    }
  };
  const base = await settleStackedDiffBase(exec, 'main', {
    baseRef: 'stack:feat/a',
    commitish: branchPoint,
  });
  const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
  assert.deepEqual(
    (await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n').sort(),
    ['b.txt', 'shared.txt'],
    'a.txt is the upstream’s; the conflict B resolved in shared.txt is B’s',
  );
});

test("a checkout rebased onto the upstream's newer head measures from that head", async (t) => {
  const { author, slot, stacked, exec } = await fixture(t);
  // A gets a review fix; B rebases onto it while A is still open.
  await git(author, 'checkout', '-q', 'feat/a');
  const fixed = await commitFile(author, 'a-fix.txt', 'A review fix');
  await git(author, 'push', '-q', 'origin', 'feat/a');
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'rebase', '-q', 'origin/feat/a');

  const base = await settleStackedDiffBase(exec, 'main', stacked);
  assert.equal(base.commitish, fixed, 'the branch point moved with the upstream, on origin');
  const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
  assert.deepEqual(
    (await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n'),
    ['b.txt'],
    "A's fix is not B's work",
  );

  // A squash-merges and GitHub deletes its branch while B is still active.
  await git(author, 'checkout', '-q', 'main');
  await git(author, 'merge', '-q', '--squash', 'feat/a');
  await git(author, 'commit', '-q', '-m', 'A (squash)');
  await git(author, 'push', '-q', 'origin', 'main');
  await git(author, 'push', '-q', 'origin', '--delete', 'feat/a');
  const afterDelete = await settleStackedDiffBase(exec, 'main', stacked);
  assert.equal(afterDelete.commitish, fixed, 'the cached upstream ref still knows the head');
  const fromAfter =
    afterDelete.diffFrom ?? (await git(slot, 'merge-base', afterDelete.commitish, 'HEAD'));
  assert.deepEqual((await git(slot, 'diff', '--name-only', `${fromAfter}..HEAD`)).split('\n'), [
    'b.txt',
  ]);
});

test('a checkout rebased onto a force-pushed upstream measures from its new head', async (t) => {
  const { author, slot, stacked, exec, onMain } = await fixture(t);
  await onMain(async () => {
    await commitFile(author, 'x.txt', 'X');
  });
  // A rebases onto the newer main and force-pushes; B follows it.
  await git(author, 'checkout', '-q', 'feat/a');
  await git(author, 'rebase', '-q', 'main');
  const replacedHead = await git(author, 'rev-parse', 'HEAD');
  await git(author, 'push', '-q', '--force', 'origin', 'feat/a');
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'rebase', '-q', '--onto', 'origin/feat/a', stacked.commitish);

  const base = await settleStackedDiffBase(exec, 'main', stacked);
  assert.equal(base.commitish, replacedHead);
  const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
  assert.deepEqual((await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n'), [
    'b.txt',
  ]);
});

test('a checkout that merges a force-pushed upstream measures from its new head', async (t) => {
  const { author, slot, stacked, exec, onMain } = await fixture(t);
  await onMain(async () => {
    await commitFile(author, 'x.txt', 'X');
  });
  await git(author, 'checkout', '-q', 'feat/a');
  await git(author, 'rebase', '-q', 'main');
  const replacedHead = await commitFile(author, 'a-fix.txt', 'A review fix');
  await git(author, 'push', '-q', '--force', 'origin', 'feat/a');
  await git(slot, 'fetch', '-q', 'origin');
  await git(slot, 'merge', '-q', '--no-edit', 'origin/feat/a');

  const base = await settleStackedDiffBase(exec, 'main', stacked);
  assert.equal(base.commitish, replacedHead);
  const from = base.diffFrom ?? (await git(slot, 'merge-base', base.commitish, 'HEAD'));
  assert.deepEqual((await git(slot, 'diff', '--name-only', `${from}..HEAD`)).split('\n'), [
    'b.txt',
  ]);
});
