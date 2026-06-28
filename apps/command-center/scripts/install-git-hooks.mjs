#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const commandCenterRoot = dirname(scriptDir);
const repoRoot = resolve(commandCenterRoot, '../..');
const hooksDir = join(scriptDir, 'git-hooks');
const force = process.argv.includes('--force');

const gitPath = join(repoRoot, '.git');
// Worktrees store .git as a file that points at the common git dir; either shape is valid.
if (!existsSync(gitPath)) {
  console.log('Skipping hook install: not running inside the farmslot git checkout.');
  process.exit(0);
}

// Use an absolute path because git resolves relative core.hooksPath values from
// the caller's current directory, not reliably from this repository root.
const desiredHooksPath = join(commandCenterRoot, 'scripts/git-hooks');
let currentHooksPath = '';
try {
  currentHooksPath = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
} catch {
  currentHooksPath = '';
}
const currentHooksPathResolved =
  currentHooksPath && !isAbsolute(currentHooksPath)
    ? join(repoRoot, currentHooksPath)
    : currentHooksPath;

let worktrees = [];
try {
  worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
} catch {
  worktrees = [];
}
if (worktrees.length > 1) {
  console.warn(
    `core.hooksPath is stored in git config and may affect ${worktrees.length} worktrees sharing this repository.`,
  );
}

let defaultHookPath = '';
try {
  const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  defaultHookPath = join(
    isAbsolute(gitCommonDir) ? gitCommonDir : join(repoRoot, gitCommonDir),
    'hooks/pre-commit',
  );
} catch {
  defaultHookPath = '';
}
if (!currentHooksPath && defaultHookPath && existsSync(defaultHookPath) && !force) {
  console.error(
    `Refusing to override existing default pre-commit hook at ${defaultHookPath}. Merge it into ${desiredHooksPath}, then rerun with --force if replacement is intended.`,
  );
  process.exit(1);
}

if (currentHooksPath && currentHooksPathResolved !== desiredHooksPath && !force) {
  console.error(
    `Refusing to replace existing core.hooksPath=${currentHooksPath}. Merge custom hooks into ${desiredHooksPath}, then rerun with --force if replacement is intended.`,
  );
  process.exit(1);
}
if (currentHooksPath && currentHooksPathResolved !== desiredHooksPath) {
  console.warn(
    `Replacing existing core.hooksPath=${currentHooksPath} with ${desiredHooksPath}. Merge custom hooks into ${desiredHooksPath} if this checkout needs them.`,
  );
}

for (const entry of readdirSync(hooksDir)) {
  chmodSync(join(hooksDir, entry), 0o755);
}
execFileSync('git', ['config', '--local', 'core.hooksPath', desiredHooksPath], {
  cwd: repoRoot,
  stdio: 'inherit',
});
console.log(`Installed farmslot git hooks via core.hooksPath=${desiredHooksPath}`);
