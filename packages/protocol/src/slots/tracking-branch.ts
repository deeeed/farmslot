import type { ExecResult } from '../contracts/common.js';
import { DEFAULT_BRANCH } from '../contracts/runs.js';

export interface SlotIdleResetResult {
  trackingBranch: string;
  previousBranch: string;
  linkedWorktree: boolean;
}

export interface ResetSlotRepoToIdleOptions {
  /** When known by the caller, skip a second linked-worktree probe. */
  linkedWorktree?: boolean;
}

export function remoteBranchRefspec(name: string, remote = 'origin'): string {
  return `+refs/heads/${name}:refs/remotes/${remote}/${name}`;
}

/** The refs that hold a default branch: the local branch and its origin remote-tracking ref. */
export function defaultBranchRefs(branch: string): { local: string; remote: string } {
  return { local: `refs/heads/${branch}`, remote: `refs/remotes/origin/${branch}` };
}

/** What a slot repo says about its origin fetch config and default-branch refs. */
export interface DefaultBranchRepoState {
  /** `remote.origin.fetch` values, in config order. */
  fetchRefspecs: string[];
  /** Existing refs among `defaultBranchRefs(branch)`. */
  refs: string[];
}

function fullRef(pattern: string): string {
  return pattern.startsWith('refs/') ? pattern : `refs/heads/${pattern}`;
}

/** What `ref` matches in a refspec side: '' for an exact match, the `*` part for a glob, else null. */
function refPatternCapture(pattern: string, ref: string): string | null {
  const full = fullRef(pattern);
  const star = full.indexOf('*');
  if (star === -1) return full === ref ? '' : null;
  const prefix = full.slice(0, star);
  const suffix = full.slice(star + 1);
  if (
    ref.length < prefix.length + suffix.length ||
    !ref.startsWith(prefix) ||
    !ref.endsWith(suffix)
  )
    return null;
  return ref.slice(prefix.length, ref.length - suffix.length);
}

/**
 * Where a configured fetch refspec stores `ref`, or null when it does not.
 * A refspec without a `:dst` fetches only into FETCH_HEAD; a glob source
 * stores through its glob destination.
 */
function refspecDestination(spec: string, ref: string): string | null {
  const [src = '', dst] = spec.trim().replace(/^\+/, '').split(':');
  if (!dst) return null;
  const captured = refPatternCapture(src, ref);
  if (captured === null) return null;
  if (!src.includes('*')) return dst;
  return dst.includes('*') ? dst.replace('*', captured) : null;
}

/**
 * Why prepare cannot check out the project's default branch in this repo, or
 * null when it can. A single-branch clone fetches only its own branch: even
 * after prepare fetches `origin/<branch>` explicitly, `git checkout <branch>`
 * cannot create the local branch from a ref no configured refspec maps, and
 * fails with "pathspec did not match".
 */
export function defaultBranchRepoBlocker(
  state: DefaultBranchRepoState,
  defaultBranch: string,
): string | null {
  const { local, remote } = defaultBranchRefs(defaultBranch);
  const specs = state.fetchRefspecs.map((spec) => spec.trim()).filter(Boolean);
  const excluded = specs.some(
    (spec) => spec.startsWith('^') && refPatternCapture(spec.slice(1), local) !== null,
  );
  const fetched =
    !excluded &&
    specs.some((spec) => !spec.startsWith('^') && refspecDestination(spec, local) === remote);
  if (!fetched) {
    const configured = state.fetchRefspecs.length ? state.fetchRefspecs.join(', ') : '(none)';
    return `origin fetch refspec ${configured} does not fetch default branch '${defaultBranch}' into ${remote} (single-branch clone?); add ${remoteBranchRefspec(defaultBranch)} to remote.origin.fetch and fetch`;
  }
  if (!state.refs.includes(local) && !state.refs.includes(remote)) {
    return `repo has no default branch '${defaultBranch}' (neither local nor origin/${defaultBranch}); fetch origin`;
  }
  return null;
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One POSIX shell command that reads what `defaultBranchRepoBlocker` needs
 * from `repo`: each git call prints its exit status on a labelled line and its
 * output as `fetch=`/`ref=` lines, leaving git's own errors on stderr. Run it
 * locally (`sh -c`) or over a slot transport, then read it with
 * `readDefaultBranchProbe`.
 */
export function defaultBranchProbeCommand(repo: string, defaultBranch: string): string {
  const git = `git -C ${shellArg(repo)}`;
  const { local, remote } = defaultBranchRefs(defaultBranch);
  return [
    `out=$(${git} config --get-all remote.origin.fetch); printf 'fetch-exit=%s\\n' "$?"`,
    `printf '%s\\n' "$out" | sed '/^$/d; s/^/fetch=/'`,
    `out=$(${git} for-each-ref --format='%(refname)' ${shellArg(local)} ${shellArg(remote)}); printf 'refs-exit=%s\\n' "$?"`,
    `printf '%s\\n' "$out" | sed '/^$/d; s/^/ref=/'`,
    // Last line: output cut short (a timeout) lacks it and gives no verdict.
    `printf 'probe=done\\n'`,
  ].join('; ');
}

/**
 * The probe's verdict. `readable: false` means a git read failed (unreadable
 * refs or config, not a repo, a broken transport): there is no verdict about
 * the default branch either way, and `error` says why.
 */
export type DefaultBranchProbe =
  | { readable: true; blocker: string | null }
  | { readable: false; error: string };

export function readDefaultBranchProbe(
  output: ExecResult,
  defaultBranch: string,
): DefaultBranchProbe {
  const state: DefaultBranchRepoState = { fetchRefspecs: [], refs: [] };
  let fetchExit: string | undefined;
  let refsExit: string | undefined;
  let done = false;
  for (const line of output.stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'probe=done') done = true;
    else if (trimmed.startsWith('fetch-exit=')) fetchExit = trimmed.slice('fetch-exit='.length);
    else if (trimmed.startsWith('refs-exit=')) refsExit = trimmed.slice('refs-exit='.length);
    else if (trimmed.startsWith('fetch=')) state.fetchRefspecs.push(trimmed.slice('fetch='.length));
    else if (trimmed.startsWith('ref=')) state.refs.push(trimmed.slice('ref='.length));
  }
  const detail = output.stderr.trim().split('\n').slice(-1)[0] ?? '';
  const failure = (what: string) => ({
    readable: false as const,
    error: detail ? `${what}: ${detail}` : what,
  });
  if (output.exitCode !== 0) return failure(`probe exited ${output.exitCode}`);
  if (!done) return failure('probe output ended early');
  // `git config --get-all` exits 1 when no refspec is configured: that is a reading.
  if (fetchExit !== '0' && fetchExit !== '1')
    return failure(`git config remote.origin.fetch exited ${fetchExit ?? '(no status)'}`);
  if (refsExit !== '0') return failure(`git for-each-ref exited ${refsExit ?? '(no status)'}`);
  return { readable: true, blocker: defaultBranchRepoBlocker(state, defaultBranch) };
}

export interface SlotTrackingProjectConfig {
  defaultBranch?: string;
  slotTrackingBranch?: string;
}

export interface SlotTrackingSlotContext {
  session?: string;
  slotId?: string;
  /**
   * Set by fleet refresh via linked .git probe — single source for stale/idle inference.
   * When absent (pre-refresh rows), treated as false (primary-clone rules).
   */
  linkedWorktree?: boolean;
}

/** Default linked-worktree branch prefix when slot_tracking_branch is unset. */
export const LINKED_WORKTREE_SESSION_BRANCH_PREFIX = 'wt/';

export function expandSlotTrackingTemplate(template: string, ctx: SlotTrackingSlotContext): string {
  return template
    .replace(/\{\{session\}\}/g, ctx.session ?? '')
    .replace(/\{\{slot_id\}\}/g, ctx.slotId ?? '');
}

export function resolveSlotTrackingBranch(
  project: SlotTrackingProjectConfig,
  ctx: SlotTrackingSlotContext,
  linkedWorktree: boolean,
  fallbackDefaultBranch: string = DEFAULT_BRANCH,
): string {
  const defaultBranch = project.defaultBranch || fallbackDefaultBranch;
  if (!linkedWorktree) return defaultBranch;

  const template = project.slotTrackingBranch?.trim();
  if (template) {
    return expandSlotTrackingTemplate(template, ctx);
  }

  const session = ctx.session?.trim();
  if (session) return `${LINKED_WORKTREE_SESSION_BRANCH_PREFIX}${session}`;

  return defaultBranch;
}

/**
 * What a detached HEAD reports. `git rev-parse --abbrev-ref HEAD` answers the
 * literal string `HEAD` when no branch is checked out, which is what the fleet
 * refresh records as the slot's branch.
 *
 * Exported, NOT baked into `isSlotIdleBranch`: this predicate is shared with
 * `slot.release`'s unmerged-work refusal and with fleet health, where a
 * detached HEAD can hold real unpushed commits that must still be protected.
 * Only dispatch scoring may treat a detached slot as idle, and only when a park
 * record proves the commits are preserved.
 */
export const DETACHED_HEAD_BRANCH = 'HEAD';

export function isSlotIdleBranch(
  currentBranch: string,
  trackingBranch: string,
  defaultBranch: string,
  linkedWorktree: boolean,
): boolean {
  if (!currentBranch) return false;
  if (linkedWorktree) {
    return currentBranch === trackingBranch || currentBranch === defaultBranch;
  }
  return currentBranch === defaultBranch;
}

export function isSlotRefreshStaleBranch(
  branch: string,
  project: SlotTrackingProjectConfig,
  ctx: SlotTrackingSlotContext,
): boolean {
  if (!branch) return false;
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
  const linkedWorktree = ctx.linkedWorktree ?? false;
  const trackingBranch = resolveSlotTrackingBranch(project, ctx, linkedWorktree, defaultBranch);
  return !isSlotIdleBranch(branch, trackingBranch, defaultBranch, linkedWorktree);
}
