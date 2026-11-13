import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertCIFixScope,
  BranchMaintenanceRefusal,
  captureCIFixScope,
  inspectBranchMaintenance,
  normalizeMaintenanceBranch,
  pushBranchMaintenance,
  pushOrdinaryBranchMaintenance,
  verifyCIFixScope,
} from './branch-update.js';
import { buildBranchUpdateGuardCommand } from './task-document.js';

test('normalizes only equivalent explicit remote branch names', () => {
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('feature/origin/base'), 'feature/origin/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/origin/feat'), 'origin/feat');
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/origin/feat'), 'origin/feat');
});

function scopeFixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'f415-push-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const remote = path.join(root, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe', timeout: 1000 }).trim();
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
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

test('CI fix push refuses workflow changes outside the original PR files', (t) => {
  const { repo, git, headSha, operation, request, scope } = scopeFixture(t);
  mkdirSync(path.join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(path.join(repo, '.github/workflows/validate.yml'), 'timeout-minutes: 60\n');
  git('add', '.');
  git('commit', '-qm', 'change timeout');
  assert.throws(
    () => pushBranchMaintenance(operation, scope),
    (error: unknown) => {
      assert.ok(error instanceof BranchMaintenanceRefusal);
      assert.equal(error.code, 'CI_FIX_OUT_OF_SCOPE');
      assert.equal(
        error.message,
        'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
      );
      return true;
    },
  );
  assert.throws(() => pushOrdinaryBranchMaintenance(request, scope), {
    code: 'CI_FIX_OUT_OF_SCOPE',
    message: 'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
  });
  assert.equal(git('ls-remote', 'origin', 'refs/heads/fix/product').split('\t')[0], headSha);
  git('push', '-q', 'origin', 'HEAD');
  assert.throws(
    () => verifyCIFixScope({ ...request, operation, scope, headSha: git('rev-parse', 'HEAD') }),
    {
      code: 'CI_FIX_OUT_OF_SCOPE',
      message: 'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: .github/workflows/validate.yml',
    },
  );
});

test('scope captures renamed paths against the publication merge base and allows owned fixes', (t) => {
  const { repo, git, headSha, request, scope } = scopeFixture(t);
  assert.deepEqual(scope, {
    baseRef: 'main',
    headSha,
    ownedFiles: ['old.ts', 'product.ts', 'renamed.ts'],
  });
  writeFileSync(path.join(repo, 'product.ts'), 'fixed product\n');
  git('commit', '-qam', 'fix product');
  pushOrdinaryBranchMaintenance(request, scope);
  assert.equal(
    git('ls-remote', 'origin', 'refs/heads/fix/product').split('\t')[0],
    git('rev-parse', 'HEAD'),
  );
  verifyCIFixScope({ ...request, scope, headSha: git('rev-parse', 'HEAD') });
});

test('scope rejects a reverted unrelated edit and an unpublished completion', (t) => {
  const { repo, git, request, scope } = scopeFixture(t);
  writeFileSync(path.join(repo, 'unrelated.ts'), 'unrelated\n');
  git('add', '.');
  git('commit', '-qm', 'unrelated');
  git('revert', '--no-edit', 'HEAD');
  const headSha = git('rev-parse', 'HEAD');
  assert.throws(() => assertCIFixScope(repo, scope, headSha), {
    code: 'CI_FIX_OUT_OF_SCOPE',
    message: 'Branch maintenance refused: CI_FIX_OUT_OF_SCOPE: unrelated.ts',
  });
  assert.throws(() => verifyCIFixScope({ ...request, scope, headSha }), {
    code: 'CI_FIX_NOT_PUSHED',
    message: 'Branch maintenance refused: CI_FIX_NOT_PUSHED',
  });
});

for (const budget of ['2500', '500']) {
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
      `#!/bin/sh\necho started > .git/hook-started\nsleep ${budget === '500' ? '0.8' : '0.05'}\necho finished > .git/hook-finished\n`,
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
    const result = spawnSync(process.platform === 'darwin' ? 'zsh' : 'bash', ['-c', command], {
      cwd: f.repo,
      env: { ...process.env, GIT_SSH_COMMAND: `'${ssh}'`, GIT_SSH_VARIANT: 'ssh' },
      encoding: 'utf8',
      timeout: 4000,
    });
    if (result.error) throw result.error;
    assert.ok(existsSync(path.join(f.repo, '.git/hook-started')));
    if (budget === '500') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /git push timed out after 500 ms.*pre-push hook budget/);
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
    assert.equal(remoteHead, budget === '500' ? f.headSha : f.git('rev-parse', 'HEAD'));
  });
}
