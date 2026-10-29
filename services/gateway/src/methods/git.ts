// methods/git.ts — git.status, git.diff, git.log, git.show, git.files, git.stage, git.unstage, git.discard
import { GIT_DIFF_COMMAND, gitDiffArgs } from '@farmslot/agent-runtime/scripts/git-diff.cjs';
import {
  type BranchDiffStatus,
  classifyDiffFile,
  type CommandOutput,
  compileTestFileMatcher,
  type GitBranchDiffParams,
  type GitBranchDiffResult,
  type GitChange,
  type GitChangeStatus,
  type GitDiffParams,
  type GitDiffResult,
  type GitDiscardParams,
  type GitFilesParams,
  type GitFilesResult,
  type GitLogParams,
  type GitLogResult,
  type GitShowBatchEntry,
  type GitShowBatchParams,
  type GitShowBatchResult,
  type GitShowParams,
  type GitShowResult,
  type GitStageParams,
  type GitStatusParams,
  type GitStatusResult,
  type GitUnstageParams,
  type OkResult,
  resolveTestFilePatterns,
} from '@farmslot/protocol';

import {
  execArgvOnSlot,
  getProjectFieldRaw,
  isLocal,
  loadSlotVars,
  type RawProjectJson,
} from '../core/index.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { isWorkspaceObservedRead } from '../resources/workspace-read.js';
import { workspaceReviewGit } from '../review-workspaces/git.js';
import { loadProjectVarsOrNull } from '../run-engine/project-vars.js';
import { getRunWithArchived } from '../runs/store.js';

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
  runCommand?: (args: string[]) => Promise<CommandOutput>;
  resolveRepo?: typeof resolveRepoPath;
  loadVars?: typeof loadSlotVars;
  /** Project config for diff-view test patterns; null falls back to the defaults. */
  loadProjectJson?: (project: string) => Promise<RawProjectJson | null>;
  runOnSlot?: typeof execArgvOnSlot;
  /** Git with stdin `input`; stdout leaves the host process as base64 and returns as raw bytes. */
  runBytes?: (args: string[], input: string, maxBuffer: number) => Promise<Buffer>;
}

export async function gitExec(
  slotId: string,
  args: string[],
  opts?: { maxBuffer?: number },
  deps: GitExecDeps = {},
): Promise<CommandOutput> {
  if (deps.runCommand) return deps.runCommand(args);
  const repoPath = await (deps.resolveRepo ?? resolveRepoPath)(slotId);
  const slotVars = await (deps.loadVars ?? loadSlotVars)(slotId);
  const result = await (deps.runOnSlot ?? execArgvOnSlot)(
    slotVars,
    [
      'git',
      // Status normally refreshes index stat metadata. An observed read must not
      // invalidate its own filesystem source by taking that optional write lock.
      ...(isWorkspaceObservedRead() ? ['--no-optional-locks'] : []),
      ...(args[0] === 'diff' ? gitDiffArgs(args.slice(1)) : args),
    ],
    {
      cwd: repoPath,
      maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

// Exec paths decode stdout as text, so raw bytes leave the slot's host as base64.
const HOST_GIT_BYTES = `const cp=require('node:child_process');const p=JSON.parse(process.argv[1]);
const r=cp.spawnSync('git',p.args,{input:p.input,maxBuffer:p.maxBuffer});
if(r.error)throw r.error;process.stdout.write(r.stdout.toString('base64'));process.stderr.write(r.stderr);process.exitCode=r.status??1;`;

async function gitBytes(
  slotId: string,
  args: string[],
  input: string,
  maxBuffer: number,
  deps: GitExecDeps,
): Promise<Buffer> {
  if (deps.runBytes) return deps.runBytes(args, input, maxBuffer);
  const repoPath = await (deps.resolveRepo ?? resolveRepoPath)(slotId);
  const slotVars = await (deps.loadVars ?? loadSlotVars)(slotId);
  const node = isLocal(slotVars.host, slotVars.machine) ? process.execPath : 'node';
  const result = await (deps.runOnSlot ?? execArgvOnSlot)(
    slotVars,
    [node, '-e', HOST_GIT_BYTES, JSON.stringify({ args, input, maxBuffer })],
    { cwd: repoPath, maxBuffer: Math.ceil(maxBuffer / 3) * 4 + 64 * 1024 },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode}`);
  }
  return Buffer.from(result.stdout, 'base64');
}

/** Untracked diff text stays under the exec cap; files past it are listed without content. */
const UNTRACKED_DIFF_BUDGET = 8 * 1024 * 1024;

// Git lists a file over core.bigFileThreshold as a binary new file without reading
// it, so a file that does not fit the remaining budget is listed exactly that way.
const NEW_FILE_DIFF = GIT_DIFF_COMMAND.replace(/^git /, () => 'git -c core.bigFileThreshold="$1" ');

// Untracked files diff as new files. `--no-index` exits 1 when the sides differ.
const UNTRACKED_DIFF_SCRIPT = [
  'set -euo pipefail',
  'budget=$1',
  'shift',
  'tmp=$(mktemp "${TMPDIR:-/tmp}/farmslot-untracked.XXXXXX")',
  `trap 'rm -f "$tmp"' EXIT`,
  `new_file_diff() { ${NEW_FILE_DIFF} --full-index --no-index -- /dev/null "$file" > "$tmp" || [ $? -eq 1 ]; }`,
  `git -c core.quotePath=false ls-files --others --exclude-standard -z -- "$@" | while IFS= read -r -d '' file; do`,
  '  [ -f "$file" ] || continue',
  '  if [ "$budget" -gt 1 ]; then new_file_diff "$budget"; fi',
  '  if [ "$budget" -le 1 ] || [ $(($(wc -c < "$tmp"))) -gt "$budget" ]; then new_file_diff 1; fi',
  '  budget=$((budget - $(wc -c < "$tmp")))',
  '  cat "$tmp"',
  'done',
].join('\n');

async function gitUntrackedDiff(
  slotId: string,
  path: string | undefined,
  deps: GitExecDeps,
): Promise<string> {
  const repoPath = await (deps.resolveRepo ?? resolveRepoPath)(slotId);
  const slotVars = await (deps.loadVars ?? loadSlotVars)(slotId);
  const result = await (deps.runOnSlot ?? execArgvOnSlot)(
    slotVars,
    [
      'bash',
      '-c',
      UNTRACKED_DIFF_SCRIPT,
      'git-untracked-diff',
      String(UNTRACKED_DIFF_BUDGET),
      ...(path ? [path] : []),
    ],
    { cwd: repoPath, maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git exited with code ${result.exitCode}`);
  }
  return result.stdout;
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
  if (/^[0-9a-f]{7,40}$/i.test(base)) {
    await ensureReviewCommitAvailable(slotId, base, deps);
    return base;
  }
  if (base.startsWith('refs/')) {
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

async function ensureReviewCommitAvailable(
  slotId: string,
  commit: string,
  deps: GitExecDeps,
): Promise<CommandOutput> {
  const commitRef = `${commit}^{commit}`;
  try {
    return await gitExec(slotId, ['rev-parse', '--verify', commitRef], undefined, deps);
  } catch (verificationError) {
    if (!/^[0-9a-f]{40}$/i.test(commit)) throw verificationError;
  }

  try {
    // Exact review snapshots can outlive the slot branch that originally fetched
    // them. Fetching by immutable SHA restores the object without moving a branch
    // or changing the worktree.
    await gitExec(slotId, ['fetch', '--no-tags', 'origin', commit], undefined, deps);
    return await gitExec(slotId, ['rev-parse', '--verify', commitRef], undefined, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Review commit ${commit} is unavailable after fetch: ${message}`);
  }
}

function remoteHistoryRef(ref: string): string {
  if (ref.startsWith('origin/')) return `refs/heads/${ref.slice('origin/'.length)}`;
  if (ref.startsWith('refs/remotes/origin/')) {
    return `refs/heads/${ref.slice('refs/remotes/origin/'.length)}`;
  }
  return ref;
}

async function ensureExactReviewRangeAvailable(
  slotId: string,
  base: string,
  head: string,
  deps: GitExecDeps,
): Promise<CommandOutput> {
  const headResult = await ensureReviewCommitAvailable(slotId, head, deps);
  try {
    await gitExec(slotId, ['merge-base', base, head], undefined, deps);
    return headResult;
  } catch (mergeBaseError) {
    const { stdout: shallow } = await gitExec(
      slotId,
      ['rev-parse', '--is-shallow-repository'],
      undefined,
      deps,
    );
    if (shallow.trim() !== 'true') throw mergeBaseError;
  }

  let fetchError: unknown;
  try {
    // A shallow repository can contain both snapshot tips while still hiding
    // their common ancestor. Restore only the histories reachable from the
    // frozen range, without moving a branch or changing the worktree.
    await gitExec(
      slotId,
      [
        'fetch',
        '--no-tags',
        '--unshallow',
        'origin',
        remoteHistoryRef(base),
        remoteHistoryRef(head),
      ],
      undefined,
      deps,
    );
  } catch (error) {
    // Another exact-diff request may have completed the same unshallow fetch.
    // The merge-base check below decides whether that race recovered the range.
    fetchError = error;
  }

  try {
    await gitExec(slotId, ['merge-base', base, head], undefined, deps);
    return headResult;
  } catch (error) {
    const cause = fetchError ?? error;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Review range ${base}...${head} has no merge base after fetch: ${message}`);
  }
}

export async function gitDiff(
  params: GitDiffParams,
  deps: GitExecDeps = {},
): Promise<GitDiffResult> {
  // Explicit fields: client params must not reach workspaceReviewGit options.
  if (params.runId)
    deps = await workspaceReviewGit({
      runId: params.runId,
      slotId: params.slotId,
      base: params.base,
      head: params.head,
      target: params.target,
    });
  if (params.head && !params.base) {
    throw new Error('An exact review head requires a base ref');
  }
  if (params.includeUntracked && params.target !== 'worktree') {
    throw new Error('includeUntracked requires a worktree diff');
  }
  // Full blob ids let clients map each path to content they hold offline.
  const args = ['diff', '--full-index'];
  let commits: Pick<GitDiffResult, 'mergeBaseSha' | 'headSha'> = {};

  if (params.base) {
    // `git.diff` is also a public RPC/chat tool and cannot assume a preceding
    // branch-inventory request refreshed the PR base.
    const baseRef = await resolveRemoteBaseRef(params.slotId, params.base, deps, {
      refresh: !isWorkspaceObservedRead(),
    });

    if (params.head) {
      if (params.target === 'worktree') {
        throw new Error('An exact review head cannot be combined with a worktree diff');
      }
      const headResult = await ensureExactReviewRangeAvailable(
        params.slotId,
        baseRef,
        params.head,
        deps,
      );
      const { stdout: mergeBase } = await gitExec(
        params.slotId,
        ['merge-base', baseRef, params.head],
        undefined,
        deps,
      );
      commits = { mergeBaseSha: mergeBase.trim(), headSha: headResult.stdout.trim() };
      args.push(`${baseRef}...${params.head}`);
    } else {
      // Pin HEAD once so the reported commits are the ones diffed.
      const { stdout: head } = await gitExec(
        params.slotId,
        ['rev-parse', '--verify', 'HEAD^{commit}'],
        undefined,
        deps,
      );
      const headSha = head.trim();
      const { stdout: mergeBase } = await gitExec(
        params.slotId,
        ['merge-base', baseRef, headSha],
        undefined,
        deps,
      );
      const mergeBaseSha = mergeBase.trim();
      commits = { mergeBaseSha, headSha };
      // 'worktree' diffs merge-base against the working tree (committed +
      // uncommitted); default diffs committed history only.
      args.push(params.target === 'worktree' ? mergeBaseSha : `${mergeBaseSha}..${headSha}`);
    }
  }

  if (params.path) {
    args.push('--', params.path);
    // A renamed file needs both sides in the limiter, or the diff degrades
    // to a plain add of the new path.
    if (params.oldPath && params.oldPath !== params.path) args.push(params.oldPath);
  }

  const { stdout } = await gitExec(params.slotId, args, { maxBuffer: 10 * 1024 * 1024 }, deps);
  const untracked = params.includeUntracked
    ? await gitUntrackedDiff(params.slotId, params.path, deps)
    : '';
  return { diff: stdout + untracked, ...commits };
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

export async function gitShow(
  params: GitShowParams,
  deps: GitExecDeps = {},
): Promise<GitShowResult> {
  if (params.runId)
    deps = await workspaceReviewGit({
      runId: params.runId,
      slotId: params.slotId,
      ref: params.ref,
    });
  // Show the resolved object so the content is exactly the object `id` names.
  const { stdout: object } = await gitExec(
    params.slotId,
    ['rev-parse', '--verify', `${params.ref}:${params.path}`],
    undefined,
    deps,
  );
  const id = object.trim();
  const { stdout } = await gitExec(
    params.slotId,
    ['show', id],
    {
      maxBuffer: 10 * 1024 * 1024,
    },
    deps,
  );
  return { content: stdout, id };
}

const MB = 1024 * 1024;
/** A batched page never carries more than one `git.show` may return. */
const MAX_SHOW_PAGE_BYTES = 10 * MB;
/** Host commands take their object list as one argv element, which Linux caps at 128 KiB. */
const MAX_SHOW_INPUT_BYTES = 64 * 1024;

function pageLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function gitShowBatch(
  params: GitShowBatchParams,
  deps: GitExecDeps = {},
): Promise<GitShowBatchResult> {
  const { ref } = params;
  if (params.runId)
    deps = await workspaceReviewGit({
      runId: params.runId,
      slotId: params.slotId,
      ref,
      mergeBaseRef: true,
    });
  if ((params as { path?: unknown }).path !== undefined)
    throw new Error('git.show takes path or paths, not both');
  if (!Array.isArray(params.paths) || params.paths.length === 0)
    throw new Error('git.show paths must list at least one path');
  // Object names travel one per line to `git cat-file`.
  if ([ref, ...params.paths].some((name) => typeof name !== 'string' || /[\n\r\0]/.test(name)))
    throw new Error('git.show ref and paths must be single-line strings');
  const paths = [...new Set(params.paths)];
  const maxBytes = Math.min(pageLimit(params.maxBytes, 4 * MB, 'maxBytes'), MAX_SHOW_PAGE_BYTES);
  // A file larger than a page could never be returned, so it is too large as well.
  const maxFileBytes = Math.min(pageLimit(params.maxFileBytes, MB, 'maxFileBytes'), maxBytes);
  let start = 0;
  if (params.after !== undefined) {
    start = paths.indexOf(params.after) + 1;
    if (start === 0 || start === paths.length) throw new Error('Unknown git.show cursor');
  }

  const batch: string[] = [];
  let inputBytes = 0;
  for (const path of paths.slice(start)) {
    inputBytes += Buffer.byteLength(JSON.stringify(`${ref}:${path}\n`));
    if (batch.length > 0 && inputBytes > MAX_SHOW_INPUT_BYTES) break;
    batch.push(path);
  }
  const names = [`${ref}^{commit}`, ...batch.map((path) => `${ref}:${path}`)];
  const checkInput = `${names.join('\n')}\n`;
  const checked = (
    await gitBytes(
      params.slotId,
      ['cat-file', '--batch-check'],
      checkInput,
      Buffer.byteLength(checkInput) + 128 * names.length,
      deps,
    )
  )
    .toString()
    .split('\n');
  if (!/^[0-9a-f]+ commit \d+$/.test(checked[0])) throw new Error(`Unknown commit ${ref}`);

  const have = new Set(params.have ?? []);
  const entries: GitShowBatchEntry[] = [];
  let pageBytes = 0;
  for (const [index, path] of batch.entries()) {
    // Missing and ambiguous names echo the request instead of an object line.
    const object = /^([0-9a-f]+) (\S+) (\d+)$/.exec(checked[index + 1] ?? '');
    if (!object) {
      entries.push({ path, status: 'missing' });
      continue;
    }
    const [, id, type, sizeText] = object;
    const size = Number(sizeText);
    if (type !== 'blob') entries.push({ path, status: 'not-blob', id });
    else if (have.has(id)) entries.push({ path, status: 'held', id, size });
    else if (size > maxFileBytes) entries.push({ path, status: 'too-large', id, size });
    else if (entries.length > 0 && pageBytes + size > maxBytes) break;
    else {
      pageBytes += size;
      entries.push({ path, status: 'ok', id, size });
    }
  }

  const wanted = entries.filter((entry) => entry.status === 'ok');
  if (wanted.length > 0) {
    const stream = await gitBytes(
      params.slotId,
      ['cat-file', '--batch'],
      `${wanted.map((entry) => entry.id).join('\n')}\n`,
      pageBytes + 128 * wanted.length,
      deps,
    );
    let offset = 0;
    for (const entry of wanted) {
      const headerEnd = stream.indexOf(0x0a, offset);
      const end = headerEnd + 1 + entry.size!;
      if (
        headerEnd < 0 ||
        stream.toString('latin1', offset, headerEnd) !== `${entry.id} blob ${entry.size}` ||
        stream[end] !== 0x0a
      )
        throw new Error(`git.show could not read ${entry.path}`);
      entry.content = stream.subarray(headerEnd + 1, end).toString('base64');
      offset = end + 1;
    }
  }
  return {
    entries,
    cursor: entries[entries.length - 1].path,
    hasMore: start + entries.length < paths.length,
  };
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
  if (params.runId)
    deps = await workspaceReviewGit({
      runId: params.runId,
      slotId: params.slotId,
      base: params.base,
      head: params.head,
      target: params.target,
    });
  if (params.head && !params.base) {
    throw new Error('An exact review head requires a base ref');
  }
  const base = params.base || 'main';
  const baseRef = await resolveRemoteBaseRef(params.slotId, base, deps, {
    refresh: !params.head && !isWorkspaceObservedRead(),
  });

  if (params.head && params.target === 'worktree') {
    throw new Error('An exact review head cannot be combined with a worktree diff');
  }
  const [diffAnchorResult, branchResult] = await Promise.all([
    params.head
      ? ensureExactReviewRangeAvailable(params.slotId, baseRef, params.head, deps)
      : gitExec(params.slotId, ['merge-base', baseRef, 'HEAD'], undefined, deps),
    gitExec(params.slotId, ['branch', '--show-current'], undefined, deps),
  ]);

  const diffAnchor = diffAnchorResult.stdout.trim();
  const head = params.head ? diffAnchor : branchResult.stdout.trim();
  // 'worktree' diffs the merge-base against the working tree — every change
  // on the branch (committed + uncommitted), deduped per file by git itself.
  // Default compares committed history only (what a PR would contain).
  const worktree = params.target === 'worktree';
  const diffRange = params.head
    ? `${baseRef}...${diffAnchor}`
    : worktree
      ? diffAnchor
      : `${diffAnchor}..HEAD`;

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
          ['diff', '--name-status', `${diffAnchor}..HEAD`],
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

  const testFilePatterns = [...(await diffViewTestPatterns(params, deps))];
  const isTestFile = compileTestFileMatcher(testFilePatterns);
  for (const file of files) file.kind = classifyDiffFile(file.path, isTestFile);

  return { base, head, files, totalAdditions, totalDeletions, testFilePatterns };
}

/** Project `diff_view` test globs for this diff's repo, on top of the defaults. */
export async function diffViewTestPatterns(
  params: Pick<GitBranchDiffParams, 'slotId' | 'runId'>,
  deps: GitExecDeps,
): Promise<readonly string[]> {
  // A review workspace resolves its run with the archive included (see
  // workspaceReviewGit), so the patterns must too; runId and slotId are
  // mutually exclusive on that path.
  let project: string | undefined;
  if (params.runId) {
    project = (await getRunWithArchived(params.runId))?.project;
    if (!project) {
      console.warn(
        `[git] branchDiff for run ${params.runId.slice(0, 8)}: run not found, using default test patterns`,
      );
    }
  } else if (params.slotId) {
    project = (await (deps.loadVars ?? loadSlotVars)(params.slotId)).projectName;
  }
  const projectJson = project
    ? await (deps.loadProjectJson ?? defaultLoadProjectJson)(project)
    : null;
  const raw = projectJson ? getProjectFieldRaw(projectJson, 'diff_view') : undefined;
  const block = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const patterns = Array.isArray(block.test_patterns)
    ? block.test_patterns.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  return resolveTestFilePatterns({
    testPatterns: patterns,
    useDefaultTestPatterns:
      typeof block.use_default_test_patterns === 'boolean'
        ? block.use_default_test_patterns
        : undefined,
  });
}

async function defaultLoadProjectJson(project: string): Promise<RawProjectJson | null> {
  const pv = await loadProjectVarsOrNull(project, 'diff view');
  return pv?.projectJson ?? null;
}
