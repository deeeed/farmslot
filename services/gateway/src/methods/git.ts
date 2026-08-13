// methods/git.ts — git.status, git.diff, git.log, git.show, git.files, git.stage, git.unstage, git.discard

import type {
  BranchDiffStatus,
  CommandOutput,
  GitBranchDiffParams,
  GitBranchDiffResult,
  GitChange,
  GitChangeStatus,
  GitDiffParams,
  GitDiffResult,
  GitDiscardParams,
  GitFilesParams,
  GitFilesResult,
  GitLogParams,
  GitLogResult,
  GitShowParams,
  GitShowResult,
  GitStageParams,
  GitStatusParams,
  GitStatusResult,
  GitUnstageParams,
  OkResult,
} from '@farmslot/protocol';

import { execArgvOnSlot, loadSlotVars } from '../core/index.js';
import { loadPoolConfigs } from '../fleet/state.js';

async function resolveRepoPath(slotId: string): Promise<string> {
  const pools = await loadPoolConfigs();
  for (const pool of pools) {
    const slot = pool.slots.find((s) => s.id === slotId);
    if (slot) {
      if (!slot.repo) throw new Error(`No repo path configured for slot ${slotId}`);
      return slot.repo;
    }
  }
  throw new Error(`Slot ${slotId} not found in pool configs`);
}

/**
 * Run a git command for a slot — locally via execFile, or remotely via agent exec.
 */
export interface GitExecDeps {
  resolveRepo?: typeof resolveRepoPath;
  loadVars?: typeof loadSlotVars;
  runOnSlot?: typeof execArgvOnSlot;
}

export async function gitExec(
  slotId: string,
  args: string[],
  opts?: { maxBuffer?: number },
  deps: GitExecDeps = {},
): Promise<CommandOutput> {
  const repoPath = await (deps.resolveRepo ?? resolveRepoPath)(slotId);
  const slotVars = await (deps.loadVars ?? loadSlotVars)(slotId);
  const result = await (deps.runOnSlot ?? execArgvOnSlot)(slotVars, ['git', ...args], {
    cwd: repoPath,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const VALID_STATUSES: GitChangeStatus[] = ['M', 'A', 'D', '?', 'R'];
const BASE_REFRESH_TTL_MS = 15_000;
const baseRefreshCache = new Map<string, { expiresAt: number; refresh: Promise<void> }>();

export async function refreshRemoteBaseRef(
  slotId: string,
  remoteRef: string,
  deps: GitExecDeps = {},
): Promise<void> {
  const branch = remoteRef.startsWith('origin/') ? remoteRef.slice('origin/'.length) : remoteRef;
  const refreshBase = () =>
    gitExec(
      slotId,
      ['fetch', '--no-tags', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
      undefined,
      deps,
    ).then(() => undefined);
  if (Object.keys(deps).length > 0) {
    await refreshBase();
    return;
  }

  const now = Date.now();
  for (const [key, cached] of baseRefreshCache) {
    if (cached.expiresAt <= now) baseRefreshCache.delete(key);
  }
  const cacheKey = `${slotId}:origin/${branch}`;
  const cached = baseRefreshCache.get(cacheKey);
  if (cached) {
    await cached.refresh;
    return;
  }
  const refresh = refreshBase();
  baseRefreshCache.set(cacheKey, { expiresAt: now + BASE_REFRESH_TTL_MS, refresh });
  await refresh;
}

function toStatus(char: string): GitChangeStatus {
  return VALID_STATUSES.includes(char as GitChangeStatus) ? (char as GitChangeStatus) : 'M';
}

/**
 * Parse porcelain v1 status line into 0-2 GitChange entries.
 * Format: XY path  (where X=index/staged, Y=worktree/unstaged)
 * A file can appear in both staged and unstaged if partially staged.
 */
function parseStatusLine(line: string): GitChange[] {
  if (line.length < 4) return [];
  const x = line[0]; // index (staged) status
  const y = line[1]; // working tree (unstaged) status
  const rest = line.substring(3);
  const changes: GitChange[] = [];

  // Untracked files
  if (x === '?' && y === '?') {
    return [{ path: rest, status: '?', staged: false }];
  }

  // Renames: "R  old -> new"
  const isRenameStaged = x === 'R';
  const isRenameUnstaged = y === 'R';
  if (isRenameStaged || isRenameUnstaged) {
    const parts = rest.split(' -> ');
    const entry: GitChange = {
      path: parts[1] || rest,
      status: 'R',
      staged: isRenameStaged,
      oldPath: parts[0],
    };
    return [entry];
  }

  // Staged change (X column, not space/?)
  if (x !== ' ' && x !== '?') {
    changes.push({ path: rest, status: toStatus(x), staged: true });
  }

  // Unstaged change (Y column, not space/?)
  if (y !== ' ' && y !== '?') {
    changes.push({ path: rest, status: toStatus(y), staged: false });
  }

  return changes;
}

export async function gitStatus(
  params: GitStatusParams,
  deps: GitExecDeps = {},
): Promise<GitStatusResult> {
  // A successful status establishes that this is a readable repository. HEAD
  // may still be absent before its first commit, which is a valid workspace.
  const porcelainResult = await gitExec(
    params.slotId,
    ['status', '--porcelain=v1'],
    undefined,
    deps,
  );
  const [branchResult, headResult, aheadBehindResult] = await Promise.all([
    gitExec(params.slotId, ['branch', '--show-current'], undefined, deps),
    gitExec(params.slotId, ['rev-parse', '--verify', 'HEAD'], undefined, deps).catch(() => ({
      stdout: '',
      stderr: '',
    })),
    gitExec(
      params.slotId,
      ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
      undefined,
      deps,
    ).catch(() => ({
      stdout: '0\t0',
      stderr: '',
    })),
  ]);

  const branch = branchResult.stdout.trim();
  const headSha = headResult.stdout.trim();

  const parts = aheadBehindResult.stdout.trim().split('\t');
  const ahead = parseInt(parts[0], 10) || 0;
  const behind = parseInt(parts[1], 10) || 0;

  const changes: GitChange[] = [];
  for (const line of porcelainResult.stdout.split('\n')) {
    if (!line) continue;
    changes.push(...parseStatusLine(line));
  }

  return { branch, headSha, ahead, behind, changes };
}

async function resolveRemoteBaseRef(
  slotId: string,
  requestedBase: string,
  deps: GitExecDeps = {},
  options: { refresh: boolean } = { refresh: false },
): Promise<string> {
  const base = requestedBase.trim() || 'main';
  if (base.startsWith('refs/') || /^[0-9a-f]{7,40}$/i.test(base)) {
    await gitExec(slotId, ['rev-parse', '--verify', base], undefined, deps);
    return base;
  }
  const remoteRef = base.startsWith('origin/') ? base : `origin/${base}`;
  const branch = remoteRef.slice('origin/'.length);
  if (options.refresh) {
    // Branch inventory refreshes the PR base once. Per-file diff reads reuse
    // that ref instead of multiplying network fetches across an opened tree.
    // A missing network refresh is non-fatal when the remote-tracking ref is
    // already available; the verification/fallback below remains authoritative.
    await refreshRemoteBaseRef(slotId, remoteRef, deps).catch(() => undefined);
  }
  try {
    await gitExec(slotId, ['rev-parse', '--verify', remoteRef], undefined, deps);
    return remoteRef;
  } catch {
    // Offline/local-only worktrees may have no remote-tracking ref yet. The
    // named local branch is a safe read-only fallback for a per-file diff.
    await gitExec(slotId, ['rev-parse', '--verify', branch], undefined, deps);
    return branch;
  }
}

export async function gitDiff(
  params: GitDiffParams,
  deps: GitExecDeps = {},
): Promise<GitDiffResult> {
  const args = ['diff'];

  if (params.base) {
    // `git.diff` is also a public RPC/chat tool and cannot assume a preceding
    // branch-inventory request refreshed the PR base.
    const baseRef = await resolveRemoteBaseRef(params.slotId, params.base, deps, {
      refresh: true,
    });

    if (params.head) {
      if (params.target === 'worktree') {
        throw new Error('An exact review head cannot be combined with a worktree diff');
      }
      await gitExec(params.slotId, ['rev-parse', '--verify', params.head], undefined, deps);
      args.push(`${baseRef}...${params.head}`);
    } else {
      const { stdout: mergeBase } = await gitExec(
        params.slotId,
        ['merge-base', baseRef, 'HEAD'],
        undefined,
        deps,
      );
      // 'worktree' diffs merge-base against the working tree (committed +
      // uncommitted); default diffs committed history only.
      args.push(params.target === 'worktree' ? mergeBase.trim() : `${mergeBase.trim()}..HEAD`);
    }
  }

  if (params.path) {
    args.push('--', params.path);
    // A renamed file needs both sides in the limiter, or the diff degrades
    // to a plain add of the new path.
    if (params.oldPath && params.oldPath !== params.path) args.push(params.oldPath);
  }

  const { stdout } = await gitExec(params.slotId, args, { maxBuffer: 10 * 1024 * 1024 }, deps);
  return { diff: stdout };
}

export async function gitLog(params: GitLogParams): Promise<GitLogResult> {
  const limit = params.limit || 20;
  const { stdout } = await gitExec(params.slotId, [
    'log',
    `--max-count=${limit}`,
    '--format=%H|%s|%an|%aI',
  ]);

  const entries = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, message, author, date] = line.split('|');
      return { hash, message, author, date };
    });

  return { entries };
}

export async function gitShow(params: GitShowParams): Promise<GitShowResult> {
  const { stdout } = await gitExec(params.slotId, ['show', `${params.ref}:${params.path}`], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return { content: stdout };
}

export async function gitFiles(params: GitFilesParams): Promise<GitFilesResult> {
  const { stdout } = await gitExec(params.slotId, ['ls-files'], { maxBuffer: 10 * 1024 * 1024 });
  const files = stdout.trim().split('\n').filter(Boolean);
  return { files };
}

export async function gitStage(params: GitStageParams): Promise<OkResult> {
  await gitExec(params.slotId, ['add', '--', params.path]);
  return { ok: true };
}

export async function gitUnstage(params: GitUnstageParams): Promise<OkResult> {
  await gitExec(params.slotId, ['reset', 'HEAD', '--', params.path]);
  return { ok: true };
}

export async function gitDiscard(params: GitDiscardParams): Promise<OkResult> {
  await gitExec(params.slotId, ['checkout', '--', params.path]);
  return { ok: true };
}

/**
 * Normalize a `--numstat` rename path ("old => new" or "pre/{old => new}/post")
 * to the new path. Git quotes pathological names (tabs, braces) in C-style
 * quoting, which never matches these patterns — such rows pass through raw,
 * matching the pre-rename behavior.
 */
export function numstatNewPath(raw: string): string {
  const braced = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braced) return `${braced[1]}${braced[3]}${braced[4]}`;
  const plain = raw.match(/^(.*) => (.*)$/);
  if (plain) return plain[2];
  return raw;
}

const VALID_BRANCH_DIFF_STATUSES: BranchDiffStatus[] = ['M', 'A', 'D', 'R'];

function toBranchDiffStatus(char: string): BranchDiffStatus {
  return VALID_BRANCH_DIFF_STATUSES.includes(char as BranchDiffStatus)
    ? (char as BranchDiffStatus)
    : 'M';
}

export async function gitBranchDiff(
  params: GitBranchDiffParams,
  deps: GitExecDeps = {},
): Promise<GitBranchDiffResult> {
  const base = params.base || 'main';
  const baseRef = await resolveRemoteBaseRef(params.slotId, base, deps, {
    refresh: !params.head,
  });

  if (params.head && params.target === 'worktree') {
    throw new Error('An exact review head cannot be combined with a worktree diff');
  }
  const [mergeBaseResult, branchResult] = await Promise.all([
    params.head
      ? gitExec(params.slotId, ['rev-parse', '--verify', params.head], undefined, deps)
      : gitExec(params.slotId, ['merge-base', baseRef, 'HEAD'], undefined, deps),
    gitExec(params.slotId, ['branch', '--show-current'], undefined, deps),
  ]);

  const mergeBase = mergeBaseResult.stdout.trim();
  const head = params.head ? mergeBase : branchResult.stdout.trim();
  // 'worktree' diffs the merge-base against the working tree — every change
  // on the branch (committed + uncommitted), deduped per file by git itself.
  // Default compares committed history only (what a PR would contain).
  const worktree = params.target === 'worktree';
  const diffRange = params.head
    ? `${baseRef}...${mergeBase}`
    : worktree
      ? mergeBase
      : `${mergeBase}..HEAD`;

  const [nameStatusResult, numstatResult, untrackedResult, committedResult] = await Promise.all([
    gitExec(
      params.slotId,
      ['diff', '--name-status', diffRange],
      { maxBuffer: 10 * 1024 * 1024 },
      deps,
    ),
    gitExec(params.slotId, ['diff', '--numstat', diffRange], { maxBuffer: 10 * 1024 * 1024 }, deps),
    worktree
      ? gitExec(
          params.slotId,
          ['ls-files', '--others', '--exclude-standard'],
          { maxBuffer: 10 * 1024 * 1024 },
          deps,
        )
      : Promise.resolve({ stdout: '', stderr: '' }),
    // Worktree mode also lists the committed-only set so each file can carry
    // a committed flag (committed vs purely-local is invisible in a
    // merge-base→worktree diff alone).
    worktree
      ? gitExec(
          params.slotId,
          ['diff', '--name-status', `${mergeBase}..HEAD`],
          { maxBuffer: 10 * 1024 * 1024 },
          deps,
        )
      : Promise.resolve({ stdout: '', stderr: '' }),
  ]);

  // Parse --numstat: "additions\tdeletions\tpath". Rename rows format the
  // path as "old => new" or "prefix/{old => new}/suffix" — normalize to the
  // new path so the --name-status lookup (which uses newPath) finds counts.
  const statMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatResult.stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const add = parseInt(parts[0], 10) || 0;
      const del = parseInt(parts[1], 10) || 0;
      const path = numstatNewPath(parts.slice(2).join('\t'));
      statMap.set(path, { additions: add, deletions: del });
    }
  }

  // Parse --name-status: "STATUS\tpath" or "R###\toldpath\tnewpath"
  const files: GitBranchDiffResult['files'] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of nameStatusResult.stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const statusStr = parts[0];
    const statusChar = statusStr[0]; // R100 → R

    if (statusChar === 'R' && parts.length >= 3) {
      const oldPath = parts[1];
      const newPath = parts[2];
      const stats = statMap.get(newPath) ?? { additions: 0, deletions: 0 };
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
      files.push({
        path: newPath,
        status: 'R',
        oldPath,
        additions: stats.additions,
        deletions: stats.deletions,
      });
    } else if (parts.length >= 2) {
      const path = parts[1];
      const stats = statMap.get(path) ?? { additions: 0, deletions: 0 };
      totalAdditions += stats.additions;
      totalDeletions += stats.deletions;
      files.push({
        path,
        status: toBranchDiffStatus(statusChar),
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }
  }

  // Untracked files are invisible to `git diff` but are part of "every change
  // vs base" in worktree mode. Counts stay 0 — reading each file to count
  // lines is not worth the exec fan-out.
  const seen = new Set(files.map((f) => f.path));
  for (const path of untrackedResult.stdout.split('\n')) {
    if (!path || seen.has(path)) continue;
    files.push({ path, status: 'A', additions: 0, deletions: 0 });
  }

  if (worktree) {
    const committedPaths = new Set<string>();
    for (const line of committedResult.stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      // "STATUS\tpath" or "R###\told\tnew" — the new path is the identity.
      if (parts.length >= 2) committedPaths.add(parts[parts.length - 1]);
    }
    for (const file of files) {
      // A worktree rename lists the file under its new path while the
      // committed set may know it by the old one — either match counts.
      file.committed =
        committedPaths.has(file.path) ||
        (file.oldPath !== undefined && committedPaths.has(file.oldPath));
    }
  }

  return { base, head, files, totalAdditions, totalDeletions };
}
