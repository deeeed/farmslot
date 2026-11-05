import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

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
