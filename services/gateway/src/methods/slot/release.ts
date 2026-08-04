import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  AGENT_ROLES,
  agentDispatchWindow,
  type AgentRole,
  agentRoleWindow,
  DEFAULT_BRANCH,
  isReviewerWindowName,
  SLOT_DESTRUCTIVE_OPS,
  type SlotReleaseParams,
} from '@farmslot/protocol';

import {
  WORKER_ARTIFACT_COPY_EXCLUDES,
  WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES,
} from '../../core/artifact-copy-policy.js';
import {
  execOnSlot,
  expandHook,
  expandRecycleCmd,
  getOrchestratorTaskRoot,
  getProjectField,
  loadProjectVars,
  loadSlotVars,
  markSlotBusy,
  markSlotStatusIf,
  type ProjectVars,
  type RawProjectJson,
  readSlotField,
  resetSlotIf,
  resolveProjectTaskDirName,
  SLOT_PHASE_RELEASING,
  type SlotVars,
  updateSlotStatusIf,
} from '../../core/index.js';
import { slotCopyDir, SlotCopyDirEntryError } from '../../core/slot-io.js';
import {
  firstWindowTarget,
  resolveTmuxSession,
  shellQuote,
  tmuxSendTextCommand,
  tmuxShellSnippet,
} from '../../core/tmux.js';
import { cleanupSlotStorage } from '../../fleet/slot-storage-cleanup.js';
import { findActiveGateHeldRunForSlot } from '../../run-engine/gate-held-lifecycle.js';
import { findRunnerDescendantPid } from '../../runners/session-process.js';
import { killSlotScreenSessions } from '../../runtime/screen-session.js';
import { buildDispatchRoleShellCommand } from '../dispatch/role-target.js';
import { terminalAttachmentCleanup } from '../terminal-attachment.js';

import { slotPrepare } from './prepare.js';
import { closeDevServerLogTailWindow } from './prepare-devserver-log.js';
import { detachRunsForReleasedSlot } from './release-run-ownership.js';
import { applySelectedApp, type EventEmitter } from './shared.js';
import {
  assertSlotNotOperatorRoot,
  detectLinkedWorktree,
  isSlotIdleBranch,
  resetSlotRepoToIdle,
  resolveSlotTrackingBranchFromProject,
  slotIdleResetStepDetail,
} from './slot-tracking.js';

// In-flight teardown coalescing: two concurrent releases for the same slot
// must be ONE teardown — the slower duplicate previously re-killed and reset
// whatever claimed the slot after the first release finished.
const inflightReleases = new Map<
  string,
  { key: string; promise: Promise<{ released: boolean }> }
>();

function releaseCoalesceKey(params: SlotReleaseParams): string {
  // Only semantically identical requests may share one teardown; a request
  // with different options/owner must wait for the in-flight one and then run
  // itself (it may legitimately become a no-op via the owner/epoch guards).
  return JSON.stringify({
    expectedRunId: params.expectedRunId ?? null,
    keepWarm: params.keepWarm ?? false,
    keepWork: params.keepWork ?? false,
    skipArtifacts: params.skipArtifacts ?? false,
    forceReset: params.forceReset ?? false,
    preserveAgents: params.preserveAgents ?? false,
    detachRuns: params.detachRuns ?? true,
  });
}

export async function slotRelease(
  params: SlotReleaseParams,
  emit: EventEmitter,
): Promise<{ released: boolean }> {
  const key = releaseCoalesceKey(params);
  // Re-check the map after every wait: several differing waiters can be woken
  // by the same settled teardown, and only the first to register may run —
  // the rest must queue behind IT, not start parallel teardowns.
  for (;;) {
    const inflight = inflightReleases.get(params.slotId);
    if (!inflight) break;
    if (inflight.key === key) {
      console.log(
        `[release] coalescing duplicate release for ${params.slotId} onto in-flight teardown`,
      );
      return inflight.promise;
    }
    console.log(`[release] queueing differing release for ${params.slotId} behind in-flight one`);
    await inflight.promise.catch(() => undefined);
  }
  const teardown = slotReleaseImpl(params, emit).finally(() => {
    if (inflightReleases.get(params.slotId)?.promise === teardown) {
      inflightReleases.delete(params.slotId);
    }
  });
  inflightReleases.set(params.slotId, { key, promise: teardown });
  return teardown;
}

async function slotReleaseImpl(
  params: SlotReleaseParams,
  emit: EventEmitter,
): Promise<{ released: boolean }> {
  // Cheap early checks (authoritative validation happens atomically at the
  // releasing-marker CAS below, after the non-destructive preflight). A slot
  // already mid-release belongs to that teardown — a bound release joining at
  // the same epoch would run a second destructive pass.
  if ((await readSlotField(params.slotId, 'phase')) === SLOT_PHASE_RELEASING) {
    console.log(`[release] slot ${params.slotId} is already mid-release; leaving it untouched`);
    return { released: false };
  }
  if (params.expectedRunId) {
    const boundOwner =
      ((await readSlotField(params.slotId, 'current_run_id')) as string | null) ?? null;
    if (boundOwner !== params.expectedRunId) {
      console.log(
        `[release] slot ${params.slotId} is held by ${boundOwner ?? 'nobody'}, not expected run ${params.expectedRunId}; leaving it untouched`,
      );
      return { released: false };
    }
  }
  const vars = await loadSlotVars(params.slotId);
  const forceReset = params.forceReset ?? false;
  const preserveAgents = params.preserveAgents ?? false;
  const gateHeldRun = findActiveGateHeldRunForSlot(params.slotId);
  if (gateHeldRun && !preserveAgents && !forceReset) {
    throw new Error(
      `Slot ${params.slotId} is gate-held for run ${gateHeldRun.id} — resolve or cancel the publication gate before release`,
    );
  }

  // Release runs idle-reset + the project recycle hook (both can reset --hard
  // the slot repo) — guard so the operator root is never recycled.
  await assertSlotNotOperatorRoot(vars, SLOT_DESTRUCTIVE_OPS.release);
  await applySelectedApp(vars);

  let projectVars: ProjectVars | undefined;
  let projectJson: RawProjectJson = {};
  try {
    projectVars = await loadProjectVars(vars.projectName);
    projectJson = projectVars.projectJson;
  } catch {
    /* no project config */
  }

  const defaultBranch = getProjectField(projectJson, 'default_branch') || DEFAULT_BRANCH;
  const keepWarm = params.keepWarm ?? false;
  const keepWork = params.keepWork ?? false;
  const skipArtifacts = params.skipArtifacts ?? false;
  const detachRuns = params.detachRuns ?? true;
  const requestId = params.requestId ?? `release-${randomUUID()}`;
  const startTime = Date.now();

  const out = (line: string) =>
    emit('script.output', {
      requestId,
      stream: 'stdout' as const,
      data: line.endsWith('\n') ? line : `${line}\n`,
      timestamp: Date.now(),
    });
  const complete = (exitCode: number) =>
    emit('script.complete', {
      requestId,
      exitCode,
      duration: Date.now() - startTime,
    });
  const step = (name: string, detail: string) => {
    emit('slot.release.step', { requestId, slotId: params.slotId, name, detail });
    out(`[${name}] ${detail}`);
  };

  // ONE serialized CAS does owner validation, the releasing marker, and the
  // epoch capture together: an owner sampled before the preflight awaits can
  // never be silently replaced by a rival claim's — the predicate re-reads
  // the CURRENT owner inside the write chain, and when expectedRunId is set
  // the teardown is refused unless that exact run still holds the claim.
  const mark = await markSlotStatusIf(
    params.slotId,
    (slot: Readonly<Record<string, unknown>>) => {
      // A pending handoff reservation means an incoming run's delivery is in
      // flight on this worker — no teardown (bound or not) may start under it.
      if (typeof slot.handoff_run_id === 'string' && slot.handoff_run_id) return false;
      // A slot already mid-release belongs to that teardown — a bound release
      // joining at the same epoch would run a second destructive pass and keep
      // going after the first publishes `ready`, clobbering whatever claims
      // the slot next. Applies to bound AND unbound entries.
      if (slot.phase === SLOT_PHASE_RELEASING) return false;
      const owner = ((slot.current_run_id as string | null | undefined) ?? null) as string | null;
      if (params.expectedRunId) return owner === params.expectedRunId;
      // Unbound (operator) release: releases whoever currently holds the slot.
      return true;
    },
    { lifecycle: 'busy', phase: SLOT_PHASE_RELEASING },
  );
  if (!mark.applied) {
    step(
      'claim',
      `Slot ${params.slotId} was claimed by another run (or is already releasing); leaving it alone`,
    );
    complete(0);
    return { released: false };
  }
  const entryEpoch = mark.epoch ?? 0;

  // Stop TASK.md watching — only after the CAS proves this teardown owns the
  // slot; removing watchers first would strip a rival claim's watchers even
  // when the release is then correctly refused.
  try {
    const { unwatchSlot } = await import('../../tasks/watcher.js');
    await unwatchSlot(params.slotId);
  } catch (err) {
    // A failed watcher removal must not strand the slot in `releasing`. For
    // a full teardown the killed session moots the watcher; for a
    // preserveAgents (gate-hold) release the leftover watcher is rebound by
    // the next watchSlot. In both cases proceeding beats aborting mid-mark.
    console.warn(
      `[release] unwatch failed for ${params.slotId}; continuing teardown: ${(err as Error).message}`,
    );
  }
  const guardedTeardownWrite = async (fields: Record<string, unknown>): Promise<boolean> => {
    const ok = await updateSlotStatusIf(
      params.slotId,
      (slot) => (Number(slot.slot_epoch) || 0) === entryEpoch,
      fields,
    );
    if (!ok) {
      step(
        'claim',
        `Slot ${params.slotId} was re-claimed mid-teardown (epoch moved past ${entryEpoch}); aborting remaining teardown`,
      );
    }
    return ok;
  };

  // 1. Kill running agent. Local-first publication gate-hold skips slotRelease at
  // COMPLETE entirely (see holdSlotForPublicationGate) and keeps the worker warm
  // through FINALIZE → ci-watch; agent teardown happens here at family/slot end
  // (or terminal-failure / cancel). preserveAgents is for partial release call sites only.
  if (!preserveAgents) {
    // Close the passive log reader first. If it were the only non-agent
    // window, killing role windows first would leave it as tmux's last window;
    // closing it afterward would destroy the slot session.
    await closeDevServerLogTailWindow(vars);
    step('agent', 'Killing agent...');
    await killAllAgentWindows(vars);
    await killAgentInSession(vars);
    step('agent', 'Agent killed');
    // The staged terminal attachments belong to the session that just died. Delete them
    // here rather than waiting for the bounded stale sweep so the slot goes back to idle
    // without operator images sitting in its runtime dir.
    try {
      const cleaned = await terminalAttachmentCleanup({ slotId: params.slotId, scope: 'all' });
      step('attachments', `Removed ${cleaned.removed.length} staged terminal attachment(s)`);
    } catch (err) {
      // Recovery is explicit: staged attachments are already age-bounded by the stale
      // sweep on the next upload, so a failed delete must not strand the slot in
      // `releasing` — every later teardown step still needs to run.
      step('attachments', `Attachment cleanup skipped: ${(err as Error).message}`);
    }
  } else {
    step('agent', 'Preserving agent windows for human gate');
  }

  // 2. Safety check (skip if --keepWork, --forceReset, or --force implied by keepWarm)
  if (!keepWork && !forceReset) {
    const currentBranch = (
      await execOnSlot(
        vars,
        `git -C ${shellQuote(vars.remoteRepo)} rev-parse --abbrev-ref HEAD 2>/dev/null`,
      )
    ).stdout.trim();
    const linkedWorktree = await detectLinkedWorktree(vars);
    const trackingBranch = resolveSlotTrackingBranchFromProject(
      projectJson,
      vars,
      projectVars,
      linkedWorktree,
    );
    if (
      currentBranch &&
      !isSlotIdleBranch(currentBranch, trackingBranch, defaultBranch, linkedWorktree)
    ) {
      const dirty = (
        await execOnSlot(
          vars,
          `git -C ${shellQuote(vars.remoteRepo)} status --porcelain 2>/dev/null | grep -v '^\?\? \.omc/' | grep -v '^\?\? \.task/' | grep -v '^\?\? \.claude/CLAUDE\\.local\\.md' | head -5`,
        )
      ).stdout.trim();
      const hasRemote =
        (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} rev-parse --verify ${shellQuote(`origin/${currentBranch}`)} 2>/dev/null && echo yes`,
          )
        ).stdout.trim() === 'yes';
      let unpushed = '';
      if (hasRemote) {
        unpushed = (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} log --oneline ${shellQuote(`origin/${currentBranch}..HEAD`)} 2>/dev/null | head -5`,
          )
        ).stdout.trim();
      } else {
        unpushed = (
          await execOnSlot(
            vars,
            `git -C ${shellQuote(vars.remoteRepo)} log --oneline ${shellQuote(`${defaultBranch}..HEAD`)} 2>/dev/null | head -5`,
          )
        ).stdout.trim();
      }
      if (dirty || unpushed) {
        // Check if the remote branch still exists — GitHub deletes branches after PR merge.
        // If gone from remote, the work was merged and there's nothing to lose.
        const remoteBranchExists =
          (
            await execOnSlot(
              vars,
              `git -C ${shellQuote(vars.remoteRepo)} ls-remote --heads origin ${shellQuote(currentBranch)} 2>/dev/null`,
            )
          ).stdout.trim() !== '';
        if (remoteBranchExists) {
          await markSlotBusy(params.slotId, 'working');
          const details = [dirty && 'dirty files', unpushed && 'unpushed commits']
            .filter(Boolean)
            .join(' + ');
          throw new Error(
            `UNMERGED_WORK:${currentBranch}:${details}:Slot has work on '${currentBranch}' (${details}) that would be lost. Use Force Reset to discard.`,
          );
        }
        console.log(
          `[slot.release] ${params.slotId}: remote branch '${currentBranch}' deleted (merged) — allowing recycle`,
        );
      }
    }
  }

  // 3. Collect artifacts + clean task files + git reset
  const taskDirName = resolveProjectTaskDirName(projectJson);
  let idleBranchAfterRelease: string | undefined;
  if (!keepWork) {
    // Read task_file from status
    const taskRel = (await readSlotField(params.slotId, 'task_file')) as string | null;

    if (!skipArtifacts && taskRel) {
      step('artifacts', 'Collecting artifacts...');
      const workerArtifacts = `${vars.remoteRepo}/${taskDirName}/${taskRel}/artifacts`;
      const hasArtifacts =
        (
          await execOnSlot(vars, `test -d ${shellQuote(workerArtifacts)} && echo yes`)
        ).stdout.trim() === 'yes';
      if (hasArtifacts) {
        const orchTaskDir = path.join(
          getOrchestratorTaskRoot(vars.projectName, projectJson),
          taskRel,
        );
        const localArtifactsDir = path.join(orchTaskDir, 'artifacts');
        const entryFailures: SlotCopyDirEntryError[] = [];
        await slotCopyDir(vars, workerArtifacts, localArtifactsDir, {
          excludeTopLevel: [...WORKER_ARTIFACT_COPY_EXCLUDES],
          excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
          // Release-time copyback is best-effort: one transient EACCES on a
          // screenshot must not block reset of the whole slot. Per-file errors
          // are surfaced in the step breadcrumb so operators see partial copies.
          onEntryFailure: (err) => {
            entryFailures.push(err);
            console.warn(
              `[slot.release] artifact copy entry failure ${err.sourcePath}: ${err.message.slice(0, 200)}`,
            );
          },
        });
        if (entryFailures.length > 0) {
          step(
            'artifacts',
            `Artifacts collected to ${localArtifactsDir}/ (with ${entryFailures.length} per-file failure${entryFailures.length === 1 ? '' : 's'})`,
          );
        } else {
          step('artifacts', `Artifacts collected to ${localArtifactsDir}/`);
        }
      } else {
        step('artifacts', 'No artifacts directory');
      }
    }

    // Clean task files
    if (taskRel) {
      await execOnSlot(
        vars,
        `rm -rf ${shellQuote(`${vars.remoteRepo}/${taskDirName}/${taskRel}`)}`,
      );
      step('clean', `Task dir ${taskDirName}/${taskRel} cleaned`);
    }

    try {
      const storageCleanup = await cleanupSlotStorage(vars, projectJson, {
        // Release keeps warm resources alive, so only prune completed task
        // copies and runtime artifact buckets. Browser profile directories are
        // reserved for explicit slot.cleanup after resource shutdown.
        includeBrowserProfiles: false,
      });
      if (storageCleanup.deleted.length > 0 || storageCleanup.skipped.length > 0) {
        step(
          'storage-clean',
          `Pruned ${storageCleanup.deleted.length} stale slot director${storageCleanup.deleted.length === 1 ? 'y' : 'ies'}`,
        );
      } else {
        step('storage-clean', 'No stale slot directories');
      }
    } catch (err) {
      // Storage pruning is intentionally best-effort at release time: by this
      // point the active task artifacts have already been copied back, and a
      // stale-cache cleanup failure must not strand the slot in releasing.
      const detail = (err as Error).message.slice(0, 200);
      console.warn(`[slot.release] ${params.slotId}: storage cleanup skipped: ${detail}`);
      step('storage-clean', `Skipped stale storage cleanup: ${detail}`);
    }

    step('git', `Returning slot to idle baseline...`);
    const idleReset = await resetSlotRepoToIdle(vars, projectJson, projectVars, defaultBranch);
    idleBranchAfterRelease = idleReset.linkedWorktree ? idleReset.trackingBranch : defaultBranch;
    step('git', slotIdleResetStepDetail(idleReset, defaultBranch));

    // Recycle app
    step('recycle', 'Recycling app...');
    const recycleCmd = vars.recycleCmd
      ? expandRecycleCmd(vars)
      : expandHook('recycle', projectJson, vars, projectVars);
    if (recycleCmd) {
      await execOnSlot(vars, recycleCmd);
      step('recycle', 'App recycled');
    } else {
      step('recycle', 'No recycle command configured');
    }
  }

  // 5. Teardown — DELIBERATELY DOES NOTHING for resources. Release flips
  // the slot back to ready but leaves the simulator / dev-server / browser
  // alive so the next run reuses warm infra and so a human-driven manual
  // build in the worktree isn't yanked out from under them.
  // Resource shutdown is a separate explicit user action via the
  // slot.cleanup RPC (cleanup button). The historical "fallback" that
  // ran `xcrun simctl shutdown` here was the source of the live-sim kill
  // problem; do not reintroduce it. Screen capture sessions are still
  // torn down because they're tied to a specific PID that's about to
  // change anyway.
  if (!keepWarm) {
    killSlotScreenSessions(params.slotId);
  }

  // 6. Update status fields — epoch-guarded: a rival claim landing after the
  // release marker (only possible through a writer not yet on the claim
  // protocol) bumps the epoch and the finalize must abort rather than reset
  // the new owner's claim.
  if (!keepWork) {
    if (
      !(await guardedTeardownWrite({
        handoff_run_id: null,
        task_id: null,
        task_file: null,
        runner: null,
        model: null,
        app: null,
        current_run_id: null,
        current_flow_type: null,
        current_ticket_or_pr: null,
        current_mode: null,
        current_family_id: null,
        current_lane: null,
        current_variant: null,
      }))
    ) {
      complete(0);
      return { released: false };
    }
  } else if (!keepWarm) {
    if (!(await guardedTeardownWrite({ app: null }))) {
      complete(0);
      return { released: false };
    }
  }
  if (
    !(await guardedTeardownWrite({
      completed_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      agent: 'idle',
      ...(idleBranchAfterRelease ? { branch: idleBranchAfterRelease } : {}),
    }))
  ) {
    complete(0);
    return { released: false };
  }

  // 7. Re-prepare if keep-warm, otherwise mark ready (cold). resetSlot writes
  // unconditionally, so re-verify the epoch immediately before it.
  const epochStillOurs = (slot: Readonly<Record<string, unknown>>): boolean =>
    (Number(slot.slot_epoch) || 0) === entryEpoch;
  const abortReset = (): { released: boolean } => {
    step(
      'claim',
      `Slot ${params.slotId} was re-claimed before final reset (epoch moved past ${entryEpoch}); aborting reset`,
    );
    complete(0);
    return { released: false };
  };
  if (keepWarm) {
    step('reprepare', 'Re-preparing slot...');
    try {
      await slotPrepare({ slotId: params.slotId }, emit);
      if (!(await resetSlotIf(params.slotId, epochStillOurs, true))) return abortReset();
    } catch (err) {
      step('reprepare', `Re-prepare had issues: ${(err as Error).message}`);
      if (!(await resetSlotIf(params.slotId, epochStillOurs, true))) return abortReset();
    }
  } else {
    if (!(await resetSlotIf(params.slotId, epochStillOurs))) return abortReset();
  }
  if (detachRuns) {
    const detachedRunIds = detachRunsForReleasedSlot(params.slotId, emit);
    if (detachedRunIds.length > 0) {
      step('runs', `Detached ${detachedRunIds.length} run(s) from released slot`);
    }
  }

  emit('slot.release.done', { requestId, slotId: params.slotId, keepWarm });
  complete(0);
  return { released: true };
}

/** Tear down role windows and runner processes without running a full slot release. */
export async function killSlotAgents(slotId: string): Promise<void> {
  const vars = await loadSlotVars(slotId);
  // Preserve the replacement-window invariant in killAllAgentWindows: remove
  // the passive tail before it counts as the session's final non-agent window.
  await closeDevServerLogTailWindow(vars);
  await killAllAgentWindows(vars);
  await killAgentInSession(vars);
}

// ─── slotRecycle — convenience wrapper ───

export async function killAgentInSession(
  vars: SlotVars,
  runner?: string,
  role: AgentRole = 'primary',
): Promise<void> {
  const TMUX_CMD_TIMEOUT = 10_000;
  const session = await resolveTmuxSession(vars.slotId, vars);
  const roleWindow = agentDispatchWindow(role);
  const hasSession =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasSession) return;

  // Resolve the cleanup target the same way dispatch does — `${session}:0`
  // doesn't exist on hosts where tmux is configured with `base-index 1`
  // (mini.local + many community confs). Using firstWindowTarget keeps the
  // kill path aligned with renameDefaultWorkerWindow / ensureWorkerRoleTarget
  // / waitForRunnerProcessExit so a runner alive in `${session}:1` actually
  // gets interrupted instead of orphaned through a no-op cleanup.
  const target = roleWindow ? `${session}:${roleWindow}` : await firstWindowTarget(vars, session);

  const hasTarget =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`,
        ),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasTarget) return;

  const panePid = (
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-panes -t ${shellQuote(target)} -F '#{pane_pid}' 2>/dev/null | head -1`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    )
  ).stdout.trim();
  if (!panePid) return;

  // Walk descendants instead of pgrep -P direct children — a project with a
  // wrapping `dispatch_cmd` (e.g. `bash -lc 'codex …'`) makes the runner a
  // grandchild of the pane shell, and the old check returned empty, skipping
  // the graceful `/exit` step entirely. The kill -TERM/KILL fallback below
  // operates on the actual runner PID, so the descendant walk needs to
  // surface that PID, not just a boolean.
  const agentPid = await findRunnerDescendantPid(vars, panePid, runner);

  if (agentPid) {
    await execOnSlot(vars, tmuxSendTextCommand(target, '/exit', { enter: true }), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 2000));

    const stillAlive =
      (
        await execOnSlot(vars, `kill -0 ${shellQuote(agentPid)} 2>/dev/null`, {
          timeout: TMUX_CMD_TIMEOUT,
        })
      ).exitCode === 0;
    if (stillAlive) {
      await execOnSlot(vars, `kill -TERM ${shellQuote(agentPid)} 2>/dev/null`, {
        timeout: TMUX_CMD_TIMEOUT,
      });
      await new Promise((r) => setTimeout(r, 1000));
      await execOnSlot(
        vars,
        `kill -0 ${shellQuote(agentPid)} 2>/dev/null && kill -KILL ${shellQuote(agentPid)} 2>/dev/null`,
        { timeout: TMUX_CMD_TIMEOUT },
      );
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  const shellAlive =
    (
      await execOnSlot(vars, `kill -0 ${shellQuote(panePid)} 2>/dev/null && echo yes`, {
        timeout: TMUX_CMD_TIMEOUT,
      })
    ).stdout.trim() === 'yes';

  if (shellAlive) {
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 300));
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
    });
    await new Promise((r) => setTimeout(r, 300));
    await execOnSlot(
      vars,
      tmuxSendTextCommand(target, `cd ${vars.remoteRepo}`, { enter: true, suffix: '2>/dev/null' }),
      { timeout: TMUX_CMD_TIMEOUT },
    );
  } else {
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `respawn-pane -k -t ${shellQuote(target)} ${shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo))} 2>/dev/null`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function killAllAgentWindows(
  vars: SlotVars,
  sessionOverride?: string,
  options?: { exclude?: ReadonlyArray<AgentRole> },
): Promise<void> {
  const TMUX_CMD_TIMEOUT = 10_000;
  const session = sessionOverride ?? (await resolveTmuxSession(vars.slotId, vars));
  const hasSession =
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(`has-session -t ${shellQuote(session)} 2>/dev/null`),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).exitCode === 0;
  if (!hasSession) return;

  const excluded = new Set<string>(
    (options?.exclude ?? [])
      .map((role) => agentRoleWindow(role))
      .filter((name): name is string => Boolean(name)),
  );
  const roleWindowNames = new Set(
    AGENT_ROLES.map((role) => agentRoleWindow(role))
      .filter((name): name is string => Boolean(name))
      .filter((name) => !excluded.has(name)),
  );
  const shouldKillWindow = (name: string | undefined): boolean =>
    shouldKillAgentWindowName(name, { roleWindowNames, excluded });
  let previousMatchSignature: string | null = null;
  let killAttempts = 0;
  let maxObservedWindows = 0;
  while (true) {
    const listed = await execOnSlot(
      vars,
      tmuxShellSnippet(
        `list-windows -t ${shellQuote(session)} -F '#{window_index}\t#{window_name}' 2>/dev/null`,
      ),
      { timeout: TMUX_CMD_TIMEOUT },
    );
    if (listed.exitCode !== 0) return;

    const windows = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [index, name] = line.split('\t', 2);
        return { index, name };
      });
    maxObservedWindows = Math.max(maxObservedWindows, windows.length);
    const roleWindows = windows
      .filter((window) => window.index && window.name && shouldKillWindow(window.name))
      .sort((a, b) => Number(b.index) - Number(a.index));
    if (roleWindows.length === 0) return;

    const matchSignature = roleWindows.map((window) => `${window.index}:${window.name}`).join('|');
    if (matchSignature === previousMatchSignature) {
      throw new Error(
        `Tmux role window cleanup is not converging for session ${session}; still matched ${matchSignature}`,
      );
    }
    previousMatchSignature = matchSignature;

    for (const roleWindow of roleWindows) {
      killAttempts += 1;
      if (killAttempts > Math.max(1, maxObservedWindows) * 2) {
        throw new Error(
          `Tmux role window cleanup exceeded ${killAttempts - 1} kill attempts for session ${session}; windows may be respawning`,
        );
      }
      const target = `${session}:${roleWindow.index}`;
      const command = buildKillRoleWindowCommand(session, target, windows.length, vars.remoteRepo);
      const killed = await execOnSlot(vars, tmuxShellSnippet(command), {
        timeout: TMUX_CMD_TIMEOUT,
      });
      if (killed.exitCode !== 0) {
        throw new Error(
          `Failed to kill tmux role window ${target}: ${killed.stderr || killed.stdout || `exit ${killed.exitCode}`}`,
        );
      }
    }
  }
}

export function shouldKillAgentWindowName(
  name: string | undefined,
  opts: { roleWindowNames: ReadonlySet<string>; excluded?: ReadonlySet<string> },
): boolean {
  if (!name || opts.excluded?.has(name)) return false;
  return opts.roleWindowNames.has(name) || isReviewerWindowName(name);
}

export function buildKillRoleWindowCommand(
  session: string,
  target: string,
  windowCount: number,
  remoteRepo: string,
): string {
  if (windowCount <= 1) {
    // tmuxShellSnippet() prefixes a single tmux binary invocation. Use tmux's
    // command separator rather than shell `&&`; otherwise the second command
    // runs as a shell command (`kill-window`) and fails with exit 127.
    return `new-window -t ${shellQuote(session)} -n worker -c ${shellQuote(remoteRepo)} -d \\; kill-window -t ${shellQuote(target)} 2>/dev/null`;
  }
  return `kill-window -t ${shellQuote(target)} 2>/dev/null`;
}
