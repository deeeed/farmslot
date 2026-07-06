import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const guardScript = fileURLToPath(new URL('./check-conventional-commits.mjs', import.meta.url));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Build a throwaway repo: base -> feature (good subject) -> merge of a side
// branch. The merge subject is deliberately non-conventional, mirroring the
// "Merge branch 'main' into <branch>" commit GitHub's Update branch button makes.
function makeRepoWithMerge() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccguard-'));
  const run = (...args) => git(dir, args);
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('commit', '--allow-empty', '-q', '-m', 'chore: base');
  const base = run('rev-parse', 'HEAD');
  run('checkout', '-q', '-b', 'feature');
  run('commit', '--allow-empty', '-q', '-m', 'fix(scope): real change');
  run('checkout', '-q', 'main');
  run('commit', '--allow-empty', '-q', '-m', 'feat: main advanced');
  run('checkout', '-q', 'feature');
  // Non-fast-forward merge -> a real merge commit with >1 parent.
  run('merge', '--no-ff', '-q', '-m', "Merge branch 'main' into feature", 'main');
  return { dir, base };
}

function runGuard(cwd, args) {
  return spawnSync('node', [guardScript, ...args], { cwd, encoding: 'utf8' });
}

test('conventional commit guard skips merge commits in a range', () => {
  const { dir, base } = makeRepoWithMerge();
  try {
    const result = runGuard(dir, ['--range', `${base}..HEAD`]);
    assert.equal(
      result.status,
      0,
      `guard should pass despite the merge commit subject.\n${result.stdout}${result.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('conventional commit guard still fails non-merge commits with bad subjects', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccguard-'));
  try {
    const run = (...args) => git(dir, args);
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'test@example.com');
    run('config', 'user.name', 'Test');
    run('commit', '--allow-empty', '-q', '-m', 'chore: base');
    const base = run('rev-parse', 'HEAD');
    run('commit', '--allow-empty', '-q', '-m', 'not a conventional subject');
    const result = runGuard(dir, ['--range', `${base}..HEAD`]);
    assert.equal(result.status, 1, 'guard should reject a non-conventional non-merge subject');
    assert.match(result.stderr, /not a Conventional Commit subject/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
