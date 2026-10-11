import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';

import { findUnmergedSlotWork } from './unmerged-work.js';

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

test('owned task and observability scaffolding does not block a published slot', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  mkdirSync(path.join(repo, '.task/qa'), { recursive: true });
  writeFileSync(path.join(repo, '.task/qa/TASK.md'), 'completed task');
  mkdirSync(path.join(repo, '.agent/.observability'), { recursive: true });
  writeFileSync(path.join(repo, '.agent/.observability/hooks.jsonl'), '{}');
  symlinkSync('.agent/.observability', path.join(repo, '.observability'));
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), null);
  writeFileSync(path.join(repo, 'new-feature.ts'), 'user work');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});

test('configured namespaces with spaces are owned but adjacent user paths are protected', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const project = { task_dir: 'support/tasks with spaces', paths: { runtime_dir: '.runtime' } };
  mkdirSync(path.join(repo, project.task_dir), { recursive: true });
  writeFileSync(path.join(repo, project.task_dir, 'TASK.md'), 'scaffold');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash, project), null);
  mkdirSync(path.join(repo, 'support/tasks with spaces-extra'));
  writeFileSync(path.join(repo, 'support/tasks with spaces-extra/user.md'), 'user work');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash, project), 'dirty files');
});

test('tracked edits inside a reserved namespace remain protected', async (t) => {
  const { repo, vars } = slotRepo(t, ['origin']);
  mkdirSync(path.join(repo, '.task'));
  commit(repo, '.task/tracked.md');
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  writeFileSync(path.join(repo, '.task/tracked.md'), 'user edit');
  assert.equal(await findUnmergedSlotWork(vars, BRANCH, bash), 'dirty files');
});
