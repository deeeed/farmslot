import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  assertCIFixScope,
  BranchMaintenanceRefusal,
  normalizeMaintenanceBranch,
  pushBranchMaintenance,
  pushOrdinaryBranchMaintenance,
  verifyCIFixScope,
} from './branch-update.js';
import { scopeFixture } from './branch-update.test-support.js';

test('normalizes only equivalent explicit remote branch names', () => {
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('origin/feat/base'), 'feat/base');
  assert.equal(normalizeMaintenanceBranch('feature/origin/base'), 'feature/origin/base');
  assert.equal(normalizeMaintenanceBranch('refs/heads/origin/feat'), 'origin/feat');
  assert.equal(normalizeMaintenanceBranch('refs/remotes/origin/origin/feat'), 'origin/feat');
});

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
