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

export function remoteBranchRefspec(name: string): string {
  return `+refs/heads/${name}:refs/remotes/origin/${name}`;
}

/** What a slot repo says about its origin fetch config and default-branch refs. */
export interface DefaultBranchRepoState {
  /** `remote.origin.fetch` values, in config order. */
  fetchRefspecs: string[];
  /** Existing refs among `refs/heads/<branch>` and `refs/remotes/origin/<branch>`. */
  refs: string[];
}

function refPatternMatches(pattern: string, ref: string): boolean {
  const full = pattern.startsWith('refs/') ? pattern : `refs/heads/${pattern}`;
  const star = full.indexOf('*');
  if (star === -1) return full === ref;
  const prefix = full.slice(0, star);
  const suffix = full.slice(star + 1);
  return (
    ref.length >= prefix.length + suffix.length && ref.startsWith(prefix) && ref.endsWith(suffix)
  );
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
  const head = `refs/heads/${defaultBranch}`;
  const sources = state.fetchRefspecs
    .map((spec) => spec.trim().replace(/^\+/, '').split(':')[0])
    .filter(Boolean);
  const excluded = sources.some(
    (src) => src.startsWith('^') && refPatternMatches(src.slice(1), head),
  );
  const fetched =
    !excluded && sources.some((src) => !src.startsWith('^') && refPatternMatches(src, head));
  if (!fetched) {
    const configured = state.fetchRefspecs.length ? state.fetchRefspecs.join(', ') : '(none)';
    return `origin fetch refspec ${configured} does not fetch default branch '${defaultBranch}' (single-branch clone?); add ${remoteBranchRefspec(defaultBranch)} to remote.origin.fetch and fetch`;
  }
  if (!state.refs.includes(head) && !state.refs.includes(`refs/remotes/origin/${defaultBranch}`)) {
    return `repo has no default branch '${defaultBranch}' (neither local nor origin/${defaultBranch}); fetch origin`;
  }
  return null;
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
