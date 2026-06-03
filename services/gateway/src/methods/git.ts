// methods/git.ts — git.status, git.diff, git.log, git.show, git.files, git.stage, git.unstage, git.discard

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

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

import { getSlotLocality, nodeExec } from '../fleet/node-rpc.js';
import { loadPoolConfigs } from '../fleet/state.js';

const execFile = promisify(execFileCb);

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
async function gitExec(
  slotId: string,
  args: string[],
  opts?: { maxBuffer?: number },
): Promise<CommandOutput> {
  const repoPath = await resolveRepoPath(slotId);
  const { isLocal, machine } = await getSlotLocality(slotId);

  if (isLocal) {
    return execFile('git', args, { cwd: repoPath, maxBuffer: opts?.maxBuffer ?? 1024 * 1024 });
  }

  // Remote: run via agent exec
  const cmd = `git ${args.map((a) => (a.includes(' ') || a.includes('|') ? `'${a}'` : a)).join(' ')}`;
  const result = await nodeExec(machine, cmd, repoPath);
  if (result.exitCode !== 0 && result.stderr) {
    throw new Error(result.stderr.trim());
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

const VALID_STATUSES: GitChangeStatus[] = ['M', 'A', 'D', '?', 'R'];

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

export async function gitStatus(params: GitStatusParams): Promise<GitStatusResult> {
  const [porcelainResult, branchResult, aheadBehindResult] = await Promise.all([
    gitExec(params.slotId, ['status', '--porcelain=v1']),
    gitExec(params.slotId, ['branch', '--show-current']),
    gitExec(params.slotId, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => ({
      stdout: '0\t0',
      stderr: '',
    })),
  ]);

  const branch = branchResult.stdout.trim();

  const parts = aheadBehindResult.stdout.trim().split('\t');
  const ahead = parseInt(parts[0], 10) || 0;
  const behind = parseInt(parts[1], 10) || 0;

  const changes: GitChange[] = [];
  for (const line of porcelainResult.stdout.split('\n')) {
    if (!line) continue;
    changes.push(...parseStatusLine(line));
  }

  return { branch, ahead, behind, changes };
}

export async function gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
  const args = ['diff'];

  if (params.base) {
    let baseRef = params.base;
    try {
      await gitExec(params.slotId, ['rev-parse', '--verify', `origin/${params.base}`]);
      baseRef = `origin/${params.base}`;
    } catch {
      /* use local ref */
    }

    const { stdout: mergeBase } = await gitExec(params.slotId, ['merge-base', baseRef, 'HEAD']);
    args.push(`${mergeBase.trim()}..HEAD`);
  }

  if (params.path) args.push('--', params.path);

  const { stdout } = await gitExec(params.slotId, args, { maxBuffer: 10 * 1024 * 1024 });
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

const VALID_BRANCH_DIFF_STATUSES: BranchDiffStatus[] = ['M', 'A', 'D', 'R'];

function toBranchDiffStatus(char: string): BranchDiffStatus {
  return VALID_BRANCH_DIFF_STATUSES.includes(char as BranchDiffStatus)
    ? (char as BranchDiffStatus)
    : 'M';
}

export async function gitBranchDiff(params: GitBranchDiffParams): Promise<GitBranchDiffResult> {
  const base = params.base || 'main';

  let baseRef = base;
  try {
    await gitExec(params.slotId, ['rev-parse', '--verify', `origin/${base}`]);
    baseRef = `origin/${base}`;
  } catch {
    /* use local ref */
  }

  const [mergeBaseResult, branchResult] = await Promise.all([
    gitExec(params.slotId, ['merge-base', baseRef, 'HEAD']),
    gitExec(params.slotId, ['branch', '--show-current']),
  ]);

  const mergeBase = mergeBaseResult.stdout.trim();
  const head = branchResult.stdout.trim();
  const diffRange = `${mergeBase}..HEAD`;

  const [nameStatusResult, numstatResult] = await Promise.all([
    gitExec(params.slotId, ['diff', '--name-status', diffRange], { maxBuffer: 10 * 1024 * 1024 }),
    gitExec(params.slotId, ['diff', '--numstat', diffRange], { maxBuffer: 10 * 1024 * 1024 }),
  ]);

  // Parse --numstat: "additions\tdeletions\tpath"
  const statMap = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstatResult.stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const add = parseInt(parts[0], 10) || 0;
      const del = parseInt(parts[1], 10) || 0;
      // For renames, numstat shows "old => new" or just the new path
      const path = parts.slice(2).join('\t');
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

  return { base, head, files, totalAdditions, totalDeletions };
}
