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
 */
const DETACHED_HEAD_BRANCH = 'HEAD';

export function isSlotIdleBranch(
  currentBranch: string,
  trackingBranch: string,
  defaultBranch: string,
  linkedWorktree: boolean,
): boolean {
  if (!currentBranch) return false;
  // A detached HEAD holds no branch ref, so there is no work for the next
  // occupant's prepare to clobber and nothing for an operator to rescue — the
  // slot is as idle as one sitting on its tracking branch. ADR-054 `free-slot`
  // detaches deliberately for exactly this reason, and without this the freed
  // slot would carry the stale-branch penalty and force an operator pick.
  if (currentBranch === DETACHED_HEAD_BRANCH) return true;
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
