import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  AGENT_ROLES,
  agentDispatchWindow,
  type AgentRole,
  agentRoleWindow,
  DEFAULT_BRANCH,
  type FlowType,
  isReviewerWindowName,
  isTerminalRunStatus,
  primaryRoleForFlow,
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
  readSlotRow,
  resetSlotIf,
  resolveProjectTaskDirName,
  SLOT_PHASE_RELEASING,
  SLOT_RELEASING_SINCE,
  slotReleasingFenceFields,
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
import { archiveSlotScaffolding, excludeSlotScaffolding } from '../../fleet/slot-scaffolding.js';
import { cleanupSlotStorage, normalizeTaskRelativeDir } from '../../fleet/slot-storage-cleanup.js';
import {
  findActiveGateHeldRunForSlot,
  findGateParkedRunForSlot,
} from '../../run-engine/gate-held-lifecycle.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
} from '../../run-engine/terminal-teardown-registry.js';
import { isRunArchiving } from '../../run-lifecycle/archive-fence.js';
import {
  assertNativeSlotReplacementOwner,
  cancelNativeRunWorkers,
  retireNativeWorkersForSlot,
} from '../../runners/native/worker.js';
import { runnerPromptSubmitKey } from '../../runners/registry.js';
import { archiveRunnerSessionsForSlotRelease } from '../../runners/session-archive.js';
import {
  RUNNER_PARK_GRACEFUL_EXIT_MAX_TIMEOUT_MS,
  RUNNER_PARK_LIVENESS_PROBE_ATTEMPTS,
} from '../../runners/session-lifecycle.js';
import { findRunnerDescendantPid } from '../../runners/session-process.js';
import {
  getRun,
  getRunWithArchived,
  listRunsForSlotHistory,
  runsDirectory,
  runSessionArchiveDir,
} from '../../runs/store.js';
import { killSlotScreenSessions } from '../../runtime/screen-session.js';
import { buildDispatchRoleShellCommand } from '../dispatch/role-target.js';
import { releaseRuntimeCapabilitiesForSlot } from '../runtime-capabilities.js';
import { terminalAttachmentCleanup } from '../terminal-attachment.js';

import { slotPrepare } from './prepare.js';
import { prepareIdentityPath, reapSlotPrepareScope } from './prepare-command.js';
import { closeDevServerLogTailWindow } from './prepare-devserver-log.js';
import { detachRunsForReleasedSlot } from './release-run-ownership.js';
import { activePrepareAborts, applySelectedApp, type EventEmitter } from './shared.js';
import {
  assertSlotNotOperatorRoot,
  detectLinkedWorktree,
  isSlotIdleBranch,
  resetSlotRepoToIdle,
  resolveSlotTrackingBranchFromProject,
  slotIdleResetStepDetail,
} from './slot-tracking.js';
import { findUnmergedSlotWork } from './unmerged-work.js';

// In-flight teardown coalescing: two concurrent releases for the same slot
// must be ONE teardown — the slower duplicate previously re-killed and reset
// whatever claimed the slot after the first release finished.
const inflightReleases = new Map<
  string,
  { key: string; promise: Promise<{ released: boolean }> }
>();

/** How long a release waits for an aborted in-flight prepare to settle. A
 * git command stalled on a dropped network never observes the abort; past
 * this the slot is held with the reason instead of the release hanging. */
export const RELEASE_PREPARE_STOP_TIMEOUT_MS = 3 * 60_000;
/** Progress while waiting, so a CLI idle timeout does not end the release first. */
const RELEASE_PREPARE_STOP_HEARTBEAT_MS = 15_000;

export interface SlotReleaseOptions {
  restartRunId?: string;
  expectedSlotEpoch?: number;
  prepareStopTimeoutMs?: number;
  prepareStopHeartbeatMs?: number;
}

class BoundReleaseClaimLostError extends Error {}

function releaseCoalesceKey(params: SlotReleaseParams, options?: SlotReleaseOptions): string {
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
    restartRunId: options?.restartRunId ?? null,
    expectedSlotEpoch: options?.expectedSlotEpoch ?? null,
  });
}

export async function slotRelease(
  params: SlotReleaseParams,
  emit: EventEmitter,
  // A blocked-run restart keeps the same run ID. It must release the slot
  // without fencing that run as terminal before the new attempt can acquire proof.
  options?: SlotReleaseOptions,
): Promise<{ released: boolean }> {
  if (options?.restartRunId !== undefined && options.restartRunId !== params.expectedRunId) {
    throw new Error('Restart release must be bound to its run owner');
  }
  const key = releaseCoalesceKey(params, options);
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
  // The reconciler's only view of a live teardown is the registry. Without
  // this, a release that outlived the stale-fence bound would be reclaimed
  // mid-teardown, now that refresh keeps the fence stamp it ages.
  beginTerminalTeardown(params.slotId);
  const teardown = slotReleaseImpl(params, emit, options)
    .catch((error: unknown) => {
      // A bound teardown losing its claim is an expected no-op for archive and
      // replay rollback. The new owner's workspace has already been left alone.
      if (error instanceof BoundReleaseClaimLostError) return { released: false };
      throw error;
    })
    .finally(() => {
      endTerminalTeardown(params.slotId);
      if (inflightReleases.get(params.slotId)?.promise === teardown) {
        inflightReleases.delete(params.slotId);
      }
    });
  inflightReleases.set(params.slotId, { key, promise: teardown });
  return teardown;
}

export interface SlotUnmergedWork {
  branch: string;
  details: string;
}

export interface SlotReleasePreflight {
  vars: SlotVars;
  boundOwner: string | null;
  ownerTerminal: boolean;
  projectVars: ProjectVars | undefined;
  projectJson: RawProjectJson;
  defaultBranch: string;
  /** Work a full release would discard; null under keepWork/forceReset. */
  unmergedWork: SlotUnmergedWork | null;
}

/**
 * The release's read-only guards, run before any teardown side effect. Returns
 * null when the release is a no-op (slot mid-release, or held by a run other
 * than `expectedRunId`) and throws when a guard refuses. Unmerged work is
 * returned, not thrown, so each caller words the refusal for its own action.
 */
export async function slotReleasePreflight(
  params: SlotReleaseParams,
  restartRunId?: string,
): Promise<SlotReleasePreflight | null> {
  // Cheap early checks (authoritative validation happens atomically at the
  // releasing-marker CAS in slotReleaseImpl, after this preflight). A slot
  // already mid-release belongs to that teardown — a bound release joining at
  // the same epoch would run a second destructive pass.
  if ((await readSlotField(params.slotId, 'phase')) === SLOT_PHASE_RELEASING) {
    console.log(`[release] slot ${params.slotId} is already mid-release; leaving it untouched`);
    return null;
  }
  const boundOwner =
    ((await readSlotField(params.slotId, 'current_run_id')) as string | null) ?? null;
  if (params.expectedRunId && boundOwner !== params.expectedRunId) {
    console.log(
      `[release] slot ${params.slotId} is held by ${boundOwner ?? 'nobody'}, not expected run ${params.expectedRunId}; leaving it untouched`,
    );
    return null;
  }
  const vars = await loadSlotVars(params.slotId);
  const forceReset = params.forceReset ?? false;
  const preserveAgents = params.preserveAgents ?? false;
  assertNativeSlotReplacementOwner(params.slotId, params.expectedRunId ?? boundOwner ?? undefined);
  const gateHeldRun = findActiveGateHeldRunForSlot(params.slotId);
  if (gateHeldRun && !preserveAgents && !forceReset) {
    throw new Error(
      `Slot ${params.slotId} is gate-held for run ${gateHeldRun.id} — resolve or cancel the publication gate before release`,
    );
  }
  // A gate-parked run (ADR-054 `free-slot`) gave the slot up but keeps a park
  // record whose restore target is this workspace. Releasing destroys it, so
  // refuse — but only when this release is aimed at the parked run itself.
  // Once another run claims the freed slot, ITS release must still work, which
  // is the whole point of freeing the slot. `preserveAgents` does not bypass:
  // there are no agents left to preserve, and the record dies either way.
  const gateParkedRun = findGateParkedRunForSlot(params.slotId);
  if (gateParkedRun && !forceReset) {
    const targetsParkedRun = params.expectedRunId
      ? params.expectedRunId === gateParkedRun.id
      : boundOwner === null || boundOwner === gateParkedRun.id;
    if (targetsParkedRun) {
      throw new Error(
        `Slot ${params.slotId} holds the park record for gate-parked run ${gateParkedRun.id} — cancel that run or pass forceReset before release`,
      );
    }
  }

  const ownerRun = boundOwner ? await getRunWithArchived(boundOwner) : undefined;
  const ownerTerminal = !!ownerRun && isTerminalRunStatus(ownerRun.status);
  const refusal = releaseOwnerRefusal(boundOwner, ownerTerminal, params, restartRunId);
  if (refusal) throw new Error(refusal);

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
  const unmergedWork =
    params.keepWork || forceReset
      ? null
      : await findReleaseUnmergedWork(vars, projectJson, projectVars, defaultBranch);
  return { vars, boundOwner, ownerTerminal, projectVars, projectJson, defaultBranch, unmergedWork };
}

function releaseOwnerRefusal(
  owner: string | null,
  archivedTerminal: boolean,
  params: SlotReleaseParams,
  restartRunId?: string,
): string | null {
  if (
    !owner ||
    restartRunId === owner ||
    (params.forceReset === true && params.expectedRunId === owner)
  )
    return null;
  const live = getRun(owner);
  // Archive already fenced a settled blocked run against replay before invoking
  // its owner-bound release. An ordinary release cannot borrow that authority.
  if (params.expectedRunId === owner && live?.status === 'blocked' && isRunArchiving(owner))
    return null;
  if (live ? isTerminalRunStatus(live.status) : archivedTerminal) return null;
  return live
    ? `Slot ${params.slotId} is held by non-terminal run ${owner}; finish it or use farmslot run cancel ${owner} before release`
    : `Slot ${params.slotId} is held by missing run ${owner}; restore its run record or explicitly discard this named workspace through slot.release RPC with forceReset:true and expectedRunId:${owner}`;
}

async function findReleaseUnmergedWork(
  vars: SlotVars,
  projectJson: RawProjectJson,
  projectVars: ProjectVars | undefined,
  defaultBranch: string,
): Promise<SlotUnmergedWork | null> {
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
    !currentBranch ||
    isSlotIdleBranch(currentBranch, trackingBranch, defaultBranch, linkedWorktree)
  )
    return null;
  const details = await findUnmergedSlotWork(vars, currentBranch, execOnSlot, projectJson);
  return details ? { branch: currentBranch, details } : null;
}

function unmergedWorkError(work: SlotUnmergedWork): Error {
  return new Error(
    `UNMERGED_WORK:${work.branch}:${work.details}:Slot has work on '${work.branch}' (${work.details}) that would be lost. Use Force Reset to discard.`,
  );
}

async function slotReleaseImpl(
  params: SlotReleaseParams,
  emit: EventEmitter,
  options?: SlotReleaseOptions,
): Promise<{ released: boolean }> {
  const preflight = await slotReleasePreflight(params, options?.restartRunId);
  if (!preflight) return { released: false };
  // Refused before the kill below, so a refusal leaves the worker running. Step 2
  // checks again after the kill for work the worker wrote in between.
  if (preflight.unmergedWork) throw unmergedWorkError(preflight.unmergedWork);
  const { vars, boundOwner, ownerTerminal, projectVars, projectJson, defaultBranch } = preflight;
  const forceReset = params.forceReset ?? false;
  const preserveAgents = params.preserveAgents ?? false;
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
  // The owner the releasing fence actually lands on: an unbound release takes
  // whoever holds the slot then, which may be a claim made after the preflight.
  let releasedOwner: string | null = null;
  let releaseRefusal: string | null = null;
  let priorFence: Record<string, unknown> = {};
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
      if (
        options?.expectedSlotEpoch !== undefined &&
        (Number(slot.slot_epoch) || 0) !== options.expectedSlotEpoch
      )
        return false;
      const owner = ((slot.current_run_id as string | null | undefined) ?? null) as string | null;
      if (params.expectedRunId && owner !== params.expectedRunId) return false;
      releaseRefusal = releaseOwnerRefusal(
        owner,
        owner === boundOwner && ownerTerminal,
        params,
        options?.restartRunId,
      );
      if (releaseRefusal) return false;
      releasedOwner = owner;
      priorFence = {
        lifecycle: slot.lifecycle,
        phase: slot.phase,
        [SLOT_RELEASING_SINCE]: slot[SLOT_RELEASING_SINCE] ?? null,
      };
      // Unbound release may take only an unowned or terminal workspace.
      return true;
    },
    slotReleasingFenceFields(),
  );
  if (!mark.applied) {
    if (releaseRefusal) throw new Error(releaseRefusal);
    step(
      'claim',
      `Slot ${params.slotId} was claimed by another run (or is already releasing); leaving it alone`,
    );
    complete(0);
    return { released: false };
  }
  const entryEpoch = mark.epoch ?? 0;
  const assertReleaseClaim = async (): Promise<void> => {
    const row = await readSlotRow(params.slotId);
    const owner = (row?.current_run_id as string | null | undefined) ?? null;
    const refusal = releaseOwnerRefusal(
      owner,
      owner === boundOwner && ownerTerminal,
      params,
      options?.restartRunId,
    );
    if (
      row &&
      (Number(row.slot_epoch) || 0) === entryEpoch &&
      row.phase === SLOT_PHASE_RELEASING &&
      owner === releasedOwner &&
      !refusal
    )
      return;
    await updateSlotStatusIf(
      params.slotId,
      (slot) =>
        (Number(slot.slot_epoch) || 0) === entryEpoch &&
        slot.phase === SLOT_PHASE_RELEASING &&
        (slot.current_run_id ?? null) === releasedOwner,
      priorFence,
    );
    if (params.expectedRunId && owner !== params.expectedRunId) {
      step(
        'claim',
        `Slot ${params.slotId} moved to another owner; remaining release actions stopped`,
      );
      complete(0);
      throw new BoundReleaseClaimLostError();
    }
    complete(1);
    throw new Error(
      refusal ??
        `Slot ${params.slotId} ownership changed before teardown; remaining release actions refused`,
    );
  };
  await assertReleaseClaim();

  // Capability leases are the authoritative ownership boundary for resources
  // acquired after core prepare. Release them before agent/session teardown so
  // provider actions still have their normal slot context. A provider failure
  // remains durable as an error lease and is reported without claiming release.
  try {
    // ADR-054: when this teardown belongs to a specific run, reconcile that run
    // to `terminal` first so the family's providers stop in dependency order and
    // the effective posture is recorded before the slot-wide sweep. A restart
    // reuses the owner ID, so its slot-wide sweep must not terminally fence it.
    if (params.expectedRunId && !options?.restartRunId) {
      const { reconcileRunPosture } = await import('../../run-engine/resource-posture.js');
      const outcome = await reconcileRunPosture({
        runId: params.expectedRunId,
        boundary: 'family-terminal',
      });
      step(
        'posture',
        outcome.error !== undefined
          ? `Terminal posture reconcile deferred: ${outcome.error}`
          : `Terminal posture ${outcome.result.transition.outcome}`,
      );
    }
    const capabilityRelease = await releaseRuntimeCapabilitiesForSlot(params.slotId);
    step(
      'capabilities',
      capabilityRelease.ok
        ? `Released ${capabilityRelease.released.length} runtime capability lease(s)`
        : `Runtime capability cleanup recorded ${capabilityRelease.failures.length} failure(s)`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    step('capabilities', `Runtime capability cleanup deferred: ${detail}`);
    console.warn(
      `[release] runtime capability cleanup failed for ${params.slotId}; continuing teardown: ${detail}`,
    );
  }

  await assertReleaseClaim();
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
    const runner = (await readSlotField(params.slotId, 'runner')) as string | null;
    const flowType = (await readSlotField(params.slotId, 'current_flow_type')) as FlowType | null;
    // Close the passive log reader first. If it were the only non-agent
    // window, killing role windows first would leave it as tmux's last window;
    // closing it afterward would destroy the slot session.
    step('agent', 'Killing agent...');
    const releasingRunId = params.expectedRunId ?? boundOwner;
    await assertReleaseClaim();
    if (releasingRunId && getRun(releasingRunId)?.transport === 'native') {
      await cancelNativeRunWorkers(releasingRunId);
    } else {
      await retireNativeWorkersForSlot(params.slotId, releasingRunId ?? undefined);
      await assertReleaseClaim();
      await closeDevServerLogTailWindow(vars);
      await assertReleaseClaim();
      await killAgentInSession(vars, runner ?? undefined, primaryRoleForFlow(flowType), {
        assertClaim: assertReleaseClaim,
      });
      await assertReleaseClaim();
      await killAllAgentWindows(vars, undefined, { assertClaim: assertReleaseClaim });
    }
    step('agent', 'Agent killed');
    // A release during or after preflight would otherwise publish readiness
    // while the prepare group and its holder keep running in the repository.
    // A prepare still in flight is stopped and joined first, for at most
    // RELEASE_PREPARE_STOP_TIMEOUT_MS: it would launch its holder after the
    // reap found nothing. This teardown holds the
    // releasing fence, so the recorded scope is this slot's own. A group that
    // survives keeps the slot held with the reason, and the release fails.
    let holdReason: string | null = null;
    const inflightPrepare = activePrepareAborts.get(params.slotId);
    if (inflightPrepare) {
      await assertReleaseClaim();
      step('prepare', 'Stopping in-flight prepare...');
      inflightPrepare.abort();
      const stopMs = options?.prepareStopTimeoutMs ?? RELEASE_PREPARE_STOP_TIMEOUT_MS;
      const waitStart = Date.now();
      const heartbeat = setInterval(
        () =>
          step(
            'prepare',
            `Waiting for in-flight prepare to stop… ${Math.round((Date.now() - waitStart) / 1000)}s`,
          ),
        options?.prepareStopHeartbeatMs ?? RELEASE_PREPARE_STOP_HEARTBEAT_MS,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([
        inflightPrepare.settled.then(() => true),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), stopMs))),
      ]);
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (!stopped)
        holdReason = `In-flight prepare did not stop within ${Math.round(stopMs / 1000)}s`;
    }
    if (!holdReason) {
      await assertReleaseClaim();
      try {
        const stopped = await reapSlotPrepareScope(vars, {
          identityPath: prepareIdentityPath(vars.remoteRepo, projectVars?.runtimeDir ?? ''),
        });
        step('prepare', stopped ? 'Prepare scope stopped' : 'No live prepare scope');
      } catch (error) {
        holdReason = error instanceof Error ? error.message : String(error);
      }
    }
    if (holdReason) {
      const reason = holdReason;
      step('prepare', reason);
      const held = await guardedTeardownWrite({
        lifecycle: 'held',
        phase: 'occupied',
        held_reason: reason,
        [SLOT_RELEASING_SINCE]: null,
      });
      if (!held) {
        complete(0);
        return { released: false };
      }
      complete(1);
      // Thrown, not `released: false`: callers that print or log success on
      // a settled release must report a slot left held.
      throw new Error(`Slot ${params.slotId} stays held: ${reason}`);
    }
    // The staged terminal attachments belong to the session that just died. Delete them
    // here rather than waiting for the bounded stale sweep so the slot goes back to idle
    // without operator images sitting in its runtime dir.
    await assertReleaseClaim();
    try {
      const cleaned = await terminalAttachmentCleanup({ slotId: params.slotId, scope: 'all' });
      step('attachments', `Removed ${cleaned.removed.length} staged terminal attachment(s)`);
    } catch (err) {
      // Recovery is explicit: staged attachments are already age-bounded by the stale
      // sweep on the next upload, so a failed delete must not strand the slot in
      // `releasing` — every later teardown step still needs to run.
      step('attachments', `Attachment cleanup skipped: ${(err as Error).message}`);
    }
    const archiveRunId =
      params.expectedRunId ??
      ((await readSlotField(params.slotId, 'current_run_id')) as string | null) ??
      boundOwner;
    if (archiveRunId) {
      await assertReleaseClaim();
      try {
        const archive = await archiveRunnerSessionsForSlotRelease({
          vars,
          runId: archiveRunId,
        });
        step('session-archive', archive.summary);
      } catch (err) {
        // Recycle must finish even if the transcript copy fails. The live file is
        // about to disappear with the slot workspace; aborting here would strand
        // the slot in `releasing` for a best-effort operator backup.
        step('session-archive', `Skipped: ${(err as Error).message}`);
        console.warn(
          `[release] session archive failed for ${params.slotId}: ${(err as Error).message}`,
        );
      }
    }
  } else {
    step('agent', 'Preserving agent windows for human gate');
  }

  // 2. Safety check (skip if --keepWork, --forceReset, or --force implied by keepWarm)
  await assertReleaseClaim();
  if (!keepWork && !forceReset) {
    const unmergedWork = await findReleaseUnmergedWork(
      vars,
      projectJson,
      projectVars,
      defaultBranch,
    );
    if (unmergedWork) {
      await markSlotBusy(params.slotId, 'working');
      throw unmergedWorkError(unmergedWork);
    }
  }

  // 3. Collect artifacts + clean task files + git reset
  const taskDirName = resolveProjectTaskDirName(projectJson);
  let idleBranchAfterRelease: string | undefined;
  if (!keepWork) {
    // Legacy slots may predate prepare exclusions; keep warm runtime files out of Git clean.
    await assertReleaseClaim();
    await excludeSlotScaffolding(vars, projectJson);
    // Read task_file from status
    const taskRel = normalizeTaskRelativeDir(
      (await readSlotField(params.slotId, 'task_file')) as string | null,
      taskDirName,
    );

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
        const releaseRunId =
          params.expectedRunId ??
          ((await readSlotField(params.slotId, 'current_run_id')) as string | null) ??
          undefined;
        await slotCopyDir(vars, workerArtifacts, localArtifactsDir, {
          excludeTopLevel: [...WORKER_ARTIFACT_COPY_EXCLUDES],
          excludeRelativePaths: [...WORKER_ARTIFACT_COPY_RELATIVE_EXCLUDES],
          // Stamp run/slot so transfer progress binds to run detail / pipeline UI.
          phase: 'mirror',
          runId: releaseRunId,
          slotId: params.slotId,
          labelPrefix: 'release-artifacts',
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

    if (!preserveAgents) {
      await assertReleaseClaim();
      const recent = listRunsForSlotHistory(params.slotId, { limit: 1 }).runs[0];
      const runId =
        params.expectedRunId ??
        boundOwner ??
        (recent && isTerminalRunStatus(recent.status) ? recent.id : null);
      const destination = runId
        ? path.join(runSessionArchiveDir(runId), 'slot-scaffolding')
        : path.join(runsDirectory(), 'slot-scaffolding', vars.slotId);
      try {
        const collected = await archiveSlotScaffolding(vars, projectJson, {
          destination,
          taskRelativeDir: taskRel,
          beforeRemove: assertReleaseClaim,
        });
        step(
          'scaffolding',
          `Collected ${collected.roots} scaffolding roots to ${collected.directory}`,
        );
      } catch (error) {
        await assertReleaseClaim();
        const reason = `Scaffolding collection failed; cleanup stopped: ${(error as Error).message}`;
        const held = await guardedTeardownWrite({
          lifecycle: 'held',
          phase: 'occupied',
          held_reason: reason,
          [SLOT_RELEASING_SINCE]: null,
        });
        if (!held) {
          complete(0);
          return { released: false };
        }
        complete(1);
        throw new Error(reason);
      }
    }

    // Clean task files
    await assertReleaseClaim();
    if (taskRel) {
      await execOnSlot(
        vars,
        `rm -rf ${shellQuote(`${vars.remoteRepo}/${taskDirName}/${taskRel}`)}`,
        { noRetry: true },
      );
      step('clean', `Task dir ${taskDirName}/${taskRel} cleaned`);
    }

    await assertReleaseClaim();
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
    await assertReleaseClaim();
    const idleReset = await resetSlotRepoToIdle(vars, projectJson, projectVars, defaultBranch);
    idleBranchAfterRelease = idleReset.linkedWorktree ? idleReset.trackingBranch : defaultBranch;
    step('git', slotIdleResetStepDetail(idleReset, defaultBranch));

    // Recycle app
    step('recycle', 'Recycling app...');
    const recycleCmd = vars.recycleCmd
      ? expandRecycleCmd(vars)
      : expandHook('recycle', projectJson, vars, projectVars);
    if (recycleCmd) {
      await assertReleaseClaim();
      await execOnSlot(vars, recycleCmd);
      step('recycle', 'App recycled');
    } else {
      step('recycle', 'No recycle command configured');
    }
  }

  // 5. Teardown — DELIBERATELY DOES NOTHING for resources. (The preflight
  // group was already reaped in step 1, so a dev server the preflight hook
  // backgrounded with `&` inside that group is gone; one started in its own
  // process group is not.) Release flips
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
    await assertReleaseClaim();
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
        readiness: null,
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
      await slotPrepare({ slotId: params.slotId }, emit, undefined, { duringRelease: true });
      if (!(await resetSlotIf(params.slotId, epochStillOurs, true))) return abortReset();
    } catch (err) {
      step('reprepare', `Re-prepare had issues: ${(err as Error).message}`);
      if (!(await resetSlotIf(params.slotId, epochStillOurs, true))) return abortReset();
    }
  } else {
    if (!(await resetSlotIf(params.slotId, epochStillOurs))) return abortReset();
  }
  if (detachRuns) {
    const detachedRunIds = detachRunsForReleasedSlot(params.slotId, emit, releasedOwner);
    if (detachedRunIds.length > 0) {
      step('runs', `Detached ${detachedRunIds.length} run(s) from released slot`);
    }
  }

  emit('slot.release.done', { requestId, slotId: params.slotId, keepWarm });
  complete(0);
  return { released: true };
}

/** Tear down role windows and runner processes without running a full slot release. */
export async function killSlotAgents(slotId: string, runId?: string): Promise<void> {
  if (runId && getRun(runId)?.transport === 'native') {
    await cancelNativeRunWorkers(runId);
    return;
  }
  await retireNativeWorkersForSlot(slotId, runId);
  const vars = await loadSlotVars(slotId);
  const runner = (await readSlotField(slotId, 'runner')) as string | null;
  const flowType = (await readSlotField(slotId, 'current_flow_type')) as FlowType | null;
  // Preserve the replacement-window invariant in killAllAgentWindows: remove
  // the passive tail before it counts as the session's final non-agent window.
  await closeDevServerLogTailWindow(vars);
  await killAgentInSession(vars, runner ?? undefined, primaryRoleForFlow(flowType));
  await killAllAgentWindows(vars);
}

// ─── slotRecycle — convenience wrapper ───

/** Ceiling on the whole pane scan, matching the park stop path's own ceiling. */
const RUNNER_TEARDOWN_PANE_SCAN_TIMEOUT_MS = RUNNER_PARK_GRACEFUL_EXIT_MAX_TIMEOUT_MS;

export async function killAgentInSession(
  vars: SlotVars,
  runner?: string,
  role: AgentRole = 'primary',
  options: { graceful?: boolean; assertClaim?: () => Promise<void> } = {},
): Promise<void> {
  // Mutations cannot be automatically resent after reconnect: that would skip
  // the ownership check and could reach a newer claim. A failed mutation leaves
  // the releasing fence for the stale-fence reconciler to reclaim.
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
  const preferredTarget = roleWindow
    ? `${session}:${roleWindow}`
    : await firstWindowTarget(vars, session);
  const listed = await execOnSlot(
    vars,
    tmuxShellSnippet(
      `list-panes -s -t ${shellQuote(session)} -F '#{pane_id}\t#{pane_pid}' 2>/dev/null`,
    ),
    { timeout: TMUX_CMD_TIMEOUT },
  );
  const panes = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [target, panePid] = line.split('\t', 2);
      return { target, panePid };
    })
    .filter((pane) => pane.target && pane.panePid);

  const preferredPaneIds = new Set(
    (
      await execOnSlot(
        vars,
        tmuxShellSnippet(
          `list-panes -t ${shellQuote(preferredTarget)} -F '#{pane_id}' 2>/dev/null`,
        ),
        { timeout: TMUX_CMD_TIMEOUT },
      )
    ).stdout
      .split('\n')
      .map((paneId) => paneId.trim())
      .filter(Boolean),
  );
  const candidates: Array<{ target: string; panePid: string; agentPid: string }> = [];
  // Each pane's probe may retry with a doubling budget, so the per-pane worst
  // case is bounded but the scan across panes was not. Cap the whole scan the
  // way the park stop path caps its wait, and refuse rather than decide a
  // teardown from panes we never got to look at.
  const scanDeadline = Date.now() + RUNNER_TEARDOWN_PANE_SCAN_TIMEOUT_MS;
  for (const pane of panes) {
    if (Date.now() >= scanDeadline) {
      throw new Error(
        `Runner teardown could not scan every pane in ${session} within ${RUNNER_TEARDOWN_PANE_SCAN_TIMEOUT_MS}ms; refusing to act on a partial scan`,
      );
    }
    // Teardown must not mistake a slow host for an empty pane, so give the
    // liveness probe the same bounded retry the park stop path uses.
    const candidatePid = await findRunnerDescendantPid(vars, pane.panePid, runner, {
      timeout: TMUX_CMD_TIMEOUT,
      attempts: RUNNER_PARK_LIVENESS_PROBE_ATTEMPTS,
    });
    if (!candidatePid) continue;
    candidates.push({ ...pane, agentPid: candidatePid });
  }
  const preferredCandidates = candidates.filter((pane) => preferredPaneIds.has(pane.target));
  const selected =
    preferredCandidates.length === 1
      ? preferredCandidates[0]
      : preferredCandidates.length === 0 && candidates.length === 1
        ? candidates[0]
        : null;
  if (!selected) {
    if (candidates.length > 1) {
      console.warn(
        `[release] refusing ambiguous runner teardown in ${session}: ${candidates.length} ${runner ?? 'agent'} processes`,
      );
    }
    return;
  }
  const { target, panePid, agentPid } = selected;

  // Prefer the flow-owned role window. A unique non-role fallback supports a
  // warm handoff whose child flow retained its parent worker window. Multiple
  // same-runner candidates fail closed instead of interrupting a reviewer.

  if (agentPid && options.graceful !== false) {
    await options.assertClaim?.();
    await execOnSlot(
      vars,
      tmuxSendTextCommand(target, '/exit', {
        enter: true,
        submitKey: runnerPromptSubmitKey(runner),
      }),
      {
        timeout: TMUX_CMD_TIMEOUT,
        noRetry: true,
      },
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (agentPid) {
    const stillAlive =
      (
        await execOnSlot(vars, `kill -0 ${shellQuote(agentPid)} 2>/dev/null`, {
          timeout: TMUX_CMD_TIMEOUT,
        })
      ).exitCode === 0;
    if (stillAlive) {
      await options.assertClaim?.();
      await execOnSlot(vars, `kill -TERM ${shellQuote(agentPid)} 2>/dev/null`, {
        timeout: TMUX_CMD_TIMEOUT,
        noRetry: true,
      });
      await new Promise((r) => setTimeout(r, 1000));
      await options.assertClaim?.();
      await execOnSlot(
        vars,
        `kill -0 ${shellQuote(agentPid)} 2>/dev/null && kill -KILL ${shellQuote(agentPid)} 2>/dev/null`,
        { timeout: TMUX_CMD_TIMEOUT, noRetry: true },
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
    await options.assertClaim?.();
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
      noRetry: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    await options.assertClaim?.();
    await execOnSlot(vars, tmuxShellSnippet(`send-keys -t ${shellQuote(target)} C-c 2>/dev/null`), {
      timeout: TMUX_CMD_TIMEOUT,
      noRetry: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    await options.assertClaim?.();
    await execOnSlot(
      vars,
      tmuxSendTextCommand(target, `cd ${vars.remoteRepo}`, { enter: true, suffix: '2>/dev/null' }),
      { timeout: TMUX_CMD_TIMEOUT, noRetry: true },
    );
  } else {
    await options.assertClaim?.();
    await execOnSlot(
      vars,
      tmuxShellSnippet(
        `respawn-pane -k -t ${shellQuote(target)} ${shellQuote(buildDispatchRoleShellCommand(vars.remoteRepo))} 2>/dev/null`,
      ),
      { timeout: TMUX_CMD_TIMEOUT, noRetry: true },
    );
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function killAllAgentWindows(
  vars: SlotVars,
  sessionOverride?: string,
  options?: { exclude?: ReadonlyArray<AgentRole>; assertClaim?: () => Promise<void> },
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
      await options?.assertClaim?.();
      const killed = await execOnSlot(vars, tmuxShellSnippet(command), {
        timeout: TMUX_CMD_TIMEOUT,
        noRetry: true,
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
