import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

import {
  canonicalRecipeJson,
  isTaskDebriefRelativePath,
  reviewDiffHash,
  type ReviewDiffSnapshot,
  reviewSnapshotIdentityText,
  TASK_DIRECTORY_LAYOUT,
  type TaskDebriefCoverage,
  type TaskDebriefEvidenceReference,
} from '@farmslot/protocol';

export const debriefPath = TASK_DIRECTORY_LAYOUT.debrief.relativePath;
const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_DEBRIEF_BYTES = 4 * MAX_INPUT_BYTES;
const MAX_GIT_BYTES = 8 * MAX_INPUT_BYTES;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export type Source = TaskDebriefEvidenceReference['source'];

export interface Input {
  coverage: TaskDebriefCoverage;
  text?: string;
  json?: unknown;
}

export interface RetainedDebriefEvidence {
  runId: string;
  attemptId: string;
  manifestDigest: string;
  reportPath?: string;
  fileDigests: ReadonlyMap<string, string>;
  mirroredPaths?: ReadonlyMap<string, string>;
}

export function digestBytes(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digestDebriefValue(value: unknown): string {
  return digestBytes(canonicalRecipeJson(value));
}

export function missingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function evidencePath(root: string, relative: string): string {
  if (!isTaskDebriefRelativePath(relative)) throw new Error('Invalid task evidence path.');
  const parts = relative.split('/');
  let current = root;
  for (const [index, segment] of parts.entries()) {
    current = path.join(current, segment);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
        throw new Error('Task evidence path crosses a link or a non-directory.');
    } catch (error) {
      // Missing segments are permitted for a first write. Existing segments must be confined.
      if (!missingFile(error)) throw error;
    }
  }
  return current;
}

export function readBoundedFile(root: string, relative: string, cap = MAX_INPUT_BYTES): Buffer {
  const candidate = evidencePath(root, relative);
  const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const real = realpathSync(candidate);
    if (real !== candidate || !real.startsWith(root + path.sep))
      throw new Error('Task evidence path escaped its root.');
    const stat = fstatSync(fd);
    const current = lstatSync(candidate);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.isSymbolicLink())
      throw new Error('Task evidence path changed during the read.');
    if (!stat.isFile() || stat.size > cap)
      throw new Error('Task evidence exceeds its file limits.');
    const buffer = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== stat.size) throw new Error('Task evidence changed during the read.');
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

export function readInput(
  root: string,
  relative: string,
  asJson = false,
  retained?: RetainedDebriefEvidence,
): Input {
  const coverage: TaskDebriefCoverage = { status: 'unavailable', path: relative };
  const expectedDigest = retained?.fileDigests.get(relative);
  if (retained && !expectedDigest) return { coverage };
  try {
    const bytes = readBoundedFile(root, retained?.mirroredPaths?.get(relative) ?? relative);
    const sha256 = digestBytes(bytes);
    if (expectedDigest && sha256 !== expectedDigest)
      return { coverage: { ...coverage, status: 'invalid', sha256 } };
    coverage.sha256 = sha256;
    const text = UTF8.decode(bytes);
    const json: unknown = asJson ? JSON.parse(text) : undefined;
    return { coverage: { ...coverage, status: 'present' }, text, json };
  } catch (error) {
    // A missing input lowers coverage. Bad bytes, unsafe paths and failed reads are invalid.
    return { coverage: { ...coverage, status: missingFile(error) ? 'unavailable' : 'invalid' } };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function positiveStep(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function git(root: string, args: string[]) {
  return spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_BYTES,
    timeout: 5_000,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
      ),
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
  });
}

export function taskGitIdentity(root: string): { head: string; diffHash: string } | null {
  const identity = git(root, ['rev-parse', '--show-toplevel', 'HEAD', '--show-object-format']);
  if (identity.status === 128 && identity.stderr.includes('not a git repository')) return null;
  if (identity.error || identity.status !== 0)
    throw new Error('Cannot bind the task checkout HEAD.');
  const [checkout, head, algorithm] = identity.stdout.trimEnd().split('\n');
  if (
    !checkout ||
    !head ||
    !/^[a-f0-9]{40,64}$/u.test(head) ||
    (algorithm !== 'sha1' && algorithm !== 'sha256')
  )
    throw new Error('Invalid task checkout identity.');
  const excluded = `:(top,exclude,literal)${path.relative(checkout, path.join(root, debriefPath))}`;
  const diff = git(checkout, [
    '-c',
    'diff.orderFile=/dev/null',
    '-c',
    'core.quotePath=false',
    'diff',
    '--binary',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--diff-algorithm=myers',
    '--unified=3',
    '--find-renames=50%',
    '--submodule=short',
    '--ignore-submodules=none',
    head,
    '--',
    excluded,
  ]);
  if (diff.error || diff.status !== 0) throw new Error('Cannot bind the task checkout diff.');
  const listed = git(checkout, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    excluded,
  ]);
  if (listed.error || listed.status !== 0) throw new Error('Cannot bind untracked checkout files.');
  const paths = listed.stdout.split('\0').filter(Boolean).sort();
  if (paths.length > 4096) throw new Error('Too many untracked files for task checkout binding.');
  const files: NonNullable<ReviewDiffSnapshot['untrackedFiles']> = [];
  let remaining = MAX_GIT_BYTES;
  for (const relative of paths) {
    const parent = path.posix.dirname(relative);
    const directory = parent === '.' ? checkout : evidencePath(checkout, parent);
    if (realpathSync(directory) !== directory)
      throw new Error('Untracked checkout file escaped the repository.');
    const file = path.join(directory, path.posix.basename(relative));
    const stat = lstatSync(file);
    const mode = stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644';
    const bytes = stat.isSymbolicLink()
      ? readlinkSync(file, { encoding: 'buffer' })
      : readBoundedFile(checkout, relative, remaining);
    remaining -= bytes.length;
    if (remaining < 0) throw new Error('Untracked checkout files exceed the task binding limit.');
    const blobSha = createHash(algorithm)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest('hex');
    files.push({ path: relative, blobSha, mode });
  }
  return { head, diffHash: reviewDiffHash(reviewSnapshotIdentityText(diff.stdout, files)) };
}
