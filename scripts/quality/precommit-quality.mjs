#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const commandCenterRequire = createRequire(join(repoRoot, 'apps/command-center/package.json'));
const eslintPackagePath = commandCenterRequire.resolve('eslint/package.json');
const eslintBin = join(dirname(eslintPackagePath), 'bin/eslint.js');
const prettierBin = commandCenterRequire.resolve('prettier/bin/prettier.cjs');

function exitCodeFor(result) {
  if (result.status !== null) return result.status;
  if (result.signal) return 128 + (osConstants.signals[result.signal] ?? 0);
  return 1;
}

class CommandFailedError extends Error {
  constructor(command, args, result) {
    super(`${command} ${args.join(' ')} failed with exit code ${exitCodeFor(result)}`);
    this.exitCode = exitCodeFor(result);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', shell: false });
  const status = exitCodeFor(result);
  if (status !== 0 && !(options.allowLintIssues && status === 1)) {
    throw new CommandFailedError(command, args, result);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new CommandFailedError(command, args, result);
  }
  return result.stdout;
}

function hasUnstagedChanges() {
  const tracked = spawnSync('git', ['diff', '--quiet', '--ignore-submodules', '--'], {
    cwd: repoRoot,
    shell: false,
  });
  if (tracked.status === 1) return true;
  if (tracked.status !== 0) throw new CommandFailedError('git', ['diff', '--quiet'], tracked);
  return capture('git', ['ls-files', '--others', '--exclude-standard', '-z']).length > 0;
}

function splitNullList(output) {
  return output.split('\0').filter(Boolean);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

const stagedFiles = splitNullList(
  capture('git', ['diff', '--name-only', '--cached', '--diff-filter=ACMRD', '-z']),
);
const existingStagedFiles = stagedFiles.filter((file) => existsSync(join(repoRoot, file)));
const deletedStagedFiles = stagedFiles.filter((file) => !existsSync(join(repoRoot, file)));
const eslintFiles = existingStagedFiles.filter((file) => /\.[cm]?[jt]sx?$/.test(file));

let stashedUnstagedChanges = false;
let restoreExitCode = 0;

try {
  if (stagedFiles.length === 0) {
    console.log('farmslot pre-commit: no staged files; skipping quality hook.');
    process.exit(0);
  }

  if (hasUnstagedChanges()) {
    run('git', [
      'stash',
      'push',
      '--quiet',
      '--keep-index',
      '--include-untracked',
      '-m',
      `farmslot-precommit-quality-${process.pid}`,
    ]);
    stashedUnstagedChanges = true;
  }

  for (const batch of chunks(eslintFiles, 100)) {
    run(process.execPath, [eslintBin, '--fix', ...batch], { allowLintIssues: true });
  }
  for (const batch of chunks(existingStagedFiles, 100)) {
    run(process.execPath, [prettierBin, '--write', '--ignore-unknown', ...batch]);
  }
  for (const batch of chunks(existingStagedFiles, 100)) {
    run('git', ['add', '--', ...batch]);
  }
  for (const batch of chunks(deletedStagedFiles, 100)) {
    // Keep staged deletions staged after format/lint rewrites. `git add --`
    // rejects an absent pathspec, so deleted files need the removal path.
    run('git', ['rm', '--cached', '--ignore-unmatch', '--', ...batch]);
  }

  run('node', ['scripts/quality/check-no-first-party-legacy.mjs']);
  run('node', ['scripts/quality/check-eslint-ratchet.mjs', '--strict-stale']);
  if (existsSync(join(repoRoot, 'apps/command-center/scripts/check-type-escape-ratchet.mjs'))) {
    run('node', ['apps/command-center/scripts/check-type-escape-ratchet.mjs', '--strict-stale']);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error?.exitCode ?? 1;
} finally {
  if (stashedUnstagedChanges) {
    const result = spawnSync('git', ['stash', 'pop', '--quiet'], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: false,
    });
    if (result.status !== 0) {
      restoreExitCode = exitCodeFor(result);
      process.stderr.write(
        'Failed to restore pre-commit unstaged changes from git stash; resolve the stash before retrying.\n',
      );
      if (process.exitCode) {
        process.stderr.write(
          `The quality command had already failed with exit code ${process.exitCode}; restore the stash first, then rerun the command to see the original failure again.\n`,
        );
      }
    }
  }
}

if (restoreExitCode !== 0) {
  process.exit(restoreExitCode);
}
if (process.exitCode) {
  process.exit(process.exitCode);
}
console.log('farmslot pre-commit: repo ESLint ratchet, Prettier, and type ratchets passed.');
