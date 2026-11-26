import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { initGitFixture } from '../../test/git-fixtures.cjs';

import { captureCIFixScope, inspectBranchMaintenance } from './branch-update.js';
import { buildBranchUpdateGuardCommand } from './task-document.js';

function scopeFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'f415-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe', timeout: 1000 }).trim();
  mkdirSync(repo);
  initGitFixture(repo);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  writeFileSync(path.join(repo, 'product.ts'), 'base\n');
  writeFileSync(path.join(repo, 'old.ts'), 'renamed source\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  git('init', '--bare', '-q', remote);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'fix/product');
  writeFileSync(path.join(repo, 'product.ts'), 'product\n');
  git('mv', 'old.ts', 'renamed.ts');
  git('commit', '-qam', 'product');
  git('push', '-q', 'origin', 'HEAD');
  const headSha = git('rev-parse', 'HEAD');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const operation = inspectBranchMaintenance({
    id: `ordinary-${digest(JSON.stringify([path.resolve(repo), 'fix/product', 'main']))}`,
    ownerRunId: 'ordinary',
    project: 'example',
    repo,
    branch: 'fix/product',
    baseRef: 'main',
    kind: 'rebase',
    authority: { headSha, comparisonBaseSha: base, replayBoundarySha: base },
  });
  writeFileSync(
    path.join(repo, '.git', `farmslot-branch-${digest(operation.id)}.json`),
    JSON.stringify({
      operationHash: digest(JSON.stringify(operation)),
      operation,
      sourceHeadSha: headSha,
      replayHeadSha: headSha,
      boundarySha: base,
      phase: 'completed',
      rebaseResultSha: headSha,
      resultHeadSha: headSha,
    }),
  );
  const request = { kind: 'ordinary' as const, repo, branch: 'fix/product', baseRef: 'main' };
  const scope = captureCIFixScope({ ...request, headSha });
  return { repo, git, headSha, operation, request, scope };
}
// Each budget also covers shell, node and git startup before the hook, so the timeout case
// leaves that headroom and its hook blocks until the budget kills its process group.
export const pushHookBudgets = ['10000', '3000'];
export function registerPushHookBudget(variant: (typeof pushHookBudgets)[number]) {
  const budget = variant;
  test(`TASK.md worker push shares SSH protection and ${budget}ms hook budget`, (t) => {
    const f = scopeFixture(t);
    const remote = f.git('remote', 'get-url', 'origin');
    const capture = path.join(f.repo, '.git', 'ssh-argv');
    const ssh = path.join(f.repo, '.git', 'fixture-ssh');
    writeFileSync(
      ssh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\nfor arg do [ "$arg" = -G ] && exit 0; last=$arg; done\nexec sh -c "$last"\n`,
      { mode: 0o755 },
    );
    f.git('remote', 'set-url', 'origin', `fixture@localhost:${remote}`);
    f.git('config', 'core.hooksPath', '.git/hooks');
    writeFileSync(
      path.join(f.repo, '.git/hooks/pre-push'),
      `#!/bin/sh\necho started > .git/hook-started\nsleep ${budget === '3000' ? '30' : '0.05'}\necho finished > .git/hook-finished\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(f.repo, 'product.ts'), 'worker fix\n');
    f.git('commit', '-qam', 'worker fix');
    const command = buildBranchUpdateGuardCommand(
      {
        REPO: f.repo,
        BRANCH: f.request.branch,
        PUBLICATION_BASE: 'main',
        BRANCH_UPDATE_SCRIPT: fileURLToPath(
          new URL('../../scripts/branch-update.mjs', import.meta.url),
        ),
        FARMSLOT_GIT_PUSH_TIMEOUT_MS: budget,
      },
      'push',
    );
    const result = spawnSync(process.platform === 'darwin' ? 'zsh' : 'sh', ['-c', command], {
      cwd: f.repo,
      env: { ...process.env, GIT_SSH_COMMAND: `'${ssh}'`, GIT_SSH_VARIANT: 'ssh' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    assert.ok(existsSync(path.join(f.repo, '.git/hook-started')));
    if (budget === '3000') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /git push timed out after 3000 ms.*pre-push hook budget/);
      assert.equal(existsSync(path.join(f.repo, '.git/hook-finished')), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(existsSync(path.join(f.repo, '.git/hook-finished')));
      assert.match(readFileSync(capture, 'utf8'), /ServerAliveInterval=20/);
      assert.match(readFileSync(capture, 'utf8'), /ServerAliveCountMax=30/);
    }
    // Read the bare remote directly; no network or worker transport is needed.
    const remoteHead = execFileSync(
      'git',
      ['--git-dir', remote, 'rev-parse', `refs/heads/${f.request.branch}`],
      { encoding: 'utf8' },
    ).trim();
    assert.equal(remoteHead, budget === '3000' ? f.headSha : f.git('rev-parse', 'HEAD'));
  });
}

export { scopeFixture };
