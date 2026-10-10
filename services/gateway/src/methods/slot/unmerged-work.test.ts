import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';

import { assertPrepareCommitsPublished, findUnmergedSlotWork } from './unmerged-work.js';

const BRANCH = 'TAT-4091-feat-fix-terminal-unit-tests';

async function bash(_vars: SlotVars, cmd: string) {
  const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

function git(cwd: string, ...args: string[]): string {
  // Isolate from machine/global core.hooksPath (farmslot pre-commit breaks temp repos).
  const result = spawnSync('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function commit(repo: string, file: string): void {
  writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', file);
}

/** A slot repo on a work branch, plus bare repos standing in for its remotes. */
function slotRepo(t: test.TestContext, remotes: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'farmslot-unmerged-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'slot');
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  commit(repo, 'base.txt');
  for (const remote of remotes) {
    const bare = path.join(root, `${remote}.git`);
    git(root, 'init', '-q', '--bare', bare);
    git(repo, 'remote', 'add', remote, bare);
    git(repo, 'push', '-q', remote, 'main');
  }
  git(repo, 'checkout', '-q', '-b', BRANCH);
  commit(repo, 'fix.txt');
  return { repo, vars: { slotId: 'macwork-mmt-3', remoteRepo: repo } as SlotVars };
}

test('a HEAD that publication pushed to origin is not unpushed work', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('a slot without origin is judged by the fork remote its branch was pushed to', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork', 'org']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('a commit after the published head is still refused as unpushed', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork', 'org']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);
  commit(repo, 'follow-up.txt');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('dirty files on a published branch are still refused', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'edited\n');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('dirty files are refused even after the branch was deleted from the remote', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'edited after merge\n');

  // The deletion drops the tracking ref too; without the edit this would be allowed.
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files + unpushed commits');
});

test('dirty files are refused when push config names a remote the publish never used', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin', 'fork']);
  git(repo, 'config', 'remote.pushDefault', 'fork');
  // Publication pushes to origin explicitly; fork never sees the branch.
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, 'fix.txt'), 'follow-up edit\n');

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('the merged-branch probe asks the remote the publish pushed to, not push config', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin', 'fork']);
  git(repo, 'config', `branch.${BRANCH}.pushRemote`, 'fork');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  commit(repo, 'follow-up.txt');

  // fork has no such branch, but origin (where the publish went) still does.
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('unpushed work is allowed to go once its branch is deleted from the remote', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  commit(repo, 'squashed-away.txt');
  git(repo, 'push', '-q', 'origin', '--delete', BRANCH);

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
});

test('unpushed work stays protected when its remote cannot be asked', async (t) => {
  const { repo, vars } = slotRepo(t, ['fork']);
  git(repo, 'push', '-q', '-u', 'fork', BRANCH);
  commit(repo, 'follow-up.txt');
  git(repo, 'remote', 'set-url', 'fork', path.join(repo, 'missing.git'));

  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'unpushed commits');
});

test('destructive prepare refuses two unpushed linked-worktree commits without moving the branch', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  commit(repo, 'second-worker-commit.txt');
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const linked = path.join(path.dirname(repo), 'linked-slot');
  git(repo, 'worktree', 'add', '-q', linked, BRANCH);
  const linkedVars = { ...vars, remoteRepo: linked };
  await assert.rejects(
    assertPrepareCommitsPublished(linkedVars, BRANCH, bash),
    /unpushed commits.*Push or preserve/,
  );
  assert.equal(git(linked, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(repo, 'rev-parse', BRANCH), tip);
  git(linked, 'push', '-q', 'origin', BRANCH);
  await assertPrepareCommitsPublished(linkedVars, BRANCH, bash);
});

test('prepare protects an unchecked-out requested branch and fails closed on unreadable Git', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  const tip = git(repo, 'rev-parse', BRANCH);
  git(repo, 'checkout', '-q', 'main');
  await assert.rejects(
    assertPrepareCommitsPublished(vars, BRANCH, bash),
    /refs\/heads\/.*unpushed commits/,
  );
  assert.equal(git(repo, 'rev-parse', BRANCH), tip);
  await assert.rejects(
    assertPrepareCommitsPublished({ ...vars, remoteRepo: path.dirname(repo) }, BRANCH, bash),
    /Cannot inspect local branch/,
  );
});
