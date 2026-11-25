import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  buildTempScratchDeleteCommand,
  buildTempScrubCommand,
  buildTempTaskDirListCommand,
  parseTempScratchDeleteOutput,
  parseTempScrubOutput,
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

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const run = async (command: string) =>
  (await execFileAsync('bash', ['-c', command], { env: gitEnv })).stdout;
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync('git', ['-C', cwd, ...args], { env: gitEnv })).stdout.trim();
const scrub = async (repo: string, keep: string[]) =>
  parseTempScrubOutput(await run(buildTempScrubCommand({ repo, keep, taskRoot: 'temp/tasks' })));

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

test('nested clones and bare repos are deleted outright and named with their kind', async (t) => {
  const { parent, repo } = await slotWith([
    'temp/tasks/feat/tat-4800/TASK.md',
    'temp/tasks/goal3-clone/src/answer.ts',
    'temp/scratch-x/notes.md',
  ]);
  t.after(() => rm(parent, { recursive: true, force: true }));
  // A clone directly under the task root and one in a task dir, plus a bare repo in scratch.
  await git(repo, 'init', '-q', path.join(repo, 'temp/tasks/goal3-clone'));
  await git(repo, 'init', '-q', path.join(repo, 'temp/tasks/feat/tat-4800/clone'));
  await git(repo, 'init', '-q', '--bare', path.join(repo, 'temp/scratch-x/bare.git'));

  const result = await scrub(repo, []);

  assert.deepEqual(result.refused, []);
  assert.deepEqual(
    result.removed
      .filter(({ kind }) => !['file', 'dir', 'link'].includes(kind))
      .sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: 'temp/scratch-x/bare.git', kind: 'bare' },
      { path: 'temp/tasks/feat/tat-4800/clone', kind: 'clone' },
      { path: 'temp/tasks/goal3-clone', kind: 'clone' },
    ],
  );
  for (const gone of ['temp/tasks/goal3-clone', 'temp/tasks/feat', 'temp/scratch-x'])
    assert.equal(existsSync(path.join(repo, gone)), false, gone);
});

test('a linked worktree goes through worktree remove; its sibling outside temp/ keeps its admin', async (t) => {
  const { parent, repo } = await slotWith(['temp/tasks/feat/wt-task/TASK.md']);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const origin = path.join(parent, 'origin-clone');
  await git(parent, 'init', '-q', '-b', 'main', origin);
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
  const inside = path.join(repo, 'temp/tasks/feat/wt-task/wt');
  const outside = path.join(parent, 'outside-wt');
  await git(origin, 'worktree', 'add', '-q', '-b', 'inside', inside);
  await git(origin, 'worktree', 'add', '-q', '-b', 'outside', outside);
  await writeFile(path.join(outside, 'draft.md'), 'kept\n');
  // An unmounted volume looks like a missing worktree to prune; remove must not touch it.
  const missing = path.join(parent, 'unmounted-wt');
  await git(origin, 'worktree', 'add', '-q', '-b', 'unmounted', missing);
  await rm(missing, { recursive: true });

  const result = await scrub(repo, []);

  assert.deepEqual(result.refused, []);
  assert.deepEqual(
    result.removed.find(({ path: p }) => p === 'temp/tasks/feat/wt-task/wt'),
    { path: 'temp/tasks/feat/wt-task/wt', kind: 'linked worktree (branch inside kept)' },
  );
  const listed = await git(origin, 'worktree', 'list', '--porcelain');
  assert.doesNotMatch(listed, /wt-task/, "the removed worktree's admin data is gone");
  assert.match(listed, /outside-wt/, 'the sibling stays registered');
  assert.match(listed, /unmounted-wt/, 'a missing sibling is not pruned');
  assert.equal(await git(outside, 'status', '--porcelain'), '?? draft.md');
});

test('a checkout holding a kept path is refused, not deleted whole', async (t) => {
  const { parent, repo } = await slotWith(['temp/recipe/harness/state.json']);
  t.after(() => rm(parent, { recursive: true, force: true }));
  await git(repo, 'init', '-q', path.join(repo, 'temp/recipe'));

  const result = await scrub(repo, ['temp/recipe/harness']);

  assert.deepEqual(result.refused, [
    { path: 'temp/recipe', reason: 'a Git checkout holding a kept path' },
  ]);
  assert.equal(existsSync(path.join(repo, 'temp/recipe/harness/state.json')), true);
});

test('release deletes temp/tasks-layout scratch, leaves task dirs and refuses checkouts', async (t) => {
  const { parent, repo } = await slotWith([
    'temp/scratch-tat4752/fix-notes.md',
    'temp/tasks/scratch-probe/baseline-run.json',
    'temp/tasks/feat/scratch-tat-4753/probe.mts',
    // A SCRATCH-12 Jira key names a real task dir scratch-12-<date>; TASK.md keeps it in place.
    'temp/tasks/fix/scratch-12-1123-101010/TASK.md',
    'temp/tasks/manual-notes/scratch-export/notes.md',
    'temp/tasks/scratch-locked/x.json',
  ]);
  await git(repo, 'init', '-q', path.join(repo, 'temp/tasks/scratch-clone/repo'));
  const locked = path.join(repo, 'temp/tasks/scratch-locked/inner');
  await mkdir(locked);
  await chmod(locked, 0o000);
  t.after(async () => {
    await chmod(locked, 0o755);
    await rm(parent, { recursive: true, force: true });
  });

  const result = parseTempScratchDeleteOutput(await run(buildTempScratchDeleteCommand({ repo })));

  const rel = (p: string) => path.relative(repo, p);
  assert.deepEqual(result.deleted.map(rel).sort(), [
    'temp/scratch-tat4752',
    'temp/tasks/feat/scratch-tat-4753',
    'temp/tasks/scratch-probe',
  ]);
  assert.deepEqual(result.refused.map((entry) => rel(entry.path)).sort(), [
    'temp/tasks/scratch-clone',
    'temp/tasks/scratch-locked',
  ]);
  for (const kept of [
    'temp/tasks/fix/scratch-12-1123-101010/TASK.md',
    'temp/tasks/manual-notes/scratch-export/notes.md',
    'temp/tasks/scratch-clone/repo/.git',
    'temp/tasks/scratch-locked/x.json',
  ])
    assert.equal(existsSync(path.join(repo, kept)), true, kept);
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

// macOS nodes run slot commands with `zsh -f -c`, where an unmatched shell glob aborts; CI
// (Ubuntu) has no zsh, so the same checks also run under bash.
for (const [shell, args] of [
  ['/bin/zsh', ['-f', '-c']],
  ['/bin/bash', ['-c']],
] as const)
  test(
    `the task-dir listing runs under ${shell} with no task root, an empty one or empty flows`,
    { skip: !existsSync(shell) && `${shell} is not installed` },
    async (t) => {
      const { parent, repo } = await slotWith(['outside/feat/x/TASK.md']);
      t.after(() => rm(parent, { recursive: true, force: true }));
      const inShell = async (command: string) =>
        (await execFileAsync(shell, [...args, command], { env: gitEnv })).stdout;
      const list = () => inShell(buildTempTaskDirListCommand({ repo, taskRoot: 'temp/tasks' }));
      assert.equal(await list(), '', 'no temp/tasks');
      await mkdir(path.join(repo, 'temp/tasks/feat'), { recursive: true });
      assert.equal(await list(), '', 'only an empty flow folder');
      await mkdir(path.join(repo, 'temp/tasks/fix/tat-1'), { recursive: true });
      await writeFile(path.join(repo, 'temp/tasks/fix/tat-1/TASK.md'), 'x');
      await mkdir(path.join(repo, 'temp/tasks/goal3-x'), { recursive: true });
      await writeFile(path.join(repo, 'temp/tasks/goal3-x/TASK.md'), 'x');
      // A symlinked flow folder is not entered: its task dirs are not this slot's.
      await symlink(path.join(repo, 'outside/feat'), path.join(repo, 'temp/tasks/linked'));
      assert.deepEqual((await list()).split('\n').filter(Boolean), [
        'temp/tasks/fix/tat-1',
        'temp/tasks/goal3-x',
      ]);
      const scrubbed = parseTempScrubOutput(
        await inShell(buildTempScrubCommand({ repo, keep: [], taskRoot: 'temp/tasks' })),
      );
      assert.deepEqual(scrubbed.refused, [], `the scrub runs under ${shell} too`);
    },
  );

test('a locked or unregistered worktree is deleted; a clone owning one outside temp/ is refused', async (t) => {
  const { parent, repo } = await slotWith([]);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const origin = path.join(parent, 'origin-clone');
  await git(parent, 'init', '-q', '-b', 'main', origin);
  await git(origin, 'commit', '-q', '--allow-empty', '-m', 'base');
  const locked = path.join(repo, 'temp/tasks/locked-wt');
  await git(origin, 'worktree', 'add', '-q', '-b', 'locked', locked);
  await git(origin, 'worktree', 'lock', locked);
  // A `.git` file Git does not list at this path: a copied worktree.
  const copied = path.join(repo, 'temp/scratch-copy');
  await mkdir(copied, { recursive: true });
  await writeFile(
    path.join(copied, '.git'),
    `gitdir: ${path.join(origin, '.git/worktrees/locked-wt')}\n`,
  );
  // A clone inside temp/ whose own worktree lives outside it.
  const clone = path.join(repo, 'temp/tasks/owner-clone');
  await git(parent, 'init', '-q', '-b', 'main', clone);
  await git(clone, 'commit', '-q', '--allow-empty', '-m', 'base');
  await git(clone, 'worktree', 'add', '-q', '-b', 'away', path.join(parent, 'away-wt'));

  const result = await scrub(repo, []);

  assert.deepEqual(
    result.removed
      .filter(({ kind }) => kind !== 'dir')
      .map(({ path: p, kind }) => [p, kind])
      .sort(),
    [
      ['temp/scratch-copy', 'clone'],
      ['temp/tasks/locked-wt', 'linked worktree (branch locked kept)'],
    ],
  );
  assert.doesNotMatch(await git(origin, 'worktree', 'list'), /locked-wt/);
  assert.deepEqual(result.refused, [
    {
      path: 'temp/tasks/owner-clone',
      reason: `a repository whose worktree ${path.relative(repo, path.join(parent, 'away-wt'))} is outside temp/ or kept`,
    },
  ]);
  assert.equal(existsSync(path.join(parent, 'away-wt/.git')), true);
});

test('a cut-off last line of a stopped scrub drops only itself; a clean exit parses every line', () => {
  const stdout = [
    JSON.stringify({ kind: 'removed', path: 'temp/a', detail: 'dir' }),
    JSON.stringify({ kind: 'removed', path: 'temp/b', detail: 'clone' }),
    '{"kind": "removed", "path": "temp/c", "de',
  ].join('\n');
  assert.deepEqual(parseTempScrubOutput(stdout, true).removed, [
    { path: 'temp/a', kind: 'dir' },
    { path: 'temp/b', kind: 'clone' },
  ]);
  assert.throws(() => parseTempScrubOutput(stdout), SyntaxError);
});

test('a clone whose worktree is kept, unmounted, recorded relatively or unreadable is refused', async (t) => {
  const { parent, repo } = await slotWith(['temp/tasks/feat/parked-task/TASK.md']);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const clone = async (name: string) => {
    const dir = path.join(repo, 'temp/tasks', name);
    await git(parent, 'init', '-q', '-b', 'main', dir);
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    return dir;
  };
  // A worktree in a parked run's kept task dir.
  const keeper = await clone('ref-clone');
  await git(
    keeper,
    'worktree',
    'add',
    '-q',
    '-b',
    'kept',
    path.join(repo, 'temp/tasks/feat/parked-task/wt'),
  );
  // A worktree on a volume that is not mounted now.
  const mounted = await clone('mount-clone');
  await git(mounted, 'worktree', 'add', '-q', '-b', 'away', path.join(parent, 'volume/wt'));
  await rm(path.join(parent, 'volume'), { recursive: true });
  // worktree.useRelativePaths: the record is relative to its admin dir.
  const relative = await clone('relative-clone');
  const outside = path.join(parent, 'rel-wt');
  await git(relative, 'worktree', 'add', '-q', '-b', 'rel', outside);
  const admin = path.join(relative, '.git/worktrees/rel-wt');
  await writeFile(
    path.join(admin, 'gitdir'),
    `${path.relative(admin, path.join(outside, '.git'))}\n`,
  );

  // A record that cannot be read is not a missing one: refused, not deleted.
  const unreadable = await clone('unreadable-clone');
  await git(unreadable, 'worktree', 'add', '-q', '-b', 'locked-record', path.join(parent, 'u-wt'));
  const record = path.join(unreadable, '.git/worktrees/u-wt/gitdir');
  await chmod(record, 0o000);

  const result = await scrub(repo, ['temp/tasks/feat/parked-task']);

  assert.deepEqual(result.refused.map(({ path: p }) => p).sort(), [
    'temp/tasks/mount-clone',
    'temp/tasks/ref-clone',
    'temp/tasks/relative-clone',
    'temp/tasks/unreadable-clone',
  ]);
  for (const kept of ['ref-clone/.git', 'mount-clone/.git', 'relative-clone/.git', 'unreadable-clone/.git'])
    assert.equal(existsSync(path.join(repo, 'temp/tasks', kept)), true, kept);
});
