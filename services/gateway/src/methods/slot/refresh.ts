import { randomUUID } from 'node:crypto';

import {
  DEFAULT_BRANCH,
  type SlotRefreshParams,
  type SlotRefreshResult,
  type SlotStatus,
} from '@farmslot/protocol';

import {
  execOnSlot,
  getProjectField,
  isLocal,
  loadProjectVars,
  loadSlotVars,
  type ProjectVars,
  type RawProjectJson,
  type SlotVars,
  updateSlotStatusIf,
} from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { loadFleetStatus } from '../../fleet/state.js';

import {
  CLEAR_INDEX_FLAGS_COMMAND,
  REFRESH_INDEX_AND_UNLOCK_COMMAND,
  REFRESH_REMOTE_REF_LOCKS_COMMAND,
} from './git-cleanup-commands.js';
import { activePrepareSlots, type EventEmitter } from './shared.js';
import {
  detectLinkedWorktree,
  isSlotIdleBranch,
  resetSlotRepoToIdle,
  resolveSlotTrackingBranch,
  slotIdleResetStepDetail,
} from './slot-tracking.js';

export function refreshStaleBranchDetail(
  currentBranch: string,
  projectJson: RawProjectJson,
  slotVars: SlotVars,
  projectVars: ProjectVars | undefined,
  linkedWorktree: boolean,
  defaultBranch: string,
): string | null {
  if (!currentBranch) return null;
  const trackingBranch = resolveSlotTrackingBranch(
    projectJson,
    slotVars,
    projectVars,
    linkedWorktree,
  );
  if (isSlotIdleBranch(currentBranch, trackingBranch, defaultBranch, linkedWorktree)) {
    return null;
  }
  const expected = linkedWorktree
    ? `'${trackingBranch}' or '${defaultBranch}'`
    : `'${defaultBranch}'`;
  return `STALE_BRANCH: on '${currentBranch}', expected ${expected}`;
}

/** True when refresh syncs via resetSlotRepoToIdle (force or linked safe) — not the primary fetch path. */
export function refreshSyncUsesIdleReset(
  mode: 'safe' | 'force',
  linkedWorktree: boolean,
): boolean {
  return mode === 'force' || linkedWorktree;
}

export function slotRefreshBlockedReason(slot: SlotStatus | undefined): string | null {
  if (!slot) return null;
  const lc = slot.lifecycle;
  if (lc !== 'busy' && lc !== 'held' && !slot.currentRunId) return null;
  const runRef = slot.currentRunId ? ` (run ${slot.currentRunId.slice(0, 8)})` : '';
  return `Slot ${slot.slot} is ${lc}${runRef} — refresh would discard worker state`;
}

export async function slotRefresh(
  params: SlotRefreshParams,
  emit: EventEmitter,
): Promise<SlotRefreshResult> {
  // Honour a client-supplied requestId so the UI can set its event-filter
  // BEFORE issuing the request. This closes the cross-action bleed window
  // where a panel running in parallel would absorb our script.output frames
  // until our response landed.
  const requestId = params.requestId ?? `refresh-${randomUUID()}`;
  const mode: 'safe' | 'force' = params.mode ?? 'safe';
  const startTime = Date.now();

  const out = (line: string) =>
    emit('script.output', {
      requestId,
      stream: 'stdout' as const,
      data: line.endsWith('\n') ? line : `${line}\n`,
      timestamp: Date.now(),
    });
  const err = (line: string) =>
    emit('script.output', {
      requestId,
      stream: 'stderr' as const,
      data: line.endsWith('\n') ? line : `${line}\n`,
      timestamp: Date.now(),
    });
  const complete = (exitCode: number, error?: string) =>
    emit('script.complete', {
      requestId,
      exitCode,
      duration: Date.now() - startTime,
      ...(error ? { error } : {}),
    });
  const step = (name: string, detail: string) => {
    emit('slot.refresh.step', { name, detail });
    out(`[${name}] ${detail}`);
  };

  if (activePrepareSlots.has(params.slotId)) {
    const msg = `Slot ${params.slotId} is already preparing/refreshing`;
    err(msg);
    complete(1, msg);
    throw new Error(msg);
  }
  activePrepareSlots.add(params.slotId);

  try {
    const vars = await loadSlotVars(params.slotId);
    if (!vars.slotEnabled) {
      const msg = `Slot ${params.slotId} is disabled`;
      step('skip', msg);
      complete(1, msg);
      throw new Error(msg);
    }

    // Lifecycle guard. Refresh — even in force mode — must never run on a slot
    // that is actively serving a worker or holding state for one. The UI's
    // _actionAvailability gate hides the button in these states, but a direct
    // WS call (or stale UI) would otherwise reset --hard the worker's branch.
    // activePrepareSlots only blocks parallel prepare/refresh, not dispatch.
    const fleet = await loadFleetStatus();
    const slotStatus = fleet.slots.find((s) => s.slot === params.slotId);
    const blocked = slotRefreshBlockedReason(slotStatus);
    if (blocked) {
      step('skip', blocked);
      complete(1, blocked);
      throw new Error(blocked);
    }

    let projectVars: ProjectVars | undefined;
    let projectJson: RawProjectJson = {};
    try {
      projectVars = await loadProjectVars(vars.projectName);
      projectJson = projectVars.projectJson;
    } catch {
      /* no project config — fall back to DEFAULT_BRANCH */
    }
    const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
    const defaultBranchRefspec = `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
    const linkedWorktree = await detectLinkedWorktree(vars);
    const trackingBranch = resolveSlotTrackingBranch(
      projectJson,
      vars,
      projectVars,
      linkedWorktree,
    );
    const effectiveBranch = linkedWorktree ? trackingBranch : defaultBranch;

    // 1. SSH ping (remote slots only)
    if (!isLocal(vars.host, vars.machine)) {
      step('ssh', `Checking ${vars.sshTarget}...`);
      const r = await execOnSlot(vars, 'echo ok');
      if (r.exitCode !== 0) {
        const msg = `Cannot reach ${vars.sshTarget}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
      step('ssh', `Connected to ${vars.sshTarget}`);
    }

    // 2. Snapshot HEAD before any sync so we can report whether origin moved.
    const headBefore = (
      await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`)
    ).stdout.trim();

    // 3. Safe-mode pre-checks. Emit sentinel strings (DIRTY_TREE: / STALE_BRANCH:)
    //    that the UI uses to surface a Force Refresh button.
    if (mode === 'safe') {
      const currentBranch = (
        await execOnSlot(
          vars,
          `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
        )
      ).stdout.trim();
      const staleDetail = refreshStaleBranchDetail(
        currentBranch,
        projectJson,
        vars,
        projectVars,
        linkedWorktree,
        defaultBranch,
      );
      if (staleDetail) {
        step('abort', staleDetail);
        complete(0);
        return {
          requestId,
          refreshed: false,
          reason: 'stale',
          branch: effectiveBranch,
          advanced: false,
        };
      }
      const dirty = (
        await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git status --porcelain`)
      ).stdout.trim();
      if (dirty) {
        const detail = `DIRTY_TREE: ${dirty.split('\n').length} change(s) in working tree`;
        step('abort', detail);
        // Surface dirty paths verbatim so the user can see what they'd lose.
        out(dirty);
        complete(0);
        return {
          requestId,
          refreshed: false,
          reason: 'dirty',
          branch: effectiveBranch,
          advanced: false,
        };
      }
    }

    // 4. origin/HEAD reset — same gh-wrong-base guard as slotPrepare.
    step('origin-head', `Resetting origin/HEAD to ${defaultBranch}...`);
    await execOnSlot(
      vars,
      `cd ${shellQuote(vars.remoteRepo)} && git remote set-head origin ${shellQuote(defaultBranch)} 2>/dev/null`,
    );
    const originHead = (
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
      )
    ).stdout.trim();
    const expectedHead = `refs/remotes/origin/${defaultBranch}`;
    if (originHead !== expectedHead) {
      const msg = `origin/HEAD is '${originHead || 'unset'}' (expected '${expectedHead}')`;
      err(msg);
      complete(1, msg);
      throw new Error(msg);
    }
    step('origin-head', `origin/HEAD = ${expectedHead}`);

    const idleResetOptions = { linkedWorktree };

    // 5–6. Sync to origin/default. Force mode sweeps flags first; linked worktrees
    //    (safe or force) and force primary clones use resetSlotRepoToIdle once.
    //    Safe primary clones use a single fetch + reset --hard path.
    if (mode === 'force') {
      const flagSweep = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${CLEAR_INDEX_FLAGS_COMMAND}; }`,
      );
      if (flagSweep.exitCode !== 0) {
        const msg = `failed to clear skip-worktree/assume-unchanged flags: ${flagSweep.stderr.slice(-200) || flagSweep.stdout.slice(-200)}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
      step('clean', 'reset --hard HEAD + clean -fd');
      const resetR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard HEAD; }`,
      );
      if (resetR.exitCode !== 0) {
        const msg = `reset --hard HEAD failed: ${resetR.stderr.slice(-200) || resetR.stdout.slice(-200)}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
      const cleanR = await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git clean -fd`);
      if (cleanR.exitCode !== 0) {
        const msg = `git clean -fd failed: ${cleanR.stderr.slice(-200) || cleanR.stdout.slice(-200)}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
      const idleReset = await resetSlotRepoToIdle(
        vars,
        projectJson,
        projectVars,
        defaultBranch,
        idleResetOptions,
      );
      step('branch', slotIdleResetStepDetail(idleReset, defaultBranch));
    } else if (linkedWorktree) {
      // Safe refresh on linked worktrees: sync via ADR-042 helper so legacy
      // `main` checkouts normalize to the tracking branch @ origin/default.
      const idleReset = await resetSlotRepoToIdle(
        vars,
        projectJson,
        projectVars,
        defaultBranch,
        idleResetOptions,
      );
      step('sync', slotIdleResetStepDetail(idleReset, defaultBranch));
    } else {
      // Fetch only the default branch. Refresh's contract is "make this idle
      //    slot latest main"; fetching/pruning every remote branch is slow and
      //    can fail on large repos with case-colliding branch refs on macOS.
      step('fetch', `git fetch origin ${defaultBranch}`);
      await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_REMOTE_REF_LOCKS_COMMAND}; }`,
      );
      const fetchR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && git fetch origin ${shellQuote(defaultBranchRefspec)}`,
      );
      if (fetchR.exitCode !== 0) {
        const msg = `git fetch origin ${defaultBranch} failed: ${fetchR.stderr.slice(-200) || fetchR.stdout.slice(-200)}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
      step('reset', `git reset --hard origin/${defaultBranch}`);
      const ffR = await execOnSlot(
        vars,
        `cd ${shellQuote(vars.remoteRepo)} && { ${REFRESH_INDEX_AND_UNLOCK_COMMAND}; git reset --hard origin/${defaultBranch}; }`,
      );
      if (ffR.exitCode !== 0) {
        const msg = `fast-forward to origin/${defaultBranch} failed: ${ffR.stderr.slice(-200) || ffR.stdout.slice(-200)}`;
        err(msg);
        complete(1, msg);
        throw new Error(msg);
      }
    }

    // 7. Verify clean.
    const dirtyAfter = (
      await execOnSlot(vars, `cd ${shellQuote(vars.remoteRepo)} && git status --porcelain`)
    ).stdout.trim();
    if (dirtyAfter) {
      const msg = `Working tree still dirty after reset to origin/${defaultBranch}:\n${dirtyAfter}`;
      err(msg);
      complete(1, msg);
      throw new Error(msg);
    }

    const headAfter = (
      await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD 2>/dev/null`)
    ).stdout.trim();
    const advanced = headBefore !== '' && headAfter !== '' && headBefore !== headAfter;

    // 8. Lifecycle: atomic conditional write. activePrepareSlots blocks
    //    parallel refresh/prepare but NOT a dispatch landing on this slot
    //    mid-fetch. updateSlotStatusIf serialises read+predicate+write inside
    //    the writeChain so we never clobber a `busy` lifecycle that another
    //    handler set between our read and write. Slots that were already
    //    busy/held when we finish stay that way and only their error fields
    //    get cleared.
    await updateSlotStatusIf(
      params.slotId,
      (slot) => {
        const lc = slot.lifecycle;
        return lc === 'ready' || lc === 'released' || lc === undefined || lc === null;
      },
      {
        lifecycle: 'ready',
        // Refresh just reset HEAD to origin/default — persist the checkout
        // branch (tracking branch on linked worktrees) so slot.branch stays accurate.
        branch: effectiveBranch,
        last_error_at: null,
        last_error_msg: null,
      },
    );

    step('done', `${effectiveBranch} @ origin/${defaultBranch} (advanced=${advanced})`);
    emit('slot.refresh.done', {
      slotId: params.slotId,
      branch: effectiveBranch,
      advanced,
      mode,
    });
    complete(0);

    return { requestId, refreshed: true, branch: effectiveBranch, advanced };
  } catch (e) {
    // complete() was already emitted by the inner thrower; if we got here
    // some unhandled path threw — surface it once.
    const msg = (e as Error).message ?? 'slot.refresh failed';
    if (!(e as { _refreshReported?: boolean })._refreshReported) {
      err(msg);
      complete(1, msg);
    }
    throw e;
  } finally {
    activePrepareSlots.delete(params.slotId);
  }
}
