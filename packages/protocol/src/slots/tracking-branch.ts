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
}

/**
 * Legacy linked-worktree names used before every pool declared slot_tracking_branch.
 * Kept until fleet/gateway callers resolve tracking branches from project config only.
 */
export function isLegacyWorktreeTrackingBranch(branch: string): boolean {
  return /^wt\/ff-[A-Za-z0-9._-]+$/.test(branch);
}

export function expandSlotTrackingTemplate(
  template: string,
  ctx: SlotTrackingSlotContext,
): string {
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
  if (session) return `wt/${session}`;

  return defaultBranch;
}

export function isSlotIdleBranch(
  currentBranch: string,
  trackingBranch: string,
  defaultBranch: string,
  linkedWorktree: boolean,
): boolean {
  if (!currentBranch) return false;
  if (linkedWorktree) {
    return (
      currentBranch === trackingBranch ||
      currentBranch === defaultBranch ||
      isLegacyWorktreeTrackingBranch(currentBranch)
    );
  }
  return currentBranch === defaultBranch;
}

/** True when a slot repo path lives under the project's configured worktree_base. */
export function isRepoUnderWorktreeBase(
  repo: string | undefined,
  worktreeBase: string | undefined,
): boolean {
  if (!repo || !worktreeBase) return false;
  const normalizedRepo = repo.replace(/\/$/, '');
  const normalizedBase = worktreeBase.replace(/\/$/, '');
  return normalizedRepo === normalizedBase || normalizedRepo.startsWith(`${normalizedBase}/`);
}

export function isSlotRefreshStaleBranch(
  branch: string,
  project: SlotTrackingProjectConfig & { worktreeBase?: string },
  ctx: SlotTrackingSlotContext & { repo?: string },
): boolean {
  if (!branch) return false;
  const defaultBranch = project.defaultBranch || DEFAULT_BRANCH;
  const linkedWorktree = isRepoUnderWorktreeBase(ctx.repo, project.worktreeBase);
  const trackingBranch = resolveSlotTrackingBranch(project, ctx, linkedWorktree, defaultBranch);
  return !isSlotIdleBranch(branch, trackingBranch, defaultBranch, linkedWorktree);
}