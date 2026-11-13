// git-read — the harness's read-only Git: every command runs with the farm's
// settings (no automatic gc or maintenance, no hooks or fsmonitor, no optional
// index locks), facts that cannot change within a command are read once, and
// HEAD comes from the repository's files when they answer it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { countCallWork } from './call-timings.js';

// The farm's Git rules (the gateway's farm-git and review-workspace inspection apply them too).
const FARM_GIT_CONFIG = [
  'gc.auto=0',
  'maintenance.auto=false',
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
];

export function gitReadArgs(args: readonly string[]): string[] {
  return [...FARM_GIT_CONFIG.flatMap((setting) => ['-c', setting]), ...args];
}

export function gitReadEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_OPTIONAL_LOCKS: '0' };
}

/** Run one read-only Git command in `cwd`; throws like execFileSync on a non-zero exit. */
export function readGit(cwd: string, args: readonly string[]): Buffer {
  countCallWork('git');
  return execFileSync('git', gitReadArgs(args), {
    cwd,
    env: gitReadEnv(),
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

const topLevels = new Map<string, string | null>();

/** The real path of the Git work tree `dir` is in, or undefined outside one; read once per process. */
export function gitTopLevel(dir: string): string | undefined {
  const key = path.resolve(dir);
  if (!topLevels.has(key)) {
    let topLevel: string | null = null;
    try {
      const output = readGit(key, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
      topLevel = output ? fs.realpathSync(output) : null;
    } catch (error) {
      // Not inside a work tree (git exits 128), or no git at all: the directory answers for itself.
      if (!isGitRefusal(error)) throw error;
    }
    topLevels.set(key, topLevel);
  }
  return topLevels.get(key) ?? undefined;
}

const origins = new Map<string, string>();

/** The checkout's origin URL, or '' when it is not a Git checkout or has none; read once per process. */
export function gitOriginUrl(dir: string): string {
  const key = path.resolve(dir);
  if (!origins.has(key)) {
    let origin = '';
    try {
      origin = readGit(key, ['config', '--get', 'remote.origin.url']).toString('utf8').trim();
    } catch (error) {
      // No origin (git config exits 1), not a checkout, or no git: only the file checks apply.
      if (!isGitRefusal(error)) throw error;
    }
    origins.set(key, origin);
  }
  return origins.get(key) ?? '';
}

function isGitRefusal(error: unknown): boolean {
  const { status, code } = error as { status?: number | null; code?: string };
  return typeof status === 'number' || code === 'ENOENT';
}

/**
 * The commit HEAD names, read from the repository's files: a detached HEAD, or a
 * branch's loose or packed ref. Undefined when the files do not answer it (an
 * unborn branch, a symbolic ref chain, another ref store); `git rev-parse` decides then.
 */
export function readHeadCommit(topLevel: string): string | undefined {
  const gitDir = repositoryDir(topLevel);
  if (!gitDir) return undefined;
  const commonDir = readText(path.join(gitDir, 'commondir'));
  const shared = commonDir ? path.resolve(gitDir, commonDir.trim()) : gitDir;
  const head = readText(path.join(gitDir, 'HEAD'))?.trim();
  if (!head) return undefined;
  if (!head.startsWith('ref: ')) return isCommitId(head) ? head : undefined;
  const ref = head.slice('ref: '.length).trim();
  if (!ref.startsWith('refs/') || ref.split('/').includes('..')) return undefined;
  for (const dir of [gitDir, shared]) {
    const loose = readText(path.join(dir, ref))?.trim();
    if (loose !== undefined) return isCommitId(loose) ? loose : undefined;
  }
  const packed = readText(path.join(shared, 'packed-refs'));
  for (const line of packed?.split('\n') ?? []) {
    const [id, name] = line.trim().split(' ');
    if (name === ref) return id && isCommitId(id) ? id : undefined;
  }
  return undefined;
}

function repositoryDir(topLevel: string): string | undefined {
  const dotGit = path.join(topLevel, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isDirectory()) return dotGit;
  // A linked worktree or submodule: `.git` is a file naming the repository directory.
  const pointer = readText(dotGit)
    ?.match(/^gitdir: (.+)$/mu)?.[1]
    ?.trim();
  return pointer ? path.resolve(topLevel, pointer) : undefined;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    throw error;
  }
}

function isCommitId(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}
