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

/** What a caller already read from the project's work tree, so the fingerprint can reuse it. */
export interface SourceGitObservation {
  /** `git rev-parse HEAD` as printed: the commit and its newline. */
  head: string;
  /** `git status --porcelain=v1 --untracked-files=normal`, run at the project root. */
  status: string;
  /** Paths, relative to the root, the status left out. */
  excluded: readonly string[];
}

export function sourceFingerprint(
  projectRoot: string,
  inputs: SourceInputs,
  observed?: SourceGitObservation,
): string {
  const hash = createHash('sha256');
  const head = observed ? Buffer.from(observed.head) : gitHead(projectRoot);
  if (head === null) {
    hash.update('non-git\0');
    for (const relative of inputs.paths) {
      hashPath(hash, projectRoot, relative);
    }
  } else {
    hash.update(head);
    // A status that lists nothing under the source paths means their diff and
    // untracked listing are empty: the same bytes, without running git for them.
    const clean = observed !== undefined && !statusTouches(observed, inputs.paths);
    if (!clean) {
      hash.update(git(projectRoot, gitDiffArgs(['--binary', 'HEAD', '--', ...inputs.paths])));
    }
    const untracked = clean
      ? []
      : git(projectRoot, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
          '--',
          ...inputs.paths,
        ])
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

function git(cwd: string, args: string[]): Buffer {
  return execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// null when the project is not a git checkout (or git is unavailable): the
// fingerprint then hashes the source paths directly.
// Whether the status may name a change under the source paths. Anything it cannot
// read exactly (a quoted name, a rename, an excluded source path) counts as a change.
function statusTouches(observed: SourceGitObservation, paths: readonly string[]): boolean {
  const roots = paths.map((entry) => entry.replace(/\/+$/u, ''));
  if (roots.some((root) => root === '' || root === '.')) return observed.status.trim() !== '';
  const within = (name: string, root: string) => name === root || name.startsWith(`${root}/`);
  for (const excluded of observed.excluded) {
    if (roots.some((root) => within(root, excluded) || within(excluded, root))) return true;
  }
  for (const line of observed.status.split('\n')) {
    if (!line) continue;
    const name = line.slice(3);
    if (line[2] !== ' ' || name.startsWith('"') || name.includes(' -> ')) return true;
    const entry = name.replace(/\/$/u, '');
    // An untracked directory may hold a source path; a source directory may hold the entry.
    if (roots.some((root) => within(entry, root) || within(root, entry))) return true;
  }
  return false;
}

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
