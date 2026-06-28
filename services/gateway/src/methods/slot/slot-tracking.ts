import path from 'node:path';

import { DEFAULT_BRANCH } from '@farmslot/protocol';

import {
  execOnSlot,
  expandTemplate,
  getProjectField,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import type { StartRefResolution } from '../../projects/start-ref-resolution.js';

import { REFRESH_INDEX_AND_UNLOCK_COMMAND } from './git-cleanup-commands.js';

export type MergeMainStrategy = 'merge' | 'rebase';

/** Legacy farmslot ff sandboxes; kept until all pools declare slot_tracking_branch. */
export function isDefaultWorktreeTrackingBranch(branch: string): boolean {
  return /^wt\/ff-[A-Za-z0-9._-]+$/.test(branch);
}

/** Linked worktrees use a .git *file* pointing at the main repo's worktree metadata. */
export function isLinkedGitWorktreeMarker(stdout: string): boolean {
  return stdout.trim() === 'linked';
}

export function remoteBranchRefspec(name: string): string {
  return `+refs/heads/${name}:refs/remotes/origin/${name}`;
}

export function worktreeBaseResetRef(
  defaultBranch: string,
  resolvedStartRef: StartRefResolution | null,
): string {
  return resolvedStartRef?.resolvedSha ?? `origin/${defaultBranch}`;
}

export function resolveMergeMainStrategy(
  projectJson: RawProjectJson,
  override?: MergeMainStrategy,
): MergeMainStrategy {
  if (override === 'merge' || override === 'rebase') return override;
  const configured = getProjectField(projectJson, 'merge_main_strategy');
  return configured === 'rebase' ? 'rebase' : 'merge';
}

export function resolveSlotTrackingBranch(
  projectJson: RawProjectJson,
  slotVars: SlotVars,
  projectVars: ProjectVars | undefined,
  linkedWorktree: boolean,
): string {
  const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
  if (!linkedWorktree) return defaultBranch;

  const template = getProjectField(projectJson, 'slot_tracking_branch');
  if (template) {
    return expandTemplate(template, slotVars, projectVars);
  }

  const session = slotVars.session?.trim();
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
      isDefaultWorktreeTrackingBranch(currentBranch)
    );
  }
  return currentBranch === defaultBranch;
}

export async function detectLinkedWorktree(vars: SlotVars): Promise<boolean> {
  const linkedWorktreeR = await execOnSlot(
    vars,
    `test -f ${shellQuote(path.join(vars.remoteRepo, '.git'))} && echo linked || echo primary`,
  );
  return isLinkedGitWorktreeMarker(linkedWorktreeR.stdout);
}

export interface SlotIdleResetResult {
  trackingBranch: string;
  previousBranch: string;
  linkedWorktree: boolean;
}

export async function resetSlotRepoToIdle(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  defaultBranch: string,
): Promise<SlotIdleResetResult> {
  const repo = shellQuote(vars.remoteRepo);
  const linkedWorktree = await detectLinkedWorktree(vars);
  const trackingBranch = resolveSlotTrackingBranch(
    projectJson,
    vars,
    projectVars,
    linkedWorktree,
  );
  const baseRef = `origin/${defaultBranch}`;

  const currentBranch = (
    await execOnSlot(vars, `git -C ${repo} rev-parse --abbrev-ref HEAD 2>/dev/null`)
  ).stdout.trim();

  await execOnSlot(
    vars,
    `cd ${repo} && git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null`,
  );

  const fetchR = await execOnSlot(
    vars,
    `cd ${repo} && git fetch origin ${shellQuote(remoteBranchRefspec(defaultBranch))}`,
  );
  if (fetchR.exitCode !== 0) {
    throw new Error(
      `git fetch origin ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${fetchR.stderr.slice(-200) || fetchR.stdout.slice(-200)}`,
    );
  }

  if (linkedWorktree) {
    if (currentBranch !== trackingBranch) {
      const localExists =
        (
          await execOnSlot(
            vars,
            `cd ${repo} && git rev-parse --verify ${shellQuote(trackingBranch)} >/dev/null 2>&1`,
          )
        ).exitCode === 0;
      const checkoutCmd = localExists
        ? `git checkout ${shellQuote(trackingBranch)}`
        : `git checkout -b ${shellQuote(trackingBranch)} ${shellQuote(baseRef)}`;
      const coR = await execOnSlot(vars, `cd ${repo} && ${checkoutCmd}`);
      if (coR.exitCode !== 0) {
        throw new Error(
          `worktree checkout ${trackingBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${coR.stderr.slice(-200) || coR.stdout.slice(-200)}`,
        );
      }
    }
    const resetR = await execOnSlot(
      vars,
      `cd ${repo} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard ${shellQuote(baseRef)}; }`,
    );
    if (resetR.exitCode !== 0) {
      throw new Error(
        `worktree reset to ${baseRef} failed on ${vars.slotId} (${vars.remoteRepo}): ${resetR.stderr.slice(-200) || resetR.stdout.slice(-200)}`,
      );
    }
  } else if (currentBranch === defaultBranch) {
    const resetR = await execOnSlot(
      vars,
      `cd ${repo} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard ${shellQuote(baseRef)}; }`,
    );
    if (resetR.exitCode !== 0) {
      throw new Error(
        `reset to ${baseRef} failed on ${vars.slotId} (${vars.remoteRepo}): ${resetR.stderr.slice(-200) || resetR.stdout.slice(-200)}`,
      );
    }
  } else {
    const coR = await execOnSlot(vars, `cd ${repo} && git checkout ${shellQuote(defaultBranch)}`);
    if (coR.exitCode !== 0) {
      throw new Error(
        `checkout ${defaultBranch} failed on ${vars.slotId} (${vars.remoteRepo}): ${coR.stderr.slice(-200) || coR.stdout.slice(-200)}`,
      );
    }
    const resetR = await execOnSlot(
      vars,
      `cd ${repo} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard ${shellQuote(baseRef)}; }`,
    );
    if (resetR.exitCode !== 0) {
      throw new Error(
        `reset to ${baseRef} failed on ${vars.slotId} (${vars.remoteRepo}): ${resetR.stderr.slice(-200) || resetR.stdout.slice(-200)}`,
      );
    }
  }

  return { trackingBranch, previousBranch: currentBranch, linkedWorktree };
}

export function slotIdleResetStepDetail(
  result: SlotIdleResetResult,
  defaultBranch: string,
): string {
  if (result.linkedWorktree) {
    if (result.previousBranch === result.trackingBranch) {
      return `Already on ${result.trackingBranch} @ origin/${defaultBranch}`;
    }
    return `Returned to ${result.trackingBranch} @ origin/${defaultBranch} (was ${result.previousBranch})`;
  }
  if (result.previousBranch === defaultBranch) {
    return `Already on ${defaultBranch} @ origin/${defaultBranch}`;
  }
  return `Returned to ${defaultBranch} @ origin/${defaultBranch} (was ${result.previousBranch})`;
}