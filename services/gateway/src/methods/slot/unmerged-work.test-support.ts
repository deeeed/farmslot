import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type test from 'node:test';

import type { SlotVars } from '../../core/index.js';

import type { MergedPreparePullRequest } from './unmerged-work.js';

export const BRANCH = 'TAT-4091-feat-fix-terminal-unit-tests';

export async function bash(_vars: SlotVars, cmd: string) {
  const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? 1 };
}

export function git(cwd: string, ...args: string[]): string {
  // Isolate from machine/global core.hooksPath (farmslot pre-commit breaks temp repos).
  const result = spawnSync('git', ['-c', 'core.hooksPath=.git/hooks', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function commit(repo: string, file: string): void {
  writeFileSync(path.join(repo, file), `${file}\n`);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', file);
}

/** A slot repo on a work branch, plus bare repos standing in for its remotes. */
export function slotRepo(t: test.TestContext, remotes: string[]) {
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

export function squashAndPrune(repo: string, baseBranch = 'main'): MergedPreparePullRequest {
  git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  const headSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', baseBranch);
  git(repo, 'merge', '--squash', BRANCH);
  git(repo, 'commit', '-qm', 'squash merged work');
  const mergeSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'push', '-q', 'origin', baseBranch);
  const origin = git(repo, 'remote', 'get-url', 'origin');
  git(origin, 'update-ref', '-d', `refs/heads/${BRANCH}`);
  git(repo, 'fetch', '-q', '--prune', 'origin');
  git(repo, 'checkout', '-q', BRANCH);
  return { number: 241, headSha, mergeSha, baseBranch };
}
