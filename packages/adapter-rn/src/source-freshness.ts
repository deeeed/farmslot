// Fingerprint of the app source a running bundle was built from. In a git
// checkout it is HEAD plus the diff and untracked files under the source paths;
// outside git it hashes the paths themselves. Env files always count. The
// project supplies both lists.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';

import {
  checkFingerprintBaseline,
  type FingerprintCheck,
  recordFingerprintBaseline,
} from './fingerprint-baseline.js';

export interface SourceInputs {
  /** Source files and directories relative to the project root. */
  paths: readonly string[];
  /** Env files relative to the project root (absent files hash as absent). */
  envFiles: readonly string[];
}

export function sourceFingerprint(projectRoot: string, inputs: SourceInputs): string {
  const hash = createHash('sha256');
  const observed = sourceStatus(projectRoot, inputs.paths);
  const head = observed?.head ?? gitHead(projectRoot);
  if (head === null) {
    hash.update('non-git\0');
    for (const relative of inputs.paths) {
      hashPath(hash, projectRoot, relative);
    }
  } else {
    hash.update(head);
    if (!observed || observed.trackedChanges) {
      hash.update(git(projectRoot, gitDiffArgs(['--binary', 'HEAD', '--', ...inputs.paths])));
    }

    const untracked =
      observed?.untracked ??
      git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...inputs.paths])
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .sort();
    for (const relative of untracked) {
      hash.update(`untracked\0${relative}\0`);
      hash.update(fs.readFileSync(path.join(projectRoot, relative)));
      hash.update('\0');
    }
  }

  for (const relative of inputs.envFiles) {
    const absolute = path.join(projectRoot, relative);
    hash.update(`env\0${relative}\0`);
    hash.update(fs.existsSync(absolute) ? fs.readFileSync(absolute) : '<absent>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function sourceCheck(
  projectRoot: string,
  inputs: SourceInputs,
  markerPath: string,
): FingerprintCheck {
  return checkFingerprintBaseline(markerPath, sourceFingerprint(projectRoot, inputs));
}

export function recordSourceBaseline(
  projectRoot: string,
  inputs: SourceInputs,
  markerPath: string,
  expectedFingerprint: string,
): boolean {
  return recordFingerprintBaseline(markerPath, expectedFingerprint, () =>
    sourceFingerprint(projectRoot, inputs),
  );
}

interface SourceStatus {
  head: Buffer;
  trackedChanges: boolean;
  untracked: string[];
}

// One fresh observation supplies HEAD and untracked paths. The canonical diff
// still binds tracked edits. Nested roots keep ls-files' cwd-relative paths;
// porcelain paths are always relative to the repository root.
function sourceStatus(projectRoot: string, paths: readonly string[]): SourceStatus | undefined {
  if (!fs.existsSync(path.join(projectRoot, '.git'))) return undefined;
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return undefined;
  let output: Buffer;
  try {
    output = git(projectRoot, [
      'status',
      '--porcelain=v2',
      '--branch',
      '--no-ahead-behind',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
      '--no-renames',
      '--',
      ...paths,
    ]);
  } catch (error) {
    // An unavailable or unborn repository keeps the existing fallback behavior.
    const status = (error as { status?: number }).status;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof status === 'number' || code === 'ENOENT') return undefined;
    throw error;
  }
  const text = output.toString('utf8');
  if (!Buffer.from(text).equals(output)) return undefined;
  let head: string | undefined;
  let trackedChanges = false;
  const untracked: string[] = [];
  for (const record of text.split('\0').filter(Boolean)) {
    if (record.startsWith('# branch.oid ')) head = record.slice(13);
    else if (record.startsWith('# ')) continue;
    else if (record.startsWith('? ')) untracked.push(record.slice(2));
    else if (record.startsWith('1 ') || record.startsWith('u ')) trackedChanges = true;
    else return undefined;
  }
  if (!head || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) return undefined;
  return { head: Buffer.from(`${head}\n`), trackedChanges, untracked: untracked.sort() };
}

function git(cwd: string, args: string[]): Buffer {
  return execFileSync(
    'git',
    [
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      ...args,
    ],
    {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'buffer',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
}

// null when the project is not a git checkout (or git is unavailable): the
// fingerprint then hashes the source paths directly.
function gitHead(cwd: string): Buffer | null {
  try {
    return git(cwd, ['rev-parse', 'HEAD']);
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof status === 'number' || code === 'ENOENT') return null;
    throw error;
  }
}

function hashPath(hash: ReturnType<typeof createHash>, root: string, relative: string): void {
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    hash.update(`absent\0${relative}\0`);
    return;
  }
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) {
    hash.update(`directory\0${relative}\0`);
    for (const child of fs.readdirSync(absolute).sort()) {
      hashPath(hash, root, path.join(relative, child));
    }
    return;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink\0${relative}\0${fs.readlinkSync(absolute)}\0`);
    return;
  }
  hash.update(`file\0${relative}\0`);
  hash.update(fs.readFileSync(absolute));
  hash.update('\0');
}
