// Fingerprint of the app source a running bundle was built from. In a git
// checkout it is HEAD plus the diff and untracked files under the source paths;
// outside git it hashes the paths themselves. Env files always count. The
// project supplies both lists.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  const head = gitHead(projectRoot);
  if (head === null) {
    hash.update('non-git\0');
    for (const relative of inputs.paths) {
      hashPath(hash, projectRoot, relative);
    }
  } else {
    hash.update(head);
    hash.update(
      git(projectRoot, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', ...inputs.paths]),
    );

    const untracked = git(projectRoot, [
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
