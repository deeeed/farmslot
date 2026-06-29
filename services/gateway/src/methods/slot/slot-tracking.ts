import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_BRANCH,
  isSlotIdleBranch,
  remoteBranchRefspec,
  type ResetSlotRepoToIdleOptions,
  resolveSlotTrackingBranch,
  SLOT_DESTRUCTIVE_OPS,
  type SlotDestructiveOp,
  type SlotIdleResetResult,
  type SlotTrackingProjectConfig,
  type SlotTrackingSlotContext,
} from '@farmslot/protocol';

import { isLocal } from '../../core/exec.js';
import {
  execOnSlot,
  expandTemplate,
  getProjectField,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { farmslotRoot } from '../../projects/repo-root.js';
import type { StartRefResolution } from '../../projects/start-ref-resolution.js';

import { REFRESH_INDEX_AND_UNLOCK_COMMAND } from './git-cleanup-commands.js';

export type MergeMainStrategy = 'merge' | 'rebase';

export { isSlotIdleBranch, remoteBranchRefspec, resolveSlotTrackingBranch };

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

function projectTrackingConfig(
  projectJson: RawProjectJson,
  defaultBranch: string,
): SlotTrackingProjectConfig {
  return {
    defaultBranch,
    slotTrackingBranch: getProjectField(projectJson, 'slot_tracking_branch'),
  };
}

function slotTrackingContext(vars: SlotVars): SlotTrackingSlotContext {
  return { session: vars.session, slotId: vars.slotId };
}

export function resolveSlotTrackingBranchFromProject(
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

  return resolveSlotTrackingBranch(
    projectTrackingConfig(projectJson, defaultBranch),
    slotTrackingContext(slotVars),
    true,
    defaultBranch,
  );
}

/** Linked worktrees use a .git *file* pointing at the main repo's worktree metadata. */
export function isLinkedGitWorktreeMarker(stdout: string): boolean {
  return stdout.trim() === 'linked';
}

export async function detectLinkedWorktree(vars: SlotVars): Promise<boolean> {
  const linkedWorktreeR = await execOnSlot(
    vars,
    `test -f ${shellQuote(path.join(vars.remoteRepo, '.git'))} && echo linked || echo primary`,
  );
  return isLinkedGitWorktreeMarker(linkedWorktreeR.stdout);
}

export type { ResetSlotRepoToIdleOptions, SlotIdleResetResult };

/**
 * True when a slot's repo is the gateway's OWN operator root — i.e. the
 * control-plane checkout the gateway process runs from. Happens when a pool
 * slot uses `repo: "."` (resolved against farmslotRoot in core/config) or an
 * explicit operator path like a `*-fs-main` slot. Only meaningful for local
 * slots; a remote node that happens to share the path string is a different
 * filesystem and is not the operator's repo.
 */
export async function isOperatorRootSlot(vars: SlotVars): Promise<boolean> {
  if (!isLocal(vars.host, vars.machine)) return false;
  // Resolve symlinks too — a slot repo pointing at a symlink to the operator
  // root must still be caught. realpathSync throws when the path does not exist
  // yet (e.g. an uncreated worktree); fall back to lexical resolution then.
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const opRoot = canonical(farmslotRoot);
  // Exact (or symlinked) match — the cheap path, no git needed.
  if (canonical(vars.remoteRepo) === opRoot) return true;
  // Subdirectory-of-operator case: a slot pointing at any directory INSIDE the
  // operator checkout (e.g. `repo: "services/gateway"`) shares the same git
  // worktree, so `git -C <subdir> reset --hard` still nukes the operator tree.
  // Resolve the slot repo's owning worktree root and compare. This correctly
  // ALLOWS nested separate repos (projects/<name>, which have their own root)
  // and sibling linked worktrees (farmslot-wt/..., a different root).
  const top = (
    await execOnSlot(
      vars,
      `git -C ${shellQuote(vars.remoteRepo)} rev-parse --show-toplevel 2>/dev/null`,
    )
  ).stdout.trim();
  return top.length > 0 && canonical(top) === opRoot;
}

/**
 * Guard every destructive slot-lifecycle entry point (idle-reset, refresh,
 * prepare, recycle/release). These run `git reset --hard origin/<default>` +
 * `git clean -fd` on the slot repo; if the slot resolves to the operator root
 * they would wipe the control-plane's own working tree (uncommitted work, no
 * stash to recover from) on a fleet-refresh / idle-reset / dispatch timer. Fail
 * hard so the misconfigured slot is surfaced instead of silently nuking the repo.
 */
export async function assertSlotNotOperatorRoot(
  vars: SlotVars,
  operation: SlotDestructiveOp,
): Promise<void> {
  if (await isOperatorRootSlot(vars)) {
    throw new Error(
      `Refusing to ${operation} slot ${vars.slotId}: its repo (${vars.remoteRepo}) is the gateway's own operator root. ` +
        `Point this slot at a dedicated worktree (e.g. farmslot-wt/...) instead of the control-plane repo.`,
    );
  }
}

export async function resetSlotRepoToIdle(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  defaultBranch: string,
  options?: ResetSlotRepoToIdleOptions,
): Promise<SlotIdleResetResult> {
  // Backstop guard — every caller should also guard at its own entry, but this
  // is the last line before `git checkout -- . && git clean -fd && reset --hard`.
  await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.idleReset);
  const repo = shellQuote(vars.remoteRepo);
  const linkedWorktree = options?.linkedWorktree ?? (await detectLinkedWorktree(vars));
  const trackingBranch = resolveSlotTrackingBranchFromProject(
    projectJson,
    vars,
    projectVars,
    linkedWorktree,
  );
  const baseRef = `origin/${defaultBranch}`;

  const currentBranch = (
    await execOnSlot(vars, `git -C ${repo} rev-parse --abbrev-ref HEAD 2>/dev/null`)
  ).stdout.trim();

  await execOnSlot(vars, `cd ${repo} && git checkout -- . 2>/dev/null; git clean -fd 2>/dev/null`);

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
